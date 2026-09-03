import type { PoseCache, JointRef } from "./pose-cache";
import { resolveJointPosition } from "./pose-cache";

export interface Emitter {
  position: [number, number, number];
  /** Per-frame position delta (world units / frame), not yet scaled to a velocity in world units/sec. */
  velocity: [number, number, number];
  thickness: number;
  /** Normalized position along the bone, 0 = parent joint, 1 = child joint. */
  t: number;
}

/**
 * Samples one point at fraction `t` along the segment from `parentIndex` to `childIndex` (0 =
 * parent joint, 1 = child joint) for one dancer at one frame, returning that point's own
 * position and instantaneous velocity (true central difference against the neighbouring
 * baked frames — noticeably less noisy than a one-sided difference, which matters here: slow
 * bones have tiny per-frame deltas, and finite-difference noise on those was showing up as
 * incoherent stroke orientation).
 *
 * Takes `JointRef`s (real rig joints OR extrapolated points with no rig joint of their own —
 * see pose-cache.ts) rather than raw indices, so the same helper works for any segment of any
 * chain (see pose/strokes.ts generateChainMarks) — including pose/head.ts's crown segments,
 * which have no real joint to sample. An extrapolated ref re-derives its own position at
 * frame-1/frame+1 the same as frame itself (see resolveJointPosition), so its velocity here
 * comes out physically real — a crown point genuinely moves faster than the neck under a head
 * turn, the same way a point further out on a rotating rigid body would — not copied from
 * whatever real joint it's anchored to.
 *
 * Deliberately a per-point query, not "the bone's velocity" — a rotating limb's tip and base
 * move differently, and averaging them into one value per bone was tried and rejected (see
 * docs/work/pose-pipeline.md Round 3): every stroke on a bone ended up pointed the same way
 * regardless of where it actually sat, which is not what "instantaneous, per bone" means.
 */
export function sampleBoneAtT(
  cache: PoseCache,
  parentRef: JointRef,
  childRef: JointRef,
  dancerIndex: number,
  frame: number,
  t: number
): { position: [number, number, number]; velocity: [number, number, number] } {
  const parentNow = resolveJointPosition(cache, dancerIndex, frame, parentRef);
  const childNow = resolveJointPosition(cache, dancerIndex, frame, childRef);
  const position: [number, number, number] = [
    parentNow[0] + (childNow[0] - parentNow[0]) * t,
    parentNow[1] + (childNow[1] - parentNow[1]) * t,
    parentNow[2] + (childNow[2] - parentNow[2]) * t,
  ];

  const parentPrev = resolveJointPosition(cache, dancerIndex, frame - 1, parentRef);
  const childPrev = resolveJointPosition(cache, dancerIndex, frame - 1, childRef);
  const prevPosition: [number, number, number] = [
    parentPrev[0] + (childPrev[0] - parentPrev[0]) * t,
    parentPrev[1] + (childPrev[1] - parentPrev[1]) * t,
    parentPrev[2] + (childPrev[2] - parentPrev[2]) * t,
  ];

  const parentNext = resolveJointPosition(cache, dancerIndex, frame + 1, parentRef);
  const childNext = resolveJointPosition(cache, dancerIndex, frame + 1, childRef);
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
