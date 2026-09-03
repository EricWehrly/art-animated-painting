import { Pane } from "tweakpane";
import { AVAILABLE_TRIAL_PAIRS } from "../pose/pose-cache";

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
  /** true (default) = heads are rendered. false = heads are hidden from the canvas, but the
   * crown chain (pose/head.ts's buildHeadCrownChain, see main.ts's renderFrame) still gets
   * built and painted every frame rather than being skipped outright — the toggle only gates
   * what reaches the visible mesh, not whether the head is painted at all, matching the rest
   * of the figure's own compute-vs-display split. */
  showHeads: boolean;
  /** -1 = both dancers (default). 0/1 = render only that dancer — removes the other from the
   * canvas entirely so a single body can be read without the two figures overlapping. */
  soloDancer: -1 | 0 | 1;
  /** Which baked CMU 60/61 salsa trial pair to play — see pose/pose-cache.ts's
   * AVAILABLE_TRIAL_PAIRS and loadPoseCache's `pairId` param. "01" (60_01/61_01) is the pair
   * the toy has always shipped with. Changing this triggers a full page reload (see the
   * `trialPair` binding in createParamsPanel below) rather than a live pose-cache hot-swap —
   * frame count, joint list, and per-chain instance budgets in main.ts are all derived once
   * from the loaded cache at boot, so reloading with the new selection already baked into the
   * URL hash is far lower-risk than trying to re-derive all of that live.  */
  trialPair: string;
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
  showHeads: true,
  soloDancer: -1,
  trialPair: "01",
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

/** Named colorA/colorB pairings offered as swatch tiles below (see the "palette preset" row
 * built in createParamsPanel). UI-only convenience list — not part of ToyParams, doesn't
 * round-trip through the URL hash on its own (picking one just assigns into
 * params.colorA/colorB, which already round-trip). Future work (an independent per-swatch
 * color picker, saving custom presets, auto-loading saved presets on load, a gradient-strip
 * picker UI) would extend from this list. */
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

  // Palette preset swatches: Tweakpane's stock list/options binding only supports plain text
  // option labels — there's no built-in way to render a two-color swatch inside a dropdown
  // option — so this is built as plain DOM (same spirit as shell/timeline.ts's scrub bar)
  // rather than a Tweakpane blade. It gets spliced into the pane's own DOM tree just above the
  // "custom colors" folder below (see the insertBefore call after that folder is created), so
  // visually it still reads as part of the panel, in row order.
  const presetRow = document.createElement("div");
  presetRow.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;" +
    "padding:4px var(--tp-blade-horizontal-padding, 4px);gap:6px;";

  const presetLabel = document.createElement("div");
  presetLabel.textContent = "palette preset";
  presetLabel.style.cssText =
    "color:var(--tp-label-foreground-color, rgba(202,202,215,0.7));font-size:11px;";
  presetRow.appendChild(presetLabel);

  const presetTiles = document.createElement("div");
  presetTiles.style.cssText = "display:flex;gap:4px;";
  for (const preset of PALETTE_PRESETS) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.title = preset.label;
    tile.style.cssText =
      "width:28px;height:18px;padding:0;border-radius:2px;cursor:pointer;" +
      "border:1px solid rgba(255,255,255,0.2);" +
      `background:linear-gradient(135deg, ${preset.colorA} 50%, ${preset.colorB} 50%);`;
    tile.addEventListener("click", () => {
      params.colorA = preset.colorA;
      params.colorB = preset.colorB;
      // Clicking a plain DOM button doesn't fire any Tweakpane event on its own, so the
      // panel-level pane.on("change") listener in main.ts (which re-renders and saves the
      // hash) won't hear about this. pane.refresh() pulls the new colorA/colorB into those
      // bindings' internal Tweakpane values, which fires a change that bubbles up to that
      // same pane.on("change") listener — the exact mechanism the old preset dropdown relied
      // on (it mutated params then called pane.refresh(), nothing more). Call
      // saveParamsToHash directly too, so hash persistence doesn't depend on that bubbling.
      pane.refresh();
      saveParamsToHash(params);
    });
    presetTiles.appendChild(tile);
  }
  presetRow.appendChild(presetTiles);

  // Individual colorA/colorB fine-tuning now lives behind a native collapsible folder —
  // Tweakpane's addFolder gives a built-in expand/collapse chevron for free — so the swatch
  // presets above are the primary path and manual tuning is opt-in.
  const customColorsFolder = pane.addFolder({ title: "custom colors", expanded: false });
  customColorsFolder.addBinding(params, "colorA");
  customColorsFolder.addBinding(params, "colorB");
  customColorsFolder.element.parentElement?.insertBefore(presetRow, customColorsFolder.element);

  pane.addBinding(params, "reliefStrength", { min: 0, max: 60, step: 0.5 });
  pane.addBinding(params, "strokeWidthScale", { min: 0.2, max: 3, step: 0.05 });
  pane.addBinding(params, "strokeLengthScale", { min: 0.2, max: 3, step: 0.05 });
  pane.addBinding(params, "cameraDistance", { min: 8, max: 150, step: 1, label: "zoom (distance)" });
  pane.addBinding(params, "speckleAmount", { min: 0, max: 2, step: 0.05 });
  pane.addBinding(params, "pressureVariance", { min: 0, max: 1, step: 0.05 });
  pane.addBinding(params, "duress", { label: "duress (motion pressure)" });
  pane.addBinding(params, "debugMode", { label: "debug overlay" });
  pane.addBinding(params, "showHeads", { label: "show heads" });
  pane.addBinding(params, "soloDancer", {
    label: "solo dancer",
    options: { both: -1, "dancer 1": 0, "dancer 2": 1 },
  });

  // 15 baked pairs (see AVAILABLE_TRIAL_PAIRS) is comfortably within plain-dropdown territory —
  // no type-to-filter combobox needed. Switching pairs needs a full pose-cache reload (new
  // frame count, joint list, per-chain budgets — see main.ts), which is a page-load-time
  // concern, not something this panel can hot-swap — so this binding reloads the page with the
  // new selection already saved to the hash, same pattern as any other param, rather than
  // firing through the normal pane "change" listener that just re-renders the current frame.
  const trialPairOptions: Record<string, string> = {};
  for (const pair of AVAILABLE_TRIAL_PAIRS) trialPairOptions[pair.label] = pair.id;
  const trialPairBinding = pane.addBinding(params, "trialPair", {
    label: "dance",
    options: trialPairOptions,
  });
  trialPairBinding.on("change", () => {
    saveParamsToHash(params);
    window.location.reload();
  });

  pane.on("change", () => saveParamsToHash(params));

  return pane;
}
