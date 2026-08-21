import type { Emitter } from "./emitters";

export interface Stroke {
  position: [number, number, number];
  velocity: [number, number, number];
  /** World-space stroke length, ∝ speed. */
  length: number;
  /** World-space stroke width, ∝ bone thickness. */
  width: number;
  /** Feeds the height/relief field — ∝ speed, see docs/work/impasto-shading.md. */
  volume: number;
  color: [number, number, number];
  /** Per-instance phase, decorrelates the procedural brush texture between strokes. */
  seed: number;
}

export interface StrokeStyle {
  color: [number, number, number];
  lengthScale: number;
  minLength: number;
  maxLength: number;
  widthScale: number;
  volumeScale: number;
}

/**
 * Converts raw bone-sample emitters into stroke instances (see docs/work/pose-pipeline.md
 * "Strokes"). Pure data transform — no GPU/three.js dependency, so it stays testable and
 * reusable if the rendering approach changes.
 */
export function generateStrokes(emitters: Emitter[], style: StrokeStyle): Stroke[] {
  return emitters.map((e, i) => {
    const speed = Math.hypot(e.velocity[0], e.velocity[1], e.velocity[2]);
    const length = Math.min(style.maxLength, style.minLength + speed * style.lengthScale);
    return {
      position: e.position,
      velocity: e.velocity,
      length,
      width: e.thickness * style.widthScale,
      volume: 0.15 + speed * style.volumeScale,
      color: style.color,
      seed: i * 0.6180339887 + e.t,
    };
  });
}

export interface SpeckleStyle {
  color: [number, number, number];
  /** Per-frame speed below which an emitter throws no speckles at all. */
  speedThreshold: number;
  /** Speckle count at speedThreshold * 4 (count scales up to this with speed, then holds). */
  maxCount: number;
  /** World-space radius speckles scatter from the stroke tip, along and across its direction. */
  spread: number;
  sizeScale: number;
}

/** Deterministic pseudo-random in [0, 1) — stable for a given (frame, emitter, k) so replaying
 * the same frame (e.g. on a param tweak) doesn't make the speckles jump around. */
function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Small flung droplets beyond each fast-moving emitter's tip — the spatter/speckle look from
 * a real paint fling, distinct from the main brush-shaped strokes. Reuses the Stroke type and
 * the same stroke-mesh rendering: a speckle is just a small, nearly round stroke, so no new
 * geometry or shader is needed. See docs/work/pose-pipeline.md "Strokes".
 */
export function generateSpeckles(emitters: Emitter[], frame: number, style: SpeckleStyle): Stroke[] {
  const speckles: Stroke[] = [];

  emitters.forEach((e, i) => {
    const speed = Math.hypot(e.velocity[0], e.velocity[1], e.velocity[2]);
    if (speed < style.speedThreshold) return;

    const speedRatio = Math.min(speed / (style.speedThreshold * 4), 1);
    const count = Math.round(speedRatio * style.maxCount);
    const dirLen = speed || 1e-6;
    const dir: [number, number, number] = [e.velocity[0] / dirLen, e.velocity[1] / dirLen, e.velocity[2] / dirLen];

    for (let k = 0; k < count; k++) {
      const seed = frame * 97.13 + i * 13.7 + k * 7.31;
      const r1 = hash(seed);
      const r2 = hash(seed + 0.37);
      const r3 = hash(seed + 0.71);
      const r4 = hash(seed + 1.13);

      const flingDist = style.spread * (0.4 + r1 * 1.6) * speedRatio;
      const jitter = style.spread * 0.5;

      speckles.push({
        position: [
          e.position[0] + dir[0] * flingDist + (r2 - 0.5) * jitter,
          e.position[1] + dir[1] * flingDist + (r3 - 0.5) * jitter,
          e.position[2] + dir[2] * flingDist + (r4 - 0.5) * jitter,
        ],
        velocity: e.velocity,
        length: style.sizeScale * (0.4 + r1 * 0.6),
        width: style.sizeScale * (0.3 + r2 * 0.5),
        volume: 0.04 + r1 * 0.06,
        color: style.color,
        seed,
      });
    }
  });

  return speckles;
}
