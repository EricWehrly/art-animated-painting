import * as THREE from "three";

const quadVertexShader = /* glsl */ `
  precision highp float;
  // "position" and "uv" are declared automatically by THREE.ShaderMaterial for named
  // geometry attributes — redeclaring them here collides with that injected prefix.
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Impasto shading: height field -> normals via central differences -> key light with a
// paint-tinted specular -> wide-kernel AO -> height-driven thickness shading -> composite
// over a textured canvas ground. See docs/work/impasto-shading.md.
// Watercolor ground (P5) will eventually replace the procedural grain here with a real
// paper simulation; this is a cheap stand-in that at least reads as a surface, not a fill.
const quadFragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uColorSum;
  uniform sampler2D uHeightSum;
  uniform vec2 uTexelSize;
  uniform float uReliefStrength;
  uniform float uAOStrength;
  uniform vec3 uGroundColor;

  in vec2 vUv;
  out vec4 outColor;

  float heightAt(vec2 uv) {
    return texture(uHeightSum, uv).r;
  }

  // THREE.Color(hex) stores linear-space values (ColorManagement is on by default), and all
  // lighting math above is done in that linear space — correct for lighting, but this custom
  // ShaderMaterial has no automatic output-colorspace pass, so gamma-encode by hand here at
  // the very end, once, before this hits the (sRGB) default framebuffer.
  vec3 linearToSRGB(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  }

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec4 colorSum = texture(uColorSum, vUv);
    float coverage = clamp(colorSum.a, 0.0, 1.0);
    vec3 paintColor = colorSum.a > 0.0001 ? colorSum.rgb / colorSum.a : vec3(0.0);

    float h = heightAt(vUv);
    float hL = heightAt(vUv - vec2(uTexelSize.x, 0.0));
    float hR = heightAt(vUv + vec2(uTexelSize.x, 0.0));
    float hD = heightAt(vUv - vec2(0.0, uTexelSize.y));
    float hU = heightAt(vUv + vec2(0.0, uTexelSize.y));
    // A second, wider tap catches ridge-to-ridge shadowing that single-texel differences
    // miss — narrow gaps between adjacent bristle ridges need a few pixels of baseline to
    // read as a shadowed valley rather than just a slightly-darker pixel.
    float hL2 = heightAt(vUv - vec2(uTexelSize.x * 3.0, 0.0));
    float hR2 = heightAt(vUv + vec2(uTexelSize.x * 3.0, 0.0));
    float hD2 = heightAt(vUv - vec2(0.0, uTexelSize.y * 3.0));
    float hU2 = heightAt(vUv + vec2(0.0, uTexelSize.y * 3.0));

    vec3 normal = normalize(vec3((hL - hR) * uReliefStrength, (hD - hU) * uReliefStrength, 1.0));

    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.7));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir + viewDir);

    float diff = max(dot(normal, lightDir), 0.0);
    float spec = pow(max(dot(normal, halfDir), 0.0), 40.0);
    // Real paint highlights pick up some of the pigment underneath, not pure white — a fully
    // white specular is what reads as "plastic" or "screen glare" rather than paint.
    vec3 specTint = mix(vec3(1.0), paintColor, 0.4);

    float variance = abs(hL - h) + abs(hR - h) + abs(hU - h) + abs(hD - h);
    float wideVariance = abs(hL2 - h) + abs(hR2 - h) + abs(hU2 - h) + abs(hD2 - h);
    float ao = 1.0 - clamp((variance * 1.4 + wideVariance * 0.5) * uAOStrength, 0.0, 0.82);

    // Thickness shading: paint reads as paint partly because thick, freshly-loaded strokes
    // are brighter/more saturated than thin ones. Without this, height only ever shows up
    // as a lighting normal — the base color itself never responds to how much paint is
    // actually there, which is a big part of why it read flat.
    float thickness = smoothstep(0.05, 0.85, h);
    float impasto = smoothstep(0.9, 2.2, h);
    vec3 thickPaint = paintColor * mix(0.8, 1.25, thickness) + vec3(0.08) * impasto;

    vec3 lit = thickPaint * (0.3 + 0.75 * diff) * ao + specTint * spec * 1.1;

    // Cheap procedural canvas weave (screen-space, so it reads as fabric texture at any
    // zoom rather than a flat fill) — this is what mostly targets "still reads as screen
    // color": bare ground was a single uniform RGB value before this.
    vec2 px = gl_FragCoord.xy;
    float weave = 0.5 + 0.5 * sin(px.x * 0.85) * sin(px.y * 0.85);
    float grain = hash21(floor(px * 0.5)) * 0.5 + 0.5;
    vec3 ground = uGroundColor * mix(0.9, 1.08, weave) * mix(0.94, 1.04, grain);

    outColor = vec4(linearToSRGB(mix(ground, lit, coverage)), 1.0);
  }
`;

export interface ShadingPassHandle {
  render(renderer: THREE.WebGLRenderer, colorSum: THREE.Texture, heightSum: THREE.Texture): void;
  setResolution(width: number, height: number): void;
  setReliefStrength(v: number): void;
}

export function createShadingPass(): ShadingPassHandle {
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
      uReliefStrength: { value: 14 },
      uAOStrength: { value: 1.6 },
      uGroundColor: { value: new THREE.Color(0x16130f) },
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
  };
}
