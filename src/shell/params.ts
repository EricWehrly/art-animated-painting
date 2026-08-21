import { Pane } from "tweakpane";

export interface ToyParams {
  pointSize: number;
  colorA: string;
  colorB: string;
  playing: boolean;
  layersPerSecond: number;
}

export const defaultParams: ToyParams = {
  pointSize: 0.6,
  colorA: "#c94e3d",
  colorB: "#3d6fc9",
  playing: false,
  layersPerSecond: 24,
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

function saveParamsToHash(params: ToyParams) {
  window.location.hash = encodeURIComponent(JSON.stringify(params));
}

export function createParamsPanel(container: HTMLElement, params: ToyParams): Pane {
  const pane = new Pane({ container, title: "params" });

  pane.addBinding(params, "playing");
  pane.addBinding(params, "layersPerSecond", { min: 1, max: 60, step: 1 });
  pane.addBinding(params, "pointSize", { min: 0.1, max: 3, step: 0.05 });
  pane.addBinding(params, "colorA");
  pane.addBinding(params, "colorB");

  pane.on("change", () => saveParamsToHash(params));

  return pane;
}
