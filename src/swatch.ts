import * as THREE from "three";
import { createScene } from "./shell/canvas";
import { attachCameraControls } from "./shell/camera-controls";
import { createParamsPanel, loadParamsFromHash, saveParamsToHash, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import { generateSpeckles, type Stroke, type SpeckleStyle } from "./pose/strokes";
import type { Emitter } from "./pose/emitters";
import { createStrokeMesh } from "./paint/stroke-mesh";
import { createHeightPass } from "./paint/height-pass";
import { createShadingPass } from "./paint/shading-pass";

// A stripped-down canvas: a handful of large, isolated strokes, no dancers, no pose data, no
// scrubbing. See docs/roadmap.md "under consideration" — built because iterating on brush/
// paint appearance against the full dance scene was too indirect to judge quality changes.
const SWATCH_HOME_DISTANCE = 26;
const SWATCH_HOME_POSITION = new THREE.Vector3(0, 2, SWATCH_HOME_DISTANCE);
const SWATCH_HOME_TARGET = new THREE.Vector3(0, 0, 0);

interface SwatchSpec {
  col: number;
  row: number;
  angleDeg: number;
  length: number;
  width: number;
  volume: number;
  colorKey: "A" | "B";
  speckles?: boolean;
}

const SWATCHES: SwatchSpec[] = [
  { col: -1, row: 1, angleDeg: 10, length: 10, width: 1.6, volume: 0.9, colorKey: "A" },
  { col: 0, row: 1, angleDeg: 55, length: 8, width: 1.0, volume: 0.6, colorKey: "B" },
  { col: 1, row: 1, angleDeg: 95, length: 12, width: 2.2, volume: 1.3, colorKey: "A" },
  { col: -1, row: -1, angleDeg: 140, length: 9, width: 1.3, volume: 0.7, colorKey: "B" },
  { col: 0, row: -1, angleDeg: 200, length: 14, width: 2.6, volume: 1.6, colorKey: "A", speckles: true },
  { col: 1, row: -1, angleDeg: 250, length: 7, width: 0.8, volume: 0.4, colorKey: "B", speckles: true },
];

const COL_SPACING = 8;
const ROW_SPACING = 7;

function buildSwatchStrokes(params: ToyParams): Stroke[] {
  const colorA = new THREE.Color(params.colorA);
  const colorB = new THREE.Color(params.colorB);
  const strokes: Stroke[] = [];

  SWATCHES.forEach((spec, i) => {
    const c = spec.colorKey === "A" ? colorA : colorB;
    const rad = (spec.angleDeg * Math.PI) / 180;
    const speed = 0.4; // above generateSpeckles' default speedThreshold, so speckle swatches actually throw some
    const velocity: [number, number, number] = [Math.cos(rad) * speed, Math.sin(rad) * speed, 0];
    const position: [number, number, number] = [spec.col * COL_SPACING, spec.row * ROW_SPACING, 0];

    strokes.push({
      position,
      velocity,
      length: spec.length,
      width: spec.width,
      volume: spec.volume,
      color: [c.r, c.g, c.b],
      seed: i * 0.6180339887,
      chainOffset: 0,
      capStart: true,
      capEnd: true,
    });

    if (spec.speckles) {
      const emitter: Emitter = { position, velocity, thickness: 1, t: 0.5 };
      const speckleStyle: SpeckleStyle = {
        color: [c.r, c.g, c.b],
        speedThreshold: 0.15,
        maxCount: 10 * params.speckleAmount,
        spread: 3.5,
        sizeScale: 0.4,
      };
      strokes.push(...generateSpeckles([emitter], 0, speckleStyle));
    }
  });

  return strokes;
}

async function main() {
  const app = document.getElementById("app");
  if (!app) throw new Error("missing #app container");

  const { renderer, camera, domElement } = createScene(app);
  const params: ToyParams = loadParamsFromHash();
  // defaultParams.cameraDistance/target are tuned for the dance scene (main.ts) — on a fresh
  // load with no saved state, use this canvas's own home framing instead.
  if (!window.location.hash) {
    params.cameraDistance = SWATCH_HOME_DISTANCE;
    params.targetX = SWATCH_HOME_TARGET.x;
    params.targetY = SWATCH_HOME_TARGET.y;
    params.targetZ = SWATCH_HOME_TARGET.z;
  }
  const pane = createParamsPanel(app, params);

  const strokeMesh = createStrokeMesh(200);
  const heightPass = createHeightPass(domElement.width, domElement.height);
  const shadingPass = createShadingPass();

  const cameraTarget = new THREE.Vector3(params.targetX, params.targetY, params.targetZ);
  const cameraDirection = SWATCH_HOME_POSITION.clone().sub(SWATCH_HOME_TARGET).normalize();
  const controls = attachCameraControls({
    camera,
    domElement,
    direction: cameraDirection,
    target: cameraTarget,
    distance: params.cameraDistance,
    minDistance: 4,
    onChange: () => syncCameraParamsAndRerender(),
  });

  function renderFrame() {
    strokeMesh.setStrokes(buildSwatchStrokes(params));
    heightPass.render(renderer, strokeMesh.colorMesh, strokeMesh.heightMesh, camera);
    shadingPass.setReliefStrength(params.reliefStrength);
    shadingPass.render(renderer, heightPass.colorSumTexture, heightPass.heightSumTexture);
  }

  function syncCameraParamsAndRerender() {
    params.cameraDistance = controls.distance;
    params.targetX = cameraTarget.x;
    params.targetY = cameraTarget.y;
    params.targetZ = cameraTarget.z;
    pane.refresh();
    saveParamsToHash(params);
    renderFrame();
  }

  pane.addButton({ title: "reset view" }).on("click", () => {
    cameraTarget.copy(SWATCH_HOME_TARGET);
    controls.setDistance(SWATCH_HOME_DISTANCE);
    syncCameraParamsAndRerender();
  });

  pane.on("change", () => {
    controls.setDistance(params.cameraDistance);
    renderFrame();
  });

  function resize() {
    heightPass.setSize(domElement.width, domElement.height);
    shadingPass.setResolution(domElement.width, domElement.height);
    renderFrame();
  }
  window.addEventListener("resize", resize);
  resize();

  window.addEventListener("keydown", (e) => {
    if (e.key === "s") capturePNG(domElement, "brush-swatches.png");
  });
}

main().catch((err) => {
  console.error(err);
  const app = document.getElementById("app");
  if (app) app.textContent = `Failed to start: ${(err as Error).message}`;
});
