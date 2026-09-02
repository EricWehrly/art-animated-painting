import * as THREE from "three";

// Standalone variant of shading-pass.ts's fragment shader, built for
// docs/work/watercolor-aging.md's "recommended first prototype": edge darkening + reduced
// relief + desaturation, all shader-only, no new buffers. Deliberately NOT merged into the
// real shading-pass.ts — this only proves the look; wiring it to paint-accumulator's actual
// age/stage signal is a separate, later step (see that doc's "Integration path"). The screen
// is split into four fixed vertical bands (oil -> full watercolor) via vUv.x, rather than
// driven by a single live mix uniform, so a transition across simulated age is visible in one
// screenshot instead of requiring four separate captures.
const quadVertexShader = /* glsl */ `
  precision highp float;
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const quadFragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uColorSum;
  uniform sampler2D uHeightSum;
  uniform vec2 uTexelSize;
  uniform float uReliefStrength;
  uniform float uAOStrength;
  uniform vec3 uGroundColor;
  // The three technique weights from watercolor-aging.md's survey, each 0..1 — how strongly
  // that one technique applies at wcMix = 1.0 (full watercolor). Tunable live so the look can
  // be judged against a reference instead of guessed on paper.
  uniform float uEdgeDarken;
  uniform float uReliefReduction;
  uniform float uDesaturation;

  in vec2 vUv;
  out vec4 outColor;

  float heightAt(vec2 uv) {
    float h = texture(uHeightSum, uv).r;
    float cov = texture(uColorSum, uv).a;
    return h / max(cov, 1.0);
  }

  float coverageAt(vec2 uv) {
    return texture(uColorSum, uv).a;
  }

  vec3 linearToSRGB(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  }

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    // Four fixed simulated-age bands across the canvas width: 0 (pure oil, leftmost) to 1.0
    // (full watercolor, rightmost). A real per-pixel age channel (paint-accumulator) will
    // eventually replace this — see docs/work/watercolor-aging.md's "Integration path".
    const float BAND_COUNT = 4.0;
    float bandWidth = 1.0 / BAND_COUNT;
    float bandIndex = clamp(floor(vUv.x / bandWidth), 0.0, BAND_COUNT - 1.0);
    float wcMix = bandIndex / (BAND_COUNT - 1.0);
    float bandLocalX = fract(vUv.x / bandWidth);
    bool nearBandEdge = bandIndex > 0.0 && bandLocalX < 0.0015;

    vec4 colorSum = texture(uColorSum, vUv);
    float coverage = clamp(colorSum.a, 0.0, 1.0);
    vec3 paintColor = colorSum.a > 0.0001 ? colorSum.rgb / colorSum.a : vec3(0.0);

    // Desaturation / color shift toward a muted, cooler, more transparent palette.
    float lum = dot(paintColor, vec3(0.299, 0.587, 0.114));
    vec3 muted = mix(paintColor, vec3(lum), uDesaturation * wcMix * 0.85);
    vec3 coolTint = vec3(0.82, 0.9, 1.0);
    muted *= mix(vec3(1.0), coolTint, uDesaturation * wcMix * 0.4);
    paintColor = muted;
    // Thin, translucent paint lets ground show through more as it ages toward watercolor —
    // part of the same "muted, cooler, more transparent" description this technique covers.
    float wcCoverage = coverage * (1.0 - uDesaturation * wcMix * 0.35);

    // Reduced relief: watercolor is flat/thin, not built-up impasto. Scales down both the
    // normal-map strength (lighting reads flatter) and the thickness/impasto brightening bump
    // below (paint stops looking "loaded").
    float reliefScale = 1.0 - uReliefReduction * wcMix;
    float effectiveRelief = uReliefStrength * reliefScale;

    float h = heightAt(vUv);
    float hL = heightAt(vUv - vec2(uTexelSize.x, 0.0));
    float hR = heightAt(vUv + vec2(uTexelSize.x, 0.0));
    float hD = heightAt(vUv - vec2(0.0, uTexelSize.y));
    float hU = heightAt(vUv + vec2(0.0, uTexelSize.y));
    float hL2 = heightAt(vUv - vec2(uTexelSize.x * 3.0, 0.0));
    float hR2 = heightAt(vUv + vec2(uTexelSize.x * 3.0, 0.0));
    float hD2 = heightAt(vUv - vec2(0.0, uTexelSize.y * 3.0));
    float hU2 = heightAt(vUv + vec2(0.0, uTexelSize.y * 3.0));

    vec3 normal = normalize(vec3((hL - hR) * effectiveRelief, (hD - hU) * effectiveRelief, 1.0));

    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.7));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir + viewDir);

    float diffRaw = max(dot(normal, lightDir), 0.0);
    float diffBanded = floor(diffRaw * 4.0 + 0.5) / 4.0;
    float diff = mix(diffRaw, diffBanded, 0.45);
    float spec = pow(max(dot(normal, halfDir), 0.0), 18.0);
    vec3 specTint = mix(vec3(1.0), paintColor, 0.6);

    float variance = abs(hL - h) + abs(hR - h) + abs(hU - h) + abs(hD - h);
    float wideVariance = abs(hL2 - h) + abs(hR2 - h) + abs(hU2 - h) + abs(hD2 - h);
    float ao = 1.0 - clamp((variance * 1.4 + wideVariance * 0.5) * uAOStrength, 0.0, 0.82);

    // Thickness/impasto brightening also fades with reliefScale — thinned-out watercolor
    // shouldn't still glow with built-up-paint brightness even once the lighting normal is
    // flattened.
    float thickness = smoothstep(0.05, 0.85, h);
    float impasto = smoothstep(0.9, 2.2, h);
    vec3 thickPaint = paintColor * mix(0.8, 1.25, mix(0.0, thickness, reliefScale)) + vec3(0.08) * impasto * reliefScale;

    vec3 lit = thickPaint * (0.3 + 0.75 * diff) * ao + specTint * spec * 0.55 * reliefScale;

    // Edge darkening (pseudo-backrun): approximate pigment concentrating at a wet edge by
    // reacting to the coverage gradient that's already computed for AO, rather than actually
    // simulating diffusion. Strongest where coverage is transitioning fastest (a stroke's own
    // edge, or where two strokes overlap and coverage briefly exceeds 1) since real backruns
    // form at wet boundaries, not in the middle of a flat wash.
    float cov = coverageAt(vUv);
    float covL = coverageAt(vUv - vec2(uTexelSize.x, 0.0));
    float covR = coverageAt(vUv + vec2(uTexelSize.x, 0.0));
    float covD = coverageAt(vUv - vec2(0.0, uTexelSize.y));
    float covU = coverageAt(vUv + vec2(0.0, uTexelSize.y));
    float edgeGrad = abs(covL - cov) + abs(covR - cov) + abs(covU - cov) + abs(covD - cov);
    float edgeConcentration = clamp(edgeGrad * 5.0, 0.0, 1.0) * uEdgeDarken * wcMix;
    vec3 concentrated = lit * (1.0 + edgeConcentration * 0.7);
    lit = mix(concentrated, concentrated * 0.55, edgeConcentration);

    vec2 px = gl_FragCoord.xy;
    float weave = 0.5 + 0.5 * sin(px.x * 0.9) * sin(px.y * 0.9);
    float grain = hash21(floor(px * 0.5)) * 0.5 + 0.5;
    vec3 ground = uGroundColor * mix(0.72, 1.28, weave) * mix(0.85, 1.15, grain);

    vec3 result = mix(ground, lit, wcCoverage);
    if (nearBandEdge) result *= 0.4;
    outColor = vec4(linearToSRGB(result), 1.0);
  }
`;

export interface WatercolorShadingPassHandle {
  render(renderer: THREE.WebGLRenderer, colorSum: THREE.Texture, heightSum: THREE.Texture): void;
  setResolution(width: number, height: number): void;
  setReliefStrength(v: number): void;
  setEdgeDarken(v: number): void;
  setReliefReduction(v: number): void;
  setDesaturation(v: number): void;
}

export function createWatercolorShadingPass(): WatercolorShadingPassHandle {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVertexShader,
    fragmentShader: quadFragmentShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uColorSum: { value: null },
      uHeightSum: { value: null },
      uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      uReliefStrength: { value: 22 },
      uAOStrength: { value: 1.6 },
      uGroundColor: { value: new THREE.Color(0x4a4032) },
      uEdgeDarken: { value: 0.6 },
      uReliefReduction: { value: 0.7 },
      uDesaturation: { value: 0.6 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.Camera();

  return {
    render(renderer, colorSum, heightSum) {
      material.uniforms.uColorSum.value = colorSum;
      material.uniforms.uHeightSum.value = heightSum;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    setResolution(width, height) {
      material.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    },
    setReliefStrength(v) {
      material.uniforms.uReliefStrength.value = v;
    },
    setEdgeDarken(v) {
      material.uniforms.uEdgeDarken.value = v;
    },
    setReliefReduction(v) {
      material.uniforms.uReliefReduction.value = v;
    },
    setDesaturation(v) {
      material.uniforms.uDesaturation.value = v;
    },
  };
}
