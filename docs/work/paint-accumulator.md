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

## Decay

A full-screen pass runs *before* each layer's splat, behind a pluggable interface:

```ts
type Decay = (layersAgo: number) => number   // → weight in [0,1]
```

- `halfLife(H)` — the default. Weight `0.5 ** (1/H)` applied per layer.
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

## Done when

Playback shows paint stacking and older layers receding at a rate the half-life parameter
visibly controls; scrubbing to an arbitrary frame produces the same image as playing to it.
