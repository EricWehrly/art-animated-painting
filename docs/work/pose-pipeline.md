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

### Round 9: still "joint-heavy" at zero motion — the beading was never about motion at all

User reframed the whole approach: "Use the bones to derive a shape. Try to paint the shape.
... Stop having the bones be where we draw / start drawing." The concrete test: render the
FIRST frame with no force (duress off) and check whether it reads as a stick figure or a
jointed skeleton. It read as the latter — confirmed by rendering frame 0, calm mode, and
zooming into a single leg/arm: a visible chain of distinct beads at fairly regular intervals,
independent of any motion effect (duress was off the whole time). Four separate causes, found
by removing one at a time and re-rendering the same zoomed crop after each fix:

1. **Width pulsed randomly per dab.** `pressure` (from `pressureVariance`, meant to vary how
   much paint a dab laid down) was also multiplied into `width` — so the limb's own silhouette
   randomly widened and narrowed every dab, on top of the smooth Round 8 taper, each swing
   reading as a knuckle. Fixed: width now comes ONLY from `jointThickness` (the smooth taper);
   `pressure` still scales `volume` (how much material a dab deposits) but can no longer
   change the outline it paints.
2. **Every dab's surface texture restarted its own phase at 0.** The tear/bristle/facet/lump
   patterns in `stroke-mesh.ts` (added earlier for the impasto knife-daub look) were all
   functions of each dab's own *local* 0..1 coordinate — so even two touching, identically-
   oriented, identically-wide dabs had uncorrelated texture, and the mismatch at their shared
   edge read as a seam. Fixed by adding `Stroke.chainOffset` — the dab's true arc-length
   position along the WHOLE chain, tracked as `generateChainStrokes` walks — and switching
   those texture patterns to a continuous coordinate (`vChainOffset + vUv.x * vLength`) built
   from it, so a texture cycle that starts in one dab now correctly continues into the next
   instead of resetting. Also switched the per-dab random `seed` to a per-CHAIN constant, for
   the same reason (a fresh random seed per dab was its own source of discontinuity).
3. **Facet/bristle shading was coupled into ALPHA, not just richness.** `alpha` (coverage —
   is there paint here at all) included the `bristle`/`facetShade` factor, which was designed
   to vary a stroke's *richness* but does so by dipping toward 0 — fine on one big calibration
   swatch, but on a whole limb built from many dabs, a low-facet dip reads as a literal
   transparent gap, and a run of them (a facet cell is a fixed world-size, so a short dab can
   BE one cell) reads as a beaded chain with actual holes between beads. Decoupled: `alpha`
   is now just `widthMask * endCap` (shape only); richness still varies pigment (color pass)
   and height (below), just can't punch holes in the shape's own coverage anymore.
4. **The real dominant cause: height accumulates additively, uncorrected for overlap.**
   Chasing the residual banding (still strong after fixes 1-3) led to comparing
   `shading-pass.ts` against `colorFragmentShader`: color divides its accumulated sum by
   accumulated alpha before use (`colorSum.rgb / colorSum.a`), recovering a proper average —
   but height is read raw (`texture(uHeightSum, uv).r`), with no equivalent normalization.
   Round 6 had deliberately rendered each dab ~35% longer than its physical travel so
   neighboring dabs would overlap (that was the fix attempted for cause 2, before chainOffset
   existed) — every overlap zone was therefore getting height from TWO dabs summed, a real
   doubled bump at every dab boundary, which is what dominated regardless of how much the
   procedural texture amplitude (cause 2/3 fixes) was tuned down. Fixed by shrinking the
   render-length inflation back to ~1.03x (just enough to avoid a hairline gap) now that
   chainOffset (fix 2) makes texture continuity hold without deliberate overlap. Also bumped
   base `widthScale` 1.2 → 1.7 (main.ts) — with the beading gone, the figure read as a
   hairline wire rather than a painted shape at the old width.

Verified visually at frame 0, calm mode, zoomed to a single leg/arm after each of the four
fixes — the beaded/gapped look is gone; a limb now reads as one continuous tapering painted
shape with subtle (not seam-like) texture. Checked frame 180 (duress on) for regressions:
still bounded/contiguous, no runaway or disjointed strokes.

### Round 10: a diagnostic overlay, so the generator's own data is checkable without guessing

Requested directly, and reasonable given how much of Rounds 3-9 was "render, zoom, squint,
theorize, re-render" — a debug view onto the generator's actual working data, not just its
painted output. Three layers, toggled by a new `debugMode` param (main.ts's "debug overlay"
checkbox), rendered by the new `debug/overlay.ts`:

1. **The outline/character being painted** — the raw chain joint-to-joint polyline (thin
   white), i.e. literally the "skeleton" the paint strokes are deliberately NOT supposed to
   trace on their own. Useful as a registration reference against the painted shape.
2. **Each intended stroke** — every dab's true physical start/end, alternating two colors so
   adjacent dabs read as distinct strokes rather than one line.
3. **Motion arrows** — direction and magnitude of the RAW instantaneous velocity sampled at
   each dab (not the blended heading `Stroke.velocity` carries for billboard orientation,
   whose magnitude is meaningless — see that field's doc comment).

Layers 2 and 3 are sourced from `generateChainStrokes` itself via a new optional `debugOut`
parameter it pushes a `ChainDebugDab` into per dab — deliberately not a parallel/re-derived
computation, so the overlay can never show something the real generator didn't actually do.

Rendering mechanics: the actual paint never touches the camera-rendered `scene` object at all
(strokes go through an offscreen height-pass, then shading-pass draws a full-screen quad
straight to the default framebuffer) — so the debug overlay is a second, ordinary
camera-rendered `THREE.Scene` (line segments + `THREE.ArrowHelper`s, `depthTest: false`)
rendered with the SAME renderer/camera immediately after shading-pass, with
`renderer.autoClear` set false for that one call so it draws on top instead of wiping the
paint. Rebuilt from scratch every call (dispose + re-add) — simple, and cheap enough at this
instance count for a debug-only path.

Verified at frame 0 (calm) and frame 180 (duress on, mid-motion): no console errors either
way, all three layers render aligned with the painted figure. Useful and unexpected finding
from the arrows themselves: even at frame 0 with duress off (paint ignoring motion entirely),
the arrows show real nonzero velocity — the mocap dancers aren't in a static rest pose at
frame 0, they're mid-motion throughout. "No force" in the Round 9 test meant the PAINT wasn't
reacting to motion, not that the underlying motion was zero — worth keeping in mind when
using a specific frame as a calm reference.

### Round 11: two follow-ups on the debug overlay, plus a real bug it found (frame 68)

- **Arrows now respect `duress`.** They were drawing real sampled velocity regardless of
  whether the paint was reacting to it — informative once (the Round 10 finding above), but
  misleading as a steady-state view when motion is deliberately disabled. `debugOverlay.render`
  takes a `showArrows` argument now; main.ts passes `params.duress`.
- **`soloDancer` param** (both / dancer 1 / dancer 2) — isolates one dancer's strokes (and
  debug data) from the canvas entirely, not just visually. Needed because the two dancers
  overlapping is exactly what makes a single body hard to read (see frame 68 below).
- **A new comparison page, `compare.html`/`src/compare.ts`.** Same body, same pose, several
  `BoneStrokeStyle` variants rendered side by side in one canvas (via `renderer.setViewport`/
  `setScissor` per strip, one shared stroke-mesh/height-pass/shading-pass pipeline reused
  sequentially — each variant's accumulation is independent because `heightPass.render()`
  clears its targets before drawing). Frame + dancer are adjustable inputs; defaults to frame
  68, dancer 1, since that's the case that prompted it.

**What frame 68 turned out to be**: user flagged it as "super busted." Isolating dancer 1 with
solo-dancer + debug overlay showed the spine/neck chain's PAINTED strokes visibly departing
from the white bone-outline reference — not a small wobble, a real loop away from the true
line — right where the cyan arrows were longest (i.e. where sampled velocity was highest).
This is the seeking-brush's waver doing exactly what it's mathematically allowed to do:
`maxWaverBlend < 0.5` guarantees the walk always nets closer to its target every step, but
that's a distance guarantee, not a path-straightness one — nothing stops the sideways
component from bowing the path into a visible arc over many consecutive dabs before it snaps
back, and a sustained high-speed stretch (a spin/throw, exactly what frame 68 is) gives it many
dabs in a row to do that.

Built the compare page around exactly this case to check the hypothesis: same pose (frame 68,
dancer 1), three variants — current (`waverScale` 1.2, `maxWaverBlend` 0.4), a tighter waver
(0.5 / 0.18), and zero waver (pure bone-aligned, no motion influence at all). Current is a
genuinely tangled mess at the spine/neck; tighter waver is readable with some organic wobble
still intact; zero waver is clean but static. Confirms the diagnosis and gives a concrete
tuning direction, but which balance of legibility vs. motion energy to land on is an art
call — left for the user to decide via the tool rather than picked unilaterally.

### Round 12: "rings separated by masts" — the real fix was structural, not a shader parameter

User's framing this round: even at rest (no motion), legs showed "uniformly long strokes,
always overlapping in the same manner, creating this like 'rings separated by masts' look" —
a bamboo-stalk silhouette with a hard dark line at fairly regular intervals down each limb,
independent of any motion effect. The request underneath it: "we're following the position of
the bones rather than the rules of the paint applying to the shape we pursue."

Chased this by isolating one leg (the new `soloDancer` param, requested this round for
exactly this kind of investigation) and disabling ONE candidate variable at a time, re-
rendering the same zoomed crop after each:

1. **Per-dab width evaluated only at the dab's start**, not interpolated across it — fixed
   with `Stroke.widthStart`/`widthEnd`, interpolated per-vertex in the shader. No visible
   change.
2. **The `lump` height-texture term** (a fixed ~1.26-world-unit sine period) — forced flat
   (`lump = 1.0`). No visible change.
3. **The color pass's own facet-driven pigment step** (`bristle`'s `facetShade` mix, full
   strength, separate from the height-side version Round 9 already dampened) — forced off. No
   visible change.
4. **Render-length overlap** (dabs rendered ~3% longer than their physical travel, left over
   from Round 9) — set to exactly 1.0x (zero overlap). Partial improvement — marks got
   thinner/shorter, confirming SOME contribution, but didn't go away.
5. **Height accumulating additively with no coverage-normalization** (unlike color, which
   divides by alpha before use — see shading-pass.ts) — added that normalization
   (`h / max(coverage, 1.0)`) and restored generous overlap (1.3x) to lean on it. Changed the
   mark's shape (chevron instead of a straight line) but didn't remove it.

Every shader-parameter lever available had now been tried and ruled out, individually and in
combination. That's the actual signal: the marks were never a tunable texture/height issue —
Round 9's "beading" fix made the SAME misdiagnosis (see its cause 4) and this is the sequel.
The real cause is structural: each dab is rendered as an independent billboard quad instance.
Even with matching width, matching texture phase, and matching coverage math at a shared
boundary, two SEPARATE primitives meeting edge-to-edge are still two separate primitives —
independently rasterized, independently antialiased — and nothing at the shader-parameter
level can make that boundary not exist. No amount of tuning what happens on either side of a
seam removes the seam itself.

**The fix: stop rendering chains as independent dab quads. Render each chain as one real
connected mesh.** `generateChainStrokes` (walks a chain, emits a `Stroke` per dab) became
`generateChainRibbons` (walks the same chain, emits a `Ribbon` — a sequence of `RibbonPoint`s,
each just a position + width + arc-length + volume). `stroke-mesh.ts` gained a ribbon
renderer: for each chain, a real triangle-strip `BufferGeometry` built fresh on the CPU each
frame, two vertices per path point (left/right edge), consecutive points sharing actual
geometry — there is no boundary between separate primitives for a seam to appear at, by
construction, not by tuning.

Billboarding without a per-vertex shader trick: the camera's viewing angle never changes (see
shell/canvas.ts's "fixed camera" decision — only distance/pan do), so the view direction is a
build-time constant, not something that needs recomputing per vertex in view space. Each
point's sideways (width) axis is just `tangent × viewForward`, computed once on the CPU,
giving real baked 3D vertex positions. The fragment shape logic (tear/bristle/facet/lump/
crown) carried over almost unchanged — 'across' now comes from a per-vertex `side` attribute
(-1/+1 at the true edges) instead of a UV approximation, and 'alongChain' is the vertex's own
real arc-length instead of a reconstructed `chainOffset + uv.x*length`. Cap-taper (the old
`capStart`/`capEnd` shader fade) is gone entirely — the true ends of a chain now taper by the
ribbon builder shrinking their WIDTH directly (a geometric taper), not a shader fade.

Scope: only the main figure's limbs moved to this. Speckles and the swatch calibration page
stay on the old instanced-dab path (renamed `Stroke`/`createStrokeMesh`, simplified back down
— `widthStart`/`widthEnd`/`chainOffset`/`capStart`/`capEnd` all dropped, since a standalone
dab is always fully capped and was never part of a chain in the first place). Both mesh types
feed into ONE height-pass call via `THREE.Group` — calling `heightPass.render()` twice would
have the second call's own clear erase the first's contribution.

Verified: solo-dancer zoomed leg crop after the rewrite shows a genuinely continuous tapering
limb with no marks at all, at rest. Checked frame 180 and frame 68 (duress on) for
regressions — the seam is gone there too; frame 68's spine/neck is still visibly bent into an
arc by the waver, but as ONE continuous connected shape, not a chain of mismatched beads —
correctly isolating that remaining busyness as the separate, already-diagnosed Round 11 issue
(how much the waver bends the path), not a re-emergence of this one. Re-ran the Round 11
three-way comparison page after the rewrite: all three variants' limbs are now equally clean,
and the only visible difference between them is exactly the path-bowing at the torso — the
comparison now isolates precisely the one variable it was built to isolate.

### Round 13: the brush was still tracing the bone, not painting a region — replaced the
walk with target-region coverage plus motion as an applied force

User's framing this round, alongside a reference photo of real impasto tulips: "I'm trying to
get you to drive this figure that wants to be painted, and constraints we'll use to paint it.
The stick figure at rest, no motion applied, should just look like someone tried to paint a
stick figure in the area where the bones signaled. It should look like it was oil painted from
a pallet with a brush. We're getting close to that, but we're following the position of the
bones rather than the rules of the paint applying to the shape we pursue."

Named two structural mismatches with the reference image, independent of anything already
built:

1. **Nothing was ever "on top."** Color accumulates additively and divides by coverage — an
   average, not an occlusion. Two strokes crossing read as a blend, never one over the other.
   (Left as-is this round — the user deferred [paint-accumulator](paint-accumulator.md)'s
   occlusion/decay work explicitly, see below — but it's the reason the reference's layered
   look isn't fully reachable yet.)
2. **The brush was required to reach the end of the bone.** `generateChainRibbons` (Round 12)
   walked joint to joint with a heading that always kept a majority weight toward the next
   joint (`maxWaverBlend < 0.5`, a hard stability requirement for a walk that has to converge).
   Motion could only ever bend that walk, never really drive it. The user's own framing: "the
   brush knows both the area it wants to paint, and the motion that will be applied to it, and
   so paints along the motion into the area it wants to fill" — direction reversed from what
   the code did.

**The fix: stop walking chains, cover them.** `generateChainRibbons` is gone.
`generateChainMarks` (pose/strokes.ts) treats each chain's own joint-to-joint shape as a
*target region* — exactly the polyline the debug overlay's outline layer already draws — and
tiles independent brush marks across it: along its length (arc-length slots, spaced by
`markLength * (1 - overlapAlong)`) AND across its width (`round(localWidth / markWidth)`
parallel lanes, so a hip gets several passes and a forearm gets one). A mark's heading defaults
to the bone tangent plus a small always-on jitter (`angleJitter` — present with NO motion at
all, since a real brush stroke isn't perfectly axial even deliberately tracing a line) and is
pulled toward the locally-sampled instantaneous velocity direction by an amount that grows with
speed (`motionForceScale`/`maxMotionForce`); a fast mark also stretches longer (`smearScale`),
so paint streaks past where the bone actually is rather than tracing it. Because marks are
independent, there is no convergence requirement — `maxMotionForce` has no 0.5 stability
ceiling the way the old `maxWaverBlend` did; it's a pure art-direction knob now.

**This reopens, and re-solves, the Round 12 seam question.** Independent marks are exactly what
Round 12 moved away from. But the Round 12 seam ("rings separated by masts") came from
*mechanical periodicity* — uniform length, uniform angle, dabs placed end-to-end along one
line — not from the marks being independent primitives per se. Round 13's placement is
deliberately irregular at every level: along-slot centers, lane offsets, headings, and lengths
each carry independent per-mark jitter, and (critical fix mid-round, see below) each lane's
position is decorrelated ALONG the bone too, not just across it, so lanes at the same along-slot
don't line up into a ladder. Real oil paint IS built from many overlapping, irregular gestures —
that's what the reference image is — so irregularity, not one unbroken mesh, is what actually
avoids the artifact. `stroke-mesh.ts`'s ribbon renderer (the real connected triangle-strip mesh
built last round) is deleted as unused; the dab renderer it was built to replace covers the main
figure again.

**First attempt still looked wrong** — capturing a solo dancer at rest showed a tight, regular,
perpendicular-banded "inchworm" look, not an improvement on the rings. Diagnosis: marks were
close to square (markLength 1.4 vs. lane widths often 1.0–1.5), so each one read as a stamped
coin, and lanes at the same along-slot sat at the exact same arc position, differing only in
their sideways offset — a rigid ladder. Fixed by (a) elongating marks well past their width
(markLength 2.3 vs markWidth 0.8, a real stroke aspect ratio, not a disc), (b) decorrelating
each lane's own along-bone position with independent jitter, (c) raising angleJitter to ~23°,
and (d) raising density (`overlapAlong` 0.35 → 0.55, `numAlong` floor 1 → 2 per bone segment)
so any given point is usually covered by several marks' bodies, not just one mark's fading tip
— that tip is what reads as a groove, and only enough overlapping coverage hides it. The
`numAlong` floor also fixed a real coverage gap: a short bone (hand, foot) getting only one
along-slot had a single randomized length deciding whether it bridged to the next segment at
all; a miss there was a visible break at the joint.

Verified: solo dancer at rest (frame 0, duress off) now shows genuinely varied, overlapping,
angled strokes with no repeating lattice — a zoomed thigh crop shows individual marks crossing
each other at visibly different angles, the closest yet to "someone painted a stick figure with
a brush." Frame 68 (duress on, both dancers) shows marks visibly thrown along the motion
direction — streaked, elongated, overshooting past the bone — reading as a figure caught
mid-motion rather than a wobbling tube. Re-ran the three-way comparison page (relabeled for the
new motionForceScale/maxMotionForce/smearScale fields): the "no motion force" strip is a clean,
tightly bone-aligned figure, "current" shows visibly thrown strokes, and the middle setting
interpolates cleanly between them — confirming the tool isolates the one variable it names.
Debug overlay (outline/marks/arrows) checked against frame 68 and shows dense, correctly varied
mark placement matching the new model exactly, with no changes needed to overlay.ts itself
(`ChainDebugDab`'s start/end/rawVelocity shape didn't change). swatch.html and compare.html both
load with no console errors.

**Explicitly out of scope this round, on the user's direction:** cross-frame accumulation.
"We're going to continue delaying that... We haven't arrived at the underlying style yet, and
we need to do that." The user confirmed [paint-accumulator](paint-accumulator.md)'s existing
plan is right in shape (wipe-and-replay with decayed under-layers) for when this resumes, and
added one constraint for that future work: "there'll need to be very few accumulations of paint
in a single layer, so there's still some readability for the layers underneath" — i.e. a single
layer/frame needs to stay sparse enough that a decayed layer beneath it can still read through,
which argues for tuning mark density down (or coverage-gating it) once accumulation is live,
not for the dense full-coverage tuning this round's at-rest calibration used.

Also fixed this round, unrelated to the above: the Tweakpane params panel was in the DOM but
laid out entirely below the viewport (Tweakpane only self-positions when it owns its own
floating container; handed `#app` — which the full-height canvas already fills via normal
document flow — it rendered inline, below the fold). Given its own fixed-position host in
shell/params.ts, the same way shell/timeline.ts's scrub bar already had one.

### Round 14: independent marks still read as "homogenous, mono-directional lines" — loading,
depletion, and a shaky walked path, with speckles moved onto the strokes' own tips

User's framing, alongside a real-paint description of how a stroke actually gets applied: dab
the brush in the paint tray, then stroke the canvas with "gentle strokes with a shaky and
uneven attempt at even pressure, trying to move in the same general direction... going back and
dabbing the paint again once the brush begins to run dry, which we should see." Then: "we're
going to add the impulse of motion on top of that." Named the actual complaint with Round 13's
result directly: "very homogenous, mono-directional lines filling in an intended shape." Framed
the target region itself as **positive space** (the bones' shape) versus **negative space**
(everywhere else) — strokes should mostly fill the former and avoid the latter, "not that I
want him strictly confined to a space, just..." Separately: speckles have "always" read as too
far from the stroke that threw them — "like some accentuation marking particularly high
velocity... rather than looking like the breaking point of the brush's fervor."

**Root cause of the homogeneity:** every mark in Round 13 was placed independently — its own
one-shot random heading jitter, its own one-shot random paint-load draw, uncorrelated with its
neighbors. Independent random draws average out to looking uniform in aggregate; nothing about
the model gave one lane's strokes a *shared, evolving story* the way a real physical brush pass
has one.

**The fix: a lane became a simulated brush pass, not a set of independent marks.**
`generateChainMarks` still tiles each chain's target region with parallel lanes across its
width (unchanged from Round 13), but within a lane, state now persists step to step:

- **Paint load.** A lane starts each bone segment with a fresh, near-full load. Each step
  consumes some of it (proportional to that step's own length — a longer or motion-stretched
  step drains faster); a step's WIDTH and VOLUME scale down as the load runs low
  (`dryWidthFactor`/`dryVolumeFactor`), and once the load drops below `dryMinLoad` the very
  next step resets to a fresh load. This is the visible thick → thin → thick(reload) cycle
  down each lane the user asked to actually see, not just imply.
- **A walked, wobbling path, not a stationary jittered heading.** A persistent, damped random
  walk (`wobbleAngle`/`wobbleDamping`) rotates the heading around the bone tangent each step —
  damping pulls it back toward the tangent, so a pass keeps "trying to move in the same general
  direction" instead of spinning freely. Critically, this heading now also **advances the
  brush's own position** step to step (`passPos`), softly corrected back toward the lane's
  geometrically-ideal track each step (`containmentPull`) rather than snapping to it — this is
  the positive/negative-space framing directly: a pass can wander, but it's pulled back toward
  the region it's meant to fill, not confined to it outright. (First attempt at this used a
  weak correction and a large initial wobble kick, which let the very first step of a lane
  drift far enough from its true joint to leave a visible gap at torso/leg boundaries —
  fixed by shrinking the initial kick and strengthening the correction.)
- **Motion layers on top, exactly as asked.** The heading is computed from wobble+walk FIRST,
  then blended toward the locally-sampled instantaneous velocity direction by
  `motionForceScale`/`maxMotionForce` (unchanged mechanism from Round 13) — motion is an
  addition to the base stroking behavior, not a replacement for it.

**Speckles now come from the strokes themselves.** `generateChainMarks` gained an optional
`emittersOut` parameter: any step whose sampled speed exceeds `speckleSpeedThreshold` pushes an
`Emitter` at its own forward tip — the actual painted mark that's moving fastest, not an
independent bone-sampling pass. This replaced `generateEmitters`/`boneSegments` entirely (both
deleted as dead code — nothing else referenced them once main.ts stopped calling them), and
`speckleStyleFor`'s `spread` dropped from 2.5 to 0.7: a small scatter radius reads as flung
*from* the stroke tip it's tied to; a large one was what recreated the "too far from whatever
stroke it's meant to be flung from" complaint even with the right origin.

Verified: solo dancer at rest shows visible width variation down each limb (a genuine thick/
thin/reload cycle, not uniform strokes) and real path waviness, with no gap at the hip/thigh
joint after the initial-kick/containment fix. Frame 68 (duress on) shows speckles clustered
tightly around the fastest-moving strokes' own tips — most visibly the outstretched arm, where
a trail of tiny droplets sits right at the fingertip stroke's end, not floating separately near
it. swatch.html and compare.html (BASE_STYLE/variants updated to the new field names) both load
with no console errors.

**Left for the user to react to, not resolved unilaterally:** `wobbleAngle`, `wobbleDamping`,
`containmentPull`, and the paint-load timing constants (`paintCapacity`, `dryMinLoad`,
`dryWidthFactor`/`dryVolumeFactor`) are first-pass numbers, not a claimed final answer — the
user's own language ("it still needs a big pull to get where I'm thinking") suggests this is
an iteration, not the destination.

### Round 15: motion was changing the rules, not accentuating them — one variable had two jobs

User's framing this round: screenshots of frame 51 showed one dancer's leg painted as a huge,
barely-recognizable mass while the other read as a clean figure, and the debug overlay made the
cause visible — strokes on the fast leg were rendered far longer AND positioned way off from
the true bone line the outline draws (user hand-annotated a screenshot: a thin red line for
where a stroke's core should sit, a pink oval for the region around it, pink arrows for the
motion direction those strokes should still angle along). Direct quote: "the change in force...
has a HUGE proportional difference in how large the leg is drawn. This is more than just
accentuating shape using motion, it's a total change in rules." The ask: strokes under motion
should get longer at a "reasonable proportion," look "hastier" (more likely to throw
speckles), have their force "accentuated, slightly" and be "dragged out a little" — modest,
capped effects — while staying close to the true region; only their ANGLE should track motion
strongly, the way the pink arrows indicated. Separately: speckles "just look like scattering
and noise" and need to read as "a high-intensity fling of paint" instead.

**Root cause: one `length` value did two unrelated jobs.** `generateChainMarks` used the same
motion-smeared `length` both to advance the lane's walked position (`passPos += heading *
length`) and as the rendered mark's visual length. A fast, heavily-smeared step didn't just
draw a longer streak — it physically relocated the anchor that far, every step, in roughly the
same direction for as long as the motion lasted. `containmentPull`'s soft correction (Round 14)
was pulling back toward the ideal track each step, but a sustained, large, directionally-
consistent displacement every single step outpaces a single soft correction faster than it can
catch up — that's the "total change in rules" the user was seeing: under sustained motion the
walk stopped being "the calm pass, nudged," and became a different, much less contained
process entirely.

**The fix: split `walkLength` (how far the hand actually moves) from `renderLength` (how long
the visible mark looks).** `walkLength` is the base per-step length — pressure/lengthScale
jittered, but NOT motion-smeared — and is what `passPos` advances by and what
`containmentPull` corrects. `renderLength` is `walkLength` stretched by a smear bonus capped at
+80% (`Math.min(speed * smearScale, 0.8)`), used only for the Stroke's own rendered length, the
debug overlay's start/end, and the speckle emitter's tip position. The anchor's own placement is
now governed by the same calm, tightly-contained walk regardless of speed; only the mark drawn
FROM that anchor stretches out and only up to a fixed, modest ceiling — "accentuated...
slightly," not unbounded. Width picked up the same capped bonus at a smaller weight (`* (1 +
smearBonus * 0.3)`) so a forceful stroke reads as a little bolder too, not just longer.

**Speckles made anisotropic and speed-scaled.** `generateSpeckles` previously jittered a
droplet's position independently on all three axes by a FIXED radius regardless of how fast the
emitter was moving — a droplet barely above the speed threshold got the same scatter magnitude
as a genuinely violent one, which is what read as ambient noise rather than a directed fling.
Now jitter is decomposed into two axes strictly perpendicular to the fling direction (via a
`cross()`-built basis, mirroring the perpendicular-axis trick `generateChainMarks` already uses
for lane offsets) and scaled by `speedRatio`, so a gentle fling stays a tight, small spray and a
violent one throws visibly further-scattered droplets. Droplet length also stretches with
`speedRatio` (up to +160%) and width narrows slightly at high speed, so a high-intensity fling
reads as a few bigger, more visibly stretched streaks rather than a cloud of uniform dots — same
"accentuated, dragged out" shape as the main strokes above. `speckleStyleFor`'s emitter-tip
source (already fixed last round) combines with this to make speckles feel like the actual
breaking point of a stroke's fling, not a decoration near it.

Verified: re-rendered frame 51 (the exact case flagged) — both dancers now read as recognizable,
proportionate limbs; the previously-massive leg is visibly smaller and no longer dominates the
frame. Debug overlay on the same frame confirms strokes now sit close against the white outline
while still visibly angled along the cyan motion arrows — direction follows motion strongly,
position doesn't run away, matching the user's red-line/pink-area/pink-arrow annotation
directly. Speckles at frame 51 (duress on, dancer 1 solo) now read as short, outward-radiating
streaks trailing off the moving limb's edge rather than a diffuse dot cloud. swatch.html and
compare.html both still load with no console errors.

Not addressed this round (left for a future pass if it comes up again): the "park the current
approach as one brush mentality, and try [something else]" framing at the top of the user's
message — read in context, the concrete asks that followed (reasonable proportion, hastier,
accentuated force, contained position, better speckles) were all served by tightening the
EXISTING model rather than by building a second, alternate one, so no second mode was built.
If motion still needs a genuinely different regime once the tightened version is judged, that's
the next thing to reopen.

### Round 16: coverage must not depend on stroke length; speckles need chaos, not just scale

User's framing, articulated while sketching against a real splatter-painting reference: "I
think reducing stroke length should not result in gaps. The stroke length is just how far
you're getting with that brush stroke... It should still be the intention that our entire stick
figure 'area' be filled in... We're not doing 'a series of brush strokes at locations dictated
by the map / bones' — We're 'filling in the area of the figure' and again putting together the
area from the bones because motion." Also asked to further "reduce the amount that strokes are
impacted by motion." Separately, on speckles: "make them look more like the result of forceful
paint flinging? They should be the brush 'getting away from the painter' sort of" — with a
Pollock-style splatter photo attached, showing a mix of fine directional spatter and long, thin,
wildly-flung strands, not a uniform dot cloud.

**Coverage was implicitly coupled to stroke length.** `generateChainMarks` computed how many
steps (anchor points) a lane needed from `segLen / stepSpacing`, where `stepSpacing` was derived
from the STYLE's nominal `stepLength`. That conflated two things that should be independent: how
DENSELY a region needs to be sampled to stay fully covered (a coverage requirement) and how long
any one stroke happens to render (a style/motion choice). Fixed by computing `stepSpacing` from
the WORST-CASE shortest a step's walk can ever be (`stepLength * 0.4`, the existing hard floor)
rather than the nominal value — this guarantees enough anchor density to keep the region covered
regardless of what any individual stroke's actual length ends up being, which is the invariant
the user was describing directly: "not… strokes at locations dictated by the bones" but "filling
in the area… putting together the area from the bones."

**Motion's remaining impact turned down further**, on top of Round 15's walk/render split:
`motionForceScale` 1.0→0.7, `maxMotionForce` 0.75→0.55, `smearScale` 1.2→0.8, and the smear
bonus's hard cap (already added in Round 15) tightened from +80% to +50%.

**Speckles gained two things a scale-up alone can't give: chaos and variety.** Previously every
droplet from one emitter flew in the exact same direction (the emitter's own raw velocity),
varying only in position — visually that reads as "the same fling, scattered," which is what
the user meant by "too normal... scattering and noise." Now each droplet's OWN flung direction
is randomly rotated off the true velocity direction by an angle that grows with speed (a cone
built from the same `cross()`-based perpendicular-basis trick `generateChainMarks` already uses
for lane offsets) — real spatter fans out unpredictably under momentum, it doesn't travel in one
perfectly uniform line, which is the mechanical version of "the brush getting away from the
painter." Separately, about 1 in 4 droplets per emission rolls as a long, thin, far-flung
"strand" instead of a small round droplet, mixing two visibly different droplet shapes the way
the reference photo does, rather than one droplet shape at varying sizes.

Verified: solo dancer at rest shows denser, still-gapless coverage (visibly more continuous than
Round 14/15's, since anchor density is now sized for the worst case rather than the average).
Frame 51 (the case flagged last round) with both dancers under motion now shows a much smaller
gap in relative size between the fast and slow leg — still visibly bigger (correctly, since it
really is moving faster), but no longer a barely-recognizable mass dominating the frame. Zoomed
speckle crop at the same frame shows a genuinely chaotic fan of varied-length, varied-angle
strands radiating off the limb's edge, not a uniform radial dot cloud. swatch.html and
compare.html (BASE_STYLE/variant labels updated to the new motion defaults) both load with no
console errors.

### Round 17: speckles overshot into drama, motion's meaning inverted, and a real displacement bug

User's framing this round, from a hand-annotated screenshot (a red box around a small cluster
of marks floating visibly detached from a limb) plus direct feedback on Round 16's result:

1. **A real bug, not a matter of taste**: "some angles are still getting these parts that
   wound up getting drawn very strangely" — marks rendering visibly disconnected from their
   limb, not merely displaced.
2. **Speckles overcorrected**: "I do want mostly dots... like someone's spitting at you when
   they're talking. It's extra emphasis from the movement... they're projected so far out now.
   That's too much. It should just be a little pizazz." Round 16 fixed the "uniform noise
   cloud" complaint by adding directional chaos and elongated strands, but pushed distance,
   elongation, and strand frequency (1 in 4 droplets) all too far in the other direction.
3. **Motion's whole effect should invert**: "lower motion on the relative bones = smoother,
   more even, well-distributed strokes. I want the ones with more movement to be quicker,
   shallower, more uneven, dynamic." Every round through 16 had motion make strokes BOLDER
   (more width, more volume, more length) — the user is asking for the opposite: calm bones
   should read orderly and consistent, energetic bones should read thin, quick, and erratic.

**The displacement bug: a global constant colliding with a local size.** `walkLength` (Round
15's fix) is derived from the STYLE's `stepLength`, a single value shared by every bone in the
figure. `containmentPull`'s soft correction pulls the walked position back toward its ideal
track by a fixed fraction each step — but on a short bone (hand, foot) or after an unlucky run
of wobble draws, one step's `walkLength` can be large relative to THAT segment's own size, and
the soft correction alone doesn't scale down to compensate. The result: a mark rendering
visibly adrift from its limb, exactly what the user's red box shows. Fixed with a hard safety
net on top of the soft one: after computing the corrected anchor, its distance from the lane's
ideal track is clamped to at most `max(localWidth * 2, 0.3)` world units — generous enough that
normal wobble character is untouched, but a pathological outlier can no longer render detached
from its region, full stop.

**Motion inverted: a fast pass is thinner and shakier, not bolder.** Introduced one reusable
signal, `motionIntensity` (0 at rest, 1 once `forceBlend` saturates `maxMotionForce`), computed
early in the step loop and threaded through everything that used to respond to raw `speed`:

- The wobble random walk's own step size now scales with `motionIntensity` (`0.35` to `1.75`×
  the base `wobbleAngle`) instead of being a fixed magnitude everywhere — a calm bone wobbles
  gently (smoother, more even), a fast one wobbles hard (more uneven, dynamic).
- `pressureNoise`'s magnitude scales the same way — "well-distributed" at rest, genuinely
  uneven under motion, not a constant amount of noise regardless of speed.
- `containmentPull` loosens slightly with `motionIntensity` (0.75 at rest down to 0.55 at full
  motion) — calm passes stay orderly, fast ones get more freedom to wander (still bounded by
  the hard clamp above).
- Width and volume FLIP from Round 15/16's "bolder with force" to "thinner and shallower with
  force" (`width *= 1 - motionIntensity * 0.35`; `volume` drops from a 0.2 base toward a 0.05
  floor as `motionIntensity` rises) — a quick, grazing pass doesn't have time to lay down as
  much paint as a slow, deliberate one. `BoneStrokeStyle.volumeScale`'s doc comment updated to
  describe this inverted role.

**Speckles pulled back toward restraint.** Distance (`spread` 0.7→0.35, and the per-droplet
fling-distance formula's own multiplier softened), elongation (`1 + speedRatio*1.6` →
`1 + speedRatio*0.4`), the chaos cone (`maxChaosAngle` roughly halved), and the "streak" chance
(1 in 4 droplets → roughly 1 in 12, and less extreme when it does roll) were all reduced — same
underlying mechanism as Round 16 (directional chaos, occasional elongated droplets), tuned down
to "a little pizazz," most droplets staying small dots close to the stroke.

Verified: solo dancer at rest visibly reads smoother/calmer than Round 16 — less crosshatched
texture, more even coverage. Frame 51 (motion on, both dancers) shows the faster dancer reading
thinner and more textured/uneven rather than bolder, with speckles now a subtle scatter of small
dots hugging the limb edges instead of long visible strands. Swept several additional poses
(frames 100, 180 — both include close arm/torso overlap between the two dancers, the kind of
pose likely to stress the displacement fix) with no detached floating clusters found in any of
them. swatch.html and compare.html both load with no console errors.

### Round 18: strokes "pirouetting around the bone," repeating-looking heads, and speckles still too dramatic

User's framing this round, from an annotated screenshot with two boxes: one around a small
cluster of marks in the middle of a torso forming an "H"/ladder shape, one around a leg reading
as uniform ribbed segments. Direct quotes: "you see the strokes like pirouette around the bone
or something. It's bizarre." / "a lot of frames at our default values the strokes predictably
look repetitive... look at the heads... They look like they're made out of repeating sections."
Also, on speckles (a follow-up after Round 17's restraint pass): still "mostly dots" wanted, "a
little pizazz," not yet subtle enough. And a closing structural note: "if you know you're
painting an arm, you'll paint that arm contiguously. Gaps are weird, but they're a symptom of
how the strokes are being mapped."

**The "pirouette"/H-pattern: motion could rotate a mark's rendered orientation most of the way
to perpendicular.** A limb's own instantaneous velocity is very often close to perpendicular to
its bone — that's what rotating around a joint looks like. `heading` was a straight linear blend
between the bone-aligned `baseHeading` and raw `velDir` weighted by `forceBlend` (up to
`maxMotionForce`, 0.55), with no cap on the RESULTING angle relative to the bone itself. When
velocity happened to be roughly perpendicular, a heavily-blended mark could render as a short
crossbar laid ACROSS the limb rather than a stroke along it — stacked with nearby more
axial marks, that's exactly the "H"/ladder look, and it directly undercuts "you'll paint that
arm contiguously." Fixed with an explicit angular clamp: after computing the blended `heading`,
its angle from the bone tangent (`segDir`) is measured and, if it exceeds `~49°`, rotated back
to exactly that boundary — preserving which way it was leaning, just capping how far. This is
independent of wobble or motion strength: no matter how hard either pushes, a mark can lean
under motion but can never render sideways across its own limb.

**"Repeating sections": several jitter ranges were narrower than they needed to be.** Per-mark
length varied only 0.8–1.2× nominal; along-bone placement (`tJitter`) only wandered ±25% of a
step's own spacing; pressure-driven width/volume noise had a floor multiplier of 0.3 even at
rest. None of these were WRONG, individually, but stacked together they meant every mark in a
short, low-lane-count region (a neck, a forearm) looked close enough in size, spacing, and
shading phase to read as manufactured rather than hand-applied — "smooth and even" (Round 17's
goal) had drifted into "uniform." Widened: length jitter to 0.6–1.4×, `tJitter` to ±45% of step
spacing, and the pressure-noise floor from 0.3 to 0.45 — real variety even at a calm, evenly-
covered baseline, which isn't the same thing as identical strokes.

Speckles weren't touched this round — the user's message this time was entirely about stroke
placement/angle and variety, not spatter (Round 17 already addressed the "too dramatic" feedback
on speckles specifically).

Verified: swept several poses (frames 445 and a zoomed crop of it, the region nearest the
originally-reported transition) for the H/ladder pattern — none found; strokes read as leaning
under motion, not crossing the limb. A zoomed neck/head crop at rest shows visibly more organic
width and spacing variation than prior rounds, no longer a uniform ribbed column. swatch.html
and compare.html both load with no console errors.

**Not separately chased this round**: the closing "gaps are weird, but they're a symptom of how
the strokes are being mapped" comment — no NEW gap was shown in this round's screenshot (Round
16 already fixed the specific coverage/length coupling bug), and the angular clamp above should,
if anything, improve coverage reliability further (a mark that can't point wildly off-axis is
less likely to waste its length painting away from where it's needed). Read as a summary
reflection on the underlying approach rather than a new concrete symptom to fix; worth watching
for a specific recurrence rather than pre-emptively changing more before that.

### Round 19: per-segment state resets were the real cause of "stacked boxes," a napkin-math
approach to finding worst-case frames, and the comb pattern needed more than one fix

User's framing this round: positive on Round 18 ("good work"), had live-tweaked strokes shorter
via the params panel and preferred it. Flagged frame 391 as still showing the arm issue despite
Round 18's angular clamp, and suggested a concrete process improvement: "we can probably do a
quick bit of scanning and napkin math to figure out where the most extreme extent to check
would be, yeah?" — instead of guessing frames by eye. The main structural ask: "both the head
and torsos on both bodies look like stacked boxes. So 8 stacked boxes per frame... These should
look like bodies... let's figure out why we've got that gap and try something different, towards
looking like someone painting shadows." Also: default camera zoomed in a bit ("distance 30...
they can dance in and out of frame a bit").

**Napkin math, done as asked.** Wrote a small script over the raw pose cache (central-difference
speed per joint per frame, same formula `sampleBoneAtT` already uses, maxed across every joint
and both dancers) to rank frames by worst-case motion instead of guessing. Result: frame 391
ISN'T a peak-motion frame at all (max joint speed ~1.6, versus ~4.2–4.8 at the actual top
frames, e.g. 426–428 on `LeftForeArm`) — and the single highest-speed joint in the whole dataset
(frame 1, `RightHandIndex1_End`) is a finger bone, which chains/strokes never touch (dropped by
`isFingerBone`). That ruled out "frame 391 has unusually extreme motion" as the explanation and
pointed at something structural instead — confirmed below.

**The "8 stacked boxes": each short segment reset its lane's state from scratch.** A chain's
lane (paint load, wobble phase, walked position) was scoped to ONE segment's inner loop —
starting fresh every time the outer loop moved to the next bone. The spine+neck+head chain has
5+ segments, several of them short (a vertebra is much shorter than a thigh); resetting to a
fresh, full paint load and a near-zero wobble phase at every one of those short joints is
exactly what makes each segment its own self-contained, uniform-looking block — "8 stacked
boxes" is a fair description of 5+ vertebra segments each independently starting clean. Fixed
by restructuring `generateChainMarks` to precompute each segment's static geometry once, then
walk LANE-major across the WHOLE chain: one lane's paint load and wobble now flow continuously
through every joint in the chain, only pausing (not resetting) through a segment too narrow to
need that many lanes. A vertebra segment's steps now pick up mid-cycle from wherever the
previous segment's lane left off, instead of starting over.

**The arm issue at frame 391 needed a second, different fix.** The chain-continuity fix alone
didn't resolve it — reasonable, since the arm's issue wasn't a segment-reset boundary artifact
at all. Diagnosis: a rigid bone rotating around its joint has correlated velocity DIRECTION
along its whole length (a physical fact — only the speed varies with distance from the joint),
so every step sampled along that one short segment blends toward nearly the same
near-perpendicular direction. Round 18's 49° clamp let each of those correlated marks lean the
same way by nearly the same amount, reading as a uniform "comb" of parallel diagonal strokes —
different failure mode than the "H"/crossing pattern Round 18 targeted, but visually similar in
spirit (motion pulling marks too far off the bone's own axis). Two changes: a `catchJitter`
that randomizes how much of the available motion-blend actually reaches any one mark (0.2×–1.0×,
so nearby marks lean by different AMOUNTS even toward the same direction), and tightening
`maxHeadingDeviation` further, from 49° (Round 18) to 22° — the jitter alone wasn't a firm
enough ceiling on a fully-correlated lean; the clamp is what actually guarantees it.

Also: `stepLength` shortened from 1.7 to 1.3 (matching the user's own live-tweaked preference —
`strokeLengthScale` remains available on top for further live tuning) and `defaultParams.
cameraDistance` from 55 to 30.

Verified: a zoomed neck/head crop at rest now reads as one continuous flowing column, no visible
hard boundaries at any vertebra. Frame 391 re-checked after both the continuity fix (arm issue
persisted) and the catch-jitter/tighter-clamp fix (arm now reads as a natural motion streak,
not a rigid crossbar comb). Fresh default load (no saved hash) at frame 150 confirms the
zoomed-in default framing — both dancers close, legs extending past the bottom edge, matching
"dance in and out of frame." swatch.html and compare.html both load with no console errors.
