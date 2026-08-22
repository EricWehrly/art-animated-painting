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

### Round 4: a rotating limb's velocity points ACROSS itself, not along it

User feedback with an annotated screenshot: a leg was rendering as a stack of short dashes
running roughly *perpendicular* to the leg — a "ladder" — instead of strokes running along
its length. Their reference sketch showed a single flowing, gently wavering line traveling
along the limb, and they marked the ladder rungs directly on the render for comparison.

The cause is physical, not a tuning miss: Round 3's orientation was "the dab's own
instantaneous velocity, full stop." For a bone that's part of a rotating rigid chain — which
is what nearly all skeletal motion is, joints being rotational — a point's velocity is
roughly *perpendicular* to the radius from its pivot. A bone segment more or less *is* that
radius. So a swinging limb's velocity points mostly **across** the bone, not along it, and
orienting strokes straight at that instantaneous velocity was always going to draw crosswise
dashes on any bone with real angular speed — exactly the ladder in the screenshot. This
wasn't visible on a still pose (near-zero velocity falls back to the bone's own direction,
which looks right) — only on limbs that were actually moving, which is most of them on a
salsa dancer.

Fix, in `strokes.ts` (same walk, same per-dab-not-averaged velocity — that part of Round 3
was correct and stays): decompose each dab's local velocity relative to the bone's own axis.
The along-bone component is irrelevant to orientation (it's already the walk's own travel
direction, parent→child). The across-bone component is what should visibly bend the
stroke — but layered onto the bone axis and capped (`maxWaverBlend`, default 0.55 — up to
roughly a 45-60° lean, never a full flip to perpendicular), not substituted for it outright.
Position also gets pushed sideways by the same across-bone velocity (`forceScale`), so a
swinging limb's dabs visibly drift off the bone's resting line as a group, not just lean
individually — together these two effects are what produce the flowing, wavering line the
reference sketch showed, rather than either a dead-straight stick (Round 2's bug) or a
perpendicular ladder (Round 3's bug).

Verified visually: a still leg (frame 0) now renders as clean diagonal strokes running along
its own length, no ladder rungs. A leg mid-step (scrubbed to a fast frame) shows a gentle
wavering S-curve along its length instead of either a straight line or crosswise dashes.

### Round 5: calm-mode calibration — separating the base figure from the motion effect

User reframed the goal in different terms, worth recording verbatim-in-spirit since it's the
clearest statement of intent so far: the bones are "imaginary lines" — keys for motion, not
what's being painted. What's being painted is the biped, and the brush wants to "connect the
dots" and draw a recognizable stick figure; motion only *compels* the brush *within the
confines of* that base intent, it doesn't replace it. Practical ask: calibrate the base
figure — one relaxed, unhurried stick figure per dancer, single color, recognizable
torso/head/arms/legs, hands not required — *before* judging how well motion bends it, since
right now the two effects (bone coverage geometry vs. motion-driven waver) are only ever seen
tangled together.

Two changes:

- **`ToyParams.duress`** (boolean, default `true`, new checkbox in the params panel): when
  `false`, `strokeStyleFor` zeroes `forceScale`/`waverScale`/`maxWaverBlend`/`smearScale` (see
  Round 4) and both dancers share one color (`colorA`); `renderFrame` skips speckle
  generation entirely (speckles are a motion-fling effect, meaningless at rest). This is pure
  bone-aligned "connect the dots" coverage with nothing else layered on — the calibration
  target.
- **Finger/thumb bones dropped** (`skeleton.ts`): `boneSegments` now skips any bone whose
  child joint name matches thumb/index/middle/ring/pinky/fingerbase. The toy paints a
  recognizable biped, not individual digits, and per-finger segments were pure clutter at
  this scale — direct application of "there doesn't need to be hands, if we can, it's an
  improvement." The actual hand/wrist bone (ForeArm → Hand) is unaffected.

Also found a good calibration frame: a script summing per-joint speed across both dancers
found frame 25 dramatically calmer (energy ≈8) than the clip's median (≈102) or frame 0
(≈417, likely a bake-boundary discontinuity, not a real pose) — used as the "preparing to
dance" reference frame throughout verification.

Verified visually at frame 25 with `duress` off: both dancers render as clean, immediately
recognizable single-color stick figures — head, torso (a stacked column of short spine
segments, reads fine), bent arms, legs in a natural weight-shifted stance — with no
speckle noise and no finger clutter. This is the calibration baseline Round 4's motion
effects (waver/push/smear) get judged against; toggling `duress` back on with the same
scrub position is now the direct A/B for "how much did motion just add."

### Round 6: still "too skeletal" — paint chains, not bones, and stop pinching every seam

User's response to Round 5's calibration figure, reframed again: even calm, the figure looked
"too skeletal — you can see the bones through the image." The complaint wasn't about motion
at all, it was that coverage was still organized *per bone* — each bone got its own
independent dabs, so the figure read as a literal skeleton diagram (individual segments
visible) rather than a continuously painted body. Proposed model: the brush should "know
where it wants to go and work to get there," painting each limb as one ongoing pass with
occasional breaks "to return to the paint tray" — not a mesh, not a third dimension, just a
brush that travels rather than stamps.

Two changes, one data-model and one rendering:

- **`skeleton.ts` `buildChains`**: groups bones into maximal *unbranched* chains — a chain
  ends only at a leaf or a branch point (a joint with 2+ children). Run against the actual
  rig, this produces exactly 6 chains per dancer: left leg (hip→toe), right leg,
  spine→Spine1, Spine1→neck→head, left arm (shoulder→wrist), right arm. This maps precisely
  onto "paint each limb as one continuous pass, lift only at the joints where limbs actually
  branch" — the lift points are also exactly where limbs visually attach, so the figure still
  reads as fully connected even though each chain's paint decisions are independent.
- **`strokes.ts` `generateChainStrokes`** replaces `generateBoneStrokes`: walks a whole chain
  end to end. When a dab's paint-load-based length would run past the end of its current
  bone, the walk continues seamlessly into the next bone in the chain (new `dabSlot` counter
  runs across the WHOLE chain, not reset per bone) rather than stopping — so consecutive dabs
  stay position-continuous across a joint, the brush passes through an elbow or knee without
  lifting. Per-dab orientation/waver logic (Round 4) is unchanged, just re-parameterized by
  "the bone currently under the brush" instead of one fixed bone.

That alone wasn't enough — the figure was still visibly seamed. The remaining cause was in
`stroke-mesh.ts`: every dab's billboard quad tapers to a point at BOTH ends (the brush-cap
shape, with the ragged-edge tear from an earlier round). Even dabs that are perfectly
position-continuous still each pinch closed at their own tips, so a chain of touching dabs
reads as a beaded/dashed line rather than one stroke — the taper itself was the "you can see
the bones" cause, independent of coverage gaps. Fixed by giving `Stroke` two new fields,
`capStart`/`capEnd`: true only for the actual first/last dab of a whole chain (or always true
for speckles and swatch strokes, which are genuinely standalone). Threaded through as new
per-instance attributes (`iCapStart`/`iCapEnd`) to a new pair of varyings in
`strokeShapeGLSL`, which now only apply the tapered/ragged cap fade at a true endpoint —
an interior seam between two dabs of the same chain renders at full coverage right to its
edge instead.

Also found via a script: root cause of an earlier confusing "Browser pane 0x0" issue was
unrelated to the app — the automated browser tool's viewport can end up unset between
sessions in this environment; `resize_window` before first interaction is the fix, not
anything in the toy itself.

Verified visually at frame 25 (calm) and frame 180 (duress on, mid-motion, no console
errors): limbs read as continuous painted forms rather than segmented/beaded chains — a
clear improvement over Round 5's per-bone version at the same calibration frame, though not
independently re-litigated against the reference photos again this round.

### Round 7: contiguity broke under real motion — independent per-dab pushes don't compose

User's read on the frame-180 (duress on) screenshot sent at the end of Round 6: "It looks no
differently than before, just a bunch of flat lines... disjointed and separated." Round 6
only verified motion frames by eye for "no console errors," not for whether the chain fix
actually held under motion — it didn't. Root cause: each dab's position was still computed
independently — an idealized point along the bone's straight line, PLUS a sideways offset
(`push = acrossSpeed * forceScale`) from THAT dab's own local velocity. Two adjacent dabs
sample different local velocities (a rotating limb's tip and base move differently, correctly
per Round 3/4), so their independent sideways pushes don't match — under real motion the
"chain" tore apart into visibly disconnected floating strokes, exactly what the user
described. The Round 6 cap-continuity fix only addressed the *taper* at dab boundaries; it
never addressed the dabs' actual positions coming apart.

Rewrote `generateChainStrokes` as a genuine seeking agent rather than a formula sampled
independently per dab: the brush carries a real current position (wherever the *previous* dab
actually left it, not recomputed from an idealized line) and a target (the next joint). Every
dab's heading is "straight at the target," bent by that point's local sideways velocity
(`maxWaverBlend`) — motion influences *where the brush points next*, never an independent
offset tacked onto a separately-computed position. Because the next dab always starts exactly
where the last one ended, contiguity now holds by construction, under any amount of motion.

This introduced a real bug of its own, caught by a second look at the render rather than by
reasoning about it in advance: with `maxWaverBlend` at its Round 6 value (0.55), the sideways
impulse could outweigh the target-seeking pull (>50% of the blend). At frame 180 this
produced enormous sweeping arcs reaching far outside the figure — the walk wasn't guaranteed
to ever get closer to its target, so on a fast-motion frame it ran away in a mostly-straight
line for up to `MAX_DABS_PER_CHAIN_SAFETY` (40) dabs before the safety cap cut it off. Fixed
two ways: `maxWaverBlend` capped at 0.4, documented as a hard correctness constraint (must
stay below 0.5, or there is no guarantee the target-ward component of a step is ever
positive — see the `BoneStrokeStyle.maxWaverBlend` doc comment for the argument); and the
per-dab velocity sample's `t` (how far along the current bone) is now derived from remaining
distance-to-target (`1 - distToTarget / segLen`) instead of spatially projecting the brush's
actual (possibly drifted) position — the projection saturates at 0/1 once the brush drifts
off-axis, which was locking velocity sampling onto a constant value for many consecutive
dabs and compounding the runaway.

Verified visually at frame 180 (the same frame that showed both the disjointed strokes and,
after the first fix attempt, the runaway arcs): the figure is compact and bounded again, with
visible per-limb waver/bend under motion and no runaway excursions.

### Round 8: joint-shaped bulges — width stepping at bone boundaries, dabs too big

User's next screenshot (calm frame, a single leg) named a more specific version of the "too
skeletal" complaint: visible bulges at each joint, like a beaded/knuckled chain rather than
one smoothly tapering limb. Traced to two contributing causes in `generateChainStrokes`,
both about the CURRENT bone's data being used as a hard constant within its own segment:

- **Width stepped at every bone boundary.** `thickness` was `chain.thickness[segIndex]` — a
  flat constant for an entire bone, jumping to a different constant the instant the walk
  crossed into the next bone. A real limb narrows continuously along its length; it doesn't
  step in diameter exactly at a knee or elbow. Fixed by computing thickness at each JOINT
  instead (`jointThickness`: the two endpoint joints just take their one adjacent bone's
  value, interior joints blend the two bones meeting there) and interpolating between the
  current segment's two joint values using the same `t` (fraction along the segment) already
  computed for velocity sampling — a smooth taper along the whole chain, no steps.
- **Dabs were long and wide enough that each one read as its own distinct segment** rather
  than blending into a continuous mass with its neighbors. `maxStrokeLength` 3.2 → 1.8,
  `minStrokeLength` 1.0 → 0.6 (main.ts) — shorter dabs mean more of them overlap-build any
  given stretch of limb, which is what makes many small brushmarks read as one continuous
  form instead of a chain of visibly distinct capsules. `maxDabsPerChainBudget` (buffer
  sizing) raised 30 → 40 to match `MAX_DABS_PER_CHAIN_SAFETY` exactly, since a long chain at
  the new smaller `minStrokeLength` needs more dabs to cover (~32 worst case, up from ~20).

Verified visually at frame 25 (calm, matching the user's screenshot) and frame 180 (duress
on, mid-motion, no console errors, no regression to the Round 7 runaway/disjointed bugs): a
leg now reads as one continuously tapering form, no visible bulge at the knee or ankle.
