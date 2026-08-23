import * as THREE from "three";
import type { Stroke } from "../pose/strokes";

const strokeVertexShader = /* glsl */ `
  precision highp float;

  // "position" (base quad corner, x/y in [-0.5, 0.5]), modelViewMatrix and projectionMatrix
  // are declared automatically by THREE.ShaderMaterial — redeclaring them here would collide.
  in vec3 iCenter;
  in vec3 iVelocity;
  in float iWidth;
  in float iLength;
  in float iVolume;
  in vec3 iColor;
  in float iSeed;
  in float iChainOffset;
  in float iCapStart;
  in float iCapEnd;

  out vec2 vUv;
  out vec3 vColor;
  out float vVolume;
  out float vSeed;
  out float vWidth;
  out float vLength;
  out float vChainOffset;
  out float vCapStart;
  out float vCapEnd;

  void main() {
    vec3 viewCenter = (modelViewMatrix * vec4(iCenter, 1.0)).xyz;
    vec3 viewVel = mat3(modelViewMatrix) * iVelocity;

    vec2 dir = viewVel.xy;
    float dirLen = length(dir);
    vec2 tangent = dirLen > 1e-6 ? dir / dirLen : vec2(1.0, 0.0);
    vec2 normal = vec2(-tangent.y, tangent.x);

    vec2 offset = tangent * (position.x * iLength) + normal * (position.y * iWidth);
    vec3 viewPos = viewCenter + vec3(offset, 0.0);

    gl_Position = projectionMatrix * vec4(viewPos, 1.0);

    vUv = position.xy + 0.5;
    vColor = iColor;
    vVolume = iVolume;
    vSeed = iSeed;
    vWidth = iWidth;
    vLength = iLength;
    vChainOffset = iChainOffset;
    vCapStart = iCapStart;
    vCapEnd = iCapEnd;
  }
`;

// Shared by both fragment shaders below — computes alpha (coverage) and heightProfile
// (the paint's cross-section shape) identically either way, so the color pass and the
// height pass always agree on where a stroke actually is.
const strokeShapeGLSL = /* glsl */ `
  float across = abs(vUv.y - 0.5) * 2.0; // 0 at center, 1 at edge
  float along = vUv.x; // 0..1 along THIS dab — only valid for the cap taper below, which
  // legitimately needs to know "am I near this dab's own start/end," not the limb's.

  // World-space distance along the whole CHAIN (not reset per dab) — drives every texture
  // pattern below (tear/bristle/facet/lump) instead of 'along', so a chain of touching dabs
  // reads as one continuously-textured limb rather than each dab restarting its own pattern
  // at 0 and visibly seaming against its neighbor. See pose/strokes.ts Stroke.chainOffset.
  float alongChain = vChainOffset + vUv.x * vLength;

  // A perfectly smooth-sided stroke reads as a mechanical decal — real paint applied with a
  // loaded brush or knife tears unevenly along its edge instead of stopping on a clean line.
  // Low-frequency wobble (a handful of bumps along the stroke's length, not per-pixel noise,
  // which would just alias into static) perturbs where the width falloff starts.
  float tearPhase = alongChain * 9.0 + vSeed * 13.0;
  float tear = sin(tearPhase) * 0.5 + sin(tearPhase * 2.3 + vSeed * 5.0) * 0.3;
  float edgeStart = clamp(0.5 + 0.16 * tear, 0.15, 0.7);
  float widthMask = 1.0 - smoothstep(edgeStart, edgeStart + 0.38, across);

  // Same idea applied to the tip/tail so the stroke's ends look dragged/lifted-off rather
  // than perfectly rounded caps — but ONLY at a true endpoint of a brush pass (vCapStart/
  // vCapEnd, set per-instance in pose/strokes.ts). An interior seam between two dabs that are
  // actually continuing the same chain must stay at full coverage right to its edge, or a
  // chain of touching dabs pinches closed at every join and reads as a beaded/dashed line
  // instead of one continuous painted limb — see docs/work/pose-pipeline.md Round 6.
  float capTear = 0.5 + 0.5 * sin(vUv.y * 7.0 + vSeed * 9.0);
  float tearCapStart = mix(0.0, 0.05, capTear);
  float tearCapEnd = mix(0.84, 0.94, capTear);
  float startFade = vCapStart > 0.5 ? smoothstep(tearCapStart, tearCapStart + 0.1, along) : 1.0;
  float endFade = vCapEnd > 0.5 ? (1.0 - smoothstep(tearCapEnd, tearCapEnd + 0.08, along)) : 1.0;
  float endCap = startFade * endFade;

  // Bristle ridges at a fixed WORLD-space spacing (not a fixed count across the UV range) —
  // a fixed cycle count aliased badly on narrow strokes, which is what read as "pixelly":
  // dozens of ridge cycles were being crammed into a couple of screen pixels. Two
  // frequencies beating against each other (not one clean sine) break the perfectly regular
  // "barcode" look a single frequency gives — real bristle spacing isn't uniform. Widened
  // from the original 0.18 to give fewer, broader facets — reference photos show chunky
  // knife-daub planes catching light distinctly, not fine parallel hatching.
  float ridgeSpacing = 0.42;
  float cycles = min(vWidth / ridgeSpacing, 40.0);
  float wave1 = vUv.y * cycles * 6.28318 + sin(vUv.x * 6.28318 + vSeed * 3.0) * 0.6 + vSeed * 11.0;
  float wave2 = vUv.y * cycles * 1.7 * 6.28318 + vSeed * 7.0;
  float rawBristle = 0.5 + 0.35 * sin(wave1) + 0.15 * sin(wave2);

  // Fade the ridge pattern out once its on-screen frequency exceeds what this pixel can
  // resolve (screen-space derivative of the phase), instead of letting it alias into noise.
  float phaseDeriv = fwidth(wave1);
  float bristleAmp = clamp(1.0 - phaseDeriv / 3.14159, 0.0, 1.0);

  // Chop the stroke into a few blocky facets along its length (2-3 cells, a hard per-cell
  // step, not a smooth gradient) instead of letting the ridge pattern run continuously end to
  // end — the ridge pattern alone still reads as combed hatching lines; this is what actually
  // breaks a stroke into a few distinct overlapping daubs, each with its own coverage/pigment/
  // height level, the way a loaded brush or knife deposits paint in separate touches rather
  // than one continuous stripe.
  float facetCell = floor(alongChain * 2.6 + vSeed * 8.0);
  float facetHash = fract(sin(facetCell * 12.9898 + vSeed * 78.233) * 43758.5453);
  float facetShade = 0.6 + 0.4 * facetHash;

  float bristle = mix(1.0, rawBristle, 0.6 * bristleAmp) * mix(1.0, facetShade, 0.55);

  // alpha (COVERAGE — is paint here at all) must NOT be modulated by bristle/facetShade. That
  // was fine on a single wide calibration stroke, where a facet is a small patch of a much
  // bigger painted area — but on a whole limb built from many touching dabs, a low-facet cell
  // dropping alpha toward 0 reads as an actual hole in the paint, and a periodic run of them
  // (facet cells are a fixed world-size, so a short dab can BE one cell) reads as a chain of
  // separate beads with gaps between, exactly the "joint-heavy" look this was meant to avoid.
  // Richness/texture still comes through — bristle still modulates pigment (colorFragmentShader)
  // and height (heightProfile below) — it just can't punch holes in the shape's own coverage.
  float alpha = clamp(widthMask * endCap, 0.0, 1.0);
  if (alpha < 0.02) discard;

  // Height gets its OWN cross-section shape, separate from alpha's coverage mask. alpha's
  // widthMask is a near-flat plateau (opaque paint covers most of a stroke's width
  // uniformly) — using that for height too was the main reason strokes rendered as flat
  // colored ribbons with no visible 3D curvature: there was no broad surface for a normal to
  // curve across, only the fine bristle ripples, which read as thin mechanical stripes with
  // nothing underneath them. A cosine dome gives every stroke a real rounded ridge — the
  // single highest-impact change for making this look like a bead of paint, not a flat
  // decal. Along-length undulation (so the ridge crest isn't perfectly straight) comes from
  // 'lump', below.
  float crown = cos(clamp(across, 0.0, 1.0) * 1.5707963);

  // A perfectly smooth dome only ever produces ONE continuous specular highlight running
  // straight down its centerline, no matter how the light is tuned — every point along that
  // line shares the same normal direction. That single glowing line is exactly what read as
  // a glass/neon tube rather than paint: real impasto has no single normal direction, it has
  // hundreds of small ridge-top facets each catching the light differently, so highlights
  // scatter into glints instead of tracing one smooth curve. Bake the SAME bristle ridge
  // pattern already used for alpha/color into the height itself (not just a color tint) so
  // central-difference normals actually see that ridge structure.
  float ridgeHeight = (rawBristle - 0.5) * bristleAmp;

  // A second, much coarser two-frequency lump (a couple of piled bumps per stroke, not a
  // uniform tube) breaks the dome's cross-section symmetry the way a loaded brush or palette
  // knife actually deposits paint unevenly along a stroke, rather than extruding one constant
  // profile. Amplitude cut from the original +-0.22 (0.56..1.0): tried gating this by width on
  // the theory that a thin limb stroke made a fixed-frequency bump read as its own blob while
  // a wide calibration stroke absorbed the same bump as texture — but the banding turned out
  // just as strong on the WIDE bones (spine, hip) as the thin ones, so width was never the
  // actual variable. The bump frequency (2*pi/5 ~= 1.26 world units) is just close enough to a
  // single dab's own length that, at the original amplitude, every hump independently reads as
  // a bead regardless of what it's sitting on. A gentler amplitude keeps the undulation (still
  // not a perfectly uniform tube) without each cycle punching a dark ring hard enough to read
  // as a joint.
  float lumpPhase = alongChain * 5.0 + vSeed * 17.0;
  float lump = 0.9 + 0.1 * sin(lumpPhase) * sin(lumpPhase * 0.63 + vSeed * 4.0);

  // Same facet chunking as alpha/color, folded into height too — a lightly-loaded facet
  // should sit measurably lower than a heavily-loaded one, not just look thinner in color
  // while remaining exactly as tall. Mix weight also cut (0.5 -> 0.2) for the same reason as
  // 'lump' above.
  float heightProfile = endCap * crown * (lump * mix(1.0, facetShade, 0.2) + ridgeHeight * 0.35);
`;

const colorFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  in vec3 vColor;
  in float vVolume;
  in float vSeed;
  in float vWidth;
  in float vLength;
  in float vChainOffset;
  in float vCapStart;
  in float vCapEnd;

  out vec4 outColor;

  void main() {
    ${strokeShapeGLSL}

    // A single flat color per stroke, varying only in coverage, is what read as "screen
    // color" instead of paint — real pigment varies hair to hair. Reuse the bristle ridge
    // pattern (ridge tops = more pigment loaded = brighter/richer; valleys = thinner) plus
    // an independent fine-grain hash (per-hair jitter, decorrelated from the ridge geometry
    // so it doesn't just look like the same pattern twice) to modulate value and saturation.
    float grainHash = fract(sin(dot(vUv * vec2(311.7, 191.3) + vSeed, vec2(12.9898, 78.233))) * 43758.5453);
    float grain = (grainHash - 0.5) * 0.22;
    float pigmentLoad = mix(0.8, 1.2, bristle) + grain;
    vec3 tintedColor = clamp(vColor * pigmentLoad, 0.0, 1.5);

    // Coverage-weighted additive accumulation: color accumulates under ADDITIVE blending
    // (see docs/work/impasto-shading.md status notes) — the composite pass divides
    // color-sum by coverage-sum to recover an averaged color. Same pattern
    // paint-accumulator will reuse for decay + splat.
    outColor = vec4(tintedColor * alpha, alpha);
  }
`;

const heightFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  in vec3 vColor;
  in float vVolume;
  in float vSeed;
  in float vWidth;
  in float vLength;
  in float vChainOffset;
  in float vCapStart;
  in float vCapEnd;

  out vec4 outColor;

  void main() {
    ${strokeShapeGLSL}

    // Alpha MUST be nonzero, even though nothing ever reads it back (the shading pass only
    // samples .r of this target). Writing alpha=0 here — into an additively-blended
    // half-float render target — silently zeroed the RGB channels too on this environment's
    // WebGL2/ANGLE build. Confirmed by isolating every other variable (one MRT target vs.
    // two separate targets, geometry shared vs. independent between the color/height
    // meshes, vertex shader source shared vs. textually distinct, varyings as separate
    // floats vs. packed into one vector) and finding none of them mattered except this one
    // line. If you're tempted to "clean up" this alpha value, don't.
    outColor = vec4(heightProfile * vVolume, 0.0, 0.0, 1.0);
  }
`;

export interface StrokeMeshHandle {
  colorMesh: THREE.Mesh;
  heightMesh: THREE.Mesh;
  setStrokes(strokes: Stroke[]): void;
}

const QUAD_POSITIONS = new Float32Array([
  -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
]);

interface InstancedAttrs {
  geometry: THREE.InstancedBufferGeometry;
  iCenter: THREE.InstancedBufferAttribute;
  iVelocity: THREE.InstancedBufferAttribute;
  iWidth: THREE.InstancedBufferAttribute;
  iLength: THREE.InstancedBufferAttribute;
  iVolume: THREE.InstancedBufferAttribute;
  iColor: THREE.InstancedBufferAttribute;
  iSeed: THREE.InstancedBufferAttribute;
  iChainOffset: THREE.InstancedBufferAttribute;
  iCapStart: THREE.InstancedBufferAttribute;
  iCapEnd: THREE.InstancedBufferAttribute;
}

function createInstancedGeometry(maxInstances: number): InstancedAttrs {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(QUAD_POSITIONS, 3));
  geometry.instanceCount = 0;

  const iCenter = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
  const iVelocity = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
  const iWidth = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iLength = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iVolume = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
  const iSeed = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iChainOffset = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iCapStart = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iCapEnd = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  for (const [name, attr] of Object.entries({
    iCenter,
    iVelocity,
    iWidth,
    iLength,
    iVolume,
    iColor,
    iSeed,
    iChainOffset,
    iCapStart,
    iCapEnd,
  })) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }

  return { geometry, iCenter, iVelocity, iWidth, iLength, iVolume, iColor, iSeed, iChainOffset, iCapStart, iCapEnd };
}

function writeStrokes(attrs: InstancedAttrs, strokes: Stroke[], maxInstances: number) {
  const n = Math.min(strokes.length, maxInstances);
  for (let i = 0; i < n; i++) {
    const s = strokes[i];
    attrs.iCenter.setXYZ(i, s.position[0], s.position[1], s.position[2]);
    attrs.iVelocity.setXYZ(i, s.velocity[0], s.velocity[1], s.velocity[2]);
    attrs.iCapStart.setX(i, s.capStart ? 1 : 0);
    attrs.iCapEnd.setX(i, s.capEnd ? 1 : 0);
    attrs.iWidth.setX(i, s.width);
    attrs.iLength.setX(i, s.length);
    attrs.iVolume.setX(i, s.volume);
    attrs.iColor.setXYZ(i, s.color[0], s.color[1], s.color[2]);
    attrs.iSeed.setX(i, s.seed);
    attrs.iChainOffset.setX(i, s.chainOffset);
  }
  attrs.geometry.instanceCount = n;
  attrs.iCenter.needsUpdate = true;
  attrs.iVelocity.needsUpdate = true;
  attrs.iWidth.needsUpdate = true;
  attrs.iLength.needsUpdate = true;
  attrs.iVolume.needsUpdate = true;
  attrs.iColor.needsUpdate = true;
  attrs.iSeed.needsUpdate = true;
  attrs.iChainOffset.needsUpdate = true;
  attrs.iCapStart.needsUpdate = true;
  attrs.iCapEnd.needsUpdate = true;
}

function makeStrokeMaterial(fragmentShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: strokeVertexShader,
    fragmentShader,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  });
}

/**
 * Instanced billboard quads, one per stroke, oriented along each stroke's velocity in view
 * space and textured with a procedural bristle-streak alpha. The color mesh and height mesh
 * each own an independent InstancedBufferGeometry, fed identical per-instance data from a
 * single `setStrokes` call — cheap at this instance count, and it means changing one
 * material's shader can never accidentally affect the other's compiled attribute layout.
 * Neither mesh renders directly to screen; both are inputs to height-pass.ts.
 */
export function createStrokeMesh(maxInstances: number): StrokeMeshHandle {
  const colorAttrs = createInstancedGeometry(maxInstances);
  const heightAttrs = createInstancedGeometry(maxInstances);

  const colorMesh = new THREE.Mesh(colorAttrs.geometry, makeStrokeMaterial(colorFragmentShader));
  colorMesh.frustumCulled = false;
  const heightMesh = new THREE.Mesh(heightAttrs.geometry, makeStrokeMaterial(heightFragmentShader));
  heightMesh.frustumCulled = false;

  function setStrokes(strokes: Stroke[]) {
    writeStrokes(colorAttrs, strokes, maxInstances);
    writeStrokes(heightAttrs, strokes, maxInstances);
  }

  return { colorMesh, heightMesh, setStrokes };
}
