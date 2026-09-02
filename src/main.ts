import * as THREE from "three";
import { createScene, CAMERA_HOME_POSITION, CAMERA_HOME_TARGET } from "./shell/canvas";
import { attachCameraControls } from "./shell/camera-controls";
import { createTimeline } from "./shell/timeline";
import { createCreditsModal } from "./shell/credits";
import { createParamsPanel, loadParamsFromHash, saveParamsToHash, defaultParams, type ToyParams } from "./shell/params";
import { capturePNG } from "./shell/capture";
import { loadPoseCache } from "./pose/pose-cache";
import { buildChains } from "./pose/skeleton";
import type { Emitter } from "./pose/emitters";
import {
  generateChainMarks,
  generateSpeckles,
  type Stroke,
  type BoneStrokeStyle,
  type SpeckleStyle,
  type ChainDebugDab,
} from "./pose/strokes";
import { findHeadJoints, truncateHeadChain, generateHeadMarks, type HeadStyle } from "./pose/head";
import { createStrokeMesh } from "./paint/stroke-mesh";
import { createHeightPass } from "./paint/height-pass";
import { createShadingPass } from "./paint/shading-pass";
import { createDebugOverlay, type DebugDancerData } from "./debug/overlay";

async function main() {
  const app = document.getElementById("app");
  if (!app) throw new Error("missing #app container");

  // The `scene` createScene() sets up goes unused here: strokes render into an offscreen
  // pass scene owned by height-pass.ts, and shading-pass.ts renders straight to screen with
  // its own full-screen-quad scene. createScene still gives us the renderer/camera/canvas.
  const { renderer, camera, domElement } = createScene(app);

  const timeline = createTimeline(app);
  createCreditsModal(app);
  const params: ToyParams = loadParamsFromHash();
  const pane = createParamsPanel(app, params);

  // params.trialPair selects which baked CMU 60/61 trial pair to play (see the "trial pair"
  // picker in shell/params.ts) — switching it reloads the page rather than hot-swapping here,
  // since frame count/joints/chains below are all derived once from cache.header at boot.
  const cache = await loadPoseCache("/data", params.trialPair);
  // Main figure strokes cover whole CHAINS (a whole limb, e.g. hip-to-toe or shoulder-to-wrist)
  // with many brush marks tiled along and across the chain's own shape — see
  // generateChainMarks in pose/strokes.ts and buildChains in pose/skeleton.ts. Speckle emitters
  // are sourced from generateChainMarks' own fast steps (see its emittersOut parameter), not
  // an independent per-bone sampling pass, so a speckle always traces back to an actual
  // painted stroke's own tip — see docs/work/pose-pipeline.md Round 14.
  // The neck+head chain otherwise walks all the way to the head's own end site and gets the
  // same tapering-tube treatment as any limb — a small stub at the end of a shrinking tube,
  // which is what read as a "worm." headJoints is null only if the rig lacks named shoulders
  // (findHeadJoints' fallback contract) — chains stays untouched in that case, and the head
  // just keeps the old tube treatment rather than the toy failing to load.
  const headJoints = findHeadJoints(cache.header.joints);
  const chains = headJoints ? truncateHeadChain(buildChains(cache.header.joints), headJoints) : buildChains(cache.header.joints);
  const frameCount = cache.header.frameCount;
  timeline.setFrameCount(frameCount);

  const speckleMaxCount = 6;
  // Generous headroom, not an exact count — see generateChainMarks' own doc comment for why
  // its per-chain mark count isn't a simple closed form. setStrokes() silently caps at this
  // budget. The speckle share now rides on the same per-chain step count (each fast step can
  // contribute one emitter), rather than an independent bone-based estimate.
  const maxMarksPerChainEstimate = 90;
  const mainMarksTotal = chains.length * maxMarksPerChainEstimate * cache.header.dancers.length;
  // generateHeadMarks' own count formula tops out well under this per dancer — generous
  // headroom, same spirit as the chain estimate above.
  const maxHeadMarks = 400 * cache.header.dancers.length;
  const maxStrokes = mainMarksTotal + mainMarksTotal * speckleMaxCount + maxHeadMarks;

  const strokeMesh = createStrokeMesh(maxStrokes);
  // The camera's viewing angle is a fixed, build-time constant (see shell/canvas.ts) —
  // generateChainMarks uses that to derive each mark's across-limb (lane) axis on the CPU.
  const viewForwardVec = CAMERA_HOME_TARGET.clone().sub(CAMERA_HOME_POSITION).normalize();
  const viewForward: [number, number, number] = [viewForwardVec.x, viewForwardVec.y, viewForwardVec.z];
  const heightPass = createHeightPass(domElement.width, domElement.height);
  const shadingPass = createShadingPass();
  const debugOverlay = createDebugOverlay();

  let currentFrame = 0;

  // Mouse wheel = zoom, centered on the current look-at target (the point in the middle of
  // the view stays put as you zoom — that's what makes it "center zoom" rather than
  // cursor-anchored zoom). Left-drag = pan. The viewing ANGLE never changes — see
  // shell/canvas.ts — so this is a viewfinder control, not the animated camera the "fixed
  // camera" roadmap decision is about.
  const cameraTarget = new THREE.Vector3(params.targetX, params.targetY, params.targetZ);
  const cameraDirection = CAMERA_HOME_POSITION.clone().sub(CAMERA_HOME_TARGET).normalize();
  const controls = attachCameraControls({
    camera,
    domElement,
    direction: cameraDirection,
    target: cameraTarget,
    distance: params.cameraDistance,
    onChange: () => syncCameraParamsAndRerender(),
  });

  function syncCameraParamsAndRerender() {
    params.cameraDistance = controls.distance;
    params.targetX = cameraTarget.x;
    params.targetY = cameraTarget.y;
    params.targetZ = cameraTarget.z;
    pane.refresh();
    saveParamsToHash(params);
    renderFrame(currentFrame);
  }

  pane.addButton({ title: "reset view" }).on("click", () => {
    cameraTarget.copy(CAMERA_HOME_TARGET);
    controls.setDistance(defaultParams.cameraDistance);
    syncCameraParamsAndRerender();
  });

  function strokeStyleFor(dancerIndex: number): BoneStrokeStyle {
    // Calm mode ("duress" off): a single shared color for both dancers, and every
    // motion-driven effect zeroed — pure bone-aligned coverage (still with the always-on
    // wobble/loading structure that makes it read as painted, not a wire), for calibrating
    // the base figure independent of how motion later bends it. See docs/work/pose-pipeline.md
    // Round 5, Round 13, Round 14.
    const hex = params.duress ? (dancerIndex === 0 ? params.colorA : params.colorB) : params.colorA;
    const c = new THREE.Color(hex);
    return {
      color: [c.r, c.g, c.b],
      widthScale: 1.7 * params.strokeWidthScale,
      lengthScale: params.strokeLengthScale,
      volumeScale: 0.35,
      pressureVariance: params.pressureVariance,
      // Elongated relative to markWidth — a mark needs a real length-to-width ratio to read as
      // a brush gesture; close to 1:1 reads as a stamped coin/ring instead (see
      // docs/work/pose-pipeline.md Round 13's first attempt). Shortened from 1.7 (Round 19) —
      // the user's own live-tweaked value, done via the strokeLengthScale slider, read better;
      // strokeLengthScale itself stays available on top of this for further live tuning.
      stepLength: 1.3,
      stepOverlap: 0.5,
      // A single lane's target width — how many parallel passes a limb's local width needs
      // (round(localWidth / markWidth)) is what makes a hip read as several strokes wide and
      // a forearm as one, instead of every limb being one uniform-width line.
      markWidth: 0.8,
      // Always on, independent of duress — a persistent, damped wander around the bone
      // tangent, not one-shot per-mark noise. ~20 degrees, damped back toward the tangent by
      // 35% each step so a pass stays "trying to move in the same general direction."
      wobbleAngle: 0.35,
      wobbleDamping: 0.35,
      // A load covers a little under 3 steps before running dry, so the thick/thin/reload
      // cycle is visible within most bone segments, not just on the longest ones.
      paintCapacity: 4.5,
      dryMinLoad: 0.15,
      dryWidthFactor: 0.45,
      dryVolumeFactor: 0.4,
      // Unlike the old seeking-brush's maxWaverBlend, this has no 0.5 stability ceiling (see
      // BoneStrokeStyle doc comment) — these values are an art-direction choice, not a
      // correctness one. Turned down from 1.0/0.75/1.2 per direct instruction ("reduce the
      // amount that strokes are impacted by motion") — see docs/work/pose-pipeline.md Round 16.
      motionForceScale: params.duress ? 0.7 : 0,
      maxMotionForce: params.duress ? 0.55 : 0,
      smearScale: params.duress ? 0.8 : 0,
      maxMarkLength: 4.5,
      // Speckles should read as the breaking point of a stroke's own fling, not a separate
      // effect — see speckleStyleFor's spread comment.
      speckleSpeedThreshold: params.duress && params.speckleAmount > 0 ? 0.15 : Infinity,
    };
  }

  function headStyleFor(dancerIndex: number): HeadStyle {
    const hex = params.duress ? (dancerIndex === 0 ? params.colorA : params.colorB) : params.colorA;
    const c = new THREE.Color(hex);
    return { color: [c.r, c.g, c.b], widthScale: params.strokeWidthScale };
  }

  function speckleStyleFor(dancerIndex: number): SpeckleStyle {
    const hex = dancerIndex === 0 ? params.colorA : params.colorB;
    const c = new THREE.Color(hex);
    return {
      color: [c.r, c.g, c.b],
      speedThreshold: 0.15,
      maxCount: speckleMaxCount * params.speckleAmount,
      // Small — emitters now come from generateChainMarks' own fast steps (their actual tip
      // position), so a big scatter radius here would just recreate the "too far from the
      // stroke it's meant to be flung from" look. See docs/work/pose-pipeline.md Round 14.
      // Cut further in Round 17 ("that's too much... just a little pizazz on the motion" —
      // 0.7 was still throwing droplets too far out, more fling than "someone spitting"), then
      // nudged back up slightly in Round 20 ("favor more being disconnected from the
      // strokes... not too far") — 0.35 had swung a bit too far the other way.
      spread: 0.45,
      // Bumped slightly — Round 20's "about the length they are, bit bigger" — the per-droplet
      // size formula itself now varies much more widely around this base (see generateSpeckles).
      sizeScale: 0.4,
    };
  }

  function renderFrame(frame: number) {
    const allStrokes: Stroke[] = [];
    const debugDancers: DebugDancerData[] = [];
    for (let dancerIndex = 0; dancerIndex < cache.header.dancers.length; dancerIndex++) {
      // -1 = both dancers (default). Isolating one dancer removes the other from the canvas
      // entirely, not just visually — the two figures overlapping is exactly what makes a
      // single body hard to read (see the frame-68 case).
      if (params.soloDancer !== -1 && dancerIndex !== params.soloDancer) continue;
      const debugDabs: ChainDebugDab[] | undefined = params.debugMode ? [] : undefined;
      // Speckles are a fling/spatter effect from motion — meaningless (and distracting from
      // the base figure) in calm calibration mode; strokeStyleFor sets speckleSpeedThreshold
      // to Infinity in that case so no emitter is ever pushed, rather than gating here too.
      const emitters: Emitter[] | undefined = params.duress && params.speckleAmount > 0 ? [] : undefined;
      allStrokes.push(
        ...generateChainMarks(cache, chains, dancerIndex, frame, strokeStyleFor(dancerIndex), viewForward, debugDabs, emitters)
      );
      if (debugDabs) debugDancers.push({ dancerIndex, debugDabs });
      if (emitters) {
        allStrokes.push(...generateSpeckles(emitters, frame, speckleStyleFor(dancerIndex)));
      }
      if (headJoints) {
        allStrokes.push(...generateHeadMarks(cache, headJoints, dancerIndex, frame, headStyleFor(dancerIndex)));
      }
    }
    strokeMesh.setStrokes(allStrokes);

    heightPass.render(renderer, strokeMesh.colorMesh, strokeMesh.heightMesh, camera);
    shadingPass.setReliefStrength(params.reliefStrength);
    shadingPass.render(renderer, heightPass.colorSumTexture, heightPass.heightSumTexture);

    // Must run after shadingPass — see debug/overlay.ts's render() doc comment for why.
    if (params.debugMode) {
      debugOverlay.render(renderer, camera, cache, chains, frame, debugDancers, params.duress);
    }
  }

  // Resizing recreates the render targets at the new resolution, which clears their
  // contents — re-render the current frame immediately so the canvas doesn't go blank
  // until the next scrub/playback tick.
  function resize() {
    heightPass.setSize(domElement.width, domElement.height);
    shadingPass.setResolution(domElement.width, domElement.height);
    renderFrame(currentFrame);
  }
  window.addEventListener("resize", resize);
  resize();

  timeline.onSeek((frame) => {
    currentFrame = frame;
    params.playing = false;
    renderFrame(currentFrame);
  });

  // Live-tweaking params (relief, colors, stroke sizing, the cameraDistance slider, ...)
  // needs its own re-render: renderFrame only otherwise runs on scrub/resize/playback ticks,
  // so a paused param change would silently do nothing until the next one of those. Also
  // re-applies cameraDistance to the camera in case that's what changed — mouse wheel/drag
  // go through camera-controls.ts directly and don't fire this (Tweakpane-only) listener.
  pane.on("change", () => {
    controls.setDistance(params.cameraDistance);
    renderFrame(currentFrame);
  });

  // Simple playback loop, independent of the LayerClock (that drives paint accumulation
  // once paint-accumulator lands; this is just scrubbing the pose for now).
  let lastTs = performance.now();
  function tick(nowMs: number) {
    const dtSeconds = (nowMs - lastTs) / 1000;
    lastTs = nowMs;
    if (params.playing) {
      currentFrame = (currentFrame + dtSeconds * cache.header.fps) % frameCount;
      timeline.setFrame(Math.floor(currentFrame));
      renderFrame(Math.floor(currentFrame));
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener("keydown", (e) => {
    if (e.key === "s") capturePNG(domElement);
  });
}

main().catch((err) => {
  console.error(err);
  const app = document.getElementById("app");
  if (app) app.textContent = `Failed to start: ${(err as Error).message}`;
});
