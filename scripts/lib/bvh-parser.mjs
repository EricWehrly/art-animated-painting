// Minimal BVH parser + forward kinematics. No deps — this runs once, offline,
// at bake time (see docs/work/pose-pipeline.md). Not part of the shipped bundle.

const DEG2RAD = Math.PI / 180;

function tokenize(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Parses BVH HIERARCHY + MOTION into a flat joint list (DFS order) and raw
 * per-frame channel values.
 *
 * @returns {{
 *   joints: Array<{ name: string, parentIndex: number, offset: [number,number,number], channels: string[], isEndSite: boolean }>,
 *   frameTime: number,
 *   frameCount: number,
 *   frames: Float64Array[]   // frames[f] = channel values for frame f, in joint-DFS / channel-declaration order
 * }}
 */
export function parseBVH(text) {
  const tokens = tokenize(text);
  let i = 0;
  const next = () => tokens[i++];
  const expect = (tok) => {
    const t = next();
    if (t !== tok) throw new Error(`BVH parse error: expected "${tok}", got "${t}" at token ${i}`);
  };

  const joints = [];

  function parseJoint(parentIndex, isRoot) {
    const kind = next(); // ROOT | JOINT | End
    let name;
    if (kind === "End") {
      expect("Site");
      name = `${joints[parentIndex].name}_End`;
    } else {
      name = next();
    }
    const jointIndex = joints.length;
    const joint = { name, parentIndex, offset: [0, 0, 0], channels: [], isEndSite: kind === "End" };
    joints.push(joint);

    expect("{");
    let tok = next();
    while (tok !== "}") {
      if (tok === "OFFSET") {
        joint.offset = [parseFloat(next()), parseFloat(next()), parseFloat(next())];
      } else if (tok === "CHANNELS") {
        const n = parseInt(next(), 10);
        for (let c = 0; c < n; c++) joint.channels.push(next());
      } else if (tok === "JOINT" || tok === "End") {
        i -= 1;
        parseJoint(jointIndex, false);
      } else {
        throw new Error(`BVH parse error: unexpected token "${tok}" in joint "${name}"`);
      }
      tok = next();
    }
    return jointIndex;
  }

  expect("HIERARCHY");
  parseJoint(-1, true);

  expect("MOTION");
  expect("Frames:");
  const frameCount = parseInt(next(), 10);
  expect("Frame");
  expect("Time:");
  const frameTime = parseFloat(next());

  const channelsPerFrame = joints.reduce((sum, j) => sum + j.channels.length, 0);
  const frames = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const row = new Float64Array(channelsPerFrame);
    for (let c = 0; c < channelsPerFrame; c++) row[c] = parseFloat(next());
    frames[f] = row;
  }

  return { joints, frameTime, frameCount, frames };
}

// --- minimal 3x3 rotation + 4x4 affine helpers (row-major, right-handed, degrees in) ---

function axisRotation(axis, deg) {
  const r = deg * DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  if (axis === "X") return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === "Y") return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1]; // Z
}

function mat3mul(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3 + 0] * b[0 * 3 + c] + a[r * 3 + 1] * b[1 * 3 + c] + a[r * 3 + 2] * b[2 * 3 + c];
    }
  }
  return out;
}

function mat3vec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Computes world-space joint positions for every frame.
 *
 * World transform of a joint = ParentWorldRotation * (offset + positionChannels), applied
 * on top of the parent's world position, with rotation channels composed in the order they
 * appear in the BVH (R = R_c1 * R_c2 * R_c3), then carried forward to children.
 *
 * @returns Float32Array of length frameCount * jointCount * 3, laid out [frame][joint][xyz]
 */
export function computeWorldPositions(parsed) {
  const { joints, frames, frameCount } = parsed;
  const jointCount = joints.length;
  const out = new Float32Array(frameCount * jointCount * 3);

  // Precompute channel offsets per joint into the flat per-frame row.
  let cursor = 0;
  const channelStart = joints.map((j) => {
    const start = cursor;
    cursor += j.channels.length;
    return start;
  });

  for (let f = 0; f < frameCount; f++) {
    const row = frames[f];
    const worldPos = new Array(jointCount);
    const worldRot = new Array(jointCount);

    for (let j = 0; j < jointCount; j++) {
      const joint = joints[j];
      const start = channelStart[j];

      let localPos = [...joint.offset];
      let localRot = IDENTITY3;

      for (let c = 0; c < joint.channels.length; c++) {
        const chan = joint.channels[c];
        const val = row[start + c];
        if (chan === "Xposition") localPos[0] = joint.offset[0] + val;
        else if (chan === "Yposition") localPos[1] = joint.offset[1] + val;
        else if (chan === "Zposition") localPos[2] = joint.offset[2] + val;
        else if (chan === "Xrotation") localRot = mat3mul(localRot, axisRotation("X", val));
        else if (chan === "Yrotation") localRot = mat3mul(localRot, axisRotation("Y", val));
        else if (chan === "Zrotation") localRot = mat3mul(localRot, axisRotation("Z", val));
      }

      if (joint.parentIndex === -1) {
        worldPos[j] = localPos;
        worldRot[j] = localRot;
      } else {
        const pRot = worldRot[joint.parentIndex];
        const pPos = worldPos[joint.parentIndex];
        const rotatedOffset = mat3vec(pRot, localPos);
        worldPos[j] = [pPos[0] + rotatedOffset[0], pPos[1] + rotatedOffset[1], pPos[2] + rotatedOffset[2]];
        worldRot[j] = mat3mul(pRot, localRot);
      }

      const base = (f * jointCount + j) * 3;
      out[base + 0] = worldPos[j][0];
      out[base + 1] = worldPos[j][1];
      out[base + 2] = worldPos[j][2];
    }
  }

  return out;
}
