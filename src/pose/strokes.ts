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
  /** Extra multiplicative width/volume shake per step, layered on top of the paint-load
   * depletion below — "uneven pressure," not just "less paint." */
  pressureVariance: number;

  /** World-space length of one placed dab within a brush pass, before motion stretch. Kept
   * elongated relative to markWidth — a near-square dab reads as a stamped coin/ring, not a
   * gesture (see docs/work/pose-pipeline.md Round 13's first attempt). */
  stepLength: number;
  /** Fraction consecutive steps within a pass overlap by. */
  stepOverlap: number;
  /** Desired world-space width of a single lane/pass. How many parallel passes a limb's local
   * width needs is round(localWidth / markWidth) — a thick limb (hip, thigh) gets several
   * side-by-side passes, a thin one (forearm) gets one. */
  markWidth: number;

  /** Max angular deviation (radians) a pass's heading can wander from the bone tangent at any
   * one step. Drives a persistent, damped random walk carried across a whole pass's steps —
   * a shaky hand's wander, not independent per-step static — which is what stops the figure
   * reading as "homogenous, mono-directional lines" (see docs/work/pose-pipeline.md Round 14). */
  wobbleAngle: number;
  /** How strongly the wobble is pulled back toward the bone tangent each step, 0..1 — keeps a
   * pass "trying to move in the same general direction" instead of wandering into negative
   * space, per the positive/negative-space framing in Round 14. */
  wobbleDamping: number;

  /** World-length one brush "load" of paint can cover before running dry. */
  paintCapacity: number;
  /** Paint-load fraction (0..1, where 1 = a fresh load) below which the brush is considered
   * dry and the FOLLOWING step reloads to a fresh load — this is the "go back and dab the
   * paint again" moment, and it needs to be visible, not just implied: see dryWidthFactor/
   * dryVolumeFactor. */
  dryMinLoad: number;
  /** How thin (width) / faint (volume) a fully-dry step renders, relative to a fresh one —
   * 0 = nearly invisible when dry, 1 = no depletion effect at all. */
  dryWidthFactor: number;
  dryVolumeFactor: number;

  /** How strongly a step's heading is pulled from its wobbling base direction toward the local
   * instantaneous motion direction, per unit speed — layered ON TOP of the base loading/
   * wobble/depletion behaviour above, not a replacement for it (see Round 14: "then we're
   * going to add the impulse of motion on top of that"). */
  motionForceScale: number;
  /** Hard cap on how much of the heading blend motion can take over, 0..1 — an art-direction
   * choice, not a stability requirement (each step is independent, so there's no convergence
   * risk to guard against — see Round 13's doc comment on the old seeking-brush maxWaverBlend). */
  maxMotionForce: number;
  /** How much local speed stretches a step's RENDERED length beyond its base, capped at +80%
   * (see generateChainMarks' smearBonus) — deliberately does NOT affect how far the brush's
   * own hand-position actually walks (see walkLength) — see docs/work/pose-pipeline.md
   * Round 15: conflating those two was what let a fast step both draw a longer streak AND
   * physically relocate far from the target region, rather than "accentuating... slightly." */
  smearScale: number;
  maxMarkLength: number;

  /** Per-step speed above which a step also throws a couple of speckles from its own forward
   * tip — "the breaking point of the brush's fervor," sourced from the actual painted stroke
   * rather than an independent sampling pass (see docs/work/pose-pipeline.md Round 14). */
  speckleSpeedThreshold: number;
}

/** One entry per mark, for the debug overlay's "each stroke we're intending to take" and
 * "direction/strength of motion" views — see generateChainMarks' debugOut parameter. */
export interface ChainDebugDab {
  chainIndex: number;
  /** The mark's actual painted extent (its rendered quad's own long axis). */
  start: [number, number, number];
  end: [number, number, number];
  /** The raw instantaneous velocity sampled at this mark's anchor, before heading-blending.
   * Unlike Stroke.velocity (a billboard direction only), this magnitude is physically
   * meaningful — it's what an arrow's length should represent. */
  rawVelocity: [number, number, number];
}

/** Deterministic pseudo-random in [0, 1) for a given identity — used for per-step paint
 * load/wobble/jitter (below) and speckle placement (generateSpeckles). */
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
 * skeleton.ts buildChains) with brush marks, treating the chain's own joint-to-joint shape as
 * the region to fill — "positive space" the strokes paint into, versus the negative space
 * around it they should mostly avoid — rather than a bone to trace.
 *
 * Each bone segment is covered by several parallel LANES across its width (thick limbs get
 * more lanes, thin ones fewer — same coverage idea as Round 13). What's new is what happens
 * WITHIN a lane: instead of independently-jittered single marks, a lane is a simulated brush
 * PASS — the brush dabs into the paint tray once (a fresh, full paint load), then strokes
 * along the bone in a sequence of steps whose heading does a small, damped random walk around
 * the bone tangent (a shaky hand trying to hold a general direction, not a straight ruled
 * line, and not independent per-step noise either — the wobble carries over step to step).
 * Each step consumes some of the current paint load; as the load runs low the step renders
 * thinner and fainter (dryWidthFactor/dryVolumeFactor), and once it drops below dryMinLoad the
 * NEXT step reloads back to a fresh load — a visible thick/thin/thick cycle down each lane,
 * matching a real brush being dipped, dragged until it runs dry, and dipped again.
 *
 * Motion is layered ON TOP of that base behaviour, not instead of it: a step's heading is
 * pulled from its wobbling base direction toward the locally-sampled instantaneous velocity
 * direction by an amount that grows with speed (motionForceScale/maxMotionForce), and a fast
 * step also stretches longer and drains its paint load faster (smearScale) — paint thrown by
 * a fast-moving limb streaks past the bone and runs the brush dry sooner, rather than tracing
 * the limb's position. See docs/work/pose-pipeline.md Round 14.
 *
 * This replaces Round 13's independent-single-mark model, which (after fixing an earlier
 * "rings" regression via elongation/decorrelation) still read as "homogenous, mono-directional
 * lines" — every mark's own one-shot jitter was independent of its neighbours, so nothing
 *"flowed." A persistent per-lane wobble plus visible loading/depletion is what turns that into
 * something that reads as one hand's actual brush passes.
 *
 * `viewForward` is the camera's fixed look direction (see shell/canvas.ts's "fixed camera"
 * decision) — used to derive each lane's across-limb axis as `bone tangent x viewForward`.
 *
 * `emittersOut`, like `debugOut`, is optional and additive: when passed, every step whose
 * sampled speed exceeds `style.speckleSpeedThreshold` also pushes an Emitter at its own
 * forward tip, so speckles (see generateSpeckles below) originate from the actual painted
 * stroke that's moving fastest, rather than an independent bone-sampling pass — see Round 14.
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
   * approximation, so the overlay can never show something the actual generator didn't do. */
  debugOut?: ChainDebugDab[],
  /** Optional — when passed, fast steps push an emitter at their own tip for generateSpeckles
   * to consume. See the module doc comment above. */
  emittersOut?: Emitter[]
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
      // One lane COUNT per whole segment (from its mid-length width), not re-derived per step
      // — a lane is a single simulated brush pass with state (paint load, wobble) that
      // persists down the segment, so the number of lanes can't change partway through it.
      const numLanes = Math.max(1, Math.round(((width0 + width1) / 2) / style.markWidth));

      const stepSpacing = Math.max(0.12, style.stepLength * (1 - style.stepOverlap));
      // At least 2 steps even on a short bone (hand, foot) — one step has only one randomized
      // length deciding whether it bridges to the next segment's own coverage, and a short
      // miss there is a visible gap at the joint.
      const numSteps = Math.max(2, Math.round(segLen / stepSpacing));

      for (let lane = 0; lane < numLanes; lane++) {
        const laneT = numLanes === 1 ? 0.5 : (lane + 0.5) / numLanes;
        const laneSeed = chainIndex * 100000 + segIndex * 677 + lane * 131;

        // Persistent per-lane-pass state, carried across this segment's steps: a fresh paint
        // load (see the module doc comment), a small initial wobble offset, and the brush's
        // own actual position — which now WALKS under the wobbling heading below rather than
        // snapping back to a geometrically-ideal point every step. A wobble that only tilted
        // each independently-placed mark, without letting it actually carry the anchor
        // sideways, barely read as shakiness — real hand tremor moves where the brush IS, not
        // just which way it's pointed.
        let paintLoad = 0.85 + hash(laneSeed + 0.11) * 0.15;
        // Small initial offset, not a full-magnitude one — the very first step has had no
        // chance yet to be pulled back by containmentPull below, so starting near the tangent
        // is what keeps a pass beginning right at its joint instead of visibly missing it.
        let wobble = (hash(laneSeed + 0.23) - 0.5) * style.wobbleAngle * 0.3;
        let passPos: [number, number, number] = [
          segStart[0] + perp[0] * (laneT - 0.5) * width0,
          segStart[1] + perp[1] * (laneT - 0.5) * width0,
          segStart[2] + perp[2] * (laneT - 0.5) * width0,
        ];

        for (let step = 0; step < numSteps; step++) {
          const stepId = laneSeed * 7 + step * 13;
          const tBase = (step + 0.5) / numSteps;
          const tJitter = (hash(stepId) - 0.5) * (1 / numSteps) * 0.5;
          const t = Math.max(0, Math.min(1, tBase + tJitter));

          const localWidth = width0 * (1 - t) + width1 * t;
          // The lane's IDEAL track — where a perfectly steady hand would be at this point —
          // used only as a soft correction target below, not as the rendered position itself.
          const idealPos: [number, number, number] = [
            segStart[0] + segVec[0] * t + perp[0] * (laneT - 0.5) * localWidth,
            segStart[1] + segVec[1] * t + perp[1] * (laneT - 0.5) * localWidth,
            segStart[2] + segVec[2] * t + perp[2] * (laneT - 0.5) * localWidth,
          ];
          // Lanes evenly divide localWidth exactly, so widen each lane's own rendered width a
          // bit beyond that even division — otherwise adjacent lanes' soft (tear/taper) edges
          // leave a visible gap instead of overlapping like real brush passes do.
          const laneWidthRendered = (localWidth / numLanes) * 1.6;

          // Persistent, damped random walk around the bone tangent — a shaky hand trying to
          // hold a general direction, not independent per-step noise (see the module doc
          // comment). Damping pulls it back toward 0 (straight along the tangent) each step,
          // which is what keeps a pass "trying to move in the same general direction."
          wobble += (hash(stepId + 0.53) - 0.5) * style.wobbleAngle;
          wobble *= 1 - style.wobbleDamping;
          wobble = Math.max(-style.wobbleAngle, Math.min(style.wobbleAngle, wobble));
          const cosW = Math.cos(wobble);
          const sinW = Math.sin(wobble);
          const baseHeading: [number, number, number] = [
            segDir[0] * cosW + perp[0] * sinW,
            segDir[1] * cosW + perp[1] * sinW,
            segDir[2] * cosW + perp[2] * sinW,
          ];

          const { velocity } = sampleBoneAtT(cache, parentIndex, childIndex, dancerIndex, frame, t);
          const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
          const velDir = speed > 1e-4 ? normalize(velocity) : baseHeading;

          // Motion layered on top of the base wobbling heading, not instead of it.
          const forceBlend = Math.min(speed * style.motionForceScale, style.maxMotionForce);
          const heading = normalize([
            baseHeading[0] * (1 - forceBlend) + velDir[0] * forceBlend,
            baseHeading[1] * (1 - forceBlend) + velDir[1] * forceBlend,
            baseHeading[2] * (1 - forceBlend) + velDir[2] * forceBlend,
          ]);

          const lengthJitter = 0.8 + hash(stepId + 0.67) * 0.4;
          // walkLength (how far the brush's own hand actually travels this step) is
          // deliberately NOT motion-smeared — only renderLength (the visible mark) is. Using
          // one smeared value for both was Round 14's real bug: a fast step didn't just draw a
          // longer streak, it physically relocated the anchor that much further before
          // containmentPull could correct it, and since sustained motion keeps doing this
          // every step in roughly the same direction, the correction never catches up — "the
          // strokes are... WAY displaced from where the debug indicates we should want them to
          // be," not just accentuated. See docs/work/pose-pipeline.md Round 15.
          const walkLength = Math.max(style.stepLength * 0.4, style.stepLength * lengthJitter * style.lengthScale);
          // Motion still visibly drags the MARK out — "we do want them longer (at a reasonable
          // proportion)... dragged out a little" — capped well short of maxMarkLength so that
          // stays a hard safety ceiling, not the normal operating point.
          const smearBonus = Math.min(speed * style.smearScale, 0.8);
          const renderLength = Math.min(style.maxMarkLength, walkLength * (1 + smearBonus));

          // Walk the lane's own actual position under the wobbling heading — this, not just
          // tilting an independently-placed mark, is what makes the shakiness visible: the
          // brush's real position drifts, not merely which way each stationary mark points.
          // Softly corrected back toward the lane's ideal track afterward (containmentPull) so
          // a run of unlucky wobble draws can't wander the pass out into negative space — the
          // positive/negative-space framing this round asked for "not strictly confined... but
          // touch as little negative space as possible."
          const walked: [number, number, number] = [
            passPos[0] + heading[0] * walkLength,
            passPos[1] + heading[1] * walkLength,
            passPos[2] + heading[2] * walkLength,
          ];
          const containmentPull = 0.6;
          const anchor: [number, number, number] = [
            walked[0] + (idealPos[0] - walked[0]) * containmentPull,
            walked[1] + (idealPos[1] - walked[1]) * containmentPull,
            walked[2] + (idealPos[2] - walked[2]) * containmentPull,
          ];
          passPos = anchor;

          // Loading/depletion — how full the brush was AT THE START of this step decides how
          // richly it paints; the load is then spent (faster for a longer/motion-stretched
          // step) and, once dry, reloads for the step after this one.
          const loadFrac = Math.max(0, Math.min(1, paintLoad));
          const dryWidthMul = style.dryWidthFactor + (1 - style.dryWidthFactor) * loadFrac;
          const dryVolumeMul = style.dryVolumeFactor + (1 - style.dryVolumeFactor) * loadFrac;
          const pressureNoise = 1 + style.pressureVariance * 0.5 * (hash(stepId + 0.87) * 2 - 1);

          // A forceful step reads as slightly bolder too, not just longer — reuses the same
          // capped smearBonus so this can't run away any more than the length can.
          const width = laneWidthRendered * dryWidthMul * pressureNoise * (1 + smearBonus * 0.3);
          const volume = (0.15 + speed * style.volumeScale) * dryVolumeMul * pressureNoise;

          if (debugOut) {
            debugOut.push({
              chainIndex,
              start: [
                anchor[0] - heading[0] * renderLength * 0.5,
                anchor[1] - heading[1] * renderLength * 0.5,
                anchor[2] - heading[2] * renderLength * 0.5,
              ],
              end: [
                anchor[0] + heading[0] * renderLength * 0.5,
                anchor[1] + heading[1] * renderLength * 0.5,
                anchor[2] + heading[2] * renderLength * 0.5,
              ],
              rawVelocity: velocity,
            });
          }

          strokes.push({
            position: anchor,
            velocity: heading,
            length: renderLength,
            width,
            volume,
            color: style.color,
            seed: stepId * 0.6180339887,
          });

          if (emittersOut && speed > style.speckleSpeedThreshold) {
            emittersOut.push({
              position: [
                anchor[0] + heading[0] * renderLength * 0.5,
                anchor[1] + heading[1] * renderLength * 0.5,
                anchor[2] + heading[2] * renderLength * 0.5,
              ],
              velocity,
              thickness: width,
              t,
            });
          }

          const consumed = renderLength / style.paintCapacity;
          paintLoad -= consumed;
          if (paintLoad <= style.dryMinLoad) {
            paintLoad = 0.85 + hash(stepId + 1.03) * 0.15;
          }
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
  /** World-space radius speckles scatter from the stroke tip, along and across its direction —
   * kept small when emitters come from generateChainMarks (see Round 14): the point is to read
   * as the breaking point of an actual stroke's own fling, not an independent scatter effect
   * floating near it. */
  spread: number;
  sizeScale: number;
}

/**
 * Small flung droplets beyond each fast-moving emitter's tip — the spatter/speckle look from
 * a real paint fling, distinct from the main brush-shaped strokes. Reuses the Stroke type and
 * the same stroke-mesh rendering: a speckle is just a small, nearly round stroke, so no new
 * geometry or shader is needed. See docs/work/pose-pipeline.md "Strokes".
 *
 * Scatter is deliberately anisotropic — jitter only ACROSS the fling direction (via an
 * arbitrary perpendicular basis), never along it — and droplet size/elongation scale up with
 * how fast the emitter was moving. An isotropic jitter cloud reads as generic noise; a tight,
 * increasingly-stretched spray along one direction reads as an actual fling. See
 * docs/work/pose-pipeline.md Round 15.
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

    let perpA = cross(dir, [0, 1, 0]);
    let perpALen = Math.hypot(perpA[0], perpA[1], perpA[2]);
    if (perpALen < 1e-6) {
      perpA = cross(dir, [1, 0, 0]);
      perpALen = Math.hypot(perpA[0], perpA[1], perpA[2]) || 1;
    }
    perpA = [perpA[0] / perpALen, perpA[1] / perpALen, perpA[2] / perpALen];
    const perpB = cross(dir, perpA); // already unit — dir and perpA are orthonormal

    // A gentle fling barely above threshold stays a tight, small spray; a violent one throws
    // fewer-but-bigger, more visibly stretched droplets further out — "accentuated... dragged
    // out a little," the same shape the main strokes' render-length change follows above.
    const elongation = 1 + speedRatio * 1.6;
    const acrossSpread = style.spread * (0.15 + speedRatio * 0.35);

    for (let k = 0; k < count; k++) {
      const seed = frame * 97.13 + i * 13.7 + k * 7.31;
      const r1 = hash(seed);
      const r2 = hash(seed + 0.37);
      const r3 = hash(seed + 0.71);
      const r4 = hash(seed + 1.13);

      const flingDist = style.spread * (0.5 + r1 * 1.5) * speedRatio;
      const acrossA = (r3 - 0.5) * acrossSpread;
      const acrossB = (r4 - 0.5) * acrossSpread;

      speckles.push({
        position: [
          e.position[0] + dir[0] * flingDist + perpA[0] * acrossA + perpB[0] * acrossB,
          e.position[1] + dir[1] * flingDist + perpA[1] * acrossA + perpB[1] * acrossB,
          e.position[2] + dir[2] * flingDist + perpA[2] * acrossA + perpB[2] * acrossB,
        ],
        velocity: e.velocity,
        length: style.sizeScale * (0.5 + r1 * 0.6) * elongation,
        width: style.sizeScale * (0.3 + r2 * 0.4) * (1 - speedRatio * 0.2),
        volume: (0.04 + r1 * 0.06) * (1 + speedRatio * 0.6),
        color: style.color,
        seed,
      });
    }
  });

  return speckles;
}
