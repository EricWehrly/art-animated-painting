import * as THREE from "three";
import { createScene } from "./shell/canvas";
import { createTimeline } from "./shell/timeline";
import { createParamsPanel, loadParamsFromHash, type ToyParams } from "./shell/params";
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

  // "Zoom" dollies the fixed camera along its original viewing ray rather than changing its
  // angle — a static framing choice made once (or while paused, exploring), not an animated
  // orbit, so it doesn't conflict with the "fixed camera" decision in docs/roadmap.md.
  const lookAtTarget = new THREE.Vector3(0, 15, 0);
  const cameraDir = camera.position.clone().sub(lookAtTarget).normalize();
  function applyCameraDistance() {
    camera.position.copy(lookAtTarget).addScaledVector(cameraDir, params.cameraDistance);
    camera.lookAt(lookAtTarget);
  }

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
    applyCameraDistance();

    const allStrokes: Stroke[] = [];
    for (let dancerIndex = 0; dancerIndex < cache.header.dancers.length; dancerIndex++) {
      const emitters = generateEmitters(cache, bones, dancerIndex, frame, samplesPerBone);
      allStrokes.push(...generateStrokes(emitters, strokeStyleFor(dancerIndex)));
      if (params.speckleAmount > 0) {
        allStrokes.push(...generateSpeckles(emitters, frame, speckleStyleFor(dancerIndex)));
      }
    }
    strokeMesh.setStrokes(allStrokes);

    heightPass.render(renderer, strokeMesh.mesh, camera);
    shadingPass.setReliefStrength(params.reliefStrength);
    shadingPass.render(renderer, heightPass.colorSumTexture, heightPass.heightSumTexture);
  }

  let currentFrame = 0;

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

  // Live-tweaking params (zoom, relief, colors, ...) needs its own re-render: renderFrame
  // only otherwise runs on scrub/resize/playback ticks, so a paused param change would
  // silently do nothing until the next one of those.
  pane.on("change", () => renderFrame(currentFrame));

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
