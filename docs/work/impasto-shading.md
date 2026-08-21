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

### Round 2: brush texture, directionality, speckles

User feedback against reference photos (thick ridged impasto brushwork; a Pollock-style
flung/dripped piece) called out three problems: strokes read as "pixelly" rather than
brushed, not enough directionality, and no speckle/spatter from the fling itself. Root
causes and fixes:

- **Bristle aliasing.** The ridge pattern used a fixed cycle count across UV space
  regardless of a stroke's actual on-screen width — on narrow strokes that crammed dozens
  of cycles into a couple of screen pixels, aliasing into visual noise (the "pixelly" look).
  Fixed in `stroke-mesh.ts`: ridge spacing is now fixed in *world* units (`vWidth` is passed
  as a varying), and ridge contrast fades out via `fwidth(phase)` once its on-screen
  frequency exceeds what a pixel can resolve, instead of letting it alias.
- **Noisy direction.** `emitters.ts` computed velocity as a one-sided finite difference
  (frame vs. frame−1). For slow bones the per-frame delta is tiny, so that difference was
  dominated by resample noise — strokes on slow-moving limbs had essentially random
  orientation frame to frame. Switched to a true central difference (frame+1 vs. frame−1)/2,
  which is measurably smoother.
- **No speckles.** Added `generateSpeckles()` in `pose/strokes.ts` — small, nearly-round
  Stroke instances flung beyond a fast emitter's tip, count and scatter radius scaling with
  speed. Deliberately reuses the *exact same* Stroke type and stroke-mesh rendering as main
  strokes (a speckle is just a small stroke), so no new geometry or shader was needed.
  Speckle placement is seeded deterministically from `(frame, emitter index, speckle index)`
  via a GLSL-style sine hash — otherwise re-rendering the same paused frame on every param
  tweak would make the speckles jump around, which read as jittery rather than painted.

Also added, since testing the above required it: a `cameraDistance` param that dollies the
fixed camera along its original viewing ray (angle unchanged, so it doesn't reopen the
"fixed camera" decision — nothing moves once dialed in) for actually seeing stroke detail
up close, and a live re-render on any param change while paused (previously a paused param
tweak did nothing until the next scrub/resize/playback tick).

Verified in-browser: with the same camera and speckles disabled, painted-pixel coverage
matches the pre-fix baseline (2142 samples at cameraDistance 90); with defaults restored
(closer zoom, speckles on) coverage rises to 6947; live-dragging the zoom control down to
35 through the actual Tweakpane DOM input (not just a reload) immediately re-rendered at
10232 samples filling most of the frame — confirming the live param-change path fires
correctly end to end, not just on load.

### Round 3: it still reads as flat "screen color", not paint

Feedback after zoom/pan landed: even up close, the surface still reads as flat fills, not
oil paint. The real cause: every stroke had exactly **one** RGB value with only *coverage*
(alpha) varying — dividing a flat premultiplied color by its own coverage in the composite
pass exactly cancels the coverage term, so a stroke's interior was provably uniform in hue
regardless of the bristle pattern. Real paint varies hair to hair; a flat fill under any
lighting still reads as a flat fill.

Three changes, in `stroke-mesh.ts` and `shading-pass.ts`:

- **Per-fragment pigment variation.** The bristle ridge pattern now also modulates color
  value (ridge tops = more pigment = brighter; valleys = thinner), plus an independent
  fine-grain hash decorrelated from the ridge geometry (otherwise it's the same pattern
  read twice, which doesn't look like independent pigment jitter).
- **Height-driven thickness shading.** Paint color now responds to the height field itself,
  not just to lighting normals — thin paint (`smoothstep(0.05, 0.85, h)`) shifts darker
  toward the ground tone, thick/overlapped paint shifts brighter with a slight warm boost.
  Previously height only ever affected the *normal* (lighting), never the base color, so
  two areas with identical color but very different thickness looked identical up close.
- **Textured ground instead of a flat fill.** A cheap procedural canvas-weave (screen-space,
  driven by `gl_FragCoord`, not world UV, so it reads as fabric texture at any zoom level)
  replaces the previously-uniform `uGroundColor`. This is a stand-in for real watercolor
  paper (P5), not that — but a flat single-RGB ground was directly part of the "screen
  color" complaint, especially once zoom made bare canvas fill more of the frame.

Also tuned for more contrast: specular is now tinted toward the paint color (40% mix)
instead of pure white — pure-white highlights read as glare/plastic rather than paint
catching light. AO gained a second, wider sampling tap so shadowing between adjacent
bristle ridges (not just single-texel neighbors) actually shows up, and its clamp ceiling
raised (deeper max shadow). Default `reliefStrength` raised 14 → 22 (range extended to 60)
as the primary "more crusty" dial now does more per unit.

Verified in-browser: in a fully-interior patch of a stroke (every sampled pixel confirmed
far from ground color, so no coverage-edge contamination), per-channel min/max range is now
R 172–191, G 78–85, B 67–74 — real intra-stroke variation where the old code was
mathematically guaranteed exactly uniform. Ground patches likewise show non-zero per-pixel
variance where they were previously a single exact RGB value.

### Round 4: still no visible 3D curvature — a real height-field bug, not a tuning problem

Round 3's numeric checks all passed (real color variance, correct ground texture) but the
user, looking at the actual render, said it "looks the same" — flat, glowing, no visible
paint relief. That gap between "the math checks out" and "the human looking at it disagrees"
is the reason [swatch.html](../roadmap.md) got built: a handful of large strokes filling
the frame, and a local-HTTP-server trick to actually get a screenshot out of the browser
sandbox (`scripts/dev-upload-server.mjs` — the page POSTs `canvas.toBlob()` to a tiny Node
server, which writes it to disk; there is still no working screenshot tool in this
environment). First real look at the render confirmed the complaint immediately: hard
barcode-regular stripes, zero visible curvature, pure-black ground despite the "textured
ground" fix.

Two real, distinct bugs, found by actually looking rather than trusting pixel statistics:

1. **The alpha-coverage mask (`widthMask`) was reused for height**, and it's a near-flat
   plateau across most of a stroke's width — so there was no broad surface for a lighting
   normal to curve across, only fine bristle ripples with nothing underneath them. Fixed by
   giving height its own cosine-dome cross-section (`crown` in `strokeShapeGLSL`),
   independent of alpha's coverage shape.
2. **The height field itself was reading back as exactly zero**, discovered only after
   extensive isolation (documented in code comments, not repeated here) — trying single vs.
   two-attachment render targets, shared vs. independent geometry between the color/height
   meshes, shared vs. textually-distinct vertex shader source, and separate vs.
   vector-packed varyings, none of which mattered. The actual cause: `heightFragmentShader`
   wrote `alpha = 0.0` in its unused 4th output channel (nothing ever reads it — the
   composite pass only samples `.r`), and writing zero alpha into an additively-blended
   half-float render target silently zeroed the RGB channels too, on this environment's
   WebGL2/ANGLE build. Setting that channel to `1.0` — a value that is never read — fixed
   it completely. `stroke-mesh.ts` carries a deliberately blunt comment on that line so it
   doesn't get "cleaned up" by someone who doesn't know why it's there.

The color/height split ended up as two independent `InstancedBufferGeometry`s (in
`stroke-mesh.ts`) and two single-attachment render targets (in `height-pass.ts`, replacing
the original MRT target) — not because either was the actual fix, but because they were
already in place from the isolation process and are harmless (the extra draw call is
negligible at this instance count), so they were kept rather than reverted back to MRT and
re-tested again.

Verified visually this time, not just numerically: the swatch canvas now shows real domed
strokes with a highlight running down the center of each and darker shading toward the
edges — a rounded bead of paint, not a flat colored bar. Still not fully matching the
reference photos' matte, textured impasto (currently reads a bit glowy/specular-dominated,
and the bristle texture is now subtle compared to the dome), which is the next thing to
tune, but the structural bug — no height signal reaching the shading pass at all — is
resolved.

### Round 5: domed strokes still read as a glowing tube, not matte paint

User feedback against the reference photos again, this time on the fixed-relief render: it
"doesn't look anything like" real oil brush strokes — screenshots showed saturated,
soft-edged shapes with one bright glowing line down the center, closer to a lit glass/neon
rod than paint. Researched real-time painterly-shading technique (see sources below) rather
than continuing to guess; one write-up describing the same symptom named the actual cause: a
smooth single-surface stroke has exactly one normal direction along its ridge line, so it
can only ever produce one continuous specular highlight, no matter how lighting is tuned.
Real impasto has no single surface direction — it's built from many small ridge-top facets,
each catching the light independently, so highlights scatter into glints rather than
tracing a line.

Changes, in `stroke-mesh.ts` and `shading-pass.ts`:

- **Baked the bristle ridge pattern into height, not just alpha/color.** Previously the
  ridge pattern only modulated coverage and pigment tint — the height field itself was a
  perfectly smooth dome, so central-difference normals never saw any ridge structure at all.
  Now `heightProfile` includes the same ridge signal (scaled down, `* 0.7`), so the normals
  driving specular actually vary facet to facet.
- **Widened ridge spacing** (`ridgeSpacing` 0.18 → 0.42, fewer cycles across a stroke's
  width) — reference photos show a handful of broad knife-daub planes catching light
  distinctly, not fine parallel hatching.
- **Added a coarse two-bump "lump"** multiplying the crown, so a stroke's cross-section
  silhouette isn't a perfectly symmetric tube — paint piles unevenly under a loaded brush.
- **Ragged edges.** Both the width falloff and the tip/tail caps now wobble via a
  low-frequency (not per-pixel, which would alias into static) sine perturbation, so stroke
  boundaries look torn/dragged instead of a clean mechanical silhouette.
- **Toned down the specular lobe** (exponent 40 → 18, intensity roughly halved, tint shifted
  further toward pigment color, 40% → 60%) and **partially quantized the diffuse response**
  (blended 45% toward a 4-band toon step) — a smooth Lambertian gradient plus a
  tight bright lobe is what reads as glossy plastic; real matte paint's lit/shadow transition
  is closer to a few discrete facet-bands.

Sources consulted: a [stylized paint shader breakdown](https://cyn-prod.com/stylized-paint-shader-breakdown)
describing randomized per-stroke normals and toon-stepped (not smooth) diffuse as the fix for
the same "glossy/plastic" symptom. (A second search hit, Maxime Heckel's painterly-shaders
post, turned out to cover a Kuwahara post-filter approach — a different technique, not
adopted here.)

Verified visually on both the swatch canvas and the real dance scene: the single glowing
centerline is gone, replaced by scattered highlight breakup along wider, chunkier ridges,
with visibly torn stroke edges. Not yet a full match to the reference photos' broad flat
knife-daub facets — still reads more like directional hatching than distinct overlapping
daubs — flagged as the next tuning target, not treated as done.
