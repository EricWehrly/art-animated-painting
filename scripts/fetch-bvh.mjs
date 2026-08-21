// Downloads specific CMU mocap trials (BVH conversion mirrored on GitHub) into a local,
// gitignored cache. Source: docs/roadmap.md — subjects 60/61, salsa, captured as a couple.
// Not vendored into the repo: see "why bake rather than vendor" in docs/work/pose-pipeline.md.

import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const MIRROR = "https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data";
const CACHE_DIR = path.resolve(import.meta.dirname, ".cache", "bvh");

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function fetchTrial(trial) {
  const [subject] = trial.split("_");
  const dir = subject.padStart(3, "0");
  const url = `${MIRROR}/${dir}/${trial}.bvh`;
  const destDir = path.join(CACHE_DIR, dir);
  const dest = path.join(destDir, `${trial}.bvh`);

  if (await fileExists(dest)) return dest;

  await mkdir(destDir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.length < 1000) throw new Error(`Suspiciously small response for ${url} (${text.length} bytes)`);
  await writeFile(dest, text, "utf8");
  return dest;
}

// Allow running directly: `node scripts/fetch-bvh.mjs 60_01 61_01`
if (import.meta.url === `file://${process.argv[1]}`) {
  const trials = process.argv.slice(2);
  if (trials.length === 0) {
    console.error("Usage: node scripts/fetch-bvh.mjs <trial> [trial...]  e.g. 60_01 61_01");
    process.exit(1);
  }
  for (const trial of trials) {
    const dest = await fetchTrial(trial);
    console.log(`${trial} -> ${dest}`);
  }
}
