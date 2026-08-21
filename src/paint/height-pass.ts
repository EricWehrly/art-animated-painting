import * as THREE from "three";

export interface HeightPassHandle {
  target: THREE.WebGLRenderTarget;
  colorSumTexture: THREE.Texture;
  heightSumTexture: THREE.Texture;
  setSize(width: number, height: number): void;
  /** Renders `mesh` alone into the MRT target, cleared to zero (no accumulation yet — see
   * docs/work/paint-accumulator.md; that item adds the decay-then-splat version of this). */
  render(renderer: THREE.WebGLRenderer, mesh: THREE.Object3D, camera: THREE.Camera): void;
}

export function createHeightPass(width: number, height: number): HeightPassHandle {
  const target = new THREE.WebGLRenderTarget(width, height, {
    count: 2,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.textures[0].name = "colorSum";
  target.textures[1].name = "heightSum";
  for (const tex of target.textures) {
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }

  const passScene = new THREE.Scene();

  return {
    target,
    colorSumTexture: target.textures[0],
    heightSumTexture: target.textures[1],
    setSize(w: number, h: number) {
      target.setSize(w, h);
    },
    render(renderer, mesh, camera) {
      if (mesh.parent !== passScene) passScene.add(mesh);

      const prevTarget = renderer.getRenderTarget();
      const prevClearColor = new THREE.Color();
      renderer.getClearColor(prevClearColor);
      const prevClearAlpha = renderer.getClearAlpha();

      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(passScene, camera);

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
    },
  };
}
