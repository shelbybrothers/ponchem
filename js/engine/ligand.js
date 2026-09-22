/*
 * js/engine/ligand.js: the flexible ligand model of the float search.
 *
 * The ligand is the ideal conformer (SDF coordinates) with rigid fragments joined by rotatable bonds. A pose is
 * state = Float64Array(7 + nrot): [tx, ty, tz, qw, qx, qy, qz, theta_0 .. theta_nrot-1]. Torsion k rotates the
 * side of rotatable bond k that does not contain the root atom about the bond axis (so every moving set is a
 * subtree: moving sets are nested or disjoint, and the derivative of the final coordinates with respect to
 * theta_k is the rotation of the final moving set about the final axis). Then the rigid placement
 * X = R(q) (Y - c0) + t with c0 the ideal centroid (a constant), t in angstrom relative to the box centre.
 * Any order of torsion application keeps every bond and 1-3 distance exact, which is what the geometry proof checks.
 *
 *   rotatableBonds(n, bonds, elements) -> bond indices (SPEC-ENGINE.md 4.3 rule, same as the Python reference)
 *   makeLigandModel(sdf, topology, { flexible = true })
 *                                      -> model { n, nrot, rotors, X0, c0, build(state, out), project(X, state, gX, out),
 *                                                step(state, delta, out), randomState(rng, half, out), graphDist }
 *   flexible false (the method's rigid ligand) keeps the ideal conformer: no rotors, dim 6, state length 7; the
 *   topology's Nrot still divides the score, that is the chain's number and not a search choice.
 */
import { fsincos } from './fmath.js';

const TWO_PI = 6.283185307179586;

function adjacency(n, bonds) {
  const adj = Array.from({ length: n }, () => []);
  for (const [i, j] of bonds) { adj[i].push(j); adj[j].push(i); }
  return adj;
}

/** BFS graph distances, Uint8Array(n*n), 255 = disconnected. */
export function graphDistances(n, bonds) {
  const adj = adjacency(n, bonds);
  const dist = new Uint8Array(n * n).fill(255);
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    dist[s * n + s] = 0;
    let head = 0, tail = 0;
    queue[tail++] = s;
    while (head < tail) {
      const u = queue[head++];
      for (const v of adj[u]) {
        if (dist[s * n + v] === 255) { dist[s * n + v] = dist[s * n + u] + 1; queue[tail++] = v; }
      }
    }
  }
  return dist;
}

/** Atoms reachable from `start` when bond `skip` is removed. */
function sideWithout(n, bonds, skip, start) {
  const adj = Array.from({ length: n }, () => []);
  bonds.forEach(([i, j], k) => { if (k !== skip) { adj[i].push(j); adj[j].push(i); } });
  const seen = new Uint8Array(n);
  const stack = [start];
  seen[start] = 1;
  const out = [];
  while (stack.length) {
    const u = stack.pop();
    out.push(u);
    for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; stack.push(v); }
  }
  return out;
}

/**
 * The Nrot rule: order 1, not a ring bond, both endpoints with heavy degree >= 2, neither endpoint in a triple
 * bond, not an amide C(=O)-N bond. Returns the indices into `bonds` ([i, j, order]) that are rotatable.
 */
export function rotatableBonds(n, bonds, elements) {
  const adj = adjacency(n, bonds);
  const triple = new Uint8Array(n);
  const dblO = new Uint8Array(n);
  for (const [i, j, o] of bonds) {
    if (o === 3) { triple[i] = 1; triple[j] = 1; }
    if (o === 2) {
      if (elements[i] === 'C' && elements[j] === 'O') dblO[i] = 1;
      if (elements[j] === 'C' && elements[i] === 'O') dblO[j] = 1;
    }
  }
  const out = [];
  bonds.forEach(([i, j, o], k) => {
    if (o !== 1) return;
    if (adj[i].length < 2 || adj[j].length < 2) return;
    if (triple[i] || triple[j]) return;
    const amide = (elements[i] === 'C' && dblO[i] && elements[j] === 'N') || (elements[j] === 'C' && dblO[j] && elements[i] === 'N');
    if (amide) return;
    const side = sideWithout(n, bonds, k, i);
    if (side.includes(j)) return;   // ring bond: endpoints stay connected without it
    out.push(k);
  });
  return out;
}

function quatMul(a, b, out) {
  const aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  out[0] = aw * bw - ax * bx - ay * by - az * bz;
  out[1] = aw * bx + ax * bw + ay * bz - az * by;
  out[2] = aw * by - ax * bz + ay * bw + az * bx;
  out[3] = aw * bz + ax * by - ay * bx + az * bw;
  return out;
}

const sc = new Float64Array(2);

/** quaternion [w,x,y,z] of the rotation vector (axis * angle) */
export function quatFromRotvec(vx, vy, vz, out) {
  const angle = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (angle < 1e-12) { out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; return out; }
  fsincos(angle * 0.5, sc);
  const k = sc[0] / angle;
  out[0] = sc[1]; out[1] = vx * k; out[2] = vy * k; out[3] = vz * k;
  return out;
}

function quatNormalise(q) {
  const inv = 1 / Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv;
}

/** 3x3 rotation matrix (row major) of a unit quaternion */
function quatToMatrix(q, m) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w);
  m[3] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - x * w);
  m[6] = 2 * (x * z - y * w); m[7] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
  return m;
}

export function makeLigandModel(sdf, topology, { flexible = true } = {}) {
  const n = sdf.atoms.length;
  if (n !== topology.n) throw new Error(`ligand has ${n} heavy atoms, topology has ${topology.n}`);
  const elements = sdf.atoms.map((a) => a.el.toUpperCase());
  const bonds = sdf.bonds;
  const topoKeys = new Set(topology.bonds.map(([i, j]) => i * 256 + j));
  for (const [i, j] of bonds) if (!topoKeys.has(i * 256 + j)) throw new Error(`SDF bond ${i}-${j} is not in the topology`);
  if (bonds.length !== topology.bonds.length) throw new Error('SDF and topology bond counts differ');
  const rotIdx = flexible ? rotatableBonds(n, bonds, elements) : [];
  // choose the root that minimises the total moving-set size
  const sides = rotIdx.map((k) => {
    const [i, j] = bonds[k];
    const si = sideWithout(n, bonds, k, i);
    const sj = sideWithout(n, bonds, k, j);
    return { i, j, si, sj };
  });
  let root = 0, bestTotal = Infinity;
  for (let r = 0; r < n; r++) {
    let total = 0;
    for (const s of sides) total += s.si.includes(r) ? s.sj.length : s.si.length;
    if (total < bestTotal) { bestTotal = total; root = r; }
  }
  const rotors = sides.map((s) => {
    const rootOnI = s.si.includes(root);
    const moving = Int32Array.from((rootOnI ? s.sj : s.si).sort((a, b) => a - b));
    return { a: rootOnI ? s.i : s.j, b: rootOnI ? s.j : s.i, moving };
  });
  const nrot = rotors.length;
  const X0 = new Float64Array(3 * n);
  sdf.atoms.forEach((a, i) => { X0[3 * i] = a.x; X0[3 * i + 1] = a.y; X0[3 * i + 2] = a.z; });
  const c0 = [0, 0, 0];
  for (let i = 0; i < n; i++) { c0[0] += X0[3 * i]; c0[1] += X0[3 * i + 1]; c0[2] += X0[3 * i + 2]; }
  c0[0] /= n; c0[1] /= n; c0[2] /= n;
  let extent = 0;
  for (let i = 0; i < n; i++) {
    const dx = X0[3 * i] - c0[0], dy = X0[3 * i + 1] - c0[1], dz = X0[3 * i + 2] - c0[2];
    extent = Math.max(extent, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const Y = new Float64Array(3 * n);
  const m = new Float64Array(9);
  const q2 = new Float64Array(4);
  const tmpq = new Float64Array(4);

  const model = {
    n, nrot, rotors, root, X0, c0, extent, elements, bonds, flexible: !!flexible,
    rotatableBondIndices: rotIdx,
    rotatableBondPairs: rotIdx.map((k) => [bonds[k][0], bonds[k][1]]),
    graphDist: graphDistances(n, bonds),
    dim: 6 + nrot,
    stateLength: 7 + nrot,

    /** Coordinates (angstrom, box frame) of a state, written into out (Float64Array(3n)). */
    build(state, out) {
      Y.set(X0);
      for (let k = 0; k < nrot; k++) {
        const th = state[7 + k];
        if (th === 0) continue;
        const { a, b, moving } = rotors[k];
        let ux = Y[3 * b] - Y[3 * a], uy = Y[3 * b + 1] - Y[3 * a + 1], uz = Y[3 * b + 2] - Y[3 * a + 2];
        const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (len < 1e-9) continue;
        ux /= len; uy /= len; uz /= len;
        fsincos(th, sc);
        const s = sc[0], c = sc[1], oc = 1 - c;
        const ax = Y[3 * a], ay = Y[3 * a + 1], az = Y[3 * a + 2];
        for (let q = 0; q < moving.length; q++) {
          const i = moving[q];
          const px = Y[3 * i] - ax, py = Y[3 * i + 1] - ay, pz = Y[3 * i + 2] - az;
          const dot = ux * px + uy * py + uz * pz;
          // Rodrigues: p c + (u x p) s + u (u . p)(1 - c)
          Y[3 * i] = ax + px * c + (uy * pz - uz * py) * s + ux * dot * oc;
          Y[3 * i + 1] = ay + py * c + (uz * px - ux * pz) * s + uy * dot * oc;
          Y[3 * i + 2] = az + pz * c + (ux * py - uy * px) * s + uz * dot * oc;
        }
      }
      quatToMatrix(state.subarray(3, 7), m);
      const tx = state[0], ty = state[1], tz = state[2];
      for (let i = 0; i < n; i++) {
        const px = Y[3 * i] - c0[0], py = Y[3 * i + 1] - c0[1], pz = Y[3 * i + 2] - c0[2];
        out[3 * i] = m[0] * px + m[1] * py + m[2] * pz + tx;
        out[3 * i + 1] = m[3] * px + m[4] * py + m[5] * pz + ty;
        out[3 * i + 2] = m[6] * px + m[7] * py + m[8] * pz + tz;
      }
      return out;
    },

    /** Project a Cartesian gradient gX (3n) onto the state tangent space: out (dim) = [dt, domega, dtheta...]. */
    project(X, state, gX, out) {
      let fx = 0, fy = 0, fz = 0, mx = 0, my = 0, mz = 0;
      const tx = state[0], ty = state[1], tz = state[2];
      for (let i = 0; i < n; i++) {
        const gx = gX[3 * i], gy = gX[3 * i + 1], gz = gX[3 * i + 2];
        const rx = X[3 * i] - tx, ry = X[3 * i + 1] - ty, rz = X[3 * i + 2] - tz;
        fx += gx; fy += gy; fz += gz;
        mx += ry * gz - rz * gy; my += rz * gx - rx * gz; mz += rx * gy - ry * gx;
      }
      out[0] = fx; out[1] = fy; out[2] = fz; out[3] = mx; out[4] = my; out[5] = mz;
      for (let k = 0; k < nrot; k++) {
        const { a, b, moving } = rotors[k];
        const ax = X[3 * a], ay = X[3 * a + 1], az = X[3 * a + 2];
        let ux = X[3 * b] - ax, uy = X[3 * b + 1] - ay, uz = X[3 * b + 2] - az;
        const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (len < 1e-9) { out[6 + k] = 0; continue; }
        ux /= len; uy /= len; uz /= len;
        let sx = 0, sy = 0, sz = 0;
        for (let q = 0; q < moving.length; q++) {
          const i = moving[q];
          const rx = X[3 * i] - ax, ry = X[3 * i + 1] - ay, rz = X[3 * i + 2] - az;
          const gx = gX[3 * i], gy = gX[3 * i + 1], gz = gX[3 * i + 2];
          sx += ry * gz - rz * gy; sy += rz * gx - rx * gz; sz += rx * gy - ry * gx;
        }
        out[6 + k] = ux * sx + uy * sy + uz * sz;
      }
      return out;
    },

    /** out = state moved by delta (dim): translation added, rotation vector applied in the world frame, torsions added. */
    step(state, delta, out) {
      out[0] = state[0] + delta[0]; out[1] = state[1] + delta[1]; out[2] = state[2] + delta[2];
      quatFromRotvec(delta[3], delta[4], delta[5], tmpq);
      quatMul(tmpq, state.subarray(3, 7), q2);
      quatNormalise(q2);
      out[3] = q2[0]; out[4] = q2[1]; out[5] = q2[2]; out[6] = q2[3];
      for (let k = 0; k < nrot; k++) {
        let th = state[7 + k] + delta[6 + k];
        if (th > 3.141592653589793) th -= TWO_PI; else if (th < -3.141592653589793) th += TWO_PI;
        out[7 + k] = th;
      }
      return out;
    },

    /** Random start: centre uniform inside a fraction of the box, uniform orientation, uniform torsions. */
    randomState(rng, half, out, spread = 0.35) {
      out[0] = half[0] * spread * rng.sym();
      out[1] = half[1] * spread * rng.sym();
      out[2] = half[2] * spread * rng.sym();
      rng.quaternion(tmpq);
      out[3] = tmpq[0]; out[4] = tmpq[1]; out[5] = tmpq[2]; out[6] = tmpq[3];
      for (let k = 0; k < nrot; k++) out[7 + k] = 3.141592653589793 * rng.sym();
      return out;
    },

    /** [tx,ty,tz, 1,0,0,0, 0...]: the ideal conformer centred on the box centre */
    identityState(out) {
      out.fill(0);
      out[3] = 1;
      return out;
    },
  };
  return model;
}
