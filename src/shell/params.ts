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
}

export const defaultParams: ToyParams = {
  colorA: "#c94e3d",
  colorB: "#3d6fc9",
  playing: false,
  layersPerSecond: 24,
  reliefStrength: 14,
  strokeWidthScale: 1,
  strokeLengthScale: 1,
  cameraDistance: 55,
  targetX: 0,
  targetY: 15,
  targetZ: 0,
  speckleAmount: 0.6,
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

export function createParamsPanel(container: HTMLElement, params: ToyParams): Pane {
  const pane = new Pane({ container, title: "params" });

  pane.addBinding(params, "playing");
  pane.addBinding(params, "layersPerSecond", { min: 1, max: 60, step: 1 });
  pane.addBinding(params, "colorA");
  pane.addBinding(params, "colorB");
  pane.addBinding(params, "reliefStrength", { min: 0, max: 40, step: 0.5 });
  pane.addBinding(params, "strokeWidthScale", { min: 0.2, max: 3, step: 0.05 });
  pane.addBinding(params, "strokeLengthScale", { min: 0.2, max: 3, step: 0.05 });
  pane.addBinding(params, "cameraDistance", { min: 8, max: 150, step: 1, label: "zoom (distance)" });
  pane.addBinding(params, "speckleAmount", { min: 0, max: 2, step: 0.05 });

  pane.on("change", () => saveParamsToHash(params));

  return pane;
}
