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
  // Pigment settling unevenly (paper tooth, per the survey's "Granulation" bullet) rather
  // than oil's smooth thickness-driven brightening — a cheap stand-in using the same grain
  // hash the ground texture below already computes, multiplied into the paint itself instead
  // of just the canvas. Not one of the original three named techniques, added after the first
  // round showed oil's thickness-driven color read as too uniform once relief was flattened.
  uniform float uGranulation;

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

    // Round 2 tried to kill the vertical ridge "layering" by widening the height-sample tap
    // COUNT (texelMul * uTexelSize) — looked right in a small preview, but uTexelSize is
    // 1/canvas-resolution, so that offset silently SHRINKS in world/NDC space as the canvas
    // gets bigger. At a real-size window the same tap count covers far less actual distance,
    // and the ridges (a roughly fixed world-space wavelength, from stroke-mesh.ts's per-dab
    // bristle spacing) come right back. blurRadius fixes that by being an NDC-space FRACTION,
    // not a texel count — the same visual softening regardless of canvas resolution. Shared by
    // both the height taps below and the color/coverage blur that follows, since both are the
    // same underlying idea: how far has this paint's own structure spread/softened.
    float blurRadius = mix(0.0, 0.02, uReliefReduction * wcMix);

    // Soft, feathered edges + reduced internal color banding: real watercolor blooms into an
    // organic edge rather than keeping the stroke-mesh's own hard silhouette, and its color
    // pools smoothly rather than tracking each dab's own baked variation. Averaging a ring of
    // neighbors and blending toward that average — on color AND coverage together, so the
    // softened silhouette and softened internal color move as one — is the "masked screen-
    // space blur" the survey listed as cheap and didn't use in Round 1.
    if (blurRadius > 0.0005) {
      vec3 blurColorSum = vec3(0.0);
      float blurCovSum = 0.0;
      const int TAPS = 8;
      for (int i = 0; i < TAPS; i++) {
        float angle = (float(i) / float(TAPS)) * 6.28318530718;
        vec2 offset = vec2(cos(angle), sin(angle)) * blurRadius;
        vec4 s = texture(uColorSum, vUv + offset);
        blurCovSum += s.a;
        blurColorSum += s.rgb;
      }
      float avgCov = blurCovSum / float(TAPS);
      vec3 avgColor = blurCovSum > 0.0001 ? blurColorSum / blurCovSum : vec3(0.0);
      float blend = uReliefReduction * wcMix;
      paintColor = mix(paintColor, avgColor, blend * 0.7);
      coverage = mix(coverage, avgCov, blend * 0.65);
    }

    // Desaturation / color shift toward a muted, cooler, more transparent palette.
    float lum = dot(paintColor, vec3(0.299, 0.587, 0.114));
    vec3 muted = mix(paintColor, vec3(lum), uDesaturation * wcMix * 0.85);
    vec3 coolTint = vec3(0.82, 0.9, 1.0);
    muted *= mix(vec3(1.0), coolTint, uDesaturation * wcMix * 0.4);
    paintColor = muted;
    // Thin, translucent paint lets ground show through more as it ages toward watercolor —
    // part of the same "muted, cooler, more transparent" description this technique covers.
    float wcCoverage = coverage * (1.0 - uDesaturation * wcMix * 0.35);

    // Reduced relief: watercolor is flat/thin, not built-up impasto. Scales down the
    // normal-map strength (lighting reads flatter) and the thickness/impasto brightening bump
    // below (paint stops looking "loaded") — but a lower-AMPLITUDE bump sampled at the same
    // fine spacing is still the same fine-frequency ridge pattern, so it can keep reading as
    // brush-bristle "layering" even once dimmed. Oil strokes get that vertical ridging from
    // stroke-mesh.ts's own per-dab bristle bumps; real watercolor washes don't have that
    // structure at all. The tap offset below blends the original 1-texel spacing (so wcMix=0
    // stays pixel-for-pixel identical to plain oil, at any resolution) with blurRadius — an
    // NDC-space fraction, not a texel count, so this blur stays the same visual size on a
    // large canvas as it is here, unlike the texel-count version Round 2 shipped.
    float reliefScale = 1.0 - uReliefReduction * wcMix;
    float effectiveRelief = uReliefStrength * reliefScale;
    vec2 tap = uTexelSize + vec2(blurRadius);
    vec2 tap2 = uTexelSize * 3.0 + vec2(blurRadius * 2.5);

    float h = heightAt(vUv);
    float hL = heightAt(vUv - vec2(tap.x, 0.0));
    float hR = heightAt(vUv + vec2(tap.x, 0.0));
    float hD = heightAt(vUv - vec2(0.0, tap.y));
    float hU = heightAt(vUv + vec2(0.0, tap.y));
    float hL2 = heightAt(vUv - vec2(tap2.x, 0.0));
    float hR2 = heightAt(vUv + vec2(tap2.x, 0.0));
    float hD2 = heightAt(vUv - vec2(0.0, tap2.y));
    float hU2 = heightAt(vUv + vec2(0.0, tap2.y));

    vec3 normal = normalize(vec3((hL - hR) * effectiveRelief, (hD - hU) * effectiveRelief, 1.0));

    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.7));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir + viewDir);

    float diffRaw = max(dot(normal, lightDir), 0.0);
    float diffBanded = floor(diffRaw * 4.0 + 0.5) / 4.0;
    float diff = mix(diffRaw, diffBanded, 0.45);
    float spec = pow(max(dot(normal, halfDir), 0.0), 18.0);
    vec3 specTint = mix(vec3(1.0), paintColor, 0.6);

    // The wide-kernel AO below was, in Round 1, computed straight from the raw height field —
    // reliefScale never reached it, so ridge-to-ridge valley shadowing kept reading as the
    // exact same brush-bristle "layering" at every band, independent of the relief slider.
    // Widening the taps above (blurRadius) already blurs the ridge FREQUENCY feeding into this;
    // scaling the shadow's own STRENGTH down by reliefScale on top of that removes what's left
    // — the combination is what actually kills the striping, not either alone.
    float variance = abs(hL - h) + abs(hR - h) + abs(hU - h) + abs(hD - h);
    float wideVariance = abs(hL2 - h) + abs(hR2 - h) + abs(hU2 - h) + abs(hD2 - h);
    float ao = 1.0 - clamp((variance * 1.4 + wideVariance * 0.5) * uAOStrength * reliefScale, 0.0, 0.82);

    // Thickness/impasto brightening also fades with reliefScale — thinned-out watercolor
    // shouldn't still glow with built-up-paint brightness once the lighting normal is
    // flattened. But fading STRAIGHT toward oil's own thin-paint floor (0.8x) was a bug, not a
    // feature: it made full-mix paint read as dark and muddy rather than pale and diluted —
    // the opposite of what thinned pigment should look like. Fade toward a neutral 1.0x
    // instead, so watercolor's paleness comes from wcCoverage (below, letting the ground
    // through) and desaturation, not from an accidental darkening left over from oil's own
    // thickness ramp.
    float thickness = smoothstep(0.05, 0.85, h);
    float impasto = smoothstep(0.9, 2.2, h);
    float thicknessMul = mix(1.0, mix(0.8, 1.25, thickness), reliefScale);
    vec3 thickPaint = paintColor * thicknessMul + vec3(0.08) * impasto * reliefScale;

    // Granulation: pigment settling unevenly rather than oil's smooth thickness-driven
    // brightness ramp — a cheap texture multiply using the same grain hash the ground below
    // already computes (see watercolor-aging.md's survey: "safer short-term" than inventing a
    // second noise source ahead of watercolor-ground's real paper tooth). Coarser-scaled than
    // the ground's own grain so it reads as blotchy pigment density, not screen noise. Keyed
    // off vUv (screen-fraction) rather than gl_FragCoord (raw pixel coords) — the same
    // resolution-independence fix as blurRadius above; a pixel-frequency noise would give
    // finer, less visible blotches on a larger canvas than what gets tuned here.
    float granulationNoise = hash21(floor(vUv * 90.0));
    float granulation = mix(1.0, mix(0.72, 1.18, granulationNoise), uGranulation * wcMix);
    thickPaint *= granulation;

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
  setGranulation(v: number): void;
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
      // Raised from Round 1's 0.7 — the user's follow-up asked to push oil's built-up texture
      // down further as paint ages; see the AO/blurRadius changes above this now actually reaches.
      uReliefReduction: { value: 0.85 },
      uDesaturation: { value: 0.6 },
      uGranulation: { value: 0.35 },
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
    setGranulation(v) {
      material.uniforms.uGranulation.value = v;
    },
  };
}
