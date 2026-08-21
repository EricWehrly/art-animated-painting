import * as THREE from "three";

export interface HeightPassHandle {
  colorSumTexture: THREE.Texture;
  heightSumTexture: THREE.Texture;
  setSize(width: number, height: number): void;
  /** Renders `colorMesh`/`heightMesh` into their respective targets, each cleared to zero
   * (no accumulation yet — see docs/work/paint-accumulator.md; that item adds the
   * decay-then-splat version of this). */
  render(renderer: THREE.WebGLRenderer, colorMesh: THREE.Object3D, heightMesh: THREE.Object3D, camera: THREE.Camera): void;
}

function createTarget(width: number, height: number, name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.name = name;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  return target;
}

/**
 * Two separate single-attachment render targets rather than one two-attachment MRT target.
 * Not load-bearing for correctness (the real bug turned out to be a zero-alpha write into an
 * additively-blended half-float target — see the comment on `heightFragmentShader`'s output
 * in stroke-mesh.ts) but kept anyway: it's simple, and the extra draw call is negligible at
 * this instance count.
 */
export function createHeightPass(width: number, height: number): HeightPassHandle {
  const colorTarget = createTarget(width, height, "colorSum");
  const heightTarget = createTarget(width, height, "heightSum");
  const passScene = new THREE.Scene();

  function renderInto(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    mesh: THREE.Object3D,
    camera: THREE.Camera
  ) {
    // passScene is reused for both the color and height draws (called back-to-back below),
    // so it needs to hold only the mesh for whichever draw is currently happening.
    if (passScene.children[0] !== mesh) {
      passScene.clear();
      passScene.add(mesh);
    }

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
  }

  return {
    colorSumTexture: colorTarget.texture,
    heightSumTexture: heightTarget.texture,
    setSize(w: number, h: number) {
      colorTarget.setSize(w, h);
      heightTarget.setSize(w, h);
    },
    render(renderer, colorMesh, heightMesh, camera) {
      renderInto(renderer, colorTarget, colorMesh, camera);
      renderInto(renderer, heightTarget, heightMesh, camera);
    },
  };
}
