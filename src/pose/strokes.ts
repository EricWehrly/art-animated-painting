import type { PoseCache } from "./pose-cache";
import { jointWorldPosition } from "./pose-cache";
import type { Chain } from "./skeleton";
import { sampleBoneAtT, type Emitter } from "./emitters";

/** A single paint dab — a billboard quad, always capped/tapered at both ends, oriented along
 * `velocity` (a direction only; magnitude is ignored — see stroke-mesh.ts). Used for the main
 * figure's limbs, speckles, and the swatch calibration page alike: a real painted limb is
 * covered by many independent, overlapping brush gestures, not traced by one continuous line
 * — see generateChainMarks. */
export interface Stroke {
  position: [number, number, number];
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
  lengthScale: number;
  volumeScale: number;
  /** How much width/volume vary with how much paint a given mark "picked up" (0 = no
   * variation, every mark is identical; 1 = full range). Paint load is deterministic per
   * (chain, segment, along-slot, lane) — not per-frame — so it doesn't flicker as the pose
   * animates. */
  pressureVariance: number;
  /** Base world-space length of a single gestural mark, before pressure/motion scaling. */
  markLength: number;
  /** Hard clamps on the final (pressure- and motion-scaled) mark length. */
  minMarkLength: number;
  maxMarkLength: number;
  /** Fraction of markLength successive along-arc marks overlap by — 0 = edge to edge, higher
   * = denser coverage. Needs enough overlap that the target region has no gaps once each
   * mark's own soft width/cap taper (see stroke-mesh.ts dabShapeGLSL) eats into its nominal
   * footprint. */
  overlapAlong: number;
  /** Desired world-space width of a single lane/pass. How many parallel passes a limb's local
   * width needs is round(localWidth / markWidth) — a thick limb (hip, thigh) gets several
   * side-by-side marks, a thin one (forearm) gets one. This is what makes an at-rest limb read
   * as a filled painted shape instead of a thin traced wire. */
  markWidth: number;
  /** Always-on small heading deviation (radians) from the bone tangent, present even with no
   * motion at all — a real brush stroke isn't perfectly axial even when a hand is deliberately
   * tracing a line. This, not motion, is what gives the at-rest figure a painted rather than
   * an extruded look. */
  angleJitter: number;
  /** How strongly a mark's heading is pulled from the bone tangent toward the local
   * instantaneous motion direction, per unit speed — the brush "knows the area it wants to
   * paint AND the motion applied to it, and paints along the motion into the area it wants to
   * fill" (see docs/work/pose-pipeline.md Round 13), rather than being required to trace the
   * bone regardless of motion. */
  motionForceScale: number;
  /** Hard cap on how much of the heading blend motion can take over, 0..1. Unlike the old
   * seeking-brush's maxWaverBlend, this has no 0.5 stability ceiling: each mark is an
   * independent short gesture, not one step of a path that has to keep converging on a fixed
   * target, so there is no runaway-walk risk to guard against — this cap is purely an
   * art-direction choice (keep the limb legible even at top speed), not a correctness one. */
  maxMotionForce: number;
  /** How much local speed stretches a mark's length beyond its paint-load base (still clamped
   * to maxMarkLength) — paint thrown by a fast-moving limb streaks further, past where the
   * bone actually is, like the visible wake of the motion rather than a trace of its position. */
  smearScale: number;
}

/** One entry per mark, for the debug overlay's "each stroke we're intending to take" and
 * "direction/strength of motion" views — see generateChainMarks' debugOut parameter. */
export interface ChainDebugDab {
  chainIndex: number;
  /** The mark's actual painted extent (its rendered quad's own long axis), not a walked
   * path segment — there is no walk anymore, each mark is independently placed. */
  start: [number, number, number];
  end: [number, number, number];
  /** The raw instantaneous velocity sampled at this mark's anchor, before heading-blending.
   * Unlike Stroke.velocity (a billboard direction only), this magnitude is physically
   * meaningful — it's what an arrow's length should represent. */
  rawVelocity: [number, number, number];
}

/** Deterministic pseudo-random in [0, 1) for a given identity — used for per-mark paint
 * load/pressure/jitter (below) and speckle placement (generateSpeckles). */
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
 * Covers each CHAIN (a whole unbranched limb — e.g. hip to toe, or shoulder to wrist; see
 * skeleton.ts buildChains) with independent brush marks, instead of walking it as one
 * continuous traveling brush. The target region to fill is the chain's own literal
 * joint-to-joint shape (a "tube" whose width comes from jointThickness, exactly the "outline"
 * the debug overlay draws) — marks are placed to tile that region along its length AND across
 * its width, so a limb's local width decides how many parallel passes it needs, not just its
 * length how many dabs it needs.
 *
 * Each mark's heading defaults to the bone's own tangent (plus a small always-on angle jitter
 * — see BoneStrokeStyle.angleJitter) and is pulled toward the locally-sampled instantaneous
 * velocity direction by an amount that grows with speed (BoneStrokeStyle.motionForceScale/
 * maxMotionForce). A fast-moving mark also stretches longer (smearScale). This is deliberately
 * NOT the old seeking-brush model (see docs/work/pose-pipeline.md Round 6-12), which walked
 * joint to joint and was constrained to always reach the next joint — "the brush knows both
 * the area it wants to paint, and the motion that will be applied to it, and so paints along
 * the motion into the area it wants to fill," not the other way around (see Round 13). Because
 * marks are independent, there is no convergence requirement, and no "must reach the end of
 * the bone" constraint to satisfy.
 *
 * Placement is intentionally irregular — along-slot centers, lane offsets, headings, and
 * lengths all carry independent per-mark jitter — because uniform, identically-spaced,
 * identically-angled marks is exactly what produced the "rings separated by masts" artifact
 * the Round 12 ribbon rewrite was built to eliminate (see docs/work/pose-pipeline.md). That
 * artifact came from mechanical periodicity, not from marks being independent primitives per
 * se — real oil paint IS built from many independent, overlapping, irregular gestures (see the
 * Round 13 reference image), so the fix here is irregularity, not a return to one continuous
 * unbroken mesh (which is why the ribbon mesh from Round 12 is gone: it solved a seam problem
 * this model doesn't have, at the cost of eliminating the very thing — discrete brush marks —
 * that reads as painted).
 *
 * `viewForward` is the camera's fixed look direction (see shell/canvas.ts's "fixed camera"
 * decision) — used to derive each along-slot's across-limb (lane) axis as
 * `bone tangent x viewForward`, the same trick stroke-mesh.ts's now-removed ribbon builder
 * used, without needing per-vertex view-space math.
 *
 * Needs cache/frame access to sample the pose and instantaneous velocity at arbitrary points
 * along each bone, so (unlike generateSpeckles) it isn't a pure data transform over
 * pre-computed samples.
 */
export function generateChainMarks(
  cache: PoseCache,
  chains: Chain[],
  dancerIndex: number,
  frame: number,
  style: BoneStrokeStyle,
  viewForward: [number, number, number],
  /** Optional — when passed, one entry is pushed per mark as it's computed. Powers the debug
   * overlay (see debug/overlay.ts): the real generator's own data, not a re-derived
   * approximation, so the overlay can never show something the actual generator didn't do.
   * undefined in the normal (non-debug) render path costs nothing beyond the one branch. */
  debugOut?: ChainDebugDab[]
): Stroke[] {
  const strokes: Stroke[] = [];

  chains.forEach((chain, chainIndex) => {
    // Width at each JOINT, not each bone — a real limb narrows continuously along its length,
    // it doesn't step in diameter exactly at a knee or elbow. Interior joints blend the two
    // bones meeting there, so interpolating between consecutive entries below gives a smooth
    // taper along the whole chain instead of a hard jump at every bone boundary.
    const jointThickness: number[] = chain.jointPath.map((_, i) => {
      if (i === 0) return chain.thickness[0];
      if (i === chain.jointPath.length - 1) return chain.thickness[chain.thickness.length - 1];
      return (chain.thickness[i - 1] + chain.thickness[i]) / 2;
    });

    for (let segIndex = 0; segIndex < chain.jointPath.length - 1; segIndex++) {
      const parentIndex = chain.jointPath[segIndex];
      const childIndex = chain.jointPath[segIndex + 1];

      const segStart = jointWorldPosition(cache, dancerIndex, frame, parentIndex);
      const segEnd = jointWorldPosition(cache, dancerIndex, frame, childIndex);
      const segVec: [number, number, number] = [segEnd[0] - segStart[0], segEnd[1] - segStart[1], segEnd[2] - segStart[2]];
      const segLen = Math.hypot(segVec[0], segVec[1], segVec[2]);
      // Rig stub joints (zero-offset rotation pivots, e.g. BVH's "Neck"/"LHipJoint") have no
      // real length and nothing to paint.
      if (segLen < 0.05) continue;

      const segDir = normalize(segVec);

      // The across-limb (lane) axis: perpendicular to the bone, in the plane the fixed camera
      // actually sees. Degenerates when the bone happens to point straight at/away from the
      // camera — fall back to world-up as the reference axis rather than collapsing to zero.
      let perpRaw = cross(segDir, viewForward);
      let perpLen = Math.hypot(perpRaw[0], perpRaw[1], perpRaw[2]);
      if (perpLen < 1e-6) {
        perpRaw = cross(segDir, [0, 1, 0]);
        perpLen = Math.hypot(perpRaw[0], perpRaw[1], perpRaw[2]) || 1;
      }
      const perp: [number, number, number] = [perpRaw[0] / perpLen, perpRaw[1] / perpLen, perpRaw[2] / perpLen];

      const width0 = jointThickness[segIndex] * style.widthScale;
      const width1 = jointThickness[segIndex + 1] * style.widthScale;

      const spacing = Math.max(0.15, style.markLength * (1 - style.overlapAlong));
      // At least 2, even on a short bone (hand, foot): a single along-slot has only one
      // randomized paint-load length deciding whether it reaches both ends of its segment, and
      // a short miss there shows up as a visible gap at the joint to the next segment's own
      // coverage. Two independently-jittered slots make that a rare coincidence instead of a
      // structural risk.
      const numAlong = Math.max(2, Math.round(segLen / spacing));

      for (let a = 0; a < numAlong; a++) {
        const idBase = chainIndex * 10000 + segIndex * 137 + a * 11;
        const tBase = (a + 0.5) / numAlong;
        const tJitter = (hash(idBase) - 0.5) * (1 / numAlong) * 0.7;
        const t = Math.max(0, Math.min(1, tBase + tJitter));

        const centerPos: [number, number, number] = [
          segStart[0] + segVec[0] * t,
          segStart[1] + segVec[1] * t,
          segStart[2] + segVec[2] * t,
        ];
        const localWidth = width0 * (1 - t) + width1 * t;
        const numLanes = Math.max(1, Math.round(localWidth / style.markWidth));
        // Lanes evenly divide localWidth exactly, so widen each lane's own rendered width a
        // bit beyond that even division — otherwise adjacent lanes' soft (tear/taper) edges
        // leave a visible gap between them instead of overlapping like real brush passes do.
        const laneWidth = (localWidth / numLanes) * 1.4;

        const { velocity } = sampleBoneAtT(cache, parentIndex, childIndex, dancerIndex, frame, t);
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
        const velDir = speed > 1e-4 ? normalize(velocity) : segDir;

        for (let lane = 0; lane < numLanes; lane++) {
          const laneT = numLanes === 1 ? 0.5 : (lane + 0.5) / numLanes;
          const idLane = idBase * 5 + lane;
          const laneJitter = (hash(idLane + 0.19) - 0.5) * laneWidth * 0.3;
          const laneOffset = (laneT - 0.5) * localWidth + laneJitter;
          // Decorrelates each lane's position ALONG the bone too, not just across it — without
          // this every lane at a given along-slot sits at the exact same t, so adjacent lanes
          // line up into a rigid ladder/ring lattice instead of the staggered, crisscrossing
          // placement real overlapping brush passes have.
          const alongJitter = (hash(idLane + 0.31) - 0.5) * spacing * 0.8;

          const anchor: [number, number, number] = [
            centerPos[0] + perp[0] * laneOffset + segDir[0] * alongJitter,
            centerPos[1] + perp[1] * laneOffset + segDir[1] * alongJitter,
            centerPos[2] + perp[2] * laneOffset + segDir[2] * alongJitter,
          ];

          // Always-on hand-painted deviation from the bone tangent, rotated within the
          // tangent/perp plane (the plane the fixed camera actually sees) — present regardless
          // of motion, per BoneStrokeStyle.angleJitter's doc comment.
          const jitterAngle = (hash(idLane + 0.53) - 0.5) * 2 * style.angleJitter;
          const cosA = Math.cos(jitterAngle);
          const sinA = Math.sin(jitterAngle);
          const jitteredDir: [number, number, number] = [
            segDir[0] * cosA + perp[0] * sinA,
            segDir[1] * cosA + perp[1] * sinA,
            segDir[2] * cosA + perp[2] * sinA,
          ];

          const forceBlend = Math.min(speed * style.motionForceScale, style.maxMotionForce);
          const headingRaw: [number, number, number] = [
            jitteredDir[0] * (1 - forceBlend) + velDir[0] * forceBlend,
            jitteredDir[1] * (1 - forceBlend) + velDir[1] * forceBlend,
            jitteredDir[2] * (1 - forceBlend) + velDir[2] * forceBlend,
          ];
          const heading = normalize(headingRaw);

          const paintLoad = hash(idLane + 0.87);
          const pressure = 1 + style.pressureVariance * (paintLoad * 2 - 1);
          const baseLength = style.markLength * (0.6 + paintLoad * 0.9) * style.lengthScale;
          const length = Math.max(
            style.minMarkLength,
            Math.min(style.maxMarkLength, baseLength * (1 + speed * style.smearScale))
          );

          if (debugOut) {
            debugOut.push({
              chainIndex,
              start: [anchor[0] - heading[0] * length * 0.5, anchor[1] - heading[1] * length * 0.5, anchor[2] - heading[2] * length * 0.5],
              end: [anchor[0] + heading[0] * length * 0.5, anchor[1] + heading[1] * length * 0.5, anchor[2] + heading[2] * length * 0.5],
              rawVelocity: velocity,
            });
          }

          strokes.push({
            position: anchor,
            velocity: heading,
            length,
            width: laneWidth,
            volume: (0.15 + speed * style.volumeScale) * pressure,
            color: style.color,
            seed: idLane * 0.6180339887,
          });
        }
      }
    }
  });

  return strokes;
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
