/**
 * Fixed-step layer clock. Simulation time (layers) is decoupled from render time
 * (display refresh) — see docs/work/toy-shell.md. `onLayer` fires zero or more times
 * per rendered frame depending on wall-clock elapsed vs. layer cadence, so the layer
 * count for a given time span is deterministic regardless of frame rate.
 */
export class LayerClock {
  private layersPerSecond: number;
  private accumulatedSeconds = 0;
  private layerIndex = 0;
  private running = false;
  private lastTimestampMs = 0;
  private rafHandle = 0;

  constructor(layersPerSecond: number) {
    this.layersPerSecond = layersPerSecond;
  }

  setLayersPerSecond(v: number) {
    this.layersPerSecond = v;
  }

  get currentLayer() {
    return this.layerIndex;
  }

  start(onLayer: (layerIndex: number) => void, onDraw: () => void) {
    this.running = true;
    this.lastTimestampMs = performance.now();

    const tick = (nowMs: number) => {
      if (!this.running) return;
      const dt = (nowMs - this.lastTimestampMs) / 1000;
      this.lastTimestampMs = nowMs;
      this.accumulatedSeconds += dt;

      const layerDuration = 1 / this.layersPerSecond;
      while (this.accumulatedSeconds >= layerDuration) {
        this.accumulatedSeconds -= layerDuration;
        this.layerIndex += 1;
        onLayer(this.layerIndex);
      }

      onDraw();
      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  /** Jump directly to a layer index, e.g. from a scrub bar. Does not fire onLayer. */
  seek(layerIndex: number) {
    this.layerIndex = layerIndex;
    this.accumulatedSeconds = 0;
  }
}
