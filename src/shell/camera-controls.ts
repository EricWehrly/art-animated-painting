import * as THREE from "three";

export interface CameraControlsOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  /** Fixed unit vector from target to camera — the viewing angle never changes; only
   * `distance` (zoom) and `target` (pan) move. See shell/canvas.ts. */
  direction: THREE.Vector3;
  /** Mutated in place by panning. */
  target: THREE.Vector3;
  distance: number;
  minDistance?: number;
  maxDistance?: number;
  /** Called after every wheel/drag interaction, so the caller can re-render and persist state. */
  onChange: (distance: number) => void;
}

export interface CameraControlsHandle {
  readonly distance: number;
  /** Re-applies the current distance/target/direction to the camera — call after externally
   * changing `distance` (e.g. from a Tweakpane slider) so mouse controls and UI stay in sync. */
  setDistance(d: number): void;
  dispose(): void;
}

/**
 * Mouse-driven zoom (wheel, center-anchored — the look-at target never moves, so the point
 * currently centered in view stays centered as you zoom) and pan (left-drag, "grab the
 * canvas" behaviour: content tracks the cursor). Never changes the viewing angle — see
 * shell/canvas.ts.
 */
export function attachCameraControls(opts: CameraControlsOptions): CameraControlsHandle {
  const { camera, domElement, direction, target } = opts;
  let distance = opts.distance;
  const minDistance = opts.minDistance ?? 8;
  const maxDistance = opts.maxDistance ?? 150;
  const zoomSpeed = 0.0015;

  function apply() {
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }
  apply();

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * zoomSpeed);
    distance = THREE.MathUtils.clamp(distance * factor, minDistance, maxDistance);
    apply();
    opts.onChange(distance);
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    domElement.setPointerCapture(e.pointerId);
    domElement.style.cursor = "grabbing";
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const worldPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / domElement.clientHeight;

    // Content tracks the cursor: dragging right/down should move the *view* right/down.
    // Screen-space y grows downward while the camera's `up` basis vector points toward
    // screen-up, so the vertical term needs the opposite sign from the naive derivation —
    // verified empirically (a synthetic drag-down was moving content up before this flip).
    target.addScaledVector(right, -dx * worldPerPixel);
    target.addScaledVector(up, -dy * worldPerPixel);

    apply();
    opts.onChange(distance);
  }

  function onPointerUp(e: PointerEvent) {
    dragging = false;
    domElement.releasePointerCapture(e.pointerId);
    domElement.style.cursor = "grab";
  }

  domElement.addEventListener("wheel", onWheel, { passive: false });
  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.style.cursor = "grab";
  domElement.style.touchAction = "none";

  return {
    get distance() {
      return distance;
    },
    setDistance(d: number) {
      distance = THREE.MathUtils.clamp(d, minDistance, maxDistance);
      apply();
    },
    dispose() {
      domElement.removeEventListener("wheel", onWheel);
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", onPointerUp);
    },
  };
}
