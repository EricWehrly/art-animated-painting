---
id: impasto-shading
parent: roadmap
phase: P2
state: planned
---

# impasto-shading — making it read as oil, not as smears

## Why

This is the item that decides whether the toy looks like its premise. Flat colored marks
read as a smudge diagram; the same marks with a height field and a light read as loaded oil
paint standing off the canvas. **The three-dimensionality is entirely a shading trick over
`RT_height`** — no geometry is extruded.

## Passes

1. **Normals** — central differences over `RT_height`, scaled by a `reliefStrength`
   parameter. Cheap, and the scale knob is the single most effective "more crusty" dial.
2. **Lighting** — a fixed key light plus a rim. Oil wants a *chunky* specular: a tight,
   bright lobe that catches ridge tops and skips valleys, which is what sells wet-looking
   pigment. Blinn-Phong with a high exponent, plus a small amount of ambient occlusion
   approximated from local height variance so the valleys between strokes go dark.
3. **Ground composite** — over the canvas. Flat color for now; becomes real in
   [watercolor-ground](watercolor-ground.md).

## Details worth getting right

- **Brush texture.** Strokes splat with a brush alpha that has *bristle streaks*, not a soft
  gaussian. Uniform blobs are the main reason naive versions look like plastic. Procedural
  is fine: a few sine-modulated ridges along the stroke's length, jittered per instance.
- **Height is not alpha.** They accumulate under different rules (additive vs over) and must
  stay in separate channels; conflating them is why paint stops looking thick once coverage
  saturates.
- **Precision.** Additive height needs float or half-float targets. On 8-bit, height
  quantizes and normals come out in visible terraces.

## Done when

A single scrubbed frame of strokes reads convincingly as thick paint under a raking light —
before any accumulation exists.
