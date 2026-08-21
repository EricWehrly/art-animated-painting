export interface TimelineHandle {
  element: HTMLElement;
  setFrameCount(count: number): void;
  setFrame(frame: number): void;
  onSeek(cb: (frame: number) => void): void;
}

/**
 * A scrub bar over a known frame count. Emits seek events; does not own playback state.
 */
export function createTimeline(container: HTMLElement): TimelineHandle {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;padding:10px 16px;display:flex;align-items:center;gap:10px;background:rgba(0,0,0,0.35);font:12px system-ui,sans-serif;color:#eee;";

  const label = document.createElement("span");
  label.textContent = "frame 0";
  label.style.cssText = "min-width:90px;font-variant-numeric:tabular-nums;";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "0";
  slider.value = "0";
  slider.style.flex = "1";

  wrap.appendChild(label);
  wrap.appendChild(slider);
  container.appendChild(wrap);

  const seekCallbacks: Array<(frame: number) => void> = [];

  slider.addEventListener("input", () => {
    const frame = Number(slider.value);
    label.textContent = `frame ${frame}`;
    for (const cb of seekCallbacks) cb(frame);
  });

  return {
    element: wrap,
    setFrameCount(count: number) {
      slider.max = String(Math.max(0, count - 1));
    },
    setFrame(frame: number) {
      slider.value = String(frame);
      label.textContent = `frame ${frame}`;
    },
    onSeek(cb: (frame: number) => void) {
      seekCallbacks.push(cb);
    },
  };
}
