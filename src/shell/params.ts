import { Pane } from "tweakpane";

export interface ToyParams {
  colorA: string;
  colorB: string;
  playing: boolean;
  layersPerSecond: number;
  /** Normal-map scale over the height field — the primary "more crusty" dial. See docs/work/impasto-shading.md. */
  reliefStrength: number;
  strokeWidthScale: number;
  strokeLengthScale: number;
  /** World-space distance from the fixed camera to its look-at target. Primarily driven by
   * mouse wheel (see shell/camera-controls.ts) — this slider mirrors that live value rather
   * than being the primary way to set it. A viewfinder control, not an animated orbit, so it
   * doesn't conflict with the "fixed camera" (angle) decision in docs/roadmap.md. */
  cameraDistance: number;
  /** Look-at target, panned by mouse drag. Defaults to shell/canvas.ts's CAMERA_HOME_TARGET. */
  targetX: number;
  targetY: number;
  targetZ: number;
  /** 0 disables the flung-droplet speckles entirely; scales speckle count. */
  speckleAmount: number;
  /** 0 = every stroke on a bone uses identical width/volume; 1 = strokes range roughly
   * 0.5x-1.5x pressure, so paint reads as unevenly applied. See pose/strokes.ts. */
  pressureVariance: number;
  /** true (default) = strokes are bent/pushed by each bone's own motion, per
   * generateBoneStrokes ("manufactured duress"). false = pure calm "connect the dots"
   * coverage — bone-aligned only, one shared color, no speckles — for calibrating the base
   * figure (recognizable torso/head/arms/legs) independent of any motion effect. See
   * docs/work/pose-pipeline.md. */
  duress: boolean;
  /** Overlays the generator's own working data on top of the painted result: the raw bone
   * chain outline (the shape strokes are meant to cover), every individual intended stroke,
   * and arrows for each dab's raw sampled velocity (direction + relative strength). See
   * debug/overlay.ts. */
  debugMode: boolean;
  /** -1 = both dancers (default). 0/1 = render only that dancer — removes the other from the
   * canvas entirely so a single body can be read without the two figures overlapping. */
  soloDancer: -1 | 0 | 1;
}

export const defaultParams: ToyParams = {
  colorA: "#c94e3d",
  colorB: "#3d6fc9",
  playing: false,
  layersPerSecond: 24,
  reliefStrength: 22,
  strokeWidthScale: 1,
  strokeLengthScale: 1,
  // Zoomed in from 55 (Round 19) — the couple can dance partly in and out of frame at this
  // distance, which reads better than always fitting both fully in view.
  cameraDistance: 30,
  targetX: 0,
  targetY: 15,
  targetZ: 0,
  speckleAmount: 0.6,
  pressureVariance: 0.5,
  duress: true,
  debugMode: false,
  soloDancer: -1,
};

/** Reads params from the URL hash (if present), falling back to defaults. */
export function loadParamsFromHash(): ToyParams {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return { ...defaultParams };
  try {
    const parsed = JSON.parse(decodeURIComponent(hash));
    return { ...defaultParams, ...parsed };
  } catch {
    return { ...defaultParams };
  }
}

/** Exported so callers driving params outside a Tweakpane binding (e.g. mouse pan/zoom in
 * camera-controls.ts) can still persist state to the URL hash the same way. */
export function saveParamsToHash(params: ToyParams) {
  window.location.hash = encodeURIComponent(JSON.stringify(params));
}

/** Named colorA/colorB pairings offered by the "palette preset" dropdown below. UI-only
 * convenience list — not part of ToyParams, doesn't round-trip through the URL hash on its
 * own (picking one just assigns into params.colorA/colorB, which already round-trip). Future
 * work (an independent per-swatch color picker, saving custom presets, auto-loading saved
 * presets on load, a gradient-strip picker UI) would extend from this list. */
const PALETTE_PRESETS: { label: string; colorA: string; colorB: string }[] = [
  { label: "cornflower & heather", colorA: "#6495ED", colorB: "#D6B85A" },
  { label: "cyan & magenta", colorA: "#22C7D9", colorB: "#D633A6" },
  { label: "blue & gold (dark)", colorA: "#1B3A63", colorB: "#C9971C" },
];

export function createParamsPanel(container: HTMLElement, params: ToyParams): Pane {
  // Tweakpane only self-positions (fixed, top-right) when it creates its OWN floating
  // container. Handed an explicit `container`, it renders inline in normal document flow —
  // and since the canvas ahead of it is a display:block 100%-height element, the panel got
  // laid out entirely below the fold and was invisible. Give it its own fixed-position host,
  // the same way shell/timeline.ts does.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:10px;right:10px;width:280px;z-index:10;";
  container.appendChild(host);

  const pane = new Pane({ container: host, title: "params" });

  pane.addBinding(params, "playing");
  pane.addBinding(params, "layersPerSecond", { min: 1, max: 60, step: 1 });
  pane.addBinding(params, "colorA");
  pane.addBinding(params, "colorB");

  // Not a ToyParams field: picking a preset just writes the two hex values into
  // params.colorA/colorB below, the same as manually editing those color swatches would, so
  // it rides the existing colorA/colorB hash round-trip and the panel-level "change" listener
  // in main.ts that triggers the re-render — no separate wiring needed.
  const presetState = { preset: -1 };
  const presetOptions: Record<string, number> = { "— pick a preset —": -1 };
  PALETTE_PRESETS.forEach((preset, index) => {
    presetOptions[preset.label] = index;
  });
  const presetBinding = pane.addBinding(presetState, "preset", {
    label: "palette preset",
    options: presetOptions,
  });
  presetBinding.on("change", (ev) => {
    const preset = PALETTE_PRESETS[ev.value];
    if (!preset) return;
    params.colorA = preset.colorA;
    params.colorB = preset.colorB;
    pane.refresh();
  });

  pane.addBinding(params, "reliefStrength", { min: 0, max: 60, step: 0.5 });
  pane.addBinding(params, "strokeWidthScale", { min: 0.2, max: 3, step: 0.05 });
  pane.addBinding(params, "strokeLengthScale", { min: 0.2, max: 3, step: 0.05 });
  pane.addBinding(params, "cameraDistance", { min: 8, max: 150, step: 1, label: "zoom (distance)" });
  pane.addBinding(params, "speckleAmount", { min: 0, max: 2, step: 0.05 });
  pane.addBinding(params, "pressureVariance", { min: 0, max: 1, step: 0.05 });
  pane.addBinding(params, "duress", { label: "duress (motion pressure)" });
  pane.addBinding(params, "debugMode", { label: "debug overlay" });
  pane.addBinding(params, "soloDancer", {
    label: "solo dancer",
    options: { both: -1, "dancer 1": 0, "dancer 2": 1 },
  });

  pane.on("change", () => saveParamsToHash(params));

  return pane;
}
