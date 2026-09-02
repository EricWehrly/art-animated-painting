import type { PoseCache, JointMeta } from "./pose-cache";
import { jointWorldPosition } from "./pose-cache";
import type { Chain } from "./skeleton";
import type { Stroke } from "./strokes";
import { sampleBoneAtT } from "./emitters";

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
  /** Same meaning and role as BoneStrokeStyle's field of the same name — how strongly a
   * mark's heading is pulled toward the neck->head bone's own sampled velocity, per unit
   * speed. 0 (duress off) means the head paints with no motion response at all, matching how
   * the rest of the figure goes still in calm mode. */
  motionForceScale: number;
  maxMotionForce: number;
  smearScale: number;
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
 *
 * Round 21's version filled that disc with a static jittered grid — geometrically correct, but
 * it reads as a shape that was RENDERED and then perspective-distorted, not something that was
 * PAINTED, because nothing about it worked the way pose/strokes.ts's limb coverage does: no
 * paint load, no wobble, no response to motion. Round 22 ports that same brush-pass model into
 * the oval's own 2D (up, side) frame: each "lane" is a vertical brush pass across the oval,
 * with the SAME persistent paint-load-depletion and damped-wobble state a limb lane carries,
 * and its own length is however far that lane's vertical chord actually spans the ellipse at
 * its distance from center (edge lanes are short, the center lane is the full height) — the
 * same "let the region's own shape decide coverage density" principle generateChainMarks uses.
 *
 * Motion intensity is sampled from the neck->head bone itself (real per-frame signal) but
 * deliberately NOT applied as one uniform constant force to every mark — see `attachFalloff`
 * and `catchJitter` below, which soften and spread it: strokes nearer the neck (where the
 * motion is actually anchored) respond more than strokes near the crown, and no two nearby
 * marks catch exactly the same share of it, the same de-correlation trick that fixed limbs
 * reading as a mechanical "comb" under motion (see Round 19).
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

  // Same brush-pass scale as the limb system's defaults (see main.ts's strokeStyleFor) — the
  // head should look like it's made of the same size of gesture as the rest of the figure, not
  // its own miniature texture.
  const markWidth = 0.8 * style.widthScale;
  const stepLength = 1.3 * style.widthScale;
  const stepOverlap = 0.5;
  const wobbleAngle = 0.35;
  const wobbleDamping = 0.35;
  const paintCapacity = 4.5;
  const dryMinLoad = 0.15;
  const dryWidthFactor = 0.45;
  const dryVolumeFactor = 0.4;
  const maxHeadingDeviation = 0.38; // radians, ~22 degrees — same clamp as Round 19's limb fix

  const numLanes = Math.max(3, Math.round((2 * rx) / markWidth));
  const idSalt = dancerIndex * 97411 + headJoints.headJoint * 733;

  for (let lane = 0; lane < numLanes; lane++) {
    // -1..1 across the oval's width. A lane's own vertical run is however far the ellipse
    // actually extends at this x-offset (a chord of the ellipse), not the oval's full height —
    // short near the edges, longest through the center, the same way a limb's local width
    // varies along its own length instead of being uniform.
    const laneX = ((lane + 0.5) / numLanes) * 2 - 1;
    const laneHalfHeight = Math.sqrt(Math.max(0, 1 - laneX * laneX));
    if (laneHalfHeight < 0.08) continue; // a sliver lane right at the oval's edge — skip it

    const laneSeed = idSalt + lane * 677;
    const laneLength = laneHalfHeight * ry * 2;
    const stepSpacing = Math.max(0.12, stepLength * 0.4 * (1 - stepOverlap));
    const numSteps = Math.max(2, Math.round(laneLength / stepSpacing));

    let paintLoad = 0.85 + hash(laneSeed + 0.11) * 0.15;
    let wobble = (hash(laneSeed + 0.23) - 0.5) * wobbleAngle * 0.3;
    let passPos: [number, number, number] = [
      center[0] + side[0] * laneX * rx - up[0] * laneHalfHeight * ry,
      center[1] + side[1] * laneX * rx - up[1] * laneHalfHeight * ry,
      center[2] + side[2] * laneX * rx - up[2] * laneHalfHeight * ry,
    ];

    for (let step = 0; step < numSteps; step++) {
      const stepId = laneSeed * 7 + step * 13;
      // Inclusive endpoints (Round 20's fix) — the lane's own first/last step sit exactly at
      // its chord's true ends, not half a slot short of them.
      const isEndpoint = numSteps > 1 && (step === 0 || step === numSteps - 1);
      const tBase = numSteps === 1 ? 0.5 : step / (numSteps - 1);
      const tJitter = isEndpoint ? 0 : (hash(stepId) - 0.5) * (1 / numSteps) * 0.9;
      const t = Math.max(0, Math.min(1, tBase + tJitter));

      const laneY = -laneHalfHeight + t * laneHalfHeight * 2;
      const idealPos: [number, number, number] = [
        center[0] + side[0] * laneX * rx + up[0] * laneY * ry,
        center[1] + side[1] * laneX * rx + up[1] * laneY * ry,
        center[2] + side[2] * laneX * rx + up[2] * laneY * ry,
      ];
      // BUG (found responding to the user's "trident people" screenshot): this divided by rx
      // (the oval's HALF-width) where generateChainMarks' equivalent divides by the limb's FULL
      // local width — see strokes.ts's `const laneWidthRendered = (localWidth / numLanes) * 1.6`.
      // Using half-width here with a 2.2 multiplier was still only ~1.1x the lane spacing (half
      // of limbs' ~1.6x overlap margin), not enough margin to survive dry-brush width shrinkage
      // (dryWidthFactor down to 0.45x) or motion-driven thinning — lanes lost contact with their
      // neighbours and read as separate fingers/prongs instead of one filled oval, exactly the
      // "gaps miss the whole point of wanting to fill this area in" complaint. Matches
      // strokes.ts's formula exactly now (full width / numLanes * 1.6), same overlap margin
      // limbs already rely on. See docs/work/pose-pipeline.md Round 24.
      const laneWidthRendered = ((2 * rx) / numLanes) * 1.6;

      // Sampled along the real physical neck->head bone, using t as the fraction — gives each
      // lane's own steps a slightly different velocity sample for free, rather than one single
      // frame-wide value applied everywhere.
      const { velocity } = sampleBoneAtT(cache, headJoints.neckJoint, headJoints.headJoint, dancerIndex, frame, t);
      const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
      const forceBlend = Math.min(speed * style.motionForceScale, style.maxMotionForce);
      const motionIntensity = style.maxMotionForce > 0 ? forceBlend / style.maxMotionForce : 0;

      // "Soften and spread... rather than a constant force": strokes nearer the neck (low t,
      // where the motion is actually anchored) carry more of it than strokes near the crown —
      // a spatial falloff, not a uniform pulse applied identically across the whole head.
      const attachFalloff = 1 - 0.35 * t;
      const softenedIntensity = motionIntensity * attachFalloff;

      const wobbleGain = 0.35 + softenedIntensity * 1.4;
      wobble += (hash(stepId + 0.53) - 0.5) * wobbleAngle * wobbleGain;
      wobble *= 1 - wobbleDamping;
      const wobbleClamp = wobbleAngle * wobbleGain;
      wobble = Math.max(-wobbleClamp, Math.min(wobbleClamp, wobble));
      const cosW = Math.cos(wobble);
      const sinW = Math.sin(wobble);
      const baseHeading: [number, number, number] = [
        up[0] * cosW + side[0] * sinW,
        up[1] * cosW + side[1] * sinW,
        up[2] * cosW + side[2] * sinW,
      ];

      const velDir = speed > 1e-4 ? normalize(velocity) : baseHeading;
      // Round 19's de-correlation trick: how much of the available pull actually lands on THIS
      // mark varies per-mark, so nearby strokes don't all lean the same amount in unison.
      const catchJitter = 0.2 + hash(stepId + 1.21) * 0.8;
      const effectiveForceBlend = forceBlend * catchJitter * attachFalloff;
      let heading = normalize([
        baseHeading[0] * (1 - effectiveForceBlend) + velDir[0] * effectiveForceBlend,
        baseHeading[1] * (1 - effectiveForceBlend) + velDir[1] * effectiveForceBlend,
        baseHeading[2] * (1 - effectiveForceBlend) + velDir[2] * effectiveForceBlend,
      ]);
      const alongUp = heading[0] * up[0] + heading[1] * up[1] + heading[2] * up[2];
      if (alongUp < Math.cos(maxHeadingDeviation)) {
        const crossComponent: [number, number, number] = [
          heading[0] - up[0] * alongUp,
          heading[1] - up[1] * alongUp,
          heading[2] - up[2] * alongUp,
        ];
        const crossLen = Math.hypot(crossComponent[0], crossComponent[1], crossComponent[2]) || 1;
        const cosMax = Math.cos(maxHeadingDeviation);
        const sinMax = Math.sin(maxHeadingDeviation);
        heading = [
          up[0] * cosMax + (crossComponent[0] / crossLen) * sinMax,
          up[1] * cosMax + (crossComponent[1] / crossLen) * sinMax,
          up[2] * cosMax + (crossComponent[2] / crossLen) * sinMax,
        ];
      }

      const lengthJitter = 0.6 + hash(stepId + 0.67) * 0.8;
      const walkLength = Math.max(stepLength * 0.4 * 0.4, stepLength * 0.4 * lengthJitter);
      const smearBonus = Math.min(speed * style.smearScale, 0.5);
      const renderLength = walkLength * (1 + smearBonus);

      const walked: [number, number, number] = [
        passPos[0] + heading[0] * walkLength,
        passPos[1] + heading[1] * walkLength,
        passPos[2] + heading[2] * walkLength,
      ];
      const containmentPull = 0.75 - softenedIntensity * 0.2;
      let anchor: [number, number, number] = [
        walked[0] + (idealPos[0] - walked[0]) * containmentPull,
        walked[1] + (idealPos[1] - walked[1]) * containmentPull,
        walked[2] + (idealPos[2] - walked[2]) * containmentPull,
      ];
      const offset: [number, number, number] = [anchor[0] - idealPos[0], anchor[1] - idealPos[1], anchor[2] - idealPos[2]];
      const offsetLen = Math.hypot(offset[0], offset[1], offset[2]);
      const maxOffset = Math.max(laneWidthRendered * 2, 0.3);
      if (offsetLen > maxOffset) {
        const clampScale = maxOffset / offsetLen;
        anchor = [idealPos[0] + offset[0] * clampScale, idealPos[1] + offset[1] * clampScale, idealPos[2] + offset[2] * clampScale];
      }
      passPos = anchor;

      const loadFrac = Math.max(0, Math.min(1, paintLoad));
      const dryWidthMul = dryWidthFactor + (1 - dryWidthFactor) * loadFrac;
      const dryVolumeMul = dryVolumeFactor + (1 - dryVolumeFactor) * loadFrac;
      const pressureNoise = 1 + 0.5 * (0.45 + softenedIntensity * 0.55) * (hash(stepId + 0.87) * 2 - 1);

      const width = laneWidthRendered * dryWidthMul * pressureNoise * (1 - softenedIntensity * 0.35);
      const volume = Math.max(0.05, 0.2 - softenedIntensity * 0.3 * 0.4) * dryVolumeMul * pressureNoise;

      strokes.push({
        position: anchor,
        velocity: heading,
        length: renderLength,
        width,
        volume,
        color: style.color,
        seed: stepId * 0.6180339887,
      });

      const consumed = renderLength / paintCapacity;
      paintLoad -= consumed;
      if (paintLoad <= dryMinLoad) {
        paintLoad = 0.85 + hash(stepId + 1.03) * 0.15;
      }
    }
  }

  return strokes;
}
