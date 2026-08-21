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
 * Samples points along every bone segment for one dancer at one frame, each carrying
 * position, velocity (central difference against neighbouring frames), and bone thickness.
 * See docs/work/pose-pipeline.md "Emitters".
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

      const parentNow = jointWorldPosition(cache, dancerIndex, frame, bone.parentIndex);
      const childNow = jointWorldPosition(cache, dancerIndex, frame, bone.childIndex);
      const position: [number, number, number] = [
        parentNow[0] + (childNow[0] - parentNow[0]) * t,
        parentNow[1] + (childNow[1] - parentNow[1]) * t,
        parentNow[2] + (childNow[2] - parentNow[2]) * t,
      ];

      // True central difference (frame-1 to frame+1, not frame-1 to frame) — noticeably
      // less noisy than a one-sided difference, which matters here: slow bones have tiny
      // per-frame deltas, and finite-difference noise on those deltas was showing up as
      // incoherent stroke orientation ("pixelly" strokes with no clear direction).
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

      emitters.push({
        position,
        velocity: [
          (nextPosition[0] - prevPosition[0]) / 2,
          (nextPosition[1] - prevPosition[1]) / 2,
          (nextPosition[2] - prevPosition[2]) / 2,
        ],
        thickness: bone.thickness,
        t,
      });
    }
  }

  return emitters;
}

export interface BoneSample {
  parentPosition: [number, number, number];
  childPosition: [number, number, number];
  /** Per-frame velocity delta (world units/frame) of the segment as a whole — the average of
   * the parent and child joints' own central-difference velocities. Represents the "force"
   * moving this limb; see pose/strokes.ts generateBoneStrokes for how it's used to bend paint
   * direction and push stroke position, on top of the bone's own static orientation. */
  velocity: [number, number, number];
  thickness: number;
  /** Stable per-bone identity (index into the `bones` array passed to generateBoneSamples),
   * used downstream to seed deterministic per-stroke pressure so it doesn't flicker frame to
   * frame — see docs/work/pose-pipeline.md. */
  boneIndex: number;
}

/**
 * One sample per bone segment (not per point along it — see generateBoneStrokes, which decides
 * how many strokes a bone needs to cover its own length). Carries both endpoints' positions
 * plus the segment's average velocity, so strokes.ts can align paint to the bone's own
 * direction and use motion only to bend/push that, rather than motion being the sole
 * determinant of stroke orientation.
 */
export function generateBoneSamples(
  cache: PoseCache,
  bones: BoneSegment[],
  dancerIndex: number,
  frame: number
): BoneSample[] {
  return bones.map((bone, boneIndex) => {
    const parentPosition = jointWorldPosition(cache, dancerIndex, frame, bone.parentIndex);
    const childPosition = jointWorldPosition(cache, dancerIndex, frame, bone.childIndex);

    const parentPrev = jointWorldPosition(cache, dancerIndex, frame - 1, bone.parentIndex);
    const childPrev = jointWorldPosition(cache, dancerIndex, frame - 1, bone.childIndex);
    const parentNext = jointWorldPosition(cache, dancerIndex, frame + 1, bone.parentIndex);
    const childNext = jointWorldPosition(cache, dancerIndex, frame + 1, bone.childIndex);

    const velocity: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const parentV = (parentNext[k] - parentPrev[k]) / 2;
      const childV = (childNext[k] - childPrev[k]) / 2;
      velocity[k] = (parentV + childV) / 2;
    }

    return { parentPosition, childPosition, velocity, thickness: bone.thickness, boneIndex };
  });
}
