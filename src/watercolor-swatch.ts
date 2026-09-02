import * as THREE from "three";
import { createScene } from "./shell/canvas";
import { attachCameraControls } from "./shell/camera-controls";
import { createParamsPanel, loadParamsFromHash, saveParamsToHash, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import type { Stroke } from "./pose/strokes";
import { createStrokeMesh } from "./paint/stroke-mesh";
import { createHeightPass } from "./paint/height-pass";
import { createWatercolorShadingPass } from "./paint/shading-pass-watercolor";

// Standalone look-test for docs/work/watercolor-aging.md's "recommended first prototype" —
// same reuse pattern as swatch.ts (shell, stroke-mesh, height-pass), but with
// shading-pass-watercolor.ts's variant carrying the watercolor treatment. That shader splits
// the screen into four fixed vertical bands (simulated age 0 -> 1, oil -> full watercolor) via
// screen-space UV, so this page's job is just to lay out the SAME three stroke groups once per
// band, at world positions that land inside that band's quarter of the frame. See that shader's
// own comments for why bands are screen-space rather than a single live mix value.
const SWATCH_HOME_DISTANCE = 46;
const SWATCH_HOME_POSITION = new THREE.Vector3(0, 0, SWATCH_HOME_DISTANCE);
const SWATCH_HOME_TARGET = new THREE.Vector3(0, 0, 0);
const BAND_COUNT = 4;
const BAND_LABELS = ["oil (0%)", "33%", "66%", "watercolor (100%)"];

function buildWatercolorStrokes(colorA: THREE.Color, colorB: THREE.Color, camera: THREE.PerspectiveCamera, distance: number): Stroke[] {
  const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const halfWidth = halfHeight * camera.aspect;
  const strokes: Stroke[] = [];
  let seedCounter = 0;

  function push(position: [number, number, number], angleDeg: number, length: number, width: number, volume: number, color: THREE.Color) {
    const rad = (angleDeg * Math.PI) / 180;
    strokes.push({
      position,
      velocity: [Math.cos(rad) * 0.4, Math.sin(rad) * 0.4, 0],
      length,
      width,
      volume,
      color: [color.r, color.g, color.b],
      seed: (seedCounter++) * 0.6180339887,
    });
  }

  for (let band = 0; band < BAND_COUNT; band++) {
    // Center of this band's quarter of the screen, converted to world X at this camera
    // distance/fov/aspect — matches shading-pass-watercolor.ts's own band split exactly (both
    // divide vUv.x into BAND_COUNT equal quarters), so each cell's strokes land inside the
    // simulated-age band its row/column position implies.
    const bandCenterFrac = (band + 0.5) / BAND_COUNT;
    const cx = halfWidth * (2 * bandCenterFrac - 1);

    // Row 1: one isolated stroke — the baseline case for edge/relief/desaturation alone.
    push([cx, halfHeight * 0.55, 0], 35, 9, 1.4, 0.9, colorA);

    // Row 2: an overlapping pair in two different colors — the case edge darkening/backrun
    // is actually about (what happens where coverage transitions or two washes meet).
    push([cx - 1.6, 0, 0], 10, 8, 1.5, 0.8, colorA);
    push([cx + 1.6, 0, 0.3], 170, 8, 1.5, 0.8, colorB);

    // Row 3: a broad, low-relief wash pair (wide, short, low volume) — closer to what
    // aged/flattened paint should look like than a full brush stroke, per the doc's own note
    // that a single isolated stroke doesn't show the wash case.
    push([cx - 2, -halfHeight * 0.55, 0], 15, 7, 5.5, 0.22, colorA);
    push([cx + 2.2, -halfHeight * 0.55, 0.2], 165, 7, 5.5, 0.22, colorB);
  }

  return strokes;
}

function buildBandLabels(container: HTMLElement) {
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;top:0;left:0;right:0;display:flex;z-index:5;pointer-events:none;";
  for (const label of BAND_LABELS) {
    const cell = document.createElement("div");
    cell.textContent = label;
    cell.style.cssText =
      "flex:1;text-align:center;padding:8px 0;font:12px system-ui,sans-serif;color:#eee;" +
      "text-shadow:0 1px 3px rgba(0,0,0,0.8);";
    bar.appendChild(cell);
  }
  container.appendChild(bar);
}

async function main() {
  const app = document.getElementById("app");
  if (!app) throw new Error("missing #app container");

  const { renderer, camera, domElement } = createScene(app);
  const params: ToyParams = loadParamsFromHash();
  if (!window.location.hash) {
    params.cameraDistance = SWATCH_HOME_DISTANCE;
    params.targetX = SWATCH_HOME_TARGET.x;
    params.targetY = SWATCH_HOME_TARGET.y;
    params.targetZ = SWATCH_HOME_TARGET.z;
  }
  const pane = createParamsPanel(app, params);
  buildBandLabels(app);

  // Standalone-only weights, not part of ToyParams (this page is the only consumer) — same
  // pattern shell/params.ts used for the palette-preset state before its own rework.
  const wcState = { edgeDarken: 0.6, reliefReduction: 0.7, desaturation: 0.6 };
  pane.addBinding(wcState, "edgeDarken", { min: 0, max: 1, step: 0.05, label: "edge darken" });
  pane.addBinding(wcState, "reliefReduction", { min: 0, max: 1, step: 0.05, label: "relief reduction" });
  pane.addBinding(wcState, "desaturation", { min: 0, max: 1, step: 0.05, label: "desaturation" });

  const strokeMesh = createStrokeMesh(200);
  const heightPass = createHeightPass(domElement.width, domElement.height);
  const shadingPass = createWatercolorShadingPass();

  const cameraTarget = new THREE.Vector3(params.targetX, params.targetY, params.targetZ);
  const cameraDirection = SWATCH_HOME_POSITION.clone().sub(SWATCH_HOME_TARGET).normalize();
  const controls = attachCameraControls({
    camera,
    domElement,
    direction: cameraDirection,
    target: cameraTarget,
    distance: params.cameraDistance,
    minDistance: 10,
    onChange: () => syncCameraParamsAndRerender(),
  });

  function renderFrame() {
    const colorA = new THREE.Color(params.colorA);
    const colorB = new THREE.Color(params.colorB);
    strokeMesh.setStrokes(buildWatercolorStrokes(colorA, colorB, camera, controls.distance));
    heightPass.render(renderer, strokeMesh.colorMesh, strokeMesh.heightMesh, camera);
    shadingPass.setReliefStrength(params.reliefStrength);
    shadingPass.setEdgeDarken(wcState.edgeDarken);
    shadingPass.setReliefReduction(wcState.reliefReduction);
    shadingPass.setDesaturation(wcState.desaturation);
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
    if (e.key === "s") capturePNG(domElement, "watercolor-swatches.png");
  });
}

main().catch((err) => {
  console.error(err);
  const app = document.getElementById("app");
  if (app) app.textContent = `Failed to start: ${(err as Error).message}`;
});
