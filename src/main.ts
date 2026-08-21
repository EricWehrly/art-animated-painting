import * as THREE from "three";
import { createScene } from "./shell/canvas";
import { createTimeline } from "./shell/timeline";
import { createParamsPanel, loadParamsFromHash, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import { loadPoseCache } from "./pose/pose-cache";
import { boneSegments } from "./pose/skeleton";
import { generateEmitters } from "./pose/emitters";

async function main() {
  const app = document.getElementById("app");
  if (!app) throw new Error("missing #app container");

  const { renderer, scene, camera, domElement } = createScene(app);
  const timeline = createTimeline(app);
  const params: ToyParams = loadParamsFromHash();
  createParamsPanel(app, params);

  const cache = await loadPoseCache("/data");
  const bones = boneSegments(cache.header.joints);
  const frameCount = cache.header.frameCount;
  timeline.setFrameCount(frameCount);

  // P1 scaffolding: flat colored points per dancer, standing in for real strokes
  // until impasto-shading (P2) and paint-accumulator (P3) land. See docs/work/pose-pipeline.md.
  const samplesPerBone = 4;
  const pointsPerDancer = bones.length * samplesPerBone;

  const dancerColors = [params.colorA, params.colorB];
  const dancerMeshes = cache.header.dancers.map((_, dancerIndex) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pointsPerDancer * 3), 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(dancerColors[dancerIndex]),
      size: params.pointSize,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    return points;
  });

  function renderFrame(frame: number) {
    for (let dancerIndex = 0; dancerIndex < cache.header.dancers.length; dancerIndex++) {
      const emitters = generateEmitters(cache, bones, dancerIndex, frame, samplesPerBone);
      const posAttr = dancerMeshes[dancerIndex].geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < emitters.length; i++) {
        const [x, y, z] = emitters[i].position;
        posAttr.setXYZ(i, x, y, z);
      }
      posAttr.needsUpdate = true;
      (dancerMeshes[dancerIndex].material as THREE.PointsMaterial).size = params.pointSize;
    }
    renderer.render(scene, camera);
  }

  let currentFrame = 0;
  timeline.onSeek((frame) => {
    currentFrame = frame;
    params.playing = false;
    renderFrame(currentFrame);
  });

  renderFrame(currentFrame);

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
