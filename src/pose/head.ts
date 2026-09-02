import type { PoseCache, JointMeta } from "./pose-cache";
import { jointWorldPosition } from "./pose-cache";
import type { Chain } from "./skeleton";
import type { Stroke } from "./strokes";

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
 * The neck+head chain (see skeleton.ts buildChains) walks all the way to the head's own end
 * site by default, which is what made it read as a "worm" — the same tapering-tube treatment
 * every limb gets, just with a small terminal joint, rather than anything that reads as a
 * head. Truncates that one chain to stop AT the head joint itself (not the neck) — the normal
 * per-limb tube coverage still paints all the way up through the neck-to-head bone, so it
 * meets generateHeadMarks' oval (also anchored at the head joint) with no seam. Stopping at
 * the neck instead left a real gap: the tube's own tip only reached the neck, and the oval's
 * own footprint only reached the head joint, leaving the neck-to-head bone itself unpainted by
 * either. See docs/work/pose-pipeline.md Round 21.
 */
export function truncateHeadChain(chains: Chain[], headJoints: HeadJoints): Chain[] {
  return chains.map((chain) => {
    const headPos = chain.jointPath.indexOf(headJoints.headJoint);
    if (headPos === -1 || headPos === chain.jointPath.length - 1) return chain;
    return {
      jointPath: chain.jointPath.slice(0, headPos + 1),
      thickness: chain.thickness.slice(0, headPos),
    };
  });
}

export interface HeadStyle {
  color: [number, number, number];
  /** Same convention as BoneStrokeStyle.widthScale — scales the head's overall footprint so
   * the strokeWidthScale param affects it consistently with the rest of the figure. */
  widthScale: number;
}

function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Paints the head as a flat oriented oval — not another tapering tube — so it reads with a
 * real directional sense instead of narrowing to a point. The mocap source only bakes joint
 * POSITIONS, never rotations, so there is no literal gaze/eye-line signal available; this is a
 * proxy, not tracked head-turning: the oval's "up" axis comes from the neck->head bone (head
 * tilt/pitch), and its "facing" axis (the oval's normal — which way the face points) comes
 * from the shoulder line, on the assumption that in this dance the head mostly tracks where
 * the body itself is facing. That assumption can break (a head turn independent of the torso
 * wouldn't show), but it's the only orientation signal the baked data actually supports. See
 * docs/work/pose-pipeline.md Round 21.
 *
 * The oval is placed as a genuinely flat 3D disc (real extent along "up" and "side", none
 * along "facing") rather than faked in 2D screen space — the fixed camera's own perspective
 * projection is what naturally foreshortens it: facing toward/away from the camera shows the
 * disc closer to full width, facing perpendicular to the camera (profile) collapses its
 * projected width toward a sliver. No manual foreshortening math needed, just real placement.
 */
export function generateHeadMarks(
  cache: PoseCache,
  headJoints: HeadJoints,
  dancerIndex: number,
  frame: number,
  style: HeadStyle
): Stroke[] {
  const strokes: Stroke[] = [];

  const headPos = jointWorldPosition(cache, dancerIndex, frame, headJoints.headJoint);
  const neckPos = jointWorldPosition(cache, dancerIndex, frame, headJoints.neckJoint);
  const leftArm = jointWorldPosition(cache, dancerIndex, frame, headJoints.leftArmJoint);
  const rightArm = jointWorldPosition(cache, dancerIndex, frame, headJoints.rightArmJoint);

  const up = normalize([headPos[0] - neckPos[0], headPos[1] - neckPos[1], headPos[2] - neckPos[2]]);

  const shoulderVec: [number, number, number] = [rightArm[0] - leftArm[0], rightArm[1] - leftArm[1], rightArm[2] - leftArm[2]];
  const shoulderWidth = Math.hypot(shoulderVec[0], shoulderVec[1], shoulderVec[2]) || 1;
  const shoulderDir = normalize(shoulderVec);

  // facing is perpendicular to both up and the shoulder line by construction (cross product) —
  // degenerates only if up and shoulderDir happen to be parallel (a dancer bent so their spine
  // points along their own shoulder line), which world-up as a fallback reference resolves the
  // same way the lane-offset axis in pose/strokes.ts does.
  let facing = cross(up, shoulderDir);
  if (Math.hypot(facing[0], facing[1], facing[2]) < 1e-6) facing = cross(up, [0, 0, 1]);
  facing = normalize(facing);
  const side = normalize(cross(facing, up));

  const headHeight = shoulderWidth * 0.62 * style.widthScale;
  const headWidth = shoulderWidth * 0.44 * style.widthScale;
  const rx = headWidth / 2;
  const ry = headHeight / 2;

  // Center sits above the Head joint (roughly chin/jaw level in this rig) by half the oval's
  // own height, so the oval's MIDDLE — not its bottom edge — is what the neck actually meets.
  const center: [number, number, number] = [
    headPos[0] + up[0] * ry,
    headPos[1] + up[1] * ry,
    headPos[2] + up[2] * ry,
  ];

  // A jittered GRID, not pure random rejection sampling — random scatter at these small counts
  // reads as clumpy/cauliflower (Poisson noise: real gaps and real pile-ups both happen by
  // chance), which is wrong for a shape that's supposed to read as one solid oval. A grid
  // guarantees even coverage; the per-cell jitter below is what keeps it from looking like a
  // literal dot matrix.
  const targetSpacing = Math.max(0.22, Math.min(rx, ry) * 0.24);
  const gridN = Math.max(3, Math.round((2 * Math.max(rx, ry)) / targetSpacing));
  const cellHalf = 1 / gridN;
  // Wider than the cell itself so neighboring marks overlap — same "generous overlap reads as
  // one continuous surface" principle pose/strokes.ts's limb coverage relies on.
  const dabSize = targetSpacing * 1.8;

  const idSalt = dancerIndex * 97411 + headJoints.headJoint * 733;
  let markIndex = 0;

  for (let gy = 0; gy < gridN; gy++) {
    for (let gx = 0; gx < gridN; gx++) {
      const cx = ((gx + 0.5) / gridN) * 2 - 1;
      const cy = ((gy + 0.5) / gridN) * 2 - 1;
      // A little generous beyond the true unit circle (1.0) — a hard cutoff at exactly the
      // ellipse boundary reads as a stamped-out shape; letting the outermost ring of cells
      // peek slightly past it gives the same soft, hand-painted edge the rest of the figure
      // has (see stroke-mesh.ts's tear/taper edge shaping).
      if (cx * cx + cy * cy > 1.15) continue;

      const idBase = idSalt + markIndex * 91.7;
      markIndex++;

      const jitterX = (hash(idBase + 0.3) - 0.5) * cellHalf * 1.3;
      const jitterY = (hash(idBase + 0.7) - 0.5) * cellHalf * 1.3;
      const sx = cx + jitterX;
      const sy = cy + jitterY;

      const pos: [number, number, number] = [
        center[0] + side[0] * sx * rx + up[0] * sy * ry,
        center[1] + side[1] * sx * rx + up[1] * sy * ry,
        center[2] + side[2] * sx * rx + up[2] * sy * ry,
      ];

      // Marks default to roughly vertical (like short brush strokes shading a portrait top to
      // bottom), with enough jitter to avoid looking combed — same "always some jitter, even at
      // rest" principle as pose/strokes.ts's chain marks.
      const angle = (hash(idBase + 5.7) - 0.5) * 1.1;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const heading: [number, number, number] = [
        up[0] * cosA + side[0] * sinA,
        up[1] * cosA + side[1] * sinA,
        up[2] * cosA + side[2] * sinA,
      ];

      const length = dabSize * (1.3 + hash(idBase + 11.3) * 0.9);
      const width = dabSize * (0.7 + hash(idBase + 13.7) * 0.6);

      strokes.push({
        position: pos,
        velocity: heading,
        length,
        width,
        volume: 0.16 + hash(idBase + 17.9) * 0.08,
        color: style.color,
        seed: idBase * 0.6180339887,
      });
    }
  }

  return strokes;
}
