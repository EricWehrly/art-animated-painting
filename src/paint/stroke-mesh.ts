import * as THREE from "three";
import type { Stroke } from "../pose/strokes";

// ---------------------------------------------------------------------------------------
// Instanced dabs — every paint mark in the toy (the main figure's limbs, speckles, and the
// swatch calibration page) is one of these: a single independent billboard quad, always
// tapered/capped at both ends. A real oil-painted limb is built from many overlapping,
// irregularly-placed brush gestures, not one continuous traced line — see pose/strokes.ts
// generateChainMarks and docs/work/pose-pipeline.md Round 13.
//
// An earlier version (Round 12) moved the main figure's limbs to a connected ribbon mesh
// instead, to eliminate a seam that showed up between uniformly-spaced, identically-angled
// dabs walked end-to-end along a single line. That seam came from mechanical periodicity in
// how dabs were placed, not from dabs being independent primitives per se — Round 13's
// placement (irregular along/across spacing, jittered heading, motion-driven length) doesn't
// reproduce it, so the dab renderer covers the main figure again and the ribbon renderer
// (real connected triangle-strip geometry, no seam by construction) was removed as unused.
// ---------------------------------------------------------------------------------------

const dabVertexShader = /* glsl */ `
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
  in float iRound;

  out vec2 vUv;
  out vec3 vColor;
  out float vVolume;
  out float vSeed;
  out float vWidth;
  out float vRound;

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
    vRound = iRound;
  }
`;

// Shared by both dab fragment shaders below — computes alpha (coverage), heightProfile (the
// paint's cross-section shape), and bristle (pigment-load variation the color shader uses)
// identically either way, so the color pass and the height pass always agree on where a dab
// actually is. Branches on vRound: the default path is a brush dab (a loaded brush/knife
// dragged across the surface — tapered ends, directional bristle ridging, always capped at
// both ends since a standalone dab is never part of a chain); the round path (see
// pose/strokes.ts's Stroke.round doc comment) is a flung droplet that beaded up on landing —
// smooth radial falloff, a domed profile, no directional ridging. Added in Round 29 after
// speckles (the only round: true caller today) read as "small stroked paint with a narrower
// base" rather than a real droplet using the brush path unconditionally.
const dabShapeGLSL = /* glsl */ `
  float across = abs(vUv.y - 0.5) * 2.0; // 0 at center, 1 at edge
  float along = vUv.x; // 0..1 along the whole dab

  float alpha;
  float heightProfile;
  float bristle;

  if (vRound < 0.5) {
    // A perfectly smooth-sided stroke reads as a mechanical decal — real paint applied with a
    // loaded brush or knife tears unevenly along its edge instead of stopping on a clean line.
    float tearPhase = along * 9.0 + vSeed * 13.0;
    float tear = sin(tearPhase) * 0.5 + sin(tearPhase * 2.3 + vSeed * 5.0) * 0.3;
    float edgeStart = clamp(0.5 + 0.16 * tear, 0.15, 0.7);
    float widthMask = 1.0 - smoothstep(edgeStart, edgeStart + 0.38, across);

    // Tip/tail look dragged/lifted-off rather than a perfectly rounded cap — always applied,
    // since a standalone dab is always a real beginning/end of a brush touch.
    float capTear = 0.5 + 0.5 * sin(vUv.y * 7.0 + vSeed * 9.0);
    float tearCapStart = mix(0.0, 0.05, capTear);
    float tearCapEnd = mix(0.84, 0.94, capTear);
    float startFade = smoothstep(tearCapStart, tearCapStart + 0.1, along);
    float endFade = 1.0 - smoothstep(tearCapEnd, tearCapEnd + 0.08, along);
    float endCap = startFade * endFade;

    float ridgeSpacing = 0.42;
    float cycles = min(vWidth / ridgeSpacing, 40.0);
    float wave1 = vUv.y * cycles * 6.28318 + sin(vUv.x * 6.28318 + vSeed * 3.0) * 0.6 + vSeed * 11.0;
    float wave2 = vUv.y * cycles * 1.7 * 6.28318 + vSeed * 7.0;
    float rawBristle = 0.5 + 0.35 * sin(wave1) + 0.15 * sin(wave2);

    float phaseDeriv = fwidth(wave1);
    float bristleAmp = clamp(1.0 - phaseDeriv / 3.14159, 0.0, 1.0);

    float facetCell = floor(along * 2.6 + vSeed * 8.0);
    float facetHash = fract(sin(facetCell * 12.9898 + vSeed * 78.233) * 43758.5453);
    float facetShade = 0.6 + 0.4 * facetHash;

    bristle = mix(1.0, rawBristle, 0.6 * bristleAmp) * mix(1.0, facetShade, 0.55);

    alpha = clamp(widthMask * endCap, 0.0, 1.0);

    float crown = cos(clamp(across, 0.0, 1.0) * 1.5707963);
    float ridgeHeight = (rawBristle - 0.5) * bristleAmp;
    float lumpPhase = along * 5.0 + vSeed * 17.0;
    float lump = 0.9 + 0.1 * sin(lumpPhase) * sin(lumpPhase * 0.63 + vSeed * 4.0);
    heightProfile = endCap * crown * (lump * mix(1.0, facetShade, 0.2) + ridgeHeight * 0.35);
  } else {
    // A comet/teardrop, not a symmetric circle: a round, domed bead of paint mass at the FRONT
    // (the direction of travel — iVelocity's own tangent, vUv.x=1) with a thin trailing drip
    // stretching out BEHIND it toward vUv.x=0, thinning as it runs. A perfectly round blob (this
    // shape's first version) read as "bubbled" but lost the sense of having been FLUNG — real
    // spatter carries a trailing thread pulled out by momentum, which is what makes it read as
    // drippy/runny rather than a bead stuck in place. See docs/work/pose-pipeline.md Round 30.
    float alongFromFront = 1.0 - vUv.x;
    // A real flung drip doesn't trail in a perfectly straight line — it curves a little as it
    // decelerates. Bends the tail's own centerline sideways, growing with distance from the
    // head; direction and amount vary per-instance (vSeed) so a cluster of drips doesn't all
    // bend the same way. Round 30's first version kept this perfectly straight, which combined
    // with a taper that only narrowed near the very tip is what read as a rigid "hay bale"
    // spike rather than a drip — fixed together with the taper curve below.
    float curveAmount = 0.4 * sin(vSeed * 5.7);
    float acrossC = (vUv.y - 0.5) * 2.0 - curveAmount * alongFromFront * alongFromFront;

    // Fraction of the dab's own length the round head occupies before the trailing drip begins.
    const float BLOB_SPAN = 0.28;
    float taperT = clamp((alongFromFront - BLOB_SPAN) / (1.0 - BLOB_SPAN), 0.0, 1.0);
    // A real drip thins out FAST right after leaving the head, then stays thin for most of its
    // own length — not a constant thickness that only narrows at the last moment. The concave
    // curve (pow < 1) front-loads the thinning; the old linear taper stayed close to full width
    // for too much of the tail's length, reading as a straight rod rather than a drip.
    float taperCurve = pow(taperT, 0.35);
    float dripWobble = 0.13 * sin(alongFromFront * 11.0 + vSeed * 11.0) * taperT;
    float widthAt = mix(1.0, 0.09, taperCurve) + dripWobble;
    float tailAlpha = 1.0 - smoothstep(0.68, 1.0, abs(acrossC) / max(widthAt, 0.04));

    // The round head itself — centered a little inside the blob region, not flush with the
    // very front tip, so it reads as a bead the tail trails off of rather than a sphere sliced
    // flat where the tail begins.
    float headAlongCenter = BLOB_SPAN * 0.5;
    vec2 headVec = vec2((alongFromFront - headAlongCenter) / (BLOB_SPAN * 0.85), acrossC);
    float headDist = length(headVec);
    float headWobble = 0.06 * sin(atan(headVec.y, headVec.x) * 3.0 + vSeed * 8.0);
    float headEdge = clamp(0.82 + headWobble, 0.6, 0.98);
    float headAlpha = 1.0 - smoothstep(headEdge, headEdge + 0.22, headDist);

    alpha = clamp(max(headAlpha, tailAlpha), 0.0, 1.0);
    // Fades the very tip of the trailing drip to a point instead of an abrupt cutoff.
    alpha *= 1.0 - smoothstep(0.95, 1.0, alongFromFront);

    // Mild grain only, no directional ridge waves — a glossy bead's surface varies softly, it
    // doesn't carry a dragged brush's own bristle pattern.
    float grainPhase = (headDist + alongFromFront * 4.0) * 6.0 + vSeed * 13.0;
    bristle = 0.5 + 0.12 * sin(grainPhase) * sin(grainPhase * 0.7 + vSeed * 5.0);

    // The head domes up like a bead of wet paint; the trailing drip stays low and thin — a
    // real drip is a thin smear, not a raised ridge — so it doesn't fight the head for being
    // the visually "thick" part.
    float headHeight = headAlpha * cos(clamp(headDist, 0.0, 1.0) * 1.5707963);
    float tailHeight = tailAlpha * mix(1.0, 0.25, taperCurve) * 0.5;
    heightProfile = alpha * max(headHeight, tailHeight);
  }

  if (alpha < 0.02) discard;
`;

const dabColorFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  in vec3 vColor;
  in float vVolume;
  in float vSeed;
  in float vWidth;
  in float vRound;

  out vec4 outColor;

  void main() {
    ${dabShapeGLSL}

    float grainHash = fract(sin(dot(vUv * vec2(311.7, 191.3) + vSeed, vec2(12.9898, 78.233))) * 43758.5453);
    float grain = (grainHash - 0.5) * 0.22;
    float pigmentLoad = mix(0.8, 1.2, bristle) + grain;
    vec3 tintedColor = clamp(vColor * pigmentLoad, 0.0, 1.5);

    outColor = vec4(tintedColor * alpha, alpha);
  }
`;

const dabHeightFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  in vec3 vColor;
  in float vVolume;
  in float vSeed;
  in float vWidth;
  in float vRound;

  out vec4 outColor;

  void main() {
    ${dabShapeGLSL}

    // Alpha MUST be nonzero — see docs/work/pose-pipeline.md; a zero-alpha write into this
    // additively-blended half-float target silently zeroes the RGB channels too on this
    // environment's WebGL2/ANGLE build.
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
  iRound: THREE.InstancedBufferAttribute;
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
  const iRound = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  for (const [name, attr] of Object.entries({ iCenter, iVelocity, iWidth, iLength, iVolume, iColor, iSeed, iRound })) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }

  return { geometry, iCenter, iVelocity, iWidth, iLength, iVolume, iColor, iSeed, iRound };
}

function writeStrokes(attrs: InstancedAttrs, strokes: Stroke[], maxInstances: number) {
  const n = Math.min(strokes.length, maxInstances);
  for (let i = 0; i < n; i++) {
    const s = strokes[i];
    attrs.iCenter.setXYZ(i, s.position[0], s.position[1], s.position[2]);
    attrs.iVelocity.setXYZ(i, s.velocity[0], s.velocity[1], s.velocity[2]);
    attrs.iWidth.setX(i, s.width);
    attrs.iLength.setX(i, s.length);
    attrs.iVolume.setX(i, s.volume);
    attrs.iColor.setXYZ(i, s.color[0], s.color[1], s.color[2]);
    attrs.iSeed.setX(i, s.seed);
    attrs.iRound.setX(i, s.round ? 1 : 0);
  }
  attrs.geometry.instanceCount = n;
  attrs.iCenter.needsUpdate = true;
  attrs.iVelocity.needsUpdate = true;
  attrs.iWidth.needsUpdate = true;
  attrs.iLength.needsUpdate = true;
  attrs.iVolume.needsUpdate = true;
  attrs.iColor.needsUpdate = true;
  attrs.iSeed.needsUpdate = true;
  attrs.iRound.needsUpdate = true;
}

function makeDabMaterial(fragmentShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: dabVertexShader,
    fragmentShader,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  });
}

/**
 * Instanced billboard quads, one per stroke, oriented along each stroke's velocity in view
 * space and textured with a procedural bristle-streak alpha.
 */
export function createStrokeMesh(maxInstances: number): StrokeMeshHandle {
  const colorAttrs = createInstancedGeometry(maxInstances);
  const heightAttrs = createInstancedGeometry(maxInstances);

  const colorMesh = new THREE.Mesh(colorAttrs.geometry, makeDabMaterial(dabColorFragmentShader));
  colorMesh.frustumCulled = false;
  const heightMesh = new THREE.Mesh(heightAttrs.geometry, makeDabMaterial(dabHeightFragmentShader));
  heightMesh.frustumCulled = false;

  function setStrokes(strokes: Stroke[]) {
    writeStrokes(colorAttrs, strokes, maxInstances);
    writeStrokes(heightAttrs, strokes, maxInstances);
  }

  return { colorMesh, heightMesh, setStrokes };
}
