import type { PoseCache } from "./pose-cache";
import type { BoneSegment } from "./skeleton";
import { sampleBoneAtT, type Emitter } from "./emitters";

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
  /** Scales the rendered length of every stroke, purely a visual knob — does not change how
   * many strokes a bone needs to cover itself (that's decided by min/maxStrokeLength below,
   * pre-scale, so cranking this doesn't cause coverage gaps or overlaps). */
  lengthScale: number;
  volumeScale: number;
  /** How much width/volume vary with how much paint a given dab "picked up" (0 = no
   * variation, every dab is identical regardless of paintLoad; 1 = full range). Paint load is
   * itself deterministic per (bone, stroke slot) — not per-frame — so it doesn't flicker as
   * the pose animates. */
  pressureVariance: number;
  /** Hard cap on a single dab's length — the brush can only carry so much paint before it
   * needs reloading, which is what forces a long bone to be covered by several strokes. */
  maxStrokeLength: number;
  /** Shortest a dab can be, even at minimum paint pickup — keeps low-paintLoad strokes from
   * collapsing to invisible specks. */
  minStrokeLength: number;
  /** How much local instantaneous speed further stretches a dab beyond its paint-load base
   * length (still hard-capped at maxStrokeLength) and pushes its position along that
   * velocity — the "force"/pressure the brief asked for: a fast-moving section smears
   * further and lands ahead of where the limb currently is. */
  forceScale: number;
  smearScale: number;
}

/** Deterministic pseudo-random in [0, 1) for a given identity — used for per-stroke paint
 * load/pressure (below) and speckle placement (generateSpeckles). */
function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

const MAX_DABS_PER_BONE_SAFETY = 20; // guards against a runaway loop on degenerate (near-zero
// minStrokeLength, or pathologically long bone) data — not a normal limit in practice.

/**
 * Walks each bone from parent to child laying down dabs of paint, "connect the dots" style —
 * each dab's length is however far its randomly-varying paint load can carry (capped at
 * maxStrokeLength), so a long bone naturally needs several dabs to cover while a short one
 * needs only one. Each dab samples its OWN instantaneous velocity fresh at its own position
 * along the bone (see emitters.ts sampleBoneAtT) — deliberately per-dab, not one velocity
 * averaged across the whole bone and reused for every stroke on it (that was tried and
 * produced strokes that all pointed identically regardless of where they sat — see
 * docs/work/pose-pipeline.md Round 3). Orientation IS that instantaneous velocity, falling
 * back to the bone's own static direction only when a point is essentially still (velocity
 * direction is meaningless at zero speed). See docs/work/pose-pipeline.md "Strokes".
 *
 * Needs cache/frame access to sample arbitrary points adaptively as the walk proceeds, so
 * (unlike the rest of this module) it isn't a pure data transform over pre-computed samples.
 */
export function generateBoneStrokes(
  cache: PoseCache,
  bones: BoneSegment[],
  dancerIndex: number,
  frame: number,
  style: BoneStrokeStyle
): Stroke[] {
  const strokes: Stroke[] = [];

  bones.forEach((bone, boneIndex) => {
    const { position: parentPos } = sampleBoneAtT(cache, bone, dancerIndex, frame, 0);
    const { position: childPos } = sampleBoneAtT(cache, bone, dancerIndex, frame, 1);
    const boneVec: [number, number, number] = [
      childPos[0] - parentPos[0],
      childPos[1] - parentPos[1],
      childPos[2] - parentPos[2],
    ];
    const boneLen = Math.hypot(boneVec[0], boneVec[1], boneVec[2]);
    // Rig stub joints (zero-offset rotation pivots, e.g. BVH's "Neck"/"LHipJoint") have no
    // real length and nothing to paint — skip rather than emit a degenerate zero-length dab.
    if (boneLen < 0.05) return;
    const boneDir: [number, number, number] = [boneVec[0] / boneLen, boneVec[1] / boneLen, boneVec[2] / boneLen];

    let t = 0;
    let slot = 0;
    while (t < 0.999 && slot < MAX_DABS_PER_BONE_SAFETY) {
      const { velocity } = sampleBoneAtT(cache, bone, dancerIndex, frame, t);
      const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
      const velDir: [number, number, number] =
        speed > 1e-4 ? [velocity[0] / speed, velocity[1] / speed, velocity[2] / speed] : boneDir;

      const identity = boneIndex * 131 + slot * 7 + 0.5;
      // How much paint this dab picked up, 0..1 — drives both how far it can carry (length)
      // and, scaled by pressureVariance, how thick/voluminous it lays down. One random draw
      // for both, since physically they're the same thing: more paint on the brush means it
      // both goes further AND deposits more material, not two independent coincidences.
      const paintLoad = hash(identity);

      // Coverage math (deciding how much of the bone this dab consumes, and thus how many
      // dabs the bone needs) uses the UNSCALED base length — lengthScale below is a pure
      // rendered-size knob and must not change stroke count/coverage.
      const baseLength = style.minStrokeLength + paintLoad * (style.maxStrokeLength - style.minStrokeLength);
      const tSpan = Math.min(1 - t, baseLength / boneLen);
      const tCenter = t + tSpan / 2;

      const centerPos: [number, number, number] = [
        parentPos[0] + boneVec[0] * tCenter,
        parentPos[1] + boneVec[1] * tCenter,
        parentPos[2] + boneVec[2] * tCenter,
      ];
      // The paint doesn't just point differently under force — it lands further along where
      // the limb is headed, like real pressure smearing it forward.
      const push = speed * style.forceScale;
      const position: [number, number, number] = [
        centerPos[0] + velDir[0] * push,
        centerPos[1] + velDir[1] * push,
        centerPos[2] + velDir[2] * push,
      ];

      const renderLength = Math.max(
        0.15,
        Math.min(style.maxStrokeLength, baseLength * (1 + speed * style.smearScale)) * style.lengthScale
      );
      const pressure = 1 + style.pressureVariance * (paintLoad * 2 - 1);

      strokes.push({
        position,
        velocity: velDir,
        length: renderLength,
        width: bone.thickness * style.widthScale * pressure,
        volume: (0.15 + speed * style.volumeScale) * pressure,
        color: style.color,
        seed: identity * 0.6180339887,
      });

      t += tSpan;
      slot++;
    }
  });

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
