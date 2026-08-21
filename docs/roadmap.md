# Roadmap — art-animated-painting

A small web art toy: two mocap dancers rendered not as characters, but as **flung paint**
that stacks into a crusty, three-dimensional oil-painting surface, layer over layer,
with older layers fading so the surface stays legible instead of turning to mud.

## Work-item identifier scheme

Flat kebab-case slugs. Each work item is one doc under `docs/work/<slug>.md` that declares
its own `id:` and names its `parent:`. Hierarchy lives in the metadata, never in the slug.

Commits cite the slug in the subject, in brackets:

```
[pose-pipeline] bake CMU 60/61 salsa to a compact pose cache
```

Traversal:

- **Backward** — "what work served this item?" → `git log --grep="\[pose-pipeline\]"`
- **Forward** — "what was this file serving?" → `git log -- src/pose/emitters.ts`, read the
  cited slug, open `docs/work/<slug>.md`, follow its `parent:` up to here.

## Items

| Phase | Item | State |
|---|---|---|
| P0 | [toy-shell](work/toy-shell.md) — canvas, fixed-step loop, params, scrub, export | planned |
| P1 | [pose-pipeline](work/pose-pipeline.md) — BVH bake, emitters, stroke generation | planned |
| P2 | [impasto-shading](work/impasto-shading.md) — height field, normals, oil lighting | planned |
| P3 | [paint-accumulator](work/paint-accumulator.md) — splat, decay, history window | planned |
| P4 | [art-direction](work/art-direction.md) — palette, depth, topmost-layer treatment | planned |
| P5 | [watercolor-ground](work/watercolor-ground.md) — paper tooth, washes, interaction | planned |

## Decisions on record

- **Single toy now, shell extracted later.** The loop/params/scrub live in `src/shell/` as
  standalone modules with no toy-specific imports, so lifting them into a package when a
  second toy appears is a move, not a rewrite. See [toy-shell](work/toy-shell.md).
- **Fixed camera.** It is a painting. A moving camera smears the accumulated surface;
  parked behind a flag as a later experiment.
- **Decay is keyed to layer cadence, not render fps.** See [paint-accumulator](work/paint-accumulator.md).

## Source data

CMU Graphics Lab Motion Capture Database, subjects **60** and **61** — 15 salsa trials each,
captured simultaneously as a couple. Verified: matching frame counts (`60_01`/`61_01` are both
2243 frames @ 120fps) and root trajectories 8–38 units apart with hips at ~17 units, i.e. the
two skeletons already share one world space at partner distance. No sync or placement needed.

CMU's data is free for all uses. BVH conversions by Bruce Hahne (cgspeed), mirrored at
[una-dinosauria/cmu-mocap](https://github.com/una-dinosauria/cmu-mocap).

Default trial: **60_01 / 61_01** (18.7s). Alternate: **60_12 / 61_12** (14.1s, calmer, shorter loop).
It is salsa rather than slow dancing — no free slow-dance couple capture appears to exist — so a
global `timeScale` slows it. This helps rather than hurts: slower bones fling shorter, fatter strokes.
