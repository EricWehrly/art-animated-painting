import type { PoseCache, JointMeta, JointRef } from "./pose-cache";
import { jointWorldPosition, realJoint } from "./pose-cache";
import type { Chain } from "./skeleton";

/**
 * Joint indices the head needs, resolved once by name at load time (not per frame — the rig's
 * topology doesn't change). `neckJoint` is the head joint's own parent, whatever the rig calls
 * it (CMU's "Neck1" here) — not hardcoded, since a different BVH source could name it
 * differently.
 */
export interface HeadJoints {
  headJoint: number;
  /** -1 if the rig has no end site under the head (e.g. a stub-free source). */
  headEndJoint: number;
  neckJoint: number;
  /** The upper-arm joint on each side (CMU's "LeftArm"/"RightArm"), NOT the shoulder/clavicle
   * joint — in this rig "LeftShoulder"/"RightShoulder" are zero-offset rotation pivots that
   * sit exactly at the spine (both sides at the SAME world position), so a shoulder-to-
   * shoulder vector built from them collapses to zero length. The arm joints carry the real
   * offset out to the actual shoulder socket, which is what's needed for a genuine left-right
   * axis. See docs/work/pose-pipeline.md Round 21. */
  leftArmJoint: number;
  rightArmJoint: number;
}

/** Finds the head/neck/arm joints by name. Returns null if the rig doesn't have a recognizable
 * set of them (e.g. a source without named arms) — callers should fall back to the plain
 * chain-tube treatment for the head in that case, not crash. */
export function findHeadJoints(joints: JointMeta[]): HeadJoints | null {
  const headJoint = joints.findIndex((j) => j.name.toLowerCase() === "head");
  if (headJoint === -1) return null;
  const neckJoint = joints[headJoint].parentIndex;
  if (neckJoint === -1) return null;
  const headEndJoint = joints.findIndex((j) => j.isEndSite && j.parentIndex === headJoint);
  // "leftarm"/"rightarm" deliberately does not match "leftforearm"/"rightforearm" — the
  // substring "leftarm" never occurs contiguously inside "leftforearm" ("left" + "fore" +
  // "arm"), so no extra exclusion check is needed.
  const leftArmJoint = joints.findIndex((j) => j.name.toLowerCase().includes("leftarm"));
  const rightArmJoint = joints.findIndex((j) => j.name.toLowerCase().includes("rightarm"));
  if (leftArmJoint === -1 || rightArmJoint === -1) return null;
  return { headJoint, headEndJoint, neckJoint, leftArmJoint, rightArmJoint };
}

/**
 * Cuts a chain right at the head joint, discarding whatever real rig stub continues past it
 * (e.g. a tiny end-site bone) — the head's own coverage past that point comes from
 * `buildHeadCrownChain` below instead, a separate chain rather than a continuation of this one,
 * so the "show heads" toggle (main.ts) can hide just the crown while the neck's own tube (which
 * this function still leaves intact, up to and including the head joint) always paints. See
 * docs/work/pose-pipeline.md Round 21 for why the cut needs to land exactly at the head joint,
 * not the neck, to avoid leaving the neck-to-head bone itself unpainted by either piece.
 */
export function truncateHeadChain(chains: Chain[], headJoints: HeadJoints): Chain[] {
  return chains.map((chain) => {
    const headPos = chain.jointPath.findIndex((ref) => ref.kind === "real" && ref.index === headJoints.headJoint);
    if (headPos === -1 || headPos === chain.jointPath.length - 1) return chain;
    return {
      jointPath: chain.jointPath.slice(0, headPos + 1),
      thickness: chain.thickness.slice(0, headPos),
    };
  });
}

/** Half-width of an ellipse (semi-axis `r`) at normalized position `u` along its own length,
 * 0..1 end to end (0 and 1 are both poles — width 0 — the widest point is the middle, u=0.5). */
function ellipseHalfWidthAt(u: number, r: number): number {
  const y = 2 * u - 1;
  return r * Math.sqrt(Math.max(0, 1 - y * y));
}

/** How many fake segments the crown extension is divided into. Each one gets its own
 * `numLanes` recomputed from its own local width (generateChainMarks already does this per
 * segment) — enough segments here is what lets lane count actually taper down toward the
 * crown's own point, rather than the same fixed lane count trying to represent both the head's
 * widest point AND its tip, which is what the old single-region implementation got wrong. */
const CROWN_SEGMENTS = 6;

/**
 * Builds the head's own coverage as a chain continuing past the real head joint — a handful of
 * synthetic (rig-less) joints extending in a straight line, in the SAME direction the neck->head
 * bone already points, out to where the head's crown should be. Fed into the exact same
 * `generateChainMarks` every limb goes through (see main.ts), rather than a separate hand-rolled
 * per-step loop: paint load, wobble, motion response, dry-brush depletion, the heading clamp —
 * all of it is now one shared implementation, not two drifting copies. See
 * docs/work/pose-pipeline.md Round 25 for why this replaced the oval-disc model from Round 21-24.
 *
 * The ellipse-derived per-segment thickness is what makes this actually round instead of
 * "square with cut corners": each of the `CROWN_SEGMENTS` segments gets its OWN width, sampled
 * from the ellipse's true profile at that segment's own position, exactly the way a limb bone's
 * width0/width1 already tapers along its own length — the old implementation used one constant
 * rendered width for the whole oval, which is what squared off the crown. Lane COUNT tapers
 * along with it (recomputed per segment from that segment's own width, same as any limb), so the
 * very last segment naturally narrows toward a single lane instead of several lanes fighting to
 * represent a near-zero-width tip.
 *
 * Orientation note, a deliberate simplification versus Round 21-24: the lane (across-head) axis
 * now comes from `generateChainMarks`' own `segDir x viewForward` (same as every limb), not from
 * a shoulder-derived body-relative axis. Since the camera is fixed and this dance is mostly
 * performed facing it, this is very often visually similar — but it does mean the head's own
 * width no longer specifically foreshortens when the dancer's body (not just their head) turns
 * away from camera, which the old shoulder-relative "facing" axis was built to handle. Revisit
 * if a turned-away pose reads oddly; shoulderWidth is still sampled here (for sizing) even
 * though its old second job (orientation) is gone.
 */
export function buildHeadCrownChain(cache: PoseCache, headJoints: HeadJoints, dancerIndex: number, frame: number): Chain {
  const leftArm = jointWorldPosition(cache, dancerIndex, frame, headJoints.leftArmJoint);
  const rightArm = jointWorldPosition(cache, dancerIndex, frame, headJoints.rightArmJoint);

  const shoulderVec: [number, number, number] = [rightArm[0] - leftArm[0], rightArm[1] - leftArm[1], rightArm[2] - leftArm[2]];
  const shoulderWidth = Math.hypot(shoulderVec[0], shoulderVec[1], shoulderVec[2]) || 1;

  // Real-world extent (how far the crown reaches past the head joint) — fixed off shoulder
  // width alone, NOT scaled by the strokeWidthScale UI knob. That matches every real chain:
  // strokeWidthScale only ever thickens marks (via the thickness values below, later
  // multiplied by style.widthScale the same as any limb bone), it never moves a joint. The old
  // oval-disc code scaled the head's own reach by strokeWidthScale too, which was actually an
  // inconsistency this rewrite incidentally fixes rather than a behaviour worth preserving.
  const height = shoulderWidth * 0.62;
  const rx = shoulderWidth * 0.22;

  const jointPath: JointRef[] = [realJoint(headJoints.headJoint)];
  const thickness: number[] = [];
  for (let i = 1; i <= CROWN_SEGMENTS; i++) {
    const u = i / CROWN_SEGMENTS;
    jointPath.push({ kind: "extrapolated", from: headJoints.neckJoint, through: headJoints.headJoint, distance: height * u });
    const midU = (i - 0.5) / CROWN_SEGMENTS;
    // Raw, unscaled — same convention as skeleton.ts's boneThickness() heuristics, which
    // generateChainMarks multiplies by style.widthScale itself. No separate "head style" or
    // widthScale plumbing needed here.
    thickness.push(2 * ellipseHalfWidthAt(midU, rx));
  }

  return { jointPath, thickness };
}
