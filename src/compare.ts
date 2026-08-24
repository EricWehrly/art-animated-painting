import * as THREE from "three";
import { loadPoseCache } from "./pose/pose-cache";
import { buildChains } from "./pose/skeleton";
import { generateChainMarks, type BoneStrokeStyle } from "./pose/strokes";
import { createStrokeMesh } from "./paint/stroke-mesh";
import { createHeightPass } from "./paint/height-pass";
import { createShadingPass } from "./paint/shading-pass";

// Same body, same pose, several different BoneStrokeStyle variants side by side — built to
// answer "is this a tuning problem or a structural one" without having to eyeball two
// separately-scrubbed sessions of the main toy against each other. See
// docs/work/pose-pipeline.md Round 11.
//
// Frame 68 defaults to the case that prompted this: at high limb speed, a mark's heading gets
// pulled hard toward the local instantaneous motion direction (see generateChainMarks'
// motionForceScale/maxMotionForce) — unlike the old seeking-brush model this replaced, there's
// no stability ceiling forcing that blend to stay a minority, so how far motion is allowed to
// pull marks off the bone tangent is purely an art-direction choice. This page is for judging
// that choice by eye.

const BASE_STYLE: Omit<BoneStrokeStyle, "color"> = {
  widthScale: 1.7,
  lengthScale: 1,
  volumeScale: 0.35,
  pressureVariance: 0.5,
  stepLength: 1.7,
  stepOverlap: 0.5,
  markWidth: 0.8,
  wobbleAngle: 0.35,
  wobbleDamping: 0.35,
  paintCapacity: 4.5,
  dryMinLoad: 0.15,
  dryWidthFactor: 0.45,
  dryVolumeFactor: 0.4,
  motionForceScale: 0.7,
  maxMotionForce: 0.55,
  smearScale: 0.8,
  maxMarkLength: 4.5,
  speckleSpeedThreshold: Infinity, // this page doesn't render speckles
};

interface Variant {
  label: string;
  style: BoneStrokeStyle;
}

function buildVariants(color: [number, number, number]): Variant[] {
  return [
    { label: "current (motionForce 0.7/0.55, smear 0.8)", style: { ...BASE_STYLE, color } },
    {
      label: "tighter motion force (0.3/0.2, smear 0.4)",
      style: { ...BASE_STYLE, color, motionForceScale: 0.3, maxMotionForce: 0.2, smearScale: 0.4 },
    },
    {
      label: "no motion force — pure bone-aligned (0/0/0)",
      style: { ...BASE_STYLE, color, motionForceScale: 0, maxMotionForce: 0, smearScale: 0 },
    },
  ];
}

const CAMERA_POSITION = new THREE.Vector3(0, 20, 42);
const CAMERA_TARGET = new THREE.Vector3(0, 15, 0);

async function main() {
  const appEl = document.getElementById("app");
  if (!appEl) throw new Error("missing #app container");
  const app: HTMLElement = appEl;

  const frameInput = document.getElementById("frame-input") as HTMLInputElement;
  const dancerInput = document.getElementById("dancer-input") as HTMLSelectElement;
  const labelEls = [0, 1, 2].map((i) => document.getElementById(`label-${i}`) as HTMLDivElement);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  app.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(CAMERA_TARGET);

  const cache = await loadPoseCache("/data");
  const chains = buildChains(cache.header.joints);

  // One shared pipeline, reused sequentially per variant/strip — each variant's height/color
  // accumulation is independent because heightPass.render() clears its targets before drawing
  // (see height-pass.ts), so nothing leaks between strips despite reusing the same RTs.
  const viewForwardVec = CAMERA_TARGET.clone().sub(CAMERA_POSITION).normalize();
  const viewForward: [number, number, number] = [viewForwardVec.x, viewForwardVec.y, viewForwardVec.z];
  // Generous headroom for one dancer's worth of marks — see main.ts's maxMarksPerChainEstimate.
  const strokeMesh = createStrokeMesh(chains.length * 140);
  const heightPass = createHeightPass(1, 1); // real size set in resize()
  const shadingPass = createShadingPass();

  function render() {
    const frame = Math.max(0, Math.min(cache.header.frameCount - 1, Number(frameInput.value) || 0));
    const dancerIndex = Number(dancerInput.value) || 0;
    const c = new THREE.Color(dancerIndex === 0 ? "#c94e3d" : "#3d6fc9");
    const variants = buildVariants([c.r, c.g, c.b]);

    const dpr = renderer.getPixelRatio();
    const totalWidth = app.clientWidth;
    const height = app.clientHeight;
    const stripWidth = Math.floor(totalWidth / variants.length);

    renderer.setSize(totalWidth, height, false);
    camera.aspect = stripWidth / height;
    camera.updateProjectionMatrix();
    const rtWidth = Math.round(stripWidth * dpr);
    const rtHeight = Math.round(height * dpr);
    heightPass.setSize(rtWidth, rtHeight);
    shadingPass.setResolution(rtWidth, rtHeight);
    renderer.setScissorTest(true);

    variants.forEach((variant, i) => {
      const marks = generateChainMarks(cache, chains, dancerIndex, frame, variant.style, viewForward);
      strokeMesh.setStrokes(marks);

      heightPass.render(renderer, strokeMesh.colorMesh, strokeMesh.heightMesh, camera);
      shadingPass.setReliefStrength(22);

      const x = i * stripWidth;
      renderer.setViewport(x, 0, stripWidth, height);
      renderer.setScissor(x, 0, stripWidth, height);
      shadingPass.render(renderer, heightPass.colorSumTexture, heightPass.heightSumTexture);

      const labelEl = labelEls[i];
      if (labelEl) {
        labelEl.textContent = variant.label;
        labelEl.style.left = `${x}px`;
        labelEl.style.width = `${stripWidth}px`;
      }
    });

    renderer.setScissorTest(false);
  }

  frameInput.addEventListener("input", render);
  dancerInput.addEventListener("input", render);
  window.addEventListener("resize", render);

  render();
}

main().catch((err) => {
  console.error(err);
  const app = document.getElementById("app");
  if (app) app.textContent = `Failed to start: ${(err as Error).message}`;
});
