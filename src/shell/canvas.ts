import * as THREE from "three";

export interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  domElement: HTMLCanvasElement;
}

// The camera's viewing ANGLE never changes — see docs/roadmap.md "Fixed camera": this is a
// painting, and rotating the view would smear the accumulated surface once paint-accumulator
// (P3) exists. Distance and look-at target ARE user-adjustable (see shell/camera-controls.ts)
// — that's a viewfinder/composition choice, not an animated camera move, and there's nothing
// to smear yet since accumulation isn't built. These two constants are the single source of
// truth for the fixed angle; camera-controls.ts derives its direction vector from them rather
// than duplicating the numbers.
export const CAMERA_HOME_POSITION = new THREE.Vector3(0, 20, 90);
export const CAMERA_HOME_TARGET = new THREE.Vector3(0, 15, 0);

/** Sets up a DPR-correct WebGL2 renderer + camera at its home framing, appended into `container`. */
export function createScene(container: HTMLElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x16130f);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  camera.position.copy(CAMERA_HOME_POSITION);
  camera.lookAt(CAMERA_HOME_TARGET);

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
