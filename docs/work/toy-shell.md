---
id: toy-shell
parent: roadmap
phase: P0
state: planned
---

# toy-shell — canvas, loop, params, scrub, export

## Why

Every art toy here needs the same four things: a correctly-sized canvas, a loop that
advances simulation time in fixed steps, a panel of live-tunable parameters, and a way to
get a frame out as an image. Writing these once, with no toy-specific imports, means the
second toy costs a fraction of the first.

## Scope

Single toy for now — **no package boundary**. These live in `src/shell/` as standalone
modules. The constraint that earns the future extraction: nothing in `src/shell/` may
import from `src/paint/` or `src/pose/`.

- `canvas.ts` — device-pixel-ratio-correct sizing, resize handling, WebGL2 context.
- `clock.ts` — fixed-step accumulator loop. **Simulation time is decoupled from render
  time**; the toy asks for "layer N", never "however long since last frame". This is what
  makes output deterministic and export reproducible.
- `params.ts` — Tweakpane bindings over a plain params object, with URL-hash
  serialization so a look worth keeping can be linked.
- `timeline.ts` — scrub bar over a known frame count; emits seek events.
- `capture.ts` — PNG of the current frame. Video export deferred.

## Design notes

The loop exposes two distinct callbacks, and the split matters:

- `onLayer(n)` — advance the painting by one layer of paint. Called zero or more times
  per rendered frame, driven by layer cadence.
- `onDraw()` — shade and present the current accumulated surface.

Layer cadence is a parameter (layers/sec), independent of display refresh. See
[paint-accumulator](paint-accumulator.md) for why the decay math depends on this.

## Done when

The scrub bar moves a placeholder scene through its frames, params round-trip through the
URL hash, and the loop's layer count for a given wall-clock span is identical across runs.
