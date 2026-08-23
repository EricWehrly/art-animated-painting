import type { JointMeta } from "./pose-cache";

export interface BoneSegment {
  parentIndex: number;
  childIndex: number;
  /** Relative thickness, used to weight stroke width/volume in the emitter stage. */
  thickness: number;
}

/** One bone per non-root joint (parent -> child), derived from the BVH hierarchy. Finger/
 * thumb bones are dropped entirely — the toy paints a recognizable biped (torso, head, arms,
 * legs), and per-finger segments only added clutter without reading as anything at this
 * scale. The hand/wrist bone itself (ForeArm -> Hand) is kept. */
export function boneSegments(joints: JointMeta[]): BoneSegment[] {
  const bones: BoneSegment[] = [];
  for (let childIndex = 0; childIndex < joints.length; childIndex++) {
    const joint = joints[childIndex];
    if (joint.parentIndex === -1) continue;
    if (isFingerBone(joint.name)) continue;
    bones.push({ parentIndex: joint.parentIndex, childIndex, thickness: boneThickness(joint.name) });
  }
  return bones;
}

export interface Chain {
  /** Ordered joint indices from this chain's start (the root, or a branch point) to its end
   * (a leaf, or the next branch point where child chains continue). */
  jointPath: number[];
  /** Per-segment thickness — thickness[i] belongs to the (jointPath[i] -> jointPath[i+1])
   * bone. One shorter than jointPath. */
  thickness: number[];
}

/**
 * Groups bones into maximal unbranched chains: the whole spine+neck+head is one chain, each
 * arm is its own chain, each leg (hip to toe) is its own chain. A chain is the unit of
 * coverage for pose/strokes.ts generateChainMarks — its own joint-to-joint shape is the target
 * region many independent marks tile across — rather than each bone getting its own
 * independent decision. See docs/work/pose-pipeline.md.
 */
export function buildChains(joints: JointMeta[]): Chain[] {
  const children: number[][] = joints.map(() => []);
  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i];
    if (joint.parentIndex === -1) continue;
    if (isFingerBone(joint.name)) continue;
    children[joint.parentIndex].push(i);
  }

  const chains: Chain[] = [];

  function walk(startJoint: number) {
    for (const firstChild of children[startJoint]) {
      const jointPath = [startJoint, firstChild];
      const thickness = [boneThickness(joints[firstChild].name)];
      let current = firstChild;
      while (children[current].length === 1) {
        const next = children[current][0];
        jointPath.push(next);
        thickness.push(boneThickness(joints[next].name));
        current = next;
      }
      chains.push({ jointPath, thickness });
      if (children[current].length >= 2) walk(current);
    }
  }

  const root = joints.findIndex((j) => j.parentIndex === -1);
  if (root !== -1) walk(root);

  return chains;
}

function isFingerBone(childJointName: string): boolean {
  const name = childJointName.toLowerCase();
  return (
    name.includes("thumb") ||
    name.includes("index") ||
    name.includes("middle") ||
    name.includes("ring") ||
    name.includes("pinky") ||
    name.includes("fingerbase")
  );
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
