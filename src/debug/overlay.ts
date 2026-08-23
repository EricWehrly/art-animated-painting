import * as THREE from "three";
import type { PoseCache } from "../pose/pose-cache";
import { jointWorldPosition } from "../pose/pose-cache";
import type { Chain } from "../pose/skeleton";
import type { ChainDebugDab } from "../pose/strokes";

export interface DebugDancerData {
  dancerIndex: number;
  debugDabs: ChainDebugDab[];
}

export interface DebugOverlayHandle {
  /**
   * Rebuilds the overlay's geometry for this frame and renders it directly to the screen, on
   * top of whatever heightPass/shadingPass just drew. shading-pass.ts renders straight to the
   * default framebuffer with its own full-screen-quad scene, bypassing the normal
   * camera-rendered `scene` entirely (see main.ts) — so this is the only way to show
   * camera-aligned debug geometry over it. Must run AFTER shadingPass.render() each frame.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, cache: PoseCache, chains: Chain[], frame: number, dancers: DebugDancerData[]): void;
  dispose(): void;
}

// Fixed, dancer-independent colors — the point of this view is reading the GENERATOR's own
// data cleanly, not matching the painted figure's palette. Two alternating stroke colors make
// individual dab boundaries visible as distinct segments (item 2 of the request: "each stroke
// we're intending to take" — a chain of many separate strokes, not one continuous line).
const OUTLINE_COLOR = 0xffffff;
const STROKE_COLOR_A = 0xffb020;
const STROKE_COLOR_B = 0xff5090;
const ARROW_COLOR = 0x30e0ff;

/**
 * Three debug layers, per the request: (1) the outline/character we're trying to paint — the
 * raw bone-chain polyline itself, i.e. exactly the literal "skeleton" the real paint strokes
 * are deliberately NOT supposed to trace; (2) each stroke actually intended — every dab's true
 * start/end, from the real generateChainStrokes walk (via its debugOut parameter), not a
 * re-derived approximation, so this view can never show something the generator didn't
 * actually do; (3) arrows for the raw sampled velocity at each dab — direction and length
 * (relative strength), separate from the strokes' own blended heading.
 */
export function createDebugOverlay(): DebugOverlayHandle {
  const scene = new THREE.Scene();

  function clear() {
    for (const obj of [...scene.children]) {
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh | THREE.Line;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = (mesh as THREE.Mesh).material;
        if (material) {
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      scene.remove(obj);
    }
  }

  function addLineSegments(points: number[], color: number) {
    if (points.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    scene.add(lines);
  }

  function render(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    cache: PoseCache,
    chains: Chain[],
    frame: number,
    dancers: DebugDancerData[]
  ) {
    clear();

    for (const { dancerIndex, debugDabs } of dancers) {
      // 1. Outline/character: the literal joint-to-joint chain polyline — the shape the
      // strokes are meant to cover, drawn thin and plain so it reads as reference, not paint.
      const outlinePts: number[] = [];
      for (const chain of chains) {
        for (let i = 0; i < chain.jointPath.length - 1; i++) {
          const a = jointWorldPosition(cache, dancerIndex, frame, chain.jointPath[i]);
          const b = jointWorldPosition(cache, dancerIndex, frame, chain.jointPath[i + 1]);
          outlinePts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      }
      addLineSegments(outlinePts, OUTLINE_COLOR);

      // 2. Each intended stroke — alternating colors by dab index so adjacent dabs are
      // visually distinguishable as separate strokes rather than one continuous polyline.
      const strokePtsA: number[] = [];
      const strokePtsB: number[] = [];
      debugDabs.forEach((dab, i) => {
        const target = i % 2 === 0 ? strokePtsA : strokePtsB;
        target.push(dab.start[0], dab.start[1], dab.start[2], dab.end[0], dab.end[1], dab.end[2]);
      });
      addLineSegments(strokePtsA, STROKE_COLOR_A);
      addLineSegments(strokePtsB, STROKE_COLOR_B);

      // 3. Motion arrows — raw sampled velocity per dab, direction + magnitude (clamped so a
      // single fast joint can't dwarf the rest of the figure).
      for (const dab of debugDabs) {
        const speed = Math.hypot(dab.rawVelocity[0], dab.rawVelocity[1], dab.rawVelocity[2]);
        if (speed < 1e-4) continue;
        const dir = new THREE.Vector3(...dab.rawVelocity).normalize();
        const origin = new THREE.Vector3(
          (dab.start[0] + dab.end[0]) / 2,
          (dab.start[1] + dab.end[1]) / 2,
          (dab.start[2] + dab.end[2]) / 2
        );
        const length = Math.min(0.4 + speed * 1.5, 4);
        const arrow = new THREE.ArrowHelper(dir, origin, length, ARROW_COLOR, length * 0.3, length * 0.18);
        (arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
        (arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
        scene.add(arrow);
      }
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = prevAutoClear;
  }

  return { render, dispose: clear };
}
