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

const strokeFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  in vec3 vColor;
  in float vVolume;
  in float vSeed;
  in float vWidth;

  layout(location = 0) out vec4 gColorSum;
  layout(location = 1) out vec4 gHeightSum;

  void main() {
    float across = abs(vUv.y - 0.5) * 2.0; // 0 at center, 1 at edge
    float widthMask = 1.0 - smoothstep(0.55, 1.0, across);

    float along = vUv.x; // 0..1 along stroke length
    float endCap = smoothstep(0.0, 0.12, along) * (1.0 - smoothstep(0.88, 1.0, along));

    // Bristle ridges at a fixed WORLD-space spacing (not a fixed count across the UV
    // range) — a fixed cycle count aliased badly on narrow strokes, which is what read as
    // "pixelly": dozens of ridge cycles were being crammed into a couple of screen pixels.
    // A little along-length wave breaks the ridges from perfectly straight into the slightly
    // wavering streaks real bristles leave.
    float ridgeSpacing = 0.18;
    float cycles = min(vWidth / ridgeSpacing, 40.0);
    float phase = vUv.y * cycles * 6.28318 + sin(vUv.x * 6.28318 + vSeed * 3.0) * 0.6 + vSeed * 11.0;

    // Fade the ridge pattern out once its on-screen frequency exceeds what this pixel can
    // resolve (screen-space derivative of the phase), instead of letting it alias into noise.
    float phaseDeriv = fwidth(phase);
    float bristleAmp = clamp(1.0 - phaseDeriv / 3.14159, 0.0, 1.0);
    float bristle = mix(1.0, 0.5 + 0.5 * sin(phase), 0.6 * bristleAmp);

    float alpha = clamp(widthMask * endCap * bristle, 0.0, 1.0);
    if (alpha < 0.02) discard;

    // Coverage-weighted additive accumulation: color and height both accumulate under a
    // single ADDITIVE blend state (see docs/work/impasto-shading.md status notes) — the
    // composite pass divides color-sum by coverage-sum to recover an averaged color. This
    // is the same pattern paint-accumulator will reuse for decay + splat.
    gColorSum = vec4(vColor * alpha, alpha);
    gHeightSum = vec4(alpha * vVolume, 0.0, 0.0, 0.0);
  }
`;

export interface StrokeMeshHandle {
  mesh: THREE.Mesh;
  setStrokes(strokes: Stroke[]): void;
}

/**
 * Instanced billboard quads, one per stroke, oriented along each stroke's velocity in view
 * space and textured with a procedural bristle-streak alpha. Renders into the MRT height
 * pass (see height-pass.ts) — never directly to screen.
 */
export function createStrokeMesh(maxInstances: number): StrokeMeshHandle {
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  quad.instanceCount = 0;

  const iCenter = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
  const iVelocity = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
  const iWidth = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iLength = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iVolume = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
  const iSeed = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1);
  for (const [name, attr] of Object.entries({ iCenter, iVelocity, iWidth, iLength, iVolume, iColor, iSeed })) {
    attr.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute(name, attr);
  }

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: strokeVertexShader,
    fragmentShader: strokeFragmentShader,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  });

  const mesh = new THREE.Mesh(quad, material);
  mesh.frustumCulled = false;

  function setStrokes(strokes: Stroke[]) {
    const n = Math.min(strokes.length, maxInstances);
    for (let i = 0; i < n; i++) {
      const s = strokes[i];
      iCenter.setXYZ(i, s.position[0], s.position[1], s.position[2]);
      iVelocity.setXYZ(i, s.velocity[0], s.velocity[1], s.velocity[2]);
      iWidth.setX(i, s.width);
      iLength.setX(i, s.length);
      iVolume.setX(i, s.volume);
      iColor.setXYZ(i, s.color[0], s.color[1], s.color[2]);
      iSeed.setX(i, s.seed);
    }
    quad.instanceCount = n;
    iCenter.needsUpdate = true;
    iVelocity.needsUpdate = true;
    iWidth.needsUpdate = true;
    iLength.needsUpdate = true;
    iVolume.needsUpdate = true;
    iColor.needsUpdate = true;
    iSeed.needsUpdate = true;
  }

  return { mesh, setStrokes };
}
