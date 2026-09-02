---
id: paint-accumulator
parent: roadmap
phase: P3
state: planned
---

# paint-accumulator — splat, decay, and the bounded history window

## The problem this item exists to solve

A paint accumulator is **stateful**: each layer is drawn over what came before. A scrub bar
is **random-access**. You cannot un-paint to seek backwards, so a naive ping-pong buffer
makes scrubbing impossible and export non-reproducible.

## The fix

Half-life decay bounds its own history. If a layer's weight halves every `H` layers, then
after `H × 8` layers its contribution has fallen below the 8-bit noise floor and is
provably invisible. So:

```
K = H * 8            // history window, in layers
```

Any frame `f` renders by clearing the buffer and replaying layers `[f-K, f]`. Deterministic,
scrub-safe, and identical math to live playback — which simply does one decay + one splat
per layer and only rebuilds the full window on seek. Two code paths, one set of rules.

`K` replays of a few thousand instanced quads is cheap; this is why the stroke cache in
[pose-pipeline](pose-pipeline.md) is built as one buffer with per-frame offsets.

## Buffers

Multiple render targets, ping-ponged:

- `RT_color` — RGB. Coverage-weighted **over**, so new paint occludes old. This is the
  "layers stack" behaviour.
- `RT_height` — R = impasto height, **additive**, so paint physically piles up. G = age,
  used for wetness in [impasto-shading](impasto-shading.md).

### Stacking is occlusion, not blending

This is the single most load-bearing piece of this item. The toy's current color
accumulation is additive-and-divided-by-coverage — an average, with no notion of "on top of."
Two strokes crossing read as a blend, never one over the other, which is exactly why the
reference's layered look hasn't been reachable so far (flagged and explicitly deferred to
this item during [pose-pipeline](pose-pipeline.md) work — see its Round 13 notes).

`RT_color`'s "coverage-weighted **over**" is not additive blending: it's the standard
Porter-Duff *over* operator, `result = src.rgb * src.a + dst.rgb * (1 - src.a)`, applied per
layer in strict layer order. Newest layer's splat is the `src`; everything accumulated so far
is the `dst`. This is real occlusion — where a new stroke's coverage is opaque, it replaces
what's beneath it rather than averaging with it; where it's partial (soft bristle edges,
speckle falloff), it fades into what's beneath proportionally to its own alpha, not to a
global blend weight. Stacking order is strictly reverse-chronological: layer N+1 is always
drawn over layer N, never the reverse, and layers are never reordered or resorted by depth,
size, or any other property — occlusion is entirely a function of paint age.

## Decay

A full-screen pass runs *before* each layer's splat, behind a pluggable interface:

```ts
type Decay = (layersAgo: number) => number   // → weight in [0,1]
```

`halfLife(H)` is the algorithm to actually build and tune first — weight `0.5 ** (1/H)`
applied per layer. The interface stays swappable on purpose: both the numeric half-life *and*
the decay algorithm itself are things to keep playing with once paint is visibly stacking, not
settle on paper now. Candidates to swap in later, keeping the same framing:

- `linear(K)` — flat ramp to zero over K layers.
- `flooredExp(H, floor)` — decays toward a permanent ghost rather than to nothing.
- `none()` — pure accumulation, for seeing what the mud looks like.

Decay applies to height (paint settles and flattens) and to color (desaturates toward the
ground) at independently tunable rates — they need not fall off together, and the difference
between them is a real art-direction lever.

### On the half-life period

The original intuition was "each new layer halves the one below", i.e. `H = 1`. That leaves
only ~8 visible layers, which is too thin to read as stacked. Start at **`H` between 4 and 8**
and tune. `K` follows from `H` automatically.

### On cadence

Decay is keyed to **layer cadence** (layers/sec from [toy-shell](toy-shell.md)), *not* render
fps. "Each time we reach a new layer above" is a statement about layers; tying it to display
refresh would make the look change on a different monitor.

### Opacity reads as discrete stages, not a smooth ramp

`halfLife` still computes a continuous per-layer weight — that's the underlying math and
stays as-is. But the *visible* opacity falloff should read as a small number of discrete
bands rather than a smooth gradient: roughly three stages to start ("fresh," "settling,"
"aged"), each a flat opacity plateau rather than a continuously-varying value.

Quantize the continuous weight into bands rather than computing a separate curve: pick
`stageCount` (default 3) and `stageWeights` (e.g. `[1.0, 0.5, 0.15]`), then bucket each
layer's `layersAgo` into a stage by comparing its continuous `halfLife` weight against
threshold cutoffs between stages (e.g. thirds of the `[0,1]` weight range, or thirds of `K`
in layer-count space — pick whichever reads better once built). The banding is a display-side
step applied to the decay pass's output, not a replacement for the underlying `Decay`
function — `stageCount` and `stageWeights` are their own tunable parameters, independent of
`H`.

Whether 3 stages is the right count is genuinely unknown until real paint is stacked several
layers deep — see "Done when" below.

## Done when

Playback shows paint stacking and older layers receding at a rate the half-life parameter
visibly controls; scrubbing to an arbitrary frame produces the same image as playing to it.
Newest-over-oldest occlusion is visually unambiguous where strokes overlap — no averaging
artifact where two crossing strokes both show through each other.

**Open question to check once staging is visible, not resolved on paper:** does 3 discrete
opacity stages read as distinct once several layers are actually stacked and occluding each
other, or does it need more (finer gradation) or fewer (the bands blur together)? Tune
`stageCount` empirically against the running toy rather than guessing further here.

## Related: topmost-layer color treatment

Giving the newest layer a distinct color (not just opacity) from older paint is
[art-direction](art-direction.md)'s "Hue shift" / "Saturation falloff" territory, not this
item's — see that doc for the concrete candidate treatments. This item is only responsible for
making the *decay* machinery (per-channel independent curves, see above) available for
art-direction to drive.
