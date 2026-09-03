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

/**
 * A chain segment endpoint: either a real rig joint (`real`, resolved every call via
 * `jointWorldPosition` — the rig's own topology never changes, so which joint this is stays
 * fixed once decided) or a point with no rig joint of its own (`extrapolated` — e.g.
 * pose/head.ts's crown points, which continue past the real head joint in the same direction
 * the neck->head bone is already pointing). An extrapolated ref stays correct across frames
 * without needing to be rebuilt: `through`/`from` are re-resolved fresh each call, so as the
 * dancer moves and the neck->head direction changes, the extrapolated point moves and rotates
 * with it, rigidly, the same way a real joint further out on a bone would.
 */
export type JointRef = { kind: "real"; index: number } | { kind: "extrapolated"; from: number; through: number; distance: number };

export function realJoint(index: number): JointRef {
  return { kind: "real", index };
}

function normalizeVec(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Resolves a `JointRef` to a world position for a given dancer + frame — the one thing every
 * caller that used to call `jointWorldPosition` directly with a raw joint index now calls
 * instead, so chain code doesn't need to know which kind of ref it's holding. */
export function resolveJointPosition(
  cache: PoseCache,
  dancerIndex: number,
  frame: number,
  ref: JointRef
): [number, number, number] {
  if (ref.kind === "real") return jointWorldPosition(cache, dancerIndex, frame, ref.index);
  const from = jointWorldPosition(cache, dancerIndex, frame, ref.from);
  const through = jointWorldPosition(cache, dancerIndex, frame, ref.through);
  const dir = normalizeVec([through[0] - from[0], through[1] - from[1], through[2] - from[2]]);
  return [through[0] + dir[0] * ref.distance, through[1] + dir[1] * ref.distance, through[2] + dir[2] * ref.distance];
}
