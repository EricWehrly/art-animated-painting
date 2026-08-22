import type { PoseCache } from "./pose-cache";
import { jointWorldPosition } from "./pose-cache";
import type { BoneSegment } from "./skeleton";

export interface Emitter {
  position: [number, number, number];
  /** Per-frame position delta (world units / frame), not yet scaled to a velocity in world units/sec. */
  velocity: [number, number, number];
  thickness: number;
  /** Normalized position along the bone, 0 = parent joint, 1 = child joint. */
  t: number;
}

/**
 * Samples one point at fraction `t` along a bone segment (0 = parent joint, 1 = child joint)
 * for one dancer at one frame, returning that point's own position and instantaneous velocity
 * (true central difference against the neighbouring baked frames — noticeably less noisy than
 * a one-sided difference, which matters here: slow bones have tiny per-frame deltas, and
 * finite-difference noise on those was showing up as incoherent stroke orientation).
 *
 * Deliberately a per-point query, not "the bone's velocity" — a rotating limb's tip and base
 * move differently, and averaging them into one value per bone was tried and rejected (see
 * docs/work/pose-pipeline.md Round 3): every stroke on a bone ended up pointed the same way
 * regardless of where it actually sat, which is not what "instantaneous, per bone" means.
 */
export function sampleBoneAtT(
  cache: PoseCache,
  bone: BoneSegment,
  dancerIndex: number,
  frame: number,
  t: number
): { position: [number, number, number]; velocity: [number, number, number] } {
  const parentNow = jointWorldPosition(cache, dancerIndex, frame, bone.parentIndex);
  const childNow = jointWorldPosition(cache, dancerIndex, frame, bone.childIndex);
  const position: [number, number, number] = [
    parentNow[0] + (childNow[0] - parentNow[0]) * t,
    parentNow[1] + (childNow[1] - parentNow[1]) * t,
    parentNow[2] + (childNow[2] - parentNow[2]) * t,
  ];

  const parentPrev = jointWorldPosition(cache, dancerIndex, frame - 1, bone.parentIndex);
  const childPrev = jointWorldPosition(cache, dancerIndex, frame - 1, bone.childIndex);
  const prevPosition: [number, number, number] = [
    parentPrev[0] + (childPrev[0] - parentPrev[0]) * t,
    parentPrev[1] + (childPrev[1] - parentPrev[1]) * t,
    parentPrev[2] + (childPrev[2] - parentPrev[2]) * t,
  ];

  const parentNext = jointWorldPosition(cache, dancerIndex, frame + 1, bone.parentIndex);
  const childNext = jointWorldPosition(cache, dancerIndex, frame + 1, bone.childIndex);
  const nextPosition: [number, number, number] = [
    parentNext[0] + (childNext[0] - parentNext[0]) * t,
    parentNext[1] + (childNext[1] - parentNext[1]) * t,
    parentNext[2] + (childNext[2] - parentNext[2]) * t,
  ];

  const velocity: [number, number, number] = [
    (nextPosition[0] - prevPosition[0]) / 2,
    (nextPosition[1] - prevPosition[1]) / 2,
    (nextPosition[2] - prevPosition[2]) / 2,
  ];

  return { position, velocity };
}

/**
 * Samples `samplesPerBone` evenly-spaced points along every bone segment for one dancer at
 * one frame. Used for speckle placement (generateSpeckles wants several velocity samples
 * along a rotating limb); main stroke coverage now walks each bone adaptively instead — see
 * pose/strokes.ts generateBoneStrokes.
 */
export function generateEmitters(
  cache: PoseCache,
  bones: BoneSegment[],
  dancerIndex: number,
  frame: number,
  samplesPerBone = 4
): Emitter[] {
  const emitters: Emitter[] = [];

  for (const bone of bones) {
    for (let s = 0; s < samplesPerBone; s++) {
      const t = samplesPerBone === 1 ? 0.5 : s / (samplesPerBone - 1);
      const { position, velocity } = sampleBoneAtT(cache, bone, dancerIndex, frame, t);
      emitters.push({ position, velocity, thickness: bone.thickness, t });
    }
  }

  return emitters;
}
