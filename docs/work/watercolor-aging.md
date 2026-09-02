---
id: watercolor-aging
parent: roadmap
phase: P6
state: planned
---

# watercolor-aging — old paint converts toward a watercolor treatment

## Why

[paint-accumulator](paint-accumulator.md) specs aged layers fading via opacity/relief decay,
banded into a few discrete stages ("fresh," "settling," "aged"). The actual ask is stronger:
once paint crosses into an aged stage, it shouldn't just get fainter and flatter oil paint —
it should look like it *became watercolor*. Softer edges, paper interaction, pigment behavior
distinct from the wet-impasto look of fresh paint. Fresh/recent paint keeps the current oil
look untouched.

This is explicitly expected to maybe be substantial, so this doc is research and a phased
plan, not an implementation. First deliverable is a standalone look-test, same spirit as
`swatch.html` — build nothing into the real accumulator until the look is validated in
isolation.

## Reconciling with watercolor-ground

[watercolor-ground](watercolor-ground.md) (P5) is the **substrate**: paper tooth, pre-baked
washes, dry-brush contact with the paper's height field. It is pre-baked once at load, mostly
static, and answers "what is the canvas made of."

This item is about the **paint itself**, and it is inherently time-varying: a layer's
treatment is a function of its age in the accumulator, keyed to the stage bands
paint-accumulator already specs. Fresh paint is oil, aged paint is watercolor, and a layer
moves from one to the other over its lifetime in the buffer. That's a different axis entirely
from "what's the paper made of."

**Verdict: sibling, not the same scope, with a real dependency.** watercolor-aging depends on
watercolor-ground for shared texture (paper grain, see "Open questions") and depends on
paint-accumulator for the age/stage signal it switches on. It does not replace or fold into
either — watercolor-ground would still matter even if no paint ever aged into watercolor
(bare canvas needs to read as paper), and paint would still need *some* aging treatment even
on a flat placeholder ground.

## What already exists to build on

This isn't starting from zero — several pieces of already-planned or already-built machinery
line up directly with what watercolor conversion needs:

- **Per-pixel age already exists.** `RT_height`'s G channel is age, per paint-accumulator's
  buffer spec — the shading pass can read "how old is the paint at this pixel" directly, no
  new signal required.
- **Discrete stage bands already exist.** paint-accumulator bands opacity into `stageCount`
  (default 3) stages via `stageWeights`. The natural switch point for watercolor is "paint in
  the aged stage" — reusing that band rather than inventing a second aging signal is the
  point of the integration section below.
- **Per-channel independent decay already exists.** Height and color decay at independently
  tunable rates in paint-accumulator's `Decay` interface. Reduced relief for aged paint is
  not a new mechanism — it's [art-direction](art-direction.md)'s already-listed "Relief
  falloff" lever ("older layers flatten while keeping color... often the most convincing"),
  realized through this same interface.
- **A procedural ground texture already exists**, as a stand-in. `shading-pass.ts`'s
  `quadFragmentShader` has a cheap screen-space weave + hash grain (`weave`, `grain` in the
  fragment shader) explicitly flagged in its own comments as a placeholder for real
  watercolor paper. This is a candidate source for paper-grain/granulation texture — see open
  questions on whether to share it.
- **A calibration-page pattern already exists and worked.** `swatch.html`/`src/swatch.ts` —
  reuses the shell (camera controls, params panel) and the full paint pipeline
  (`stroke-mesh.ts`, `height-pass.ts`, `shading-pass.ts`) unmodified, showing a handful of
  isolated strokes instead of the full dance scene. Built for exactly this kind of "judge a
  rendering change fast" problem, and per impasto-shading's Round 4 notes, having it was what
  made the height-field bug diagnosable at all. Same approach applies here.

## Technique survey

Evaluated against what this pipeline actually has: one height-field + color-sum accumulation
buffer, composited by one full-screen shading pass, no particle/fluid simulation
infrastructure, no per-stroke re-rendering once a stroke is baked into the buffer.

### Cheap — shader math only, no new passes or buffers

- **Edge darkening (pseudo-backrun).** Real watercolor backruns come from pigment migrating
  to a wet edge as water evaporates (see Curtis et al.'s wet-in-wet model, cited in
  watercolor-ground.md). A convincing *approximation* doesn't need the underlying physics: the
  shading pass already computes a coverage/height gradient near a stroke's edge (used for AO).
  Darkening/concentrating color in proportion to that existing edge gradient — not simulating
  diffusion, just reacting to the alpha falloff that's already there — is a shader-only trick.
  watercolor-ground.md itself calls this out as "the single detail that makes something read
  as watercolor rather than as an airbrush gradient," which makes it the strongest
  cost-to-payoff candidate here.
- **Reduced relief.** Already-planned machinery (art-direction's relief falloff, driven by
  paint-accumulator's height decay). Watercolor is flat/thin versus oil's built-up impasto —
  this cooperates for free, it doesn't need a watercolor-specific mechanism, just a height
  decay curve that's more aggressive (or floors lower) for the aged stage specifically.
- **Desaturation / color shift toward a muted, cooler, more transparent palette.** Also
  already-planned machinery (paint-accumulator's independently-tunable color decay). Whether
  it needs its *own* curve distinct from art-direction's topmost-layer hue-shift/saturation
  falloff, or reuses that same one, is flagged in open questions below.
- **Granulation.** Pigment settling into paper's low spots reads as a texture multiply against
  a paper-height field, modulated darker in the valleys. Cheap if a paper-height texture
  exists to sample — either the existing placeholder weave/grain in `shading-pass.ts`, or
  watercolor-ground's real paper tooth once that lands. No simulation, just a multiply.
- **Feathered/soft edges as a masked screen-space blur.** Rather than re-rendering aged
  strokes with a different brush shape (strokes are baked into the accumulator at emit time
  and aren't feasible to reshape retroactively), a narrow blur applied only within an
  age-masked region in the shading pass approximates the same visual softening. Cheap, stays
  entirely in the existing single full-screen pass, no new render target.

### Medium — a per-stroke shader tweak, no new full-screen pass

- **Faked wet-on-wet bleed.** True diffusion needs a simulation. A cheap stand-in: perturb a
  stroke's own alpha falloff with low-frequency noise at emit time (the same category of trick
  `stroke-mesh.ts` already uses for ragged edges), so the stroke's *baked* edge looks organic
  rather than diffused live. This only fakes the *shape* of bleeding, not the actual pigment
  migration between adjacent wet strokes — a real limitation, and worth being honest that this
  is where the approximation is weakest.

### Expensive / likely out of scope for this architecture

- **Real wet-in-wet diffusion / true backruns.** The full Curtis et al. treatment is a shallow
  fluid simulation across a grid — moving pigment concentration and water level via repeated
  ping-ponged passes. This is meaningfully bigger machinery than anything else here: a
  persistent simulation buffer, multiple passes per frame (or a bake step per stroke), and a
  new update loop distinct from "one accumulate, one shade." Not ruled out forever, but not a
  first-prototype candidate — the shader-only edge-darkening trick above is the pragmatic
  substitute and should be tried first.
- **Per-stroke reflow/reshaping as it ages** (e.g. actually spreading a stroke's baked
  footprint wider over time to mimic paper absorption spreading pigment). The accumulator
  replays fixed baked layers each frame (paint-accumulator's whole "replay `[f-K, f]`" design
  depends on layers being immutable once emitted); an aging effect that needs a stroke's own
  *geometry* to change over its lifetime breaks that determinism/scrub-safety guarantee and
  should be avoided — any watercolor-aging effect needs to be expressible as "shade this pixel
  differently based on its age," not "re-splat this stroke differently."

## Recommended first prototype

Cheapest technique that would still plausibly read as "watercolor," per the survey above:
**edge darkening + reduced relief + desaturation, entirely in the shading pass, no new
buffers.** All three are shader-only, all three have a direct existing hook (coverage
gradient for edge darkening, height decay for relief, color decay for desaturation), and
watercolor-ground.md's own note that edge darkening alone is what tips an airbrush gradient
into reading as watercolor is a strong, already-recorded signal that it's worth trying before
anything more elaborate. Skip granulation and faked bleed for the first pass — they add real
value but aren't needed to answer the first question, which is just "does this trio read as
watercolor at all."

## Standalone test scene

A new page analogous to `swatch.html`: `watercolor-swatch.html` / `src/watercolor-swatch.ts`.
Same reuse pattern — shell (camera controls, params panel), `stroke-mesh.ts`, `height-pass.ts`
— but with its own shading-pass variant carrying the watercolor treatment behind a mix
uniform, since the real accumulator's age signal doesn't exist yet to drive this from.

What it needs to let someone actually judge the look:

- A handful of static strokes and a couple of broader, low-relief washes (not just brush
  strokes — the wash case is closer to what aged/flattened paint should look like than a
  full-width brush stroke is), at a few different **simulated ages** — a per-swatch or
  per-slider fake age/mix value (0 = pure oil, 1 = full watercolor) standing in for the real
  per-pixel age channel.
- At least one pair of overlapping strokes, since edge darkening and backrun-adjacent effects
  are specifically about what happens where coverage transitions or where two washes meet —
  a single isolated stroke won't show that.
- The mix control exposed live in the params panel (same "live re-render on any param change
  while paused" the swatch page already has), so the edge-darkening/relief/desaturation
  weights can be tuned by eye against a reference rather than guessed on paper.

This validates the *look* only — it deliberately does not touch paint-accumulator, age
channels, or stage bands. That wiring is the next section, done only after this reads right.

## Integration path (once the standalone prototype validates)

Once a treatment is picked: aged layers in the accumulator route through it instead of the
plain oil-impasto shading once past some point in paint-accumulator's existing stage bands —
concretely, the "aged" stage (the last of `stageCount`, e.g. stage 3 of `[1.0, 0.5, 0.15]`)
becomes the trigger, read from `RT_height`'s existing G (age) channel in the shading pass.
This should not invent a second aging signal parallel to paint-accumulator's — the whole
point of building the stage-banded decay there first is that other systems (art-direction is
already on record doing the same for hue/saturation) drive off it rather than each growing
their own clock.

Two shapes this could take, deliberately left open rather than picked here (see open
questions): a hard switch at the stage boundary, or a continuous blend weighted by the
existing continuous `halfLife` weight underneath the stage banding. Either way, the shading
pass gains a second code path (or a blended mix of two code paths) selected/weighted by that
existing per-pixel signal — no new render target, no new pass, no new buffer.

## Open questions

Flagged for a human to weigh in on, not resolved here:

1. **Hard stage-cut vs. continuous blend.** A hard switch at the aged-stage boundary is
   simpler and matches how paint-accumulator already treats opacity ("discrete stages, not a
   smooth ramp"), but risks the oil/watercolor boundary reading as a seam — arguably the same
   "two layers of a collage" failure mode watercolor-ground.md explicitly warns against for
   ground/paint. A continuous blend on the underlying `halfLife` weight avoids the seam but
   risks a mushy in-between zone that reads as neither look convincingly. Needs to be judged
   against the actual running toy, not decided on paper.
2. **Does watercolor aging need its own color-shift/desaturation curve, or does it reuse
   art-direction's topmost-layer hue-shift/saturation-falloff machinery?** Two independently
   tuned desaturation systems (one for "this layer isn't newest," one for "this layer is
   watercolor now") could double-apply or fight over the same pixels. Given paint-accumulator
   already delegates hue/saturation entirely to art-direction ("Related: topmost-layer color
   treatment"), the likely answer is watercolor-aging should drive the *same* per-channel color
   decay art-direction uses, with its own target endpoint (a muted/cool watercolor palette)
   rather than a parallel mechanism — but this should be confirmed once art-direction (P4) is
   actually built, not assumed now.
3. **Shared paper-grain texture with watercolor-ground, or a separate one?** Sharing the
   granulation/paper-tooth source between "the ground the paint sits on" and "the paint once
   it's aged into watercolor" would read as more consistent (paint settling into the same
   paper the ground is made of), but couples two not-yet-built systems together before either
   exists — if watercolor-ground's real paper tooth changes shape/scale later, watercolor-aged
   paint would need to track it. Using `shading-pass.ts`'s existing placeholder weave/grain
   independently is safer short-term but risks the two looking like unrelated textures later.
4. **Is the shader-only edge-darkening approximation the permanent answer, or a placeholder
   for a real diffusion sim later?** If the "expensive" tier's true wet-in-wet simulation is
   ever actually wanted, it's a big enough lift (persistent sim buffer, multi-pass update loop)
   that it probably deserves its own future work-item rather than living inside this one — but
   that's only worth deciding once the cheap approximation has actually been seen and judged
   insufficient, not preemptively.
5. **Per-dancer palette identity through the watercolor conversion.** art-direction's
   per-dancer palette-family lever (warm vs. cool) is a distinguishing cue for fresh paint —
   does aged/watercolor paint keep that distinction, or is homogenizing the two dancers' colors
   as they fade an acceptable (maybe even desirable — paint literally losing identity as it
   ages) side effect? Worth an explicit call rather than an accident of whatever curve gets
   picked.
6. **Should the standalone prototype fake age via a hand-tuned slider, or borrow a lightweight
   stand-in of paint-accumulator's stage/decay math to test the real transition curve?** A
   slider is cheaper to build and enough to judge the *rendering* look; a real stand-in would
   also validate the *transition* (how it behaves as a layer crosses a stage boundary) but
   means partially building paint-accumulator machinery before that item is otherwise
   scheduled. Leaning toward the cheap slider first, since the question this prototype exists
   to answer is "does watercolor read as watercolor," not "does the transition feel right" —
   but flagging in case that ordering is wrong.

## Done when

The standalone watercolor swatch page shows static strokes/washes at a few simulated ages
that a person looking at them (not reading the code) agrees read as a transition from wet oil
impasto to flat watercolor — soft edges, visible edge-concentration, reduced relief, muted
color — without a chosen treatment being picked yet for integration. Integration itself is
"done" only once aged paint in the real accumulator visibly converts per the treatment
validated here, keyed off paint-accumulator's existing age/stage signal with no second aging
clock introduced.
