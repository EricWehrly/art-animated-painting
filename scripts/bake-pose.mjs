// Bakes two paired BVH trials (see docs/work/pose-pipeline.md) into a compact pose cache:
// public/data/pose-cache-<pairId>.json (header) + public/data/pose-cache-<pairId>.bin
// (Float32Array positions), where <pairId> is dancer A's trial number (e.g. "60_01" -> "01").
// Also writes public/data/pose-cache.json/.bin as an unkeyed copy of the DEFAULT pair, so
// existing callers that don't care which pair loads (loadPoseCache() with no id) keep working.
//
// Usage: yarn bake --a=60_01 --b=61_01 --fps=30 --out=public/data
//        yarn bake --a=60_12 --b=61_12 --fps=30 --out=public/data   (bakes as pose-cache-12.*)
//
// The DEFAULT_PAIR_ID pair (see below) additionally mirrors to the unkeyed pose-cache.json/.bin
// filenames, so `yarn bake` with no args keeps producing exactly what it always has.

import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchTrial } from "./fetch-bvh.mjs";
import { parseBVH, computeWorldPositions } from "./lib/bvh-parser.mjs";

// The pair the toy ships with when no pair is selected (see src/pose/pose-cache.ts's
// loadPoseCache default and src/shell/params.ts's trial picker default). Keyed off dancer A's
// trial number, same as every other pair — see pairIdFor().
const DEFAULT_PAIR_ID = "01";

/** Pair id used to key output filenames: dancer A's numeric trial suffix (e.g. "60_01" -> "01").
 * The dataset always pairs same-numbered trials (60_NN with 61_NN — see docs/roadmap.md), so
 * this alone is enough to identify a pair. */
function pairIdFor(trialA) {
  const [, nn] = trialA.split("_");
  if (!nn) throw new Error(`Trial "${trialA}" doesn't look like "<subject>_<NN>"`);
  return nn;
}

function parseArgs(argv) {
  const args = { a: "60_01", b: "61_01", fps: 30, out: "public/data" };
  for (const tok of argv) {
    const m = tok.match(/^--([a-z]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  args.fps = Number(args.fps);
  return args;
}

function resample(worldPositions, jointCount, srcFrameCount, srcFrameTime, targetFps) {
  const duration = (srcFrameCount - 1) * srcFrameTime;
  const targetFrameCount = Math.floor(duration * targetFps) + 1;
  const out = new Float32Array(targetFrameCount * jointCount * 3);

  for (let t = 0; t < targetFrameCount; t++) {
    const srcTime = t / targetFps;
    let srcIndex = Math.round(srcTime / srcFrameTime);
    if (srcIndex >= srcFrameCount) srcIndex = srcFrameCount - 1;
    const srcBase = srcIndex * jointCount * 3;
    const dstBase = t * jointCount * 3;
    out.set(worldPositions.subarray(srcBase, srcBase + jointCount * 3), dstBase);
  }

  return { positions: out, frameCount: targetFrameCount };
}

function assertMatchingRigs(jointsA, jointsB) {
  if (jointsA.length !== jointsB.length) {
    throw new Error(`Rig mismatch: dancer A has ${jointsA.length} joints, dancer B has ${jointsB.length}`);
  }
  for (let i = 0; i < jointsA.length; i++) {
    if (jointsA[i].name !== jointsB[i].name || jointsA[i].parentIndex !== jointsB[i].parentIndex) {
      throw new Error(
        `Rig mismatch at joint ${i}: A="${jointsA[i].name}"(parent ${jointsA[i].parentIndex}) ` +
          `vs B="${jointsB[i].name}"(parent ${jointsB[i].parentIndex})`
      );
    }
  }
}

async function loadTrial(trial) {
  const filePath = await fetchTrial(trial);
  const text = await readFile(filePath, "utf8");
  return parseBVH(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Baking pose cache: A=${args.a} B=${args.b} fps=${args.fps} -> ${args.out}`);

  const [parsedA, parsedB] = await Promise.all([loadTrial(args.a), loadTrial(args.b)]);
  assertMatchingRigs(parsedA.joints, parsedB.joints);

  if (parsedA.frameCount !== parsedB.frameCount) {
    console.warn(
      `Warning: frame count mismatch (A=${parsedA.frameCount}, B=${parsedB.frameCount}); ` +
        `trimming both to the shorter length.`
    );
  }
  const frameCount = Math.min(parsedA.frameCount, parsedB.frameCount);
  const jointCount = parsedA.joints.length;

  const worldA = computeWorldPositions(parsedA);
  const worldB = computeWorldPositions(parsedB);

  const { positions: resampledA, frameCount: outFrameCount } = resample(
    worldA,
    jointCount,
    frameCount,
    parsedA.frameTime,
    args.fps
  );
  const { positions: resampledB } = resample(worldB, jointCount, frameCount, parsedB.frameTime, args.fps);

  const combined = new Float32Array(resampledA.length + resampledB.length);
  combined.set(resampledA, 0);
  combined.set(resampledB, resampledA.length);

  const pairId = pairIdFor(args.a);
  const header = {
    fps: args.fps,
    frameCount: outFrameCount,
    jointCount,
    joints: parsedA.joints.map((j) => ({ name: j.name, parentIndex: j.parentIndex, isEndSite: j.isEndSite })),
    dancers: [
      { id: "A", trial: args.a, floatOffset: 0 },
      { id: "B", trial: args.b, floatOffset: resampledA.length },
    ],
    units: "bvh-native (CMU mocap; consumers should normalize scale)",
    pairId,
  };

  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const headerJson = JSON.stringify(header, null, 2);
  const binBuffer = Buffer.from(combined.buffer);

  const writeOne = (basename) =>
    Promise.all([
      writeFile(path.join(outDir, `${basename}.json`), headerJson),
      writeFile(path.join(outDir, `${basename}.bin`), binBuffer),
    ]);

  await writeOne(`pose-cache-${pairId}`);
  // Mirror the default pair to the unkeyed filenames too, so callers that just want "the pose
  // cache" (loadPoseCache() with no pair id — main.ts/compare.ts today) keep working unchanged.
  if (pairId === DEFAULT_PAIR_ID) await writeOne("pose-cache");

  const bytes = combined.byteLength;
  console.log(
    `Wrote ${outFrameCount} frames x ${jointCount} joints x 2 dancers ` +
      `(${(bytes / 1024).toFixed(0)} KB binary) to ${outDir} as pose-cache-${pairId}.{json,bin}` +
      (pairId === DEFAULT_PAIR_ID ? ` (+ mirrored to pose-cache.{json,bin} as the default)` : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
