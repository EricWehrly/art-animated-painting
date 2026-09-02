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
| P6 | [watercolor-aging](work/watercolor-aging.md) — aged paint converts to a watercolor treatment | in-progress |

## Decisions on record

- **Single toy now, shell extracted later.** The loop/params/scrub live in `src/shell/` as
  standalone modules with no toy-specific imports, so lifting them into a package when a
  second toy appears is a move, not a rewrite. See [toy-shell](work/toy-shell.md).
- **Fixed camera *angle*, adjustable framing.** It is a painting — orbiting or rotating the
  view would smear the accumulated surface once [paint-accumulator](work/paint-accumulator.md)
  exists. That's the part that stays parked behind a flag. Distance (zoom) and look-at target
  (pan) are a different thing — a viewfinder/composition choice with no accumulated paint to
  smear yet — and are mouse-driven via `shell/camera-controls.ts`: wheel zooms centered on the
  current target, left-drag pans, a "reset view" button returns to the home framing. Revisit
  whether pan/zoom should stay live once accumulation is running, at P3 time.
- **Decay is keyed to layer cadence, not render fps.** See [paint-accumulator](work/paint-accumulator.md).

## Built: brush swatch canvas

`swatch.html` / `src/swatch.ts` — a stripped-down canvas showing six large, isolated
strokes (varied angle/width/length/color, two with attached speckle clusters), no dancers,
no pose data, no scrubbing. Reuses the shell (camera controls, params panel) and the full
paint pipeline (stroke-mesh, height-pass, shading-pass) unmodified. Built once iterating
against the full dance scene stopped being fast enough to judge paint-quality changes —
turned out to be essential: it's what made the `[impasto-shading]` height-field bug (see
below) actually diagnosable, since a handful of big strokes filling the frame is far easier
to reason about than a couple hundred small ones on two moving figures.

Linked from `index.html` ("brush swatches →") and vice versa ("← painting").

## Source data

CMU Graphics Lab Motion Capture Database, subjects **60** and **61** — 15 salsa trials each,
captured simultaneously as a couple. Verified: matching frame counts (`60_01`/`61_01` are both
2243 frames @ 120fps) and root trajectories 8–38 units apart with hips at ~17 units, i.e. the
two skeletons already share one world space at partner distance. No sync or placement needed.

**All 15 numbered pairs verified and baked** (see [pose-pipeline](work/pose-pipeline.md) Round
22): every `60_NN`/`61_NN` pair (01 through 15) has a matching rig, matching frame counts (no
trimming needed for any of them), and a plausible partner distance (13.5–20.2 unit average,
clustered around the ~17-unit figure above). All 15 are baked into `public/data/` as
`pose-cache-<NN>.json`/`.bin` and selectable live from the "trial pair" dropdown in the params
panel — see `src/pose/pose-cache.ts`'s `AVAILABLE_TRIAL_PAIRS` and `scripts/bake-pose.mjs`.

CMU's data is free for all uses. BVH conversions by Bruce Hahne (cgspeed), mirrored at
[una-dinosauria/cmu-mocap](https://github.com/una-dinosauria/cmu-mocap).

Default trial: **60_01 / 61_01** (18.7s). It is salsa rather than slow dancing — no free
slow-dance couple capture appears to exist — so a global `timeScale` slows it. This helps
rather than hurts: slower bones fling shorter, fatter strokes. Any of the 15 pairs can be
switched to live via the trial-pair picker; 60_12/61_12 (14.1s, calmer, shorter loop) was the
first-known alternate before all 15 were verified.

### Alternate sources considered (not adopted)

Researched as a follow-up in case a genuinely slower/closer partner dance turns up in a directly
usable format (BVH/FBX, no proprietary retarget step):

- **[Motorica Dance Dataset](https://github.com/simonalexanderson/MotoricaDanceDataset)** — free
  for personal/hobby use (commercial needs permission), BVH, includes paired-dancer jazz/Charleston
  sessions. Best-fit format-wise; unconfirmed whether paired sessions share one coordinate space
  the way CMU 60/61 do — would need the same verification pass before use.
- **ExPI (Lindy Hop)** — genuine paired capture, but requires a data-use agreement and the style is
  acrobatic/aerial, not slow.
- **Duolando DD100** — includes actual Waltz/Foxtrot/Tango, closest style match, but gated behind
  the SMPL-X license and needs retargeting out of SMPL-X, not a direct BVH pull.
- **MDD / InterDance** — include Waltz, but not yet publicly released as downloadable data as of
  this writing.

None beat CMU 60/61 on the combination of license clarity, format, and verified shared-space
pairing, so no swap is planned unless the Motorica pairing checks out.
