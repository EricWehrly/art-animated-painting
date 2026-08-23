import * as THREE from "three";
import { createScene, CAMERA_HOME_POSITION, CAMERA_HOME_TARGET } from "./shell/canvas";
import { attachCameraControls } from "./shell/camera-controls";
import { createTimeline } from "./shell/timeline";
import { createParamsPanel, loadParamsFromHash, saveParamsToHash, defaultParams, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import { loadPoseCache } from "./pose/pose-cache";
import { boneSegments, buildChains } from "./pose/skeleton";
import { generateEmitters } from "./pose/emitters";
import {
  generateChainMarks,
  generateSpeckles,
  type Stroke,
  type BoneStrokeStyle,
  type SpeckleStyle,
  type ChainDebugDab,
} from "./pose/strokes";
import { createStrokeMesh } from "./paint/stroke-mesh";
import { createHeightPass } from "./paint/height-pass";
import { createShadingPass } from "./paint/shading-pass";
import { createDebugOverlay, type DebugDancerData } from "./debug/overlay";

async function main() {
  const app = document.getElementById("app");
  if (!app) throw new Error("missing #app container");

  // The `scene` createScene() sets up goes unused here: strokes render into an offscreen
  // pass scene owned by height-pass.ts, and shading-pass.ts renders straight to screen with
  // its own full-screen-quad scene. createScene still gives us the renderer/camera/canvas.
  const { renderer, camera, domElement } = createScene(app);

  const timeline = createTimeline(app);
  const params: ToyParams = loadParamsFromHash();
  const pane = createParamsPanel(app, params);

  const cache = await loadPoseCache("/data");
  // Main figure strokes cover whole CHAINS (a whole limb, e.g. hip-to-toe or shoulder-to-wrist)
  // with many independent brush marks tiled along and across the chain's own shape — see
  // generateChainMarks in pose/strokes.ts and buildChains in pose/skeleton.ts.
  // `bones` (the old per-bone list) is kept only for speckle placement, which still wants
  // independent per-bone velocity sampling, not chain-level coverage.
  const bones = boneSegments(cache.header.joints);
  const chains = buildChains(cache.header.joints);
  const frameCount = cache.header.frameCount;
  timeline.setFrameCount(frameCount);

  const speckleSamplesPerBone = 3;
  const speckleMaxCount = 6;
  const speckleEmittersTotal = bones.length * speckleSamplesPerBone * cache.header.dancers.length;
  // Generous headroom, not an exact count — see generateChainMarks' own doc comment for why
  // its per-chain mark count isn't a simple closed form (it depends on each bone's own length
  // and width relative to the tuned style's markLength/markWidth). setStrokes() silently caps
  // at this budget.
  const maxMarksPerChainEstimate = 90;
  const mainMarksTotal = chains.length * maxMarksPerChainEstimate * cache.header.dancers.length;
  const maxStrokes = mainMarksTotal + speckleEmittersTotal * speckleMaxCount * 2;

  const strokeMesh = createStrokeMesh(maxStrokes);
  // The camera's viewing angle is a fixed, build-time constant (see shell/canvas.ts) —
  // generateChainMarks uses that to derive each mark's across-limb (lane) axis on the CPU.
  const viewForwardVec = CAMERA_HOME_TARGET.clone().sub(CAMERA_HOME_POSITION).normalize();
  const viewForward: [number, number, number] = [viewForwardVec.x, viewForwardVec.y, viewForwardVec.z];
  const heightPass = createHeightPass(domElement.width, domElement.height);
  const shadingPass = createShadingPass();
  const debugOverlay = createDebugOverlay();

  let currentFrame = 0;

  // Mouse wheel = zoom, centered on the current look-at target (the point in the middle of
  // the view stays put as you zoom — that's what makes it "center zoom" rather than
  // cursor-anchored zoom). Left-drag = pan. The viewing ANGLE never changes — see
  // shell/canvas.ts — so this is a viewfinder control, not the animated camera the "fixed
  // camera" roadmap decision is about.
  const cameraTarget = new THREE.Vector3(params.targetX, params.targetY, params.targetZ);
  const cameraDirection = CAMERA_HOME_POSITION.clone().sub(CAMERA_HOME_TARGET).normalize();
  const controls = attachCameraControls({
    camera,
    domElement,
    direction: cameraDirection,
    target: cameraTarget,
    distance: params.cameraDistance,
    onChange: () => syncCameraParamsAndRerender(),
  });

  function syncCameraParamsAndRerender() {
    params.cameraDistance = controls.distance;
    params.targetX = cameraTarget.x;
    params.targetY = cameraTarget.y;
    params.targetZ = cameraTarget.z;
    pane.refresh();
    saveParamsToHash(params);
    renderFrame(currentFrame);
  }

  pane.addButton({ title: "reset view" }).on("click", () => {
    cameraTarget.copy(CAMERA_HOME_TARGET);
    controls.setDistance(defaultParams.cameraDistance);
    syncCameraParamsAndRerender();
  });

  function strokeStyleFor(dancerIndex: number): BoneStrokeStyle {
    // Calm mode ("duress" off): a single shared color for both dancers, and every
    // motion-driven effect zeroed — pure bone-aligned coverage (still with the always-on
    // angleJitter/lane structure that makes it read as painted, not a wire), for calibrating
    // the base figure independent of how motion later bends it. See docs/work/pose-pipeline.md
    // Round 5, Round 13.
    const hex = params.duress ? (dancerIndex === 0 ? params.colorA : params.colorB) : params.colorA;
    const c = new THREE.Color(hex);
    return {
      color: [c.r, c.g, c.b],
      widthScale: 1.7 * params.strokeWidthScale,
      lengthScale: params.strokeLengthScale,
      volumeScale: 0.35,
      pressureVariance: params.pressureVariance,
      // Elongated relative to markWidth — a mark needs a real length-to-width ratio to read as
      // a brush gesture; close to 1:1 reads as a stamped coin/ring instead (see
      // docs/work/pose-pipeline.md Round 13's first attempt).
      markLength: 2.3,
      minMarkLength: 0.5,
      maxMarkLength: 4.5,
      // How much successive along-arc marks overlap — generous enough that any given point is
      // usually covered by several marks' bodies, not just one mark's fading tip, which is
      // what keeps a dab's own end-cap taper from reading as a visible groove at its boundary.
      overlapAlong: 0.55,
      // A single lane's target width — how many parallel passes a limb's local width needs
      // (round(localWidth / markWidth)) is what makes a hip read as several strokes wide and
      // a forearm as one, instead of every limb being one uniform-width line.
      markWidth: 0.8,
      // Always on, independent of duress — see BoneStrokeStyle's doc comment. ~23 degrees.
      angleJitter: 0.4,
      // Unlike the old seeking-brush's maxWaverBlend, this has no 0.5 stability ceiling (see
      // BoneStrokeStyle doc comment) — these values are an art-direction choice, not a
      // correctness one.
      motionForceScale: params.duress ? 1.0 : 0,
      maxMotionForce: params.duress ? 0.75 : 0,
      smearScale: params.duress ? 1.2 : 0,
    };
  }

  function speckleStyleFor(dancerIndex: number): SpeckleStyle {
    const hex = dancerIndex === 0 ? params.colorA : params.colorB;
    const c = new THREE.Color(hex);
    return {
      color: [c.r, c.g, c.b],
      speedThreshold: 0.15,
      maxCount: speckleMaxCount * params.speckleAmount,
      spread: 2.5,
      sizeScale: 0.35,
    };
  }

  function renderFrame(frame: number) {
    const allStrokes: Stroke[] = [];
    const debugDancers: DebugDancerData[] = [];
    for (let dancerIndex = 0; dancerIndex < cache.header.dancers.length; dancerIndex++) {
      // -1 = both dancers (default). Isolating one dancer removes the other from the canvas
      // entirely, not just visually — the two figures overlapping is exactly what makes a
      // single body hard to read (see the frame-68 case).
      if (params.soloDancer !== -1 && dancerIndex !== params.soloDancer) continue;
      const debugDabs: ChainDebugDab[] | undefined = params.debugMode ? [] : undefined;
      allStrokes.push(...generateChainMarks(cache, chains, dancerIndex, frame, strokeStyleFor(dancerIndex), viewForward, debugDabs));
      if (debugDabs) debugDancers.push({ dancerIndex, debugDabs });
      // Speckles are a fling/spatter effect from motion — meaningless (and distracting from
      // the base figure) in calm calibration mode.
      if (params.duress && params.speckleAmount > 0) {
        const emitters = generateEmitters(cache, bones, dancerIndex, frame, speckleSamplesPerBone);
        allStrokes.push(...generateSpeckles(emitters, frame, speckleStyleFor(dancerIndex)));
      }
    }
    strokeMesh.setStrokes(allStrokes);

    heightPass.render(renderer, strokeMesh.colorMesh, strokeMesh.heightMesh, camera);
    shadingPass.setReliefStrength(params.reliefStrength);
    shadingPass.render(renderer, heightPass.colorSumTexture, heightPass.heightSumTexture);

    // Must run after shadingPass — see debug/overlay.ts's render() doc comment for why.
    if (params.debugMode) {
      debugOverlay.render(renderer, camera, cache, chains, frame, debugDancers, params.duress);
    }
  }

  // Resizing recreates the render targets at the new resolution, which clears their
  // contents — re-render the current frame immediately so the canvas doesn't go blank
  // until the next scrub/playback tick.
  function resize() {
    heightPass.setSize(domElement.width, domElement.height);
    shadingPass.setResolution(domElement.width, domElement.height);
    renderFrame(currentFrame);
  }
  window.addEventListener("resize", resize);
  resize();

  timeline.onSeek((frame) => {
    currentFrame = frame;
    params.playing = false;
    renderFrame(currentFrame);
  });

  // Live-tweaking params (relief, colors, stroke sizing, the cameraDistance slider, ...)
  // needs its own re-render: renderFrame only otherwise runs on scrub/resize/playback ticks,
  // so a paused param change would silently do nothing until the next one of those. Also
  // re-applies cameraDistance to the camera in case that's what changed — mouse wheel/drag
  // go through camera-controls.ts directly and don't fire this (Tweakpane-only) listener.
  pane.on("change", () => {
    controls.setDistance(params.cameraDistance);
    renderFrame(currentFrame);
  });

  // Simple playback loop, independent of the LayerClock (that drives paint accumulation
  // once paint-accumulator lands; this is just scrubbing the pose for now).
  let lastTs = performance.now();
  function tick(nowMs: number) {
    const dtSeconds = (nowMs - lastTs) / 1000;
    lastTs = nowMs;
    if (params.playing) {
      currentFrame = (currentFrame + dtSeconds * cache.header.fps) % frameCount;
      timeline.setFrame(Math.floor(currentFrame));
      renderFrame(Math.floor(currentFrame));
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener("keydown", (e) => {
    if (e.key === "s") capturePNG(domElement);
  });
}

main().catch((err) => {
  console.error(err);
  const app = document.getElementById("app");
  if (app) app.textContent = `Failed to start: ${(err as Error).message}`;
});
