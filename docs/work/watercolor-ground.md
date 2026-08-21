---
id: watercolor-ground
parent: roadmap
phase: P5
state: planned
---

# watercolor-ground — the surface the oils play against

## Why

The stated goal is oils sitting on a watercolor canvas. The interesting part is **not** a
background image — it is the *interaction* between a rough, absorbent ground and thick paint
laid over it.

## The ground itself

Pre-baked once at load, not simulated per frame:

- **Paper tooth** — fbm noise with directional fiber structure, giving a height field.
- **Washes** — broad, soft color fields. A simplified take on Curtis et al.'s wet-in-wet
  model: a few GPU passes of pigment diffusion, plus **edge darkening**, where pigment
  accumulates at the drying boundary of a wash. Edge darkening is the single detail that
  makes something read as watercolor rather than as an airbrush gradient.
- **Granulation** — pigment settling into the paper's low spots, driven by the tooth height.

## The interaction — this is the payoff

The paper's height field feeds *two* places:

1. **The splat** ([paint-accumulator](paint-accumulator.md)) — where the ground is low, a
   low-volume stroke doesn't make contact and skips. That is dry-brush, and it is the most
   convincing single behaviour available here.
2. **The shading pass** ([impasto-shading](impasto-shading.md)) — the ground's normals
   contribute where paint is thin, so bare canvas still catches the light as fabric.

Without (1), the ground is wallpaper behind the painting. With it, the oils and the paper
are part of the same surface.

## Done when

Thin strokes visibly catch on the paper's tooth, bare ground reads as watercolor under the
same light as the oils, and the two do not look like separate layers of a collage.
