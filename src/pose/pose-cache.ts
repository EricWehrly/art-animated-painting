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
  /** Identifies which baked trial pair this is — dancer A's numeric trial suffix (e.g. "60_01"
   * -> "01"), matching the `<pairId>` in scripts/bake-pose.mjs's `pose-cache-<pairId>.*`
   * filenames. Absent on caches baked before per-pair keying existed. */
  pairId?: string;
}

export interface PoseCache {
  header: PoseCacheHeader;
  positions: Float32Array; // [dancer][frame][joint][xyz], per dancer offset given in header.dancers
}

/**
 * Loads a baked pose cache written by scripts/bake-pose.mjs (see docs/work/pose-pipeline.md).
 *
 * `pairId` selects which baked trial pair to load (e.g. "12" for pose-cache-12.json/.bin, the
 * 60_12/61_12 pair) — see the picker in src/shell/params.ts. Omit it (the default) to load the
 * unkeyed pose-cache.json/.bin files, i.e. whichever pair the toy currently ships with as
 * default — this keeps existing callers that don't care which pair loads (main.ts, compare.ts)
 * working unchanged.
 */
export async function loadPoseCache(baseUrl = "/data", pairId?: string): Promise<PoseCache> {
  const basename = pairId ? `pose-cache-${pairId}` : "pose-cache";
  const [header, binResponse] = await Promise.all([
    fetch(`${baseUrl}/${basename}.json`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${basename}.json: ${r.status}`);
      return r.json() as Promise<PoseCacheHeader>;
    }),
    fetch(`${baseUrl}/${basename}.bin`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${basename}.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  return { header, positions: new Float32Array(binResponse) };
}

/** All baked trial pair ids, in trial order, for populating the "dance" picker in
 * src/shell/params.ts. Hardcoded rather than discovered at runtime (no directory listing
 * available over HTTP) — keep in sync with which `pose-cache-<id>.*` files
 * scripts/bake-pose.mjs has actually produced into public/data. All 15 CMU 60/61 salsa trial
 * pairs were verified as valid (matching rigs, matching frame counts, plausible partner
 * distance) and baked — see docs/roadmap.md.
 *
 * Labels are plain "Salsa N" — CMU's own site, Bruce Hahne's (cgspeed) index, and the
 * una-dinosauria/cmu-mocap mirror's own index text all independently list every one of these 30
 * trials (60_01-15, 61_01-15) with the identical generic description "salsa dance," no
 * per-trial figure/pattern name in any of their metadata. Three exceptions below carry an
 * appended figure name: not sourced from CMU's metadata (which has none), but identified by
 * separately analyzing the baked motion itself against real salsa figure vocabulary and a
 * reference annotated dataset (CoMPAS3D) — best-effort pattern matches, not certainties. See
 * docs/work/dance-naming.md for the full methodology and honest confidence caveats. */
const FIGURE_LABELS: Record<string, string> = {
  "06": "Salsa 6 — Hammerlock",
  "09": "Salsa 9 — Enchufla",
  "13": "Salsa 13 — Hammerlock",
};
export const AVAILABLE_TRIAL_PAIRS: { id: string; label: string }[] = Array.from({ length: 15 }, (_, i) => {
  const id = String(i + 1).padStart(2, "0");
  return { id, label: FIGURE_LABELS[id] ?? `Salsa ${i + 1}` };
});

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
