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

// Impasto shading: height field -> normals via central differences -> key+rim light with a
// chunky specular -> cheap variance-based AO -> composite over a flat ground color.
// See docs/work/impasto-shading.md. Watercolor ground (P5) will replace uGroundColor.
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

  void main() {
    vec4 colorSum = texture(uColorSum, vUv);
    float coverage = clamp(colorSum.a, 0.0, 1.0);
    vec3 paintColor = colorSum.a > 0.0001 ? colorSum.rgb / colorSum.a : vec3(0.0);

    float h = heightAt(vUv);
    float hL = heightAt(vUv - vec2(uTexelSize.x, 0.0));
    float hR = heightAt(vUv + vec2(uTexelSize.x, 0.0));
    float hD = heightAt(vUv - vec2(0.0, uTexelSize.y));
    float hU = heightAt(vUv + vec2(0.0, uTexelSize.y));

    vec3 normal = normalize(vec3((hL - hR) * uReliefStrength, (hD - hU) * uReliefStrength, 1.0));

    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.7));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir + viewDir);

    float diff = max(dot(normal, lightDir), 0.0);
    float spec = pow(max(dot(normal, halfDir), 0.0), 48.0);
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.0) * 0.3;

    float variance = abs(hL - h) + abs(hR - h) + abs(hU - h) + abs(hD - h);
    float ao = 1.0 - clamp(variance * uAOStrength, 0.0, 0.6);

    vec3 lit = paintColor * (0.35 + 0.65 * diff) * ao + vec3(1.0) * spec * 0.8 + vec3(0.6, 0.7, 0.9) * rim;

    outColor = vec4(linearToSRGB(mix(uGroundColor, lit, coverage)), 1.0);
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
      uAOStrength: { value: 1.2 },
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
