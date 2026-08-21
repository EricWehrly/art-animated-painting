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
