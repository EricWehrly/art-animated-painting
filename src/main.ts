import * as THREE from "three";
import { createScene, CAMERA_HOME_POSITION, CAMERA_HOME_TARGET } from "./shell/canvas";
import { attachCameraControls } from "./shell/camera-controls";
import { createTimeline } from "./shell/timeline";
import { createParamsPanel, loadParamsFromHash, saveParamsToHash, defaultParams, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import { loadPoseCache } from "./pose/pose-cache";
import { boneSegments } from "./pose/skeleton";
import { generateEmitters } from "./pose/emitters";
import { generateStrokes, generateSpeckles, type Stroke, type StrokeStyle, type SpeckleStyle } from "./pose/strokes";
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
  const bones = boneSegments(cache.header.joints);
  const frameCount = cache.header.frameCount;
  timeline.setFrameCount(frameCount);

  const samplesPerBone = 6;
  const speckleMaxCount = 6;
  const mainStrokesTotal = bones.length * samplesPerBone * cache.header.dancers.length;
  // Generous headroom for speckles on top of the main strokes — setStrokes() silently caps
  // at this budget, so this only needs to comfortably cover the worst case, not be exact.
  const maxStrokes = mainStrokesTotal * (1 + speckleMaxCount * 2);

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

  function strokeStyleFor(dancerIndex: number): StrokeStyle {
    const hex = dancerIndex === 0 ? params.colorA : params.colorB;
    const c = new THREE.Color(hex);
    return {
      color: [c.r, c.g, c.b],
      lengthScale: 0.9 * params.strokeLengthScale,
      minLength: 1.0,
      maxLength: 9,
      widthScale: 0.8 * params.strokeWidthScale,
      volumeScale: 0.35,
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
      const emitters = generateEmitters(cache, bones, dancerIndex, frame, samplesPerBone);
      allStrokes.push(...generateStrokes(emitters, strokeStyleFor(dancerIndex)));
      if (params.speckleAmount > 0) {
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
