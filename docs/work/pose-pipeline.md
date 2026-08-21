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
