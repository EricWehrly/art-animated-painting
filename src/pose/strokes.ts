import type { PoseCache } from "./pose-cache";
import type { Chain } from "./skeleton";
import { sampleBoneAtT, type Emitter } from "./emitters";

export interface Stroke {
  position: [number, number, number];
  /** Consumed by stroke-mesh.ts purely as a billboard orientation direction (magnitude
   * doesn't matter, it's normalized in the vertex shader) — for chain strokes this is the
   * blended "paint direction" (see generateChainStrokes), not necessarily the true motion. */
  velocity: [number, number, number];
  /** World-space stroke length. */
  length: number;
  /** World-space stroke width, ∝ bone thickness. */
  width: number;
  /** Feeds the height/relief field — see docs/work/impasto-shading.md. */
  volume: number;
  color: [number, number, number];
  /** Per-instance phase, decorrelates the procedural brush texture between strokes. */
  seed: number;
  /** Whether this dab's start/end should taper into a rounded brush cap (true — a real
   * beginning/end of a brush pass) or blend straight through at full coverage (false — an
   * interior seam continuing from/into an adjacent dab in the same chain). Without this,
   * consecutive dabs along a chain each pinch closed at both ends regardless of whether
   * anything else is touching them there, and a chain of touching dabs reads as a beaded/
   * dashed line instead of one continuous brush stroke. See stroke-mesh.ts strokeShapeGLSL. */
  capStart: boolean;
  capEnd: boolean;
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
  /** How much a dab's own sideways (across-the-bone) instantaneous velocity pushes its
   * position and bends its direction away from the bone's own axis — see the comment on
   * generateChainStrokes for why it's the sideways component specifically, not full velocity. */
  forceScale: number;
  /** Caps how far a dab's orientation can bend away from the bone axis toward the sideways
   * velocity direction (0 = never bends, stays exactly bone-aligned; ~0.5-0.6 = a visible
   * flowing waver without ever flipping to point across the limb). */
  maxWaverBlend: number;
  waverScale: number;
  /** How much local (total) instantaneous speed further stretches a dab's rendered length
   * beyond its paint-load base (still hard-capped at maxStrokeLength) — a fast-moving
   * section smears further, like real pressure dragging the paint out. */
  smearScale: number;
}

/** Deterministic pseudo-random in [0, 1) for a given identity — used for per-stroke paint
 * load/pressure (below) and speckle placement (generateSpeckles). */
function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

const MAX_DABS_PER_CHAIN_SAFETY = 40; // guards against a runaway loop on degenerate (near-zero
// minStrokeLength, or pathologically long chain) data — not a normal limit in practice.

/**
 * Walks each CHAIN (a whole unbranched limb — e.g. hip to toe, or shoulder to wrist; see
 * skeleton.ts buildChains) from its start joint to its end joint as one continuous traveling
 * brush, laying down dabs of paint along the way — "connect the dots" in the sense of tracing
 * the limb's own shape, not stamping each bone independently. This is deliberately NOT "one
 * stroke per bone": painting each bone as its own isolated decision was what made the figure
 * read as a literal skeleton diagram (you could see where each individual bone was, rather
 * than a continuous painted limb) — treating a whole chain as a single ongoing brush pass,
 * only ever restarting ("returning to the paint tray") at branch points between chains,
 * is what makes it read as a figure instead. A dab's length is however far its
 * randomly-varying paint load can carry (capped at maxStrokeLength), so a long chain
 * naturally needs several dabs to cover while a short one needs only one — and when a dab
 * would run past the end of its current bone, the walk continues seamlessly into the next
 * bone in the chain rather than stopping, so consecutive dabs stay position-continuous
 * across a joint (the brush passes through an elbow or knee without lifting).
 *
 * Orientation is the CURRENT bone's own axis, waved by that dab's own instantaneous SIDEWAYS
 * velocity — sampled fresh at each dab's own position (see emitters.ts sampleBoneAtT),
 * deliberately per-dab, not one velocity averaged across a whole bone or chain (see
 * docs/work/pose-pipeline.md Round 3). Using the FULL instantaneous velocity as the
 * orientation outright (tried in Round 3) was wrong for a different reason: a point on a
 * rotating rigid body moves roughly perpendicular to the radius from its pivot, and a bone
 * IS that radius — so a swinging limb's velocity points mostly ACROSS the bone, not along
 * it. The fix (Round 4, unchanged here): decompose velocity relative to the current bone's
 * axis. The along-bone component barely matters for direction (it's already the walk's own
 * travel direction). The across-bone component is what should visibly bend the stroke —
 * layered onto the bone axis and capped at maxWaverBlend, not substituted for it — the
 * "impulse from the bones applies force to the brush strokes... in the direction they're
 * moving" the brief asked for, but happening WITHIN the confines of the brush's own intent to
 * trace the limb, not replacing that intent. See docs/work/pose-pipeline.md "Strokes".
 *
 * Needs cache/frame access to sample arbitrary points adaptively as the walk proceeds, so
 * (unlike the rest of this module) it isn't a pure data transform over pre-computed samples.
 */
export function generateChainStrokes(
  cache: PoseCache,
  chains: Chain[],
  dancerIndex: number,
  frame: number,
  style: BoneStrokeStyle
): Stroke[] {
  const strokes: Stroke[] = [];

  chains.forEach((chain, chainIndex) => {
    // Collected first, capStart/capEnd assigned after the fact — only the very first and
    // very last dab of the WHOLE chain are true brush-lift endpoints; every dab in between is
    // an interior seam and must not taper (see the Stroke.capStart/capEnd doc comment).
    const chainDabs: Omit<Stroke, "capStart" | "capEnd">[] = [];

    // Runs across the WHOLE chain, not reset per bone — keeps paint-load identity, and
    // therefore the visible dab pattern, continuous as the brush crosses joints.
    let dabSlot = 0;
    for (let segIndex = 0; segIndex < chain.jointPath.length - 1 && dabSlot < MAX_DABS_PER_CHAIN_SAFETY; segIndex++) {
      const parentIndex = chain.jointPath[segIndex];
      const childIndex = chain.jointPath[segIndex + 1];
      const thickness = chain.thickness[segIndex];

      const { position: parentPos } = sampleBoneAtT(cache, parentIndex, childIndex, dancerIndex, frame, 0);
      const { position: childPos } = sampleBoneAtT(cache, parentIndex, childIndex, dancerIndex, frame, 1);
      const segVec: [number, number, number] = [
        childPos[0] - parentPos[0],
        childPos[1] - parentPos[1],
        childPos[2] - parentPos[2],
      ];
      const segLen = Math.hypot(segVec[0], segVec[1], segVec[2]);
      // Rig stub joints (zero-offset rotation pivots, e.g. BVH's "Neck"/"LHipJoint") have no
      // real length and nothing to paint — pass straight through to the next bone in the
      // chain rather than emitting a degenerate zero-length dab.
      if (segLen < 0.05) continue;
      const segDir: [number, number, number] = [segVec[0] / segLen, segVec[1] / segLen, segVec[2] / segLen];

      let t = 0;
      while (t < 0.999 && dabSlot < MAX_DABS_PER_CHAIN_SAFETY) {
        const { velocity } = sampleBoneAtT(cache, parentIndex, childIndex, dancerIndex, frame, t);
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);

        // Split velocity into "along the bone" (irrelevant to direction — that's already the
        // walk's own travel axis) and "across the bone" (a rotating limb's actual visible
        // motion relative to its own shape — this is what should wave the stroke).
        const velAlong = velocity[0] * segDir[0] + velocity[1] * segDir[1] + velocity[2] * segDir[2];
        const velAcross: [number, number, number] = [
          velocity[0] - velAlong * segDir[0],
          velocity[1] - velAlong * segDir[1],
          velocity[2] - velAlong * segDir[2],
        ];
        const acrossSpeed = Math.hypot(velAcross[0], velAcross[1], velAcross[2]);
        const acrossDir: [number, number, number] =
          acrossSpeed > 1e-4 ? [velAcross[0] / acrossSpeed, velAcross[1] / acrossSpeed, velAcross[2] / acrossSpeed] : segDir;

        const waverBlend = Math.min(acrossSpeed * style.waverScale, style.maxWaverBlend);
        const paintDirRaw: [number, number, number] = [
          segDir[0] * (1 - waverBlend) + acrossDir[0] * waverBlend,
          segDir[1] * (1 - waverBlend) + acrossDir[1] * waverBlend,
          segDir[2] * (1 - waverBlend) + acrossDir[2] * waverBlend,
        ];
        const paintDirLen = Math.hypot(paintDirRaw[0], paintDirRaw[1], paintDirRaw[2]) || 1;
        const paintDir: [number, number, number] = [
          paintDirRaw[0] / paintDirLen,
          paintDirRaw[1] / paintDirLen,
          paintDirRaw[2] / paintDirLen,
        ];

        const identity = chainIndex * 733 + dabSlot * 7 + 0.5;
        // How much paint this dab picked up, 0..1 — drives both how far it can carry (length)
        // and, scaled by pressureVariance, how thick/voluminous it lays down. One random draw
        // for both, since physically they're the same thing: more paint on the brush means it
        // both goes further AND deposits more material, not two independent coincidences.
        const paintLoad = hash(identity);

        // Coverage math (deciding how much of this bone the dab consumes) uses the UNSCALED
        // base length — lengthScale below is a pure rendered-size knob and must not change
        // stroke count/coverage.
        const baseLength = style.minStrokeLength + paintLoad * (style.maxStrokeLength - style.minStrokeLength);
        const tSpan = Math.min(1 - t, baseLength / segLen);
        const tCenter = t + tSpan / 2;

        const centerPos: [number, number, number] = [
          parentPos[0] + segVec[0] * tCenter,
          parentPos[1] + segVec[1] * tCenter,
          parentPos[2] + segVec[2] * tCenter,
        ];
        // Position gets pushed sideways too, not just the direction bent — a limb swinging
        // through the air should read as paint visibly drifting off its resting line, not
        // just strokes that lean while staying perfectly centered on it.
        const push = acrossSpeed * style.forceScale;
        const position: [number, number, number] = [
          centerPos[0] + acrossDir[0] * push,
          centerPos[1] + acrossDir[1] * push,
          centerPos[2] + acrossDir[2] * push,
        ];

        const renderLength = Math.max(
          0.15,
          Math.min(style.maxStrokeLength, baseLength * (1 + speed * style.smearScale)) * style.lengthScale
        );
        const pressure = 1 + style.pressureVariance * (paintLoad * 2 - 1);

        chainDabs.push({
          position,
          velocity: paintDir,
          length: renderLength,
          width: thickness * style.widthScale * pressure,
          volume: (0.15 + speed * style.volumeScale) * pressure,
          color: style.color,
          seed: identity * 0.6180339887,
        });

        t += tSpan;
        dabSlot++;
      }
    }

    chainDabs.forEach((dab, i) => {
      strokes.push({ ...dab, capStart: i === 0, capEnd: i === chainDabs.length - 1 });
    });
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
        capStart: true,
        capEnd: true,
      });
    }
  });

  return speckles;
}
