---
id: impasto-shading
parent: roadmap
phase: P2
state: in-progress
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

## Status

Built as three passes, all single-frame (no accumulation — that's still [paint-accumulator](paint-accumulator.md)):

1. `src/paint/stroke-mesh.ts` — instanced billboard quads, one per stroke, oriented along
   each stroke's velocity *in view space* (not full screen-space with aspect correction —
   close enough with a near-frontal fixed camera, and it avoids duplicating camera logic).
   Procedural bristle-streak alpha in the fragment shader per the brush-texture note above.
2. `src/paint/height-pass.ts` — an MRT `WebGLRenderTarget` (`{ count: 2 }`, half-float, no
   depth/stencil) holding `colorSum` (RGB = premultiplied color, A = coverage) and
   `heightSum` (R = accumulated height). Both outputs use a single `AdditiveBlending` state:
   WebGL2 core has no per-attachment blend funcs, so both channels accumulate additively and
   the composite pass recovers an averaged color as `colorSum.rgb / colorSum.a`. This
   "coverage-weighted additive accumulate, divide on read" pattern is what
   [paint-accumulator](paint-accumulator.md) will reuse for decay + splat, so building it this
   way now isn't premature — it's the same primitive one layer early.
3. `src/paint/shading-pass.ts` — full-screen quad; central-difference normals off `heightSum`,
   key + rim + Blinn-Phong specular, cheap AO from local height variance, composited over a
   flat `uGroundColor` (watercolor ground is still P5).

**Two bugs hit and fixed while building this, worth flagging for future shader work in this
repo:**

- `THREE.ShaderMaterial` auto-declares `position`/`uv`/`modelViewMatrix`/`projectionMatrix`
  as part of its injected prefix — redeclaring any of them in a custom vertex shader is a
  GLSL redefinition error. Only genuinely custom attributes (the `iCenter`/`iVelocity`/etc.
  instanced attributes here) need declaring.
- `THREE.Color(hex)` stores **linear-space** values by default (`ColorManagement` is on).
  Lighting math wants linear, which is what the passes already do — but a raw
  `ShaderMaterial` gets no automatic output-colorspace pass, so the composite shader must
  gamma-encode by hand at the very end (`linearToSRGB`) or everything renders far too dark.

Verified via pixel readback in-browser (no working screenshot tool in this environment):
ground color reads correctly post-gamma-fix, painted pixels show real color variation
(up to full saturation, not a uniform wash), and the painted region's screen-space bounding
box tracks the scrub position and shrinks/shifts frame-to-frame as the pose changes.
