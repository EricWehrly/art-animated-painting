---
id: pose-pipeline
parent: roadmap
phase: P1
state: in-progress
---

# pose-pipeline — from BVH to flung strokes

## Why

The skeletons are scaffolding, never rendered. Their only job is to say *where paint should
be thrown and how hard*. This item covers everything from raw mocap to a GPU-ready buffer
of strokes, for both dancers.

## Offline bake

`scripts/bake-pose.mjs` parses the two BVH files, runs forward kinematics, and writes a
compact binary of joint world positions.

Why bake rather than parse at runtime:

| | vendored BVH | baked binary |
|---|---|---|
| payload | ~7 MB of text | ~300 KB |
| runtime | BVH parser + FK every load | one `fetch` + `Float32Array` view |

The bake also decimates 120fps → a chosen sample rate, and trims to a loop-friendly range.

Output layout — a small JSON header (joint names, frame count, rate, bone parent indices)
plus a flat `Float32Array` of `[frame][joint][xyz]`.

## Emitters

Joints alone are too sparse — paint thrown only at elbows and knees reads as a dot pattern.
Instead, sample N points along each **bone segment** (parent → child), each carrying:

- position (world, then projected to screen space against the fixed camera)
- velocity (central difference against the neighbouring baked frames)
- bone id and normalized position along the bone

Bone thickness is a per-bone constant in a small table — torso and thighs throw fat paint,
fingers throw none. Hands and feet are the expressive ends; they get denser sampling.

## Strokes

Each emitter becomes a stroke instance:

- **length** ∝ speed — a still bone dabs, a fast bone streaks
- **angle** = velocity direction in screen space
- **width** ∝ bone thickness
- **volume/height** ∝ speed, feeding the height field in [impasto-shading](impasto-shading.md)
- **color** from the palette, keyed by dancer and bone group — see [art-direction](art-direction.md)

All frames' strokes are baked once into a single interleaved `Float32Array` with a per-frame
offset table, uploaded as one GPU buffer. Drawing a frame is then one instanced draw with an
offset and count. This is the cache that makes replay cheap — and replay is load-bearing for
scrubbing, see [paint-accumulator](paint-accumulator.md).

Budget: 2 dancers × ~20 bones × 8 samples ≈ 320 strokes/frame; ~1200 frames ≈ 384k strokes
≈ 18 MB. Comfortable.

## Done when

Both dancers' strokes for a single scrubbed frame render as flat colored marks in roughly
human arrangement, moving coherently as the scrub bar moves.

## Status

Bake (`scripts/bake-pose.mjs` + `scripts/lib/bvh-parser.mjs`) is written and verified: the
FK output's hip separation matches the raw-BVH numbers recorded in `docs/roadmap.md` exactly,
at every sampled frame. `scripts/fetch-bvh.mjs` pulls the two trials into a gitignored cache
rather than vendoring BVH text, per the "why bake" rationale above. Default bake
(60_01/61_01 @ 30fps) produces 561 frames x 38 joints x 2 dancers, ~500 KB.

Runtime `src/pose/pose-cache.ts`, `skeleton.ts`, `emitters.ts` are written — emitters sample
points along each bone with position + per-frame velocity delta. `src/pose/strokes.ts` now
converts emitters into stroke instances (length ∝ speed, width ∝ bone thickness, volume ∝
speed) — the "Strokes" section above, done as CPU data prep with no GPU dependency.

**Deliberate deviation from the original plan:** strokes are generated per-frame at scrub/
playback time from the cached pose data, not baked into one big offline GPU buffer across all
frames. At ~300 strokes/frame this recompute is trivial CPU work; the "bake every frame's
strokes into one instanced buffer" idea remains the right move once
[paint-accumulator](paint-accumulator.md) needs to replay a K-layer history window fast for
scrubbing — revisit then rather than building it speculatively now.

### Round 2: retargeted from velocity-driven speckling to bone-aligned coverage

The original "Strokes" design above (angle = velocity direction, length ∝ speed) meant a
still or slow-moving bone produced a tiny near-dot stroke and a fast one produced a streak
pointed wherever it happened to be moving — orientation had no relationship to the limb's own
shape at all. On a scrubbed frame this read as scattered speckling with no clear body, not
brushstrokes representing a dancer. User brief: paint should "connect the dots" — cover each
bone with as few strokes as possible, oriented as if the brush is being dragged along that
limb, with the limb's own motion only *pushing* that direction and position (force), not
replacing it. Also asked for uneven pressure — "different amounts of paint" stroke to stroke.

Retargeted in `emitters.ts` and `strokes.ts`:

- **`generateBoneSamples`** (emitters.ts) replaces per-bone dense sampling for the main
  strokes: one sample per bone, carrying both endpoints' positions and the segment's average
  velocity (parent + child central-difference velocity, averaged) rather than many
  independent point samples. `generateEmitters` (the old dense per-point sampler) is kept
  as-is, now used only to feed `generateSpeckles` — the fling/spatter effect still wants
  several velocity samples along a rotating limb, main coverage doesn't.
- **`generateBoneStrokes`** (strokes.ts) replaces `generateStrokes`: orientation is
  `mix(boneDirection, velocityDirection, forceBlend)` where `forceBlend` grows with speed but
  caps at 0.6, so a bone always stays recognizably aligned with the limb it represents even
  during a fast swing — motion bends the stroke, it doesn't take over. Position gets a small
  push along the velocity direction too, proportional to the same force term (paint landing
  slightly ahead of where the limb currently is, like real pressure smearing it forward).
  Stroke count per bone is `round(boneLength / targetStrokeLength)`, clamped to
  `maxStrokesPerBone` (2) — `targetStrokeLength` (10 world units) is set comfortably above the
  longest bone in the CMU rig (thighs/shins, ~7.3 units, measured directly from the baked
  cache), so almost every bone gets exactly **one** stroke. Zero-length rig stub joints (BVH's
  pure-rotation pivots, e.g. "Neck", "LHipJoint") are skipped rather than emitting a
  degenerate dot.
- **Pressure unevenness**: each stroke gets a `pressure` multiplier (`1 ± pressureVariance`,
  new `ToyParams.pressureVariance`, default 0.5) applied to both width and volume, seeded
  deterministically from `(boneIndex, strokeSlotIndex)` — not frame or time, so a bone's
  pressure is a fixed identity that doesn't flicker as the pose animates, but does vary
  stroke to stroke and bone to bone.
- `main.ts`'s per-bone base `widthScale` was raised 0.8 → 1.5: the old system built up visual
  limb thickness through several overlapping samples per bone; one stroke per bone has to
  carry that bulk alone or it reads as a thin connecting line rather than an arm/leg.

Verified visually (swatch canvas unaffected — it builds strokes directly, not through this
path — and the real dance scene, both at a static frame and mid-motion via scrub): the pose
now reads immediately as a stick-figure-like arrangement of directed limb strokes rather than
speckled dots, with visible pressure variation stroke to stroke and visible direction bias on
fast-moving limbs (mid-swing frames show strokes clearly skewed off their resting bone angle).

### Round 3: correction — orientation should be per-dab instantaneous velocity, not one averaged bone direction

User correction after Round 2: "instantaneous velocity" was the intended orientation driver
all along — Round 2 misread the brief as "align to the bone's static geometry, let motion only
bend it," when the actual ask was "align to this specific bone's own motion, not some
aggregate for the whole skeleton or scene." The mistake was literal: `generateBoneSamples`
averaged the parent and child joints' velocities into **one** value for the entire bone and
reused it for every stroke placed on that bone — collapsing exactly the per-point variation
that made a rotating limb's tip move differently than its base. Combined with the
`round(boneLength / targetStrokeLength)` sizing (Round 2), which drove almost every bone to
resolve to exactly one stroke, the result was correctly described as "too straight and
singular": one long, uniformly-angled stroke per limb. Also asked for: a hard max stroke
length, and longer bones covered by *multiple* strokes, with each stroke's length driven by
"how much paint the brush picked up" — explicitly **not** one stroke per bone.

Reworked in `emitters.ts` and `strokes.ts`:

- **`generateBoneSamples` removed.** `sampleBoneAtT(cache, bone, dancerIndex, frame, t)`
  (emitters.ts) is the shared primitive instead — one point's position + true central-
  difference velocity, queried fresh at whatever `t` is needed. `generateEmitters` (fixed
  sample count, feeds speckles) now just calls this in a loop; it used to inline the same
  math directly.
- **`generateBoneStrokes` walks each bone laying down "paint dabs.`** Starting at `t = 0`
  (parent), each iteration: sample `sampleBoneAtT` at the *current* `t` (this dab's own
  instantaneous velocity — not the bone's, not an average), draw a per-dab `paintLoad` in
  `[0, 1)` (deterministic per `(boneIndex, dabSlot)`, not time — same reasoning as pressure in
  Round 2), and set this dab's coverage length to
  `minStrokeLength + paintLoad * (maxStrokeLength - minStrokeLength)` — "how much paint it
  picked up" directly decides "how far it can carry," per the brief, both capped by the new
  hard `maxStrokeLength`. Advance `t` by that dab's coverage fraction and repeat until the
  bone is covered. A long bone (thigh/shin, ~7.3 units, `maxStrokeLength` 3.2) now resolves to
  ~3-4 dabs; short bones (hands, feet, fingers) still resolve to one, since one dab's minimum
  reach already covers them.
- **Orientation is the dab's own instantaneous velocity direction, full stop** (falling back
  to the bone's static direction only when that point is essentially motionless, where a
  velocity direction is undefined/meaningless) — no blend toward bone-geometry capped at some
  fraction, which was the actual bug Round 2 introduced.
- **`paintLoad` also drives pressure**: width/volume get the same `1 + pressureVariance *
  (paintLoad*2-1)` multiplier as before, but now derived from the same random draw as length
  rather than a separate one — physically, more paint on the brush means it goes further *and*
  lays down more material, not two independent coincidences.
- Speed still stretches a dab's *rendered* length a bit further (`smearScale`, still
  hard-capped at `maxStrokeLength`) and pushes its position along the velocity direction
  (`forceScale`) — the "afflicted by velocity pressure" effect survives Round 2, just now
  applied per-dab instead of per-bone-average.
- `widthScale` brought back down 1.5 → 1.2: with several overlapping dabs per long bone again
  contributing to a limb's visual thickness (closer to the original per-point-sampling
  system's approach than Round 2's single carry-it-all stroke), less per-stroke width is
  needed to read as full.

Verified visually on the real dance scene (static frame and mid-motion): long bones now
visibly resolve into several shorter, independently-angled dabs rather than one straight
line — legs and arms both show a rougher, more painterly buildup instead of a geometric
stick-figure look, and mid-motion frames show clear per-dab direction variation (dabs along
the same limb pointing in visibly different directions) rather than one uniform lean.
