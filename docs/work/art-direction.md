---
id: art-direction
parent: roadmap
phase: P4
state: planned
---

# art-direction — palette, depth, and giving the top layer its due

## Why

By P4 the machinery works and the remaining questions are aesthetic. This item is explicitly
a **play-and-see** phase: it exists to hold the knobs, not to prescribe the answer.

## Open questions to play with

The original brief listed several candidate treatments for making the most recent layer read
as *on top*. They are not mutually exclusive, and the plan is to build them as independent,
simultaneously-active parameters rather than picking one up front:

- **Hue shift** — topmost layer gets its own color, everything below tends toward a common
  tone. Concrete candidates, not yet chosen between: **complementary shift** (topmost layer's
  hue rotated ~180° from the layer(s) beneath), **desaturation** (topmost stays same hue, just
  more saturated — older paint desaturates toward the common tone instead of shifting hue), or
  some other chroma effect (value shift, a fixed accent hue regardless of source color). Expose
  as a live-tunable parameter following the existing Tweakpane pattern in
  `src/shell/params.ts` (`pane.addBinding(params, ..., { min, max, step, label })`) so the
  three read as switchable/blendable options rather than a single hardcoded mechanism.
- **Saturation falloff** — saturation halves per layer while value holds.
- **Opacity falloff** — the straightforward reading, already provided by the decay in
  [paint-accumulator](paint-accumulator.md).
- **Relief falloff** — older layers flatten while keeping color. Often the most convincing
  of the four, because buried paint really does get filled in rather than fading.

Each gets its own rate, and the decay interface already supports independent curves per
channel.

## Per-dancer identity

Two figures need to stay distinguishable as paint. Levers, roughly in order of strength:
palette family (warm vs cool), stroke width, brush texture coarseness, and relief height.
Palette alone is likely insufficient once layers overlap in the middle of the frame, which
is exactly where the two dancers spend their time.

## Depth

The camera is fixed, so depth must be carried by the paint itself: nearer bones get more
relief and higher-key color; farther bones get compressed contrast. This is the cheapest
available cue and it doubles as a way to keep the two figures from flattening into each other.

## Done when

The couple reads as two dancers, the topmost layer reads as topmost, and the parameters that
produced a given look can be captured in a shareable URL.
