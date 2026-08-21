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

      const parentPrev = jointWorldPosition(cache, dancerIndex, frame - 1, bone.parentIndex);
      const childPrev = jointWorldPosition(cache, dancerIndex, frame - 1, bone.childIndex);
      const prevPosition: [number, number, number] = [
        parentPrev[0] + (childPrev[0] - parentPrev[0]) * t,
        parentPrev[1] + (childPrev[1] - parentPrev[1]) * t,
        parentPrev[2] + (childPrev[2] - parentPrev[2]) * t,
      ];

      emitters.push({
        position,
        velocity: [position[0] - prevPosition[0], position[1] - prevPosition[1], position[2] - prevPosition[2]],
        thickness: bone.thickness,
        t,
      });
    }
  }

  return emitters;
}
