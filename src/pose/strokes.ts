import type { Emitter, BoneSample } from "./emitters";

export interface Stroke {
  position: [number, number, number];
  /** Consumed by stroke-mesh.ts purely as a billboard orientation direction (magnitude
   * doesn't matter, it's normalized in the vertex shader) — for bone strokes this is the
   * blended "paint direction" (see generateBoneStrokes), not necessarily the true motion. */
  velocity: [number, number, number];
  /** World-space stroke length. */
  length: number;
  /** World-space stroke width, ∝ bone thickness. */
  width: number;
  /** Feeds the height/relief field — see docs/work/impasto-shading.md. */
  volume: number;
  color: [number, number, number];
  /** Per-instance phase, decorrelates the procedural brush texture between strokes. */
  seed: number;
}

export interface BoneStrokeStyle {
  color: [number, number, number];
  widthScale: number;
  lengthScale: number;
  volumeScale: number;
  /** 0 = every stroke on a bone uses the same width/volume; 1 = strokes range roughly
   * 0.5x-1.5x pressure. Deterministic per (bone, stroke slot), not per-frame — a stroke's
   * "how hard was this one pressed" is a fixed identity, not a dice roll that would flicker
   * as the pose animates. */
  pressureVariance: number;
  /** World-space length a single stroke aims to cover. Bones longer than this split into
   * multiple strokes (up to maxStrokesPerBone); shorter bones get one stroke sized to the
   * whole bone. Set comfortably above the longest bone in the rig (thighs/shins, ~7.3 units
   * in the CMU data) so nearly every bone gets exactly one stroke — "connect the dots" in as
   * few strokes as possible, per the brief. */
  targetStrokeLength: number;
  maxStrokesPerBone: number;
  /** How much a bone's own motion (not just its static parent->child direction) bends the
   * paint direction and pushes the stroke's position — an arm swinging up, or a leg stepping
   * forward, should read as strokes pushed that way, not just strokes sitting on the limb. */
  forceScale: number;
}

/** Deterministic pseudo-random in [0, 1) for a given identity — used both for per-stroke
 * pressure (below) and speckle placement (generateSpeckles). */
function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

const BONE_STROKE_OVERSHOOT = 1.2; // slight overlap beyond the bone's own endpoints, so
// adjacent/covering strokes don't leave a visible gap at the joint.

/**
 * Converts per-bone samples into stroke instances that paint each bone segment directly —
 * "connect the dots": orientation follows the bone's own parent->child direction (so a still
 * limb still reads as that limb), motion only bends that direction and offsets position,
 * proportional to how much force/speed is behind it. See docs/work/pose-pipeline.md
 * "Strokes". Pure data transform — no GPU/three.js dependency.
 */
export function generateBoneStrokes(samples: BoneSample[], style: BoneStrokeStyle): Stroke[] {
  const strokes: Stroke[] = [];

  for (const sample of samples) {
    const boneVec: [number, number, number] = [
      sample.childPosition[0] - sample.parentPosition[0],
      sample.childPosition[1] - sample.parentPosition[1],
      sample.childPosition[2] - sample.parentPosition[2],
    ];
    const boneLen = Math.hypot(boneVec[0], boneVec[1], boneVec[2]);
    // Rig stub joints (zero-offset rotation pivots, e.g. BVH's "Neck"/"LHipJoint") have no
    // real length and nothing to paint — skip rather than emit a degenerate zero-length dab.
    if (boneLen < 0.05) continue;

    const boneDir: [number, number, number] = [boneVec[0] / boneLen, boneVec[1] / boneLen, boneVec[2] / boneLen];

    const speed = Math.hypot(sample.velocity[0], sample.velocity[1], sample.velocity[2]);
    const velDir: [number, number, number] =
      speed > 1e-5
        ? [sample.velocity[0] / speed, sample.velocity[1] / speed, sample.velocity[2] / speed]
        : boneDir;

    // Capped well under 1 so a bone always stays recognizably aligned with the limb it
    // represents, even at high speed — this is a push, not a replacement.
    const forceBlend = Math.min(speed * style.forceScale, 0.6);
    const paintDirRaw: [number, number, number] = [
      boneDir[0] * (1 - forceBlend) + velDir[0] * forceBlend,
      boneDir[1] * (1 - forceBlend) + velDir[1] * forceBlend,
      boneDir[2] * (1 - forceBlend) + velDir[2] * forceBlend,
    ];
    const paintDirLen = Math.hypot(paintDirRaw[0], paintDirRaw[1], paintDirRaw[2]) || 1;
    const paintDir: [number, number, number] = [
      paintDirRaw[0] / paintDirLen,
      paintDirRaw[1] / paintDirLen,
      paintDirRaw[2] / paintDirLen,
    ];

    const strokeCount = Math.max(
      1,
      Math.min(style.maxStrokesPerBone, Math.round(boneLen / style.targetStrokeLength))
    );
    const coverageLength = (boneLen / strokeCount) * BONE_STROKE_OVERSHOOT;

    for (let i = 0; i < strokeCount; i++) {
      const tCenter = (i + 0.5) / strokeCount;
      const basePos: [number, number, number] = [
        sample.parentPosition[0] + boneVec[0] * tCenter,
        sample.parentPosition[1] + boneVec[1] * tCenter,
        sample.parentPosition[2] + boneVec[2] * tCenter,
      ];

      const identity = sample.boneIndex * 131 + i * 7 + 0.5;
      const pressure = 1 + style.pressureVariance * (hash(identity) * 2 - 1);

      // The paint doesn't just point differently under force — it lands further along where
      // the limb is headed, like real pressure smearing it forward.
      const push = forceBlend * boneLen * 0.3;
      const position: [number, number, number] = [
        basePos[0] + velDir[0] * push,
        basePos[1] + velDir[1] * push,
        basePos[2] + velDir[2] * push,
      ];

      const length = Math.max(0.15, coverageLength * style.lengthScale * (1 + forceBlend * 0.4));

      strokes.push({
        position,
        velocity: paintDir,
        length,
        width: sample.thickness * style.widthScale * pressure,
        volume: (0.15 + speed * style.volumeScale) * pressure,
        color: style.color,
        seed: identity * 0.6180339887,
      });
    }
  }

  return strokes;
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
