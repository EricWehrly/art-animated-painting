import type { JointMeta } from "./pose-cache";

export interface BoneSegment {
  parentIndex: number;
  childIndex: number;
  /** Relative thickness, used to weight stroke width/volume in the emitter stage. */
  thickness: number;
}

/** One bone per non-root joint (parent -> child), derived from the BVH hierarchy. */
export function boneSegments(joints: JointMeta[]): BoneSegment[] {
  const bones: BoneSegment[] = [];
  for (let childIndex = 0; childIndex < joints.length; childIndex++) {
    const joint = joints[childIndex];
    if (joint.parentIndex === -1) continue;
    bones.push({ parentIndex: joint.parentIndex, childIndex, thickness: boneThickness(joint.name) });
  }
  return bones;
}

/**
 * Heuristic relative thickness by joint name. CMU's standard rig names are matched by
 * keyword rather than exact string, since capitalization/prefixes vary slightly across
 * subjects and BVH conversion tools.
 */
function boneThickness(childJointName: string): number {
  const name = childJointName.toLowerCase();
  if (name.includes("hip")) return 1.4;
  if (name.includes("spine") || name.includes("chest") || name.includes("thorax")) return 1.1;
  if (name.includes("neck") || name.includes("head")) return 0.8;
  if (name.includes("upleg") || name.includes("thigh") || name.includes("femur")) return 0.9;
  if ((name.includes("leg") || name.includes("shin") || name.includes("tibia")) && !name.includes("upleg")) return 0.6;
  if (name.includes("foot") || name.includes("toe")) return 0.4;
  if (name.includes("shoulder") || name.includes("clavicle")) return 0.55;
  if (name.includes("forearm")) return 0.4;
  if (name.includes("arm")) return 0.5;
  if (name.includes("hand") || name.includes("finger") || name.includes("thumb")) return 0.15;
  return 0.5;
}
