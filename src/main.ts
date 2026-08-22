import * as THREE from "three";
import { createScene, CAMERA_HOME_POSITION, CAMERA_HOME_TARGET } from "./shell/canvas";
import { attachCameraControls } from "./shell/camera-controls";
import { createTimeline } from "./shell/timeline";
import { createParamsPanel, loadParamsFromHash, saveParamsToHash, defaultParams, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import { loadPoseCache } from "./pose/pose-cache";
import { boneSegments, buildChains } from "./pose/skeleton";
import { generateEmitters } from "./pose/emitters";
import { generateChainStrokes, generateSpeckles, type Stroke, type BoneStrokeStyle, type SpeckleStyle } from "./pose/strokes";
import { createStrokeMesh } from "./paint/stroke-mesh";
import { createHeightPass } from "./paint/height-pass";
import { createShadingPass } from "./paint/shading-pass";

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
  // Main strokes walk whole CHAINS (a whole limb, e.g. hip-to-toe or shoulder-to-wrist) as one
  // continuous traveling brush — see generateChainStrokes in pose/strokes.ts and buildChains
  // in pose/skeleton.ts. `bones` (the old per-bone list) is kept only for speckle placement,
  // which still wants independent per-bone velocity sampling, not chain-level coverage.
  const bones = boneSegments(cache.header.joints);
  const chains = buildChains(cache.header.joints);
  const frameCount = cache.header.frameCount;
  timeline.setFrameCount(frameCount);

  // A long chain (leg: hip to toe, ~19 world units) at minimum paint load could in principle
  // need ~20 dabs at the style values below; this is generous headroom above that, not a hard
  // limit the walk itself respects (that's MAX_DABS_PER_CHAIN_SAFETY inside
  // generateChainStrokes). Speckles still sample several fixed points per bone since they
  // want the velocity spread along a rotating limb, not coverage.
  const maxDabsPerChainBudget = 30;
  const speckleSamplesPerBone = 3;
  const speckleMaxCount = 6;
  const mainStrokesTotal = chains.length * maxDabsPerChainBudget * cache.header.dancers.length;
  const speckleEmittersTotal = bones.length * speckleSamplesPerBone * cache.header.dancers.length;
  // Generous headroom for speckles on top of the main strokes — setStrokes() silently caps
  // at this budget, so this only needs to comfortably cover the worst case, not be exact.
  const maxStrokes = mainStrokesTotal + speckleEmittersTotal * speckleMaxCount * 2;

  const strokeMesh = createStrokeMesh(maxStrokes);
  const heightPass = createHeightPass(domElement.width, domElement.height);
  const shadingPass = createShadingPass();

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
    // motion-driven effect zeroed — pure bone-aligned "connect the dots" coverage, for
    // calibrating the base figure (recognizable torso/head/arms/legs) independent of how
    // motion later bends it. See docs/work/pose-pipeline.md Round 5.
    const hex = params.duress ? (dancerIndex === 0 ? params.colorA : params.colorB) : params.colorA;
    const c = new THREE.Color(hex);
    return {
      color: [c.r, c.g, c.b],
      widthScale: 1.2 * params.strokeWidthScale,
      lengthScale: params.strokeLengthScale,
      volumeScale: 0.35,
      pressureVariance: params.pressureVariance,
      // A dab can carry at most 3.2 world units of paint before it needs "reloading" — that
      // cap is what forces the longest bones (thighs/shins, ~7.3 units in the CMU data) to be
      // covered by several dabs (~3-4) rather than one long stroke, while short bones
      // (hands, feet, fingers) still get just one.
      maxStrokeLength: 3.2,
      minStrokeLength: 1.0,
      // Calibrated so a "fast" limb (across-bone speed ~0.45, roughly the speckle-fling
      // threshold's neighborhood) sits near the maxWaverBlend cap rather than far under it.
      // maxWaverBlend MUST stay below 0.5 (see the doc comment on BoneStrokeStyle) or the
      // brush's target-seeking loses its guaranteed majority and can run away instead of
      // converging — 0.4 keeps a comfortable margin.
      waverScale: params.duress ? 1.2 : 0,
      maxWaverBlend: params.duress ? 0.4 : 0,
      smearScale: params.duress ? 1.5 : 0,
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
    for (let dancerIndex = 0; dancerIndex < cache.header.dancers.length; dancerIndex++) {
      allStrokes.push(...generateChainStrokes(cache, chains, dancerIndex, frame, strokeStyleFor(dancerIndex)));
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
