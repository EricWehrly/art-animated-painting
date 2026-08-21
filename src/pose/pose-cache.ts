export interface JointMeta {
  name: string;
  parentIndex: number;
  isEndSite: boolean;
}

export interface DancerMeta {
  id: string;
  trial: string;
  floatOffset: number;
}

export interface PoseCacheHeader {
  fps: number;
  frameCount: number;
  jointCount: number;
  joints: JointMeta[];
  dancers: DancerMeta[];
  units: string;
}

export interface PoseCache {
  header: PoseCacheHeader;
  positions: Float32Array; // [dancer][frame][joint][xyz], per dancer offset given in header.dancers
}

/** Loads the baked pose cache written by scripts/bake-pose.mjs (see docs/work/pose-pipeline.md). */
export async function loadPoseCache(baseUrl = "/data"): Promise<PoseCache> {
  const [header, binResponse] = await Promise.all([
    fetch(`${baseUrl}/pose-cache.json`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load pose-cache.json: ${r.status}`);
      return r.json() as Promise<PoseCacheHeader>;
    }),
    fetch(`${baseUrl}/pose-cache.bin`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load pose-cache.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  return { header, positions: new Float32Array(binResponse) };
}

/**
 * Reads a joint's world position for a given dancer + frame.
 *
 * Returns a fresh tuple every call (not a shared scratch buffer) — callers routinely hold
 * several results live at once (e.g. parent + child, this frame + previous frame), and a
 * reused buffer would silently alias between them.
 */
export function jointWorldPosition(
  cache: PoseCache,
  dancerIndex: number,
  frame: number,
  jointIndex: number
): [number, number, number] {
  const { header, positions } = cache;
  const dancer = header.dancers[dancerIndex];
  const clampedFrame = Math.max(0, Math.min(header.frameCount - 1, frame));
  const base = dancer.floatOffset + (clampedFrame * header.jointCount + jointIndex) * 3;
  return [positions[base], positions[base + 1], positions[base + 2]];
}
