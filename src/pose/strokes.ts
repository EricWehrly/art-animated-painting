import type { PoseCache } from "./pose-cache";
import { jointWorldPosition } from "./pose-cache";
import type { Chain } from "./skeleton";
import { sampleBoneAtT, type Emitter } from "./emitters";

/** A single standalone paint dab — a billboard quad, always capped/tapered at both ends. Used
 * for speckles and the swatch calibration page; the main figure's limbs are rendered as
 * connected Ribbon meshes instead (see generateChainRibbons) specifically because independent
 * Stroke instances placed end-to-end show a visible seam at every boundary no matter how
 * their shared parameters are tuned — see docs/work/pose-pipeline.md Round 12. */
export interface Stroke {
  position: [number, number, number];
  /** Consumed by stroke-mesh.ts purely as a billboard orientation direction (magnitude
   * doesn't matter, it's normalized in the vertex shader). */
  velocity: [number, number, number];
  /** World-space stroke length. */
  length: number;
  /** World-space stroke width. */
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
  /** Caps how far the brush's heading can bend away from "straight at its target joint"
   * toward the sideways velocity direction. MUST stay below 0.5: the target-seeking
   * component has to keep a strict majority of the blend, or there is no guarantee the walk
   * ever gets closer to its target — at >=0.5 the sideways impulse can dominate every step,
   * and since the target is fixed but the impulse direction isn't reliably related to it, the
   * walk can run away in a long, mostly-straight excursion (this happened at 0.55; see
   * docs/work/pose-pipeline.md Round 7) instead of converging within a sane number of dabs.
   * Below 0.5, the target-ward component of every step is provably positive even in the
   * worst case (impulse pointing exactly away from the target), guaranteeing convergence. */
  maxWaverBlend: number;
  waverScale: number;
  /** How much local (total) instantaneous speed further stretches a dab's rendered length
   * beyond its paint-load base (still hard-capped at maxStrokeLength) — a fast-moving
   * section smears further, like real pressure dragging the paint out. */
  smearScale: number;
}

/** One entry per dab, for the debug overlay's "each stroke we're intending to take" and
 * "direction/strength of motion" views — see generateChainStrokes' debugOut parameter. */
export interface ChainDebugDab {
  chainIndex: number;
  /** The brush's actual physical position before/after this dab (NOT the render-inflated
   * quad extent Stroke.length uses) — the true walk, exactly as painted. */
  start: [number, number, number];
  end: [number, number, number];
  /** The raw instantaneous velocity sampled for this dab, before waver-blending into a
   * heading. Unlike Stroke.velocity (a billboard direction only), this magnitude is
   * physically meaningful — it's what an arrow's length should represent. */
  rawVelocity: [number, number, number];
}

/** Deterministic pseudo-random in [0, 1) for a given identity — used for per-stroke paint
 * load/pressure (below) and speckle placement (generateSpeckles). */
function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

const MAX_DABS_PER_CHAIN_SAFETY = 40; // guards against a runaway loop on degenerate (near-zero
// minStrokeLength, or pathologically long chain) data — not a normal limit in practice.

/** One point along a chain's painted path — see generateChainRibbons and
 * stroke-mesh.ts's ribbon renderer. Rendered as a single connected strip mesh per chain
 * (adjacent points share actual geometry) instead of independent quad-per-dab instances,
 * which is what let the previous approach's dab boundaries show as a visible seam no matter
 * how the texture/overlap parameters around them were tuned (see docs/work/pose-pipeline.md
 * Round 12 for the diagnosis — width mismatch, texture phase, height-overlap, and edge wobble
 * were each ruled out one at a time; the actual cause was two independently-rendered
 * primitives meeting at a boundary at all, which a connected mesh has none of, by
 * construction). */
export interface RibbonPoint {
  position: [number, number, number];
  /** World-space width at this exact point — the taper the ribbon builder interpolates
   * BETWEEN, so (unlike the old per-dab flat width) there is only ever one width value at any
   * given point on the path, shared by construction between the segment ending there and the
   * one starting there. */
  width: number;
  /** True arc-length distance from the chain's start — feeds stroke-mesh.ts's tear/bristle/
   * facet/lump texture patterns, same purpose as the old Stroke.chainOffset. */
  arcLength: number;
  volume: number;
}

export interface Ribbon {
  points: RibbonPoint[];
  color: [number, number, number];
  /** Per-chain, not per-point — see the old chainSeed doc comment in the previous version of
   * this module for why a fresh seed per point would reopen the same seam problem. */
  seed: number;
}

/**
 * Walks each CHAIN (a whole unbranched limb — e.g. hip to toe, or shoulder to wrist; see
 * skeleton.ts buildChains) from its start joint to its end joint as one continuous traveling
 * brush, producing a sequence of path points that stroke-mesh.ts connects into a single
 * ribbon mesh — "connect the dots" in the sense of tracing the limb's own shape as one
 * physically continuous form, not stamping each bone, or even each dab, independently.
 *
 * The brush is a genuine seeking agent, not a formula sampled independently at each step: it
 * has a current position (wherever the previous step actually left it) and a target (the next
 * joint along the chain), and every step's heading is "straight at the target," bent by that
 * point's own instantaneous SIDEWAYS velocity (capped at maxWaverBlend) — the "impulse from
 * the bones applies force... in the direction they're moving" the brief asked for, but
 * happening WITHIN the confines of the brush's own intent to reach the joint, not replacing
 * it. Critically, this heading is always computed fresh from the brush's ACTUAL current
 * position toward the target, so the walk self-corrects and stays exactly contiguous no
 * matter how much motion bends it.
 *
 * An earlier version (see docs/work/pose-pipeline.md Round 6) computed each dab's position
 * independently — an idealized point along the bone's straight line, PLUS a sideways offset
 * from that dab's own local velocity — and that was wrong in a way that only showed up under
 * real motion: two adjacent dabs sample different local velocities (a rotating limb's tip and
 * base move differently), so their independent sideways offsets don't match, and the "chain"
 * visibly tore apart into disconnected floating strokes the moment anything was actually
 * moving. Continuing the walk from the brush's own last position, instead of recomputing
 * position from scratch each time, is what makes contiguity hold under motion instead of only
 * at rest.
 *
 * Sideways velocity is still sampled fresh per-step at (an estimate of) the brush's own
 * position, not one velocity averaged across a whole bone or chain (see
 * docs/work/pose-pipeline.md Round 3) — a rotating limb's tip and base still move
 * differently, that part of the diagnosis was correct. See docs/work/pose-pipeline.md
 * "Strokes".
 *
 * Needs cache/frame access to sample arbitrary points adaptively as the walk proceeds, so
 * (unlike the rest of this module) it isn't a pure data transform over pre-computed samples.
 */
export function generateChainRibbons(
  cache: PoseCache,
  chains: Chain[],
  dancerIndex: number,
  frame: number,
  style: BoneStrokeStyle,
  /** Optional — when passed, one entry is pushed per walk step as it's computed. Powers the
   * debug overlay (see debug/overlay.ts): the real walk's own data, not a re-derived
   * approximation, so the overlay can never show something the actual generator didn't do.
   * undefined in the normal (non-debug) render path costs nothing beyond the one branch. */
  debugOut?: ChainDebugDab[]
): Ribbon[] {
  const ribbons: Ribbon[] = [];

  chains.forEach((chain, chainIndex) => {
    let brushPos = jointWorldPosition(cache, dancerIndex, frame, chain.jointPath[0]);
    // Runs across the WHOLE chain, not reset per bone — keeps paint-load identity, and
    // therefore the visible step-length pattern, continuous as the brush crosses joints.
    let stepSlot = 0;
    // Constant for every point in this chain (not per-point) so the whole ribbon's bristle/
    // facet/lump texture phase is consistent — only arcLength (below) varies it along the
    // length, which is what makes it read continuous instead of restarting anywhere.
    const chainSeed = chainIndex * 0.6180339887;

    // Width at each JOINT, not each bone — a real limb narrows continuously along its length,
    // it doesn't step in diameter exactly at a knee or elbow. The first/last joints just take
    // their one adjacent bone's thickness; interior joints blend the two bones meeting there,
    // so interpolating between consecutive entries below gives a smooth taper along the whole
    // chain instead of a hard jump at every bone boundary — see docs/work/pose-pipeline.md.
    const jointThickness: number[] = chain.jointPath.map((_, i) => {
      if (i === 0) return chain.thickness[0];
      if (i === chain.jointPath.length - 1) return chain.thickness[chain.thickness.length - 1];
      return (chain.thickness[i - 1] + chain.thickness[i]) / 2;
    });

    let arcLength = 0;
    const points: RibbonPoint[] = [
      { position: brushPos, width: jointThickness[0] * style.widthScale, arcLength: 0, volume: 0.15 },
    ];

    for (let segIndex = 0; segIndex < chain.jointPath.length - 1 && stepSlot < MAX_DABS_PER_CHAIN_SAFETY; segIndex++) {
      const parentIndex = chain.jointPath[segIndex];
      const childIndex = chain.jointPath[segIndex + 1];

      const segStartPos = jointWorldPosition(cache, dancerIndex, frame, parentIndex);
      const targetPos = jointWorldPosition(cache, dancerIndex, frame, childIndex);
      const segVec: [number, number, number] = [
        targetPos[0] - segStartPos[0],
        targetPos[1] - segStartPos[1],
        targetPos[2] - segStartPos[2],
      ];
      const segLen = Math.hypot(segVec[0], segVec[1], segVec[2]);
      // Rig stub joints (zero-offset rotation pivots, e.g. BVH's "Neck"/"LHipJoint") have no
      // real length and nothing to paint — pass straight through to the next bone in the
      // chain rather than emitting a degenerate zero-length step.
      if (segLen < 0.05) {
        brushPos = targetPos;
        continue;
      }
      const segDir: [number, number, number] = [segVec[0] / segLen, segVec[1] / segLen, segVec[2] / segLen];

      while (stepSlot < MAX_DABS_PER_CHAIN_SAFETY) {
        const toTarget: [number, number, number] = [
          targetPos[0] - brushPos[0],
          targetPos[1] - brushPos[1],
          targetPos[2] - brushPos[2],
        ];
        const distToTarget = Math.hypot(toTarget[0], toTarget[1], toTarget[2]);
        if (distToTarget < 0.02) {
          brushPos = targetPos;
          break;
        }
        const desiredDir: [number, number, number] = [
          toTarget[0] / distToTarget,
          toTarget[1] / distToTarget,
          toTarget[2] / distToTarget,
        ];

        // How far along this bone the brush has effectively progressed, for sampling that
        // point's own local velocity — derived from remaining distance-to-target rather than
        // spatially projecting the brush's (possibly drifted) actual position. A spatial
        // projection saturates at 0/1 once the brush drifts off the bone's straight line,
        // which locks velocity sampling onto a CONSTANT value every subsequent step instead
        // of it varying as the walk proceeds — a fixed bias repeated over many steps is
        // exactly what turns a wobble into a runaway straight-line excursion.
        const t = Math.max(0, Math.min(1, 1 - distToTarget / segLen));
        const { velocity } = sampleBoneAtT(cache, parentIndex, childIndex, dancerIndex, frame, t);
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);

        // Split velocity into "along the bone" (irrelevant — the walk already has its own
        // travel direction) and "across the bone" (a rotating limb's actual visible motion
        // relative to its own shape — this is what should wave the heading).
        const velAlong = velocity[0] * segDir[0] + velocity[1] * segDir[1] + velocity[2] * segDir[2];
        const velAcross: [number, number, number] = [
          velocity[0] - velAlong * segDir[0],
          velocity[1] - velAlong * segDir[1],
          velocity[2] - velAlong * segDir[2],
        ];
        const acrossSpeed = Math.hypot(velAcross[0], velAcross[1], velAcross[2]);
        const acrossDir: [number, number, number] =
          acrossSpeed > 1e-4 ? [velAcross[0] / acrossSpeed, velAcross[1] / acrossSpeed, velAcross[2] / acrossSpeed] : desiredDir;

        const waverBlend = Math.min(acrossSpeed * style.waverScale, style.maxWaverBlend);
        const headingRaw: [number, number, number] = [
          desiredDir[0] * (1 - waverBlend) + acrossDir[0] * waverBlend,
          desiredDir[1] * (1 - waverBlend) + acrossDir[1] * waverBlend,
          desiredDir[2] * (1 - waverBlend) + acrossDir[2] * waverBlend,
        ];
        const headingLen = Math.hypot(headingRaw[0], headingRaw[1], headingRaw[2]) || 1;
        const heading: [number, number, number] = [
          headingRaw[0] / headingLen,
          headingRaw[1] / headingLen,
          headingRaw[2] / headingLen,
        ];

        const identity = chainIndex * 733 + stepSlot * 7 + 0.5;
        // How much paint the brush picked up for this step, 0..1 — drives both how far it
        // can carry (length) and, scaled by pressureVariance, how much material it deposits
        // (volume). One random draw for both, since physically they're the same thing: more
        // paint on the brush means it both goes further AND deposits more material, not two
        // independent coincidences.
        const paintLoad = hash(identity);

        // Never overshoot the target in one step — clamping to distToTarget is what lets the
        // walk hand off cleanly to the next joint/segment instead of blowing past it.
        const baseLength = style.minStrokeLength + paintLoad * (style.maxStrokeLength - style.minStrokeLength);
        const stepLength = Math.min(distToTarget, Math.min(style.maxStrokeLength, baseLength * (1 + speed * style.smearScale)));

        const newPos: [number, number, number] = [
          brushPos[0] + heading[0] * stepLength,
          brushPos[1] + heading[1] * stepLength,
          brushPos[2] + heading[2] * stepLength,
        ];

        if (debugOut) {
          debugOut.push({ chainIndex, start: brushPos, end: newPos, rawVelocity: velocity });
        }

        const tEnd = Math.max(0, Math.min(1, 1 - (distToTarget - stepLength) / segLen));
        const width = (jointThickness[segIndex] * (1 - tEnd) + jointThickness[segIndex + 1] * tEnd) * style.widthScale;
        const pressure = 1 + style.pressureVariance * (paintLoad * 2 - 1);

        arcLength += stepLength;
        points.push({ position: newPos, width, arcLength, volume: (0.15 + speed * style.volumeScale) * pressure });

        brushPos = newPos;
        stepSlot++;
      }
    }

    // A single point (chain start only, e.g. every segment was a zero-length stub) has
    // nothing to connect into a ribbon.
    if (points.length < 2) return;

    // Soft taper at the true ends of the chain, so the ribbon reads as a brush lifting off
    // rather than a hard-cut stub — a rounded/tapered tip instead of a flat blunt end.
    points[0].width *= 0.35;
    points[points.length - 1].width *= 0.35;

    ribbons.push({ points, color: style.color, seed: chainSeed });
  });

  return ribbons;
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
