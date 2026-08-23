import * as THREE from "three";
import type { Stroke, Ribbon } from "../pose/strokes";

// ---------------------------------------------------------------------------------------
// Instanced dabs — standalone paint marks (speckles, the swatch calibration page). Each is
// a single independent billboard quad, always tapered/capped at both ends. The main figure's
// limbs do NOT use this path — see the ribbon renderer below and docs/work/pose-pipeline.md
// Round 12 for why: placing many of these end-to-end to build a limb left a visible seam at
// every dab boundary no matter how the shared shape parameters were tuned, because the seam
// was between two independently-rendered primitives, not a texture/tuning problem.
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

  out vec2 vUv;
  out vec3 vColor;
  out float vVolume;
  out float vSeed;
  out float vWidth;

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
  }
`;

// Shared by both dab fragment shaders below — computes alpha (coverage) and heightProfile
// (the paint's cross-section shape) identically either way, so the color pass and the height
// pass always agree on where a dab actually is. A standalone dab is ALWAYS capped at both
// ends (it's never part of a chain), so — unlike the ribbon shape logic below — the tip taper
// here is unconditional.
const dabShapeGLSL = /* glsl */ `
  float across = abs(vUv.y - 0.5) * 2.0; // 0 at center, 1 at edge
  float along = vUv.x; // 0..1 along the whole dab

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

  float bristle = mix(1.0, rawBristle, 0.6 * bristleAmp) * mix(1.0, facetShade, 0.55);

  float alpha = clamp(widthMask * endCap, 0.0, 1.0);
  if (alpha < 0.02) discard;

  float crown = cos(clamp(across, 0.0, 1.0) * 1.5707963);
  float ridgeHeight = (rawBristle - 0.5) * bristleAmp;
  float lumpPhase = along * 5.0 + vSeed * 17.0;
  float lump = 0.9 + 0.1 * sin(lumpPhase) * sin(lumpPhase * 0.63 + vSeed * 4.0);
  float heightProfile = endCap * crown * (lump * mix(1.0, facetShade, 0.2) + ridgeHeight * 0.35);
`;

const dabColorFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  in vec3 vColor;
  in float vVolume;
  in float vSeed;
  in float vWidth;

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
  for (const [name, attr] of Object.entries({ iCenter, iVelocity, iWidth, iLength, iVolume, iColor, iSeed })) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }

  return { geometry, iCenter, iVelocity, iWidth, iLength, iVolume, iColor, iSeed };
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
  }
  attrs.geometry.instanceCount = n;
  attrs.iCenter.needsUpdate = true;
  attrs.iVelocity.needsUpdate = true;
  attrs.iWidth.needsUpdate = true;
  attrs.iLength.needsUpdate = true;
  attrs.iVolume.needsUpdate = true;
  attrs.iColor.needsUpdate = true;
  attrs.iSeed.needsUpdate = true;
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
 * space and textured with a procedural bristle-streak alpha. Used for speckles and the swatch
 * calibration page only — see the module doc comment above.
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

// ---------------------------------------------------------------------------------------
// Ribbons — the main figure's limbs. One real connected triangle-strip mesh per chain (not
// instanced quads), built fresh on the CPU each frame from generateChainRibbons' path
// points. Adjacent points share actual geometry, so there is no boundary between separate
// primitives for a seam to ever appear at — see docs/work/pose-pipeline.md Round 12.
//
// Billboarding without a per-vertex shader trick: the camera's viewing ANGLE never changes
// (see shell/canvas.ts — only distance/pan do, as a viewfinder control), so the view
// direction is a build-time constant. Each point's sideways (width) axis is computed once on
// the CPU as tangent × viewForward, giving real 3D vertex positions that face the camera
// correctly without needing per-instance view-space math in the vertex shader.
// ---------------------------------------------------------------------------------------

const ribbonVertexShader = /* glsl */ `
  precision highp float;

  // "position" is auto-declared by THREE.ShaderMaterial from the geometry's own position
  // attribute — real baked vertex positions here, not a billboard quad corner.
  in float side;
  in float arcLength;
  in float ribbonWidth;
  in float volume;
  in vec3 vertColor;
  in float seed;

  out float vSide;
  out float vArcLength;
  out float vWidth;
  out float vVolume;
  out vec3 vColor;
  out float vSeed;

  void main() {
    vSide = side;
    vArcLength = arcLength;
    vWidth = ribbonWidth;
    vVolume = volume;
    vColor = vertColor;
    vSeed = seed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Adapted from dabShapeGLSL above, same visual language (tear/bristle/facet/lump/crown), but
// with two structural differences that fall directly out of being a real connected mesh
// instead of independent quads: 'across' comes from a per-vertex side coordinate (-1/+1 at
// the true edges, interpolated by the rasterizer — geometrically exact, not a UV
// approximation) instead of vUv.y, and 'alongChain' is the vertex's own real arc-length
// (continuous by construction across the whole chain) instead of a reconstructed
// vChainOffset + vUv.x*vLength. No cap-taper logic: an interior point never needs one (there
// is no dab boundary to fade), and the true ends of a chain taper because
// generateChainRibbons shrinks their WIDTH directly — a geometric taper, not a shader fade.
const ribbonShapeGLSL = /* glsl */ `
  float across = abs(vSide);
  float alongChain = vArcLength;
  float uvAcross = vSide * 0.5 + 0.5; // 0..1, same role vUv.y played for ridge striping

  float tearPhase = alongChain * 9.0 + vSeed * 13.0;
  float tear = sin(tearPhase) * 0.5 + sin(tearPhase * 2.3 + vSeed * 5.0) * 0.3;
  float edgeStart = clamp(0.5 + 0.16 * tear, 0.15, 0.7);
  float widthMask = 1.0 - smoothstep(edgeStart, edgeStart + 0.38, across);

  float ridgeSpacing = 0.42;
  float cycles = min(vWidth / ridgeSpacing, 40.0);
  float wave1 = uvAcross * cycles * 6.28318 + vSeed * 11.0;
  float wave2 = uvAcross * cycles * 1.7 * 6.28318 + vSeed * 7.0;
  float rawBristle = 0.5 + 0.35 * sin(wave1) + 0.15 * sin(wave2);

  float phaseDeriv = fwidth(wave1);
  float bristleAmp = clamp(1.0 - phaseDeriv / 3.14159, 0.0, 1.0);

  float facetCell = floor(alongChain * 2.6 + vSeed * 8.0);
  float facetHash = fract(sin(facetCell * 12.9898 + vSeed * 78.233) * 43758.5453);
  float facetShade = 0.6 + 0.4 * facetHash;

  float bristle = mix(1.0, rawBristle, 0.6 * bristleAmp) * mix(1.0, facetShade, 0.55);

  // alpha must not be modulated by bristle/facetShade — see docs/work/pose-pipeline.md Round
  // 9: a low-facet cell dropping alpha toward 0 reads as an actual hole in the paint.
  float alpha = clamp(widthMask, 0.0, 1.0);
  if (alpha < 0.02) discard;

  float crown = cos(clamp(across, 0.0, 1.0) * 1.5707963);
  float ridgeHeight = (rawBristle - 0.5) * bristleAmp;
  float lumpPhase = alongChain * 5.0 + vSeed * 17.0;
  float lump = 0.9 + 0.1 * sin(lumpPhase) * sin(lumpPhase * 0.63 + vSeed * 4.0);
  float heightProfile = crown * (lump * mix(1.0, facetShade, 0.2) + ridgeHeight * 0.35);
`;

const ribbonColorFragmentShader = /* glsl */ `
  precision highp float;

  in float vSide;
  in float vArcLength;
  in float vWidth;
  in float vVolume;
  in vec3 vColor;
  in float vSeed;

  out vec4 outColor;

  void main() {
    ${ribbonShapeGLSL}

    float grainHash = fract(sin(dot(vec2(alongChain, vSide) * vec2(311.7, 191.3) + vSeed, vec2(12.9898, 78.233))) * 43758.5453);
    float grain = (grainHash - 0.5) * 0.22;
    float pigmentLoad = mix(0.8, 1.2, bristle) + grain;
    vec3 tintedColor = clamp(vColor * pigmentLoad, 0.0, 1.5);

    outColor = vec4(tintedColor * alpha, alpha);
  }
`;

const ribbonHeightFragmentShader = /* glsl */ `
  precision highp float;

  in float vSide;
  in float vArcLength;
  in float vWidth;
  in float vVolume;
  in vec3 vColor;
  in float vSeed;

  out vec4 outColor;

  void main() {
    ${ribbonShapeGLSL}

    outColor = vec4(heightProfile * vVolume, 0.0, 0.0, 1.0);
  }
`;

function makeRibbonMaterial(fragmentShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: ribbonVertexShader,
    fragmentShader,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    // The width axis (tangent x viewForward) can flip winding depending on which way a
    // segment happens to be traveling — cull nothing rather than track winding per segment.
    // Safe with depthTest off: there's nothing for a stray backface to incorrectly occlude.
    side: THREE.DoubleSide,
  });
}

const tmpTangent = new THREE.Vector3();
const tmpPerp = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

function buildRibbonGeometry(ribbons: Ribbon[], viewForward: THREE.Vector3): THREE.BufferGeometry {
  const positions: number[] = [];
  const sides: number[] = [];
  const arcLengths: number[] = [];
  const widths: number[] = [];
  const volumes: number[] = [];
  const colors: number[] = [];
  const seeds: number[] = [];
  const indices: number[] = [];

  for (const ribbon of ribbons) {
    const pts = ribbon.points;
    if (pts.length < 2) continue;
    const baseVertex = positions.length / 3;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // Tangent at this point — the direction of travel, averaged from the incoming and
      // outgoing segments at an interior point so the ribbon doesn't kink sharply in
      // cross-section at a joint. A true miter join would need more geometry than a bend
      // this modest actually requires.
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      tmpA.set(prev.position[0], prev.position[1], prev.position[2]);
      tmpB.set(next.position[0], next.position[1], next.position[2]);
      tmpTangent.subVectors(tmpB, tmpA);
      if (tmpTangent.lengthSq() < 1e-10) tmpTangent.set(1, 0, 0);
      tmpTangent.normalize();

      tmpPerp.crossVectors(tmpTangent, viewForward);
      if (tmpPerp.lengthSq() < 1e-10) tmpPerp.set(0, 1, 0);
      tmpPerp.normalize();

      const half = p.width / 2;
      const [cx, cy, cz] = p.position;

      positions.push(cx + tmpPerp.x * half, cy + tmpPerp.y * half, cz + tmpPerp.z * half);
      sides.push(1);
      positions.push(cx - tmpPerp.x * half, cy - tmpPerp.y * half, cz - tmpPerp.z * half);
      sides.push(-1);

      for (let k = 0; k < 2; k++) {
        arcLengths.push(p.arcLength);
        widths.push(p.width);
        volumes.push(p.volume);
        colors.push(ribbon.color[0], ribbon.color[1], ribbon.color[2]);
        seeds.push(ribbon.seed);
      }
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const l0 = baseVertex + i * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      indices.push(l0, r0, l1, r0, r1, l1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("side", new THREE.Float32BufferAttribute(sides, 1));
  geometry.setAttribute("arcLength", new THREE.Float32BufferAttribute(arcLengths, 1));
  geometry.setAttribute("ribbonWidth", new THREE.Float32BufferAttribute(widths, 1));
  geometry.setAttribute("volume", new THREE.Float32BufferAttribute(volumes, 1));
  geometry.setAttribute("vertColor", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("seed", new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setIndex(indices);
  return geometry;
}

export interface RibbonMeshHandle {
  colorMesh: THREE.Mesh;
  heightMesh: THREE.Mesh;
  setRibbons(ribbons: Ribbon[]): void;
}

/** `viewForward` is the camera's fixed look direction (target - position, normalized) — see
 * the module doc comment above for why this can be a build-time constant. */
export function createRibbonMesh(viewForward: THREE.Vector3): RibbonMeshHandle {
  const colorMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeRibbonMaterial(ribbonColorFragmentShader));
  colorMesh.frustumCulled = false;
  const heightMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeRibbonMaterial(ribbonHeightFragmentShader));
  heightMesh.frustumCulled = false;

  function setRibbons(ribbons: Ribbon[]) {
    const newGeometry = buildRibbonGeometry(ribbons, viewForward);
    const oldGeometry = colorMesh.geometry;
    colorMesh.geometry = newGeometry;
    heightMesh.geometry = newGeometry;
    oldGeometry.dispose();
  }

  return { colorMesh, heightMesh, setRibbons };
}
