// Bakes two paired BVH trials (see docs/work/pose-pipeline.md) into a compact pose cache:
// public/data/pose-cache.json (header) + public/data/pose-cache.bin (Float32Array positions).
//
// Usage: yarn bake --a=60_01 --b=61_01 --fps=30 --out=public/data

import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchTrial } from "./fetch-bvh.mjs";
import { parseBVH, computeWorldPositions } from "./lib/bvh-parser.mjs";

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
  };

  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "pose-cache.json"), JSON.stringify(header, null, 2));
  await writeFile(path.join(outDir, "pose-cache.bin"), Buffer.from(combined.buffer));

  const bytes = combined.byteLength;
  console.log(
    `Wrote ${outFrameCount} frames x ${jointCount} joints x 2 dancers ` +
      `(${(bytes / 1024).toFixed(0)} KB binary) to ${outDir}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
