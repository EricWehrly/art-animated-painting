import * as THREE from "three";

export interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  domElement: HTMLCanvasElement;
}

/**
 * Sets up a DPR-correct WebGL2 renderer + fixed camera, appended into `container`.
 * The camera never moves — see docs/roadmap.md "Fixed camera" decision: this is a
 * painting, and a moving camera would smear the accumulated surface.
 */
export function createScene(container: HTMLElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x16130f);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  camera.position.set(0, 20, 90);
  camera.lookAt(0, 15, 0);

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  window.addEventListener("resize", resize);
  resize();

  return { renderer, scene, camera, domElement: renderer.domElement };
}
