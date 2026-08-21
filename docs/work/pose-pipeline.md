---
id: pose-pipeline
parent: roadmap
phase: P1
state: in-progress
---

# pose-pipeline — from BVH to flung strokes

## Why

The skeletons are scaffolding, never rendered. Their only job is to say *where paint should
be thrown and how hard*. This item covers everything from raw mocap to a GPU-ready buffer
of strokes, for both dancers.

## Offline bake

`scripts/bake-pose.mjs` parses the two BVH files, runs forward kinematics, and writes a
compact binary of joint world positions.

Why bake rather than parse at runtime:

| | vendored BVH | baked binary |
|---|---|---|
| payload | ~7 MB of text | ~300 KB |
| runtime | BVH parser + FK every load | one `fetch` + `Float32Array` view |

The bake also decimates 120fps → a chosen sample rate, and trims to a loop-friendly range.

Output layout — a small JSON header (joint names, frame count, rate, bone parent indices)
plus a flat `Float32Array` of `[frame][joint][xyz]`.

## Emitters

Joints alone are too sparse — paint thrown only at elbows and knees reads as a dot pattern.
Instead, sample N points along each **bone segment** (parent → child), each carrying:

- position (world, then projected to screen space against the fixed camera)
- velocity (central difference against the neighbouring baked frames)
- bone id and normalized position along the bone

Bone thickness is a per-bone constant in a small table — torso and thighs throw fat paint,
fingers throw none. Hands and feet are the expressive ends; they get denser sampling.

## Strokes

Each emitter becomes a stroke instance:

- **length** ∝ speed — a still bone dabs, a fast bone streaks
- **angle** = velocity direction in screen space
- **width** ∝ bone thickness
- **volume/height** ∝ speed, feeding the height field in [impasto-shading](impasto-shading.md)
- **color** from the palette, keyed by dancer and bone group — see [art-direction](art-direction.md)

All frames' strokes are baked once into a single interleaved `Float32Array` with a per-frame
offset table, uploaded as one GPU buffer. Drawing a frame is then one instanced draw with an
offset and count. This is the cache that makes replay cheap — and replay is load-bearing for
scrubbing, see [paint-accumulator](paint-accumulator.md).

Budget: 2 dancers × ~20 bones × 8 samples ≈ 320 strokes/frame; ~1200 frames ≈ 384k strokes
≈ 18 MB. Comfortable.

## Done when

Both dancers' strokes for a single scrubbed frame render as flat colored marks in roughly
human arrangement, moving coherently as the scrub bar moves.

## Status

Bake (`scripts/bake-pose.mjs` + `scripts/lib/bvh-parser.mjs`) is written and verified: the
FK output's hip separation matches the raw-BVH numbers recorded in `docs/roadmap.md` exactly,
at every sampled frame. `scripts/fetch-bvh.mjs` pulls the two trials into a gitignored cache
rather than vendoring BVH text, per the "why bake" rationale above. Default bake
(60_01/61_01 @ 30fps) produces 561 frames x 38 joints x 2 dancers, ~500 KB.

Runtime `src/pose/pose-cache.ts`, `skeleton.ts`, `emitters.ts` are written — emitters sample
points along each bone with position + per-frame velocity delta. **Not yet done: the "Strokes"
section above** — emitters currently render directly as flat `THREE.Points` in `main.ts` as
a P1 placeholder; converting them into actual stroke instances (length/angle/width/volume
from velocity, baked into one interleaved buffer with per-frame offsets) is the remaining
pose-pipeline work, and is what [impasto-shading](impasto-shading.md) and
[paint-accumulator](paint-accumulator.md) will consume.
