/*
 * js/engine/format.js: readers for the on-chain byte layouts (SPEC-ENGINE.md sections 4.6 and 5). Big-endian, DataView.
 *
 *   loadPocket(bytes)   -> Pocket   { pdbId, n, center [A, absolute], half [A], atoms Int16Array(3n) centi-A relative
 *                                     to the centre, types Uint8Array(n), hash, halfCenti, centerMilli, grid [nx,ny,nz],
 *                                     offsets Uint16Array(ncells+1), version, bytes }
 *   loadTopology(bytes) -> Topology { n, types Uint8Array(n), bonds [[i, j, idealCenti]], pairs12 (= bonds), pairs13,
 *                                     nrot, hash, near BigUint64Array(n), nearMat Uint8Array(n*n), farPairs Uint8Array
 *                                     (i, j pairs at graph distance >= 3), bondCount, pairCount, version, bytes }
 * Both keep the raw bytes so a caller can hand them to a worker or hash them again.
 */
import { keccak256 } from './keccak.js';

export const POCKET_VERSION = 1;
export const TOPOLOGY_VERSION = 1;
export const MAX_POCKET_ATOMS = 2000;
export const MAX_LIGAND_ATOMS = 64;

function view(bytes, what) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${what}: expected a Uint8Array`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function loadPocket(bytes) {
  const dv = view(bytes, 'pocket');
  if (bytes.length < 28) throw new Error('pocket too short');
  const pdbId = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const n = dv.getUint16(4, false);
  const hx = dv.getUint16(6, false), hy = dv.getUint16(8, false), hz = dv.getUint16(10, false);
  const cx = dv.getInt32(12, false), cy = dv.getInt32(16, false), cz = dv.getInt32(20, false);
  const nx = bytes[24], ny = bytes[25], nz = bytes[26], version = bytes[27];
  if (version !== POCKET_VERSION) throw new Error(`unsupported pocket version ${version}`);
  if (n > MAX_POCKET_ATOMS) throw new Error('too many pocket atoms');
  const ncells = nx * ny * nz;
  const expected = 28 + 7 * n + 2 * (ncells + 1);
  if (bytes.length !== expected) throw new Error(`pocket length ${bytes.length}, expected ${expected}`);
  const atoms = new Int16Array(3 * n);
  const types = new Uint8Array(n);
  let off = 28;
  for (let i = 0; i < n; i++) {
    atoms[3 * i] = dv.getInt16(off, false);
    atoms[3 * i + 1] = dv.getInt16(off + 2, false);
    atoms[3 * i + 2] = dv.getInt16(off + 4, false);
    types[i] = bytes[off + 6];
    if (types[i] > 15) throw new Error(`pocket atom ${i}: bad type ${types[i]}`);
    off += 7;
  }
  const offsets = new Uint16Array(ncells + 1);
  for (let c = 0; c <= ncells; c++) { offsets[c] = dv.getUint16(off, false); off += 2; }
  if (offsets[ncells] !== n) throw new Error('pocket offsets do not end at n');
  for (let c = 0; c < ncells; c++) if (offsets[c] > offsets[c + 1]) throw new Error('pocket offsets not monotone');
  return {
    pdbId, n,
    center: [cx / 1000, cy / 1000, cz / 1000],
    centerMilli: [cx, cy, cz],
    half: [hx / 100, hy / 100, hz / 100],
    halfCenti: [hx, hy, hz],
    grid: [nx, ny, nz],
    atoms, types, offsets,
    hash: keccak256(bytes),
    version,
    bytes,
  };
}

export function loadTopology(bytes) {
  const dv = view(bytes, 'topology');
  if (bytes.length < 8) throw new Error('topology too short');
  const version = bytes[0];
  if (version !== TOPOLOGY_VERSION) throw new Error(`unsupported topology version ${version}`);
  const n = bytes[1], b = bytes[2], nrot = bytes[3];
  const p = dv.getUint16(4, false);
  const expected = 8 + 9 * n + 4 * b + 4 * p;
  if (bytes.length !== expected) throw new Error(`topology length ${bytes.length}, expected ${expected}`);
  if (n < 1 || n > MAX_LIGAND_ATOMS) throw new Error('topology atom count out of range');
  let off = 8;
  const types = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    types[i] = bytes[off + i];
    if (types[i] > 15) throw new Error(`topology atom ${i}: bad type ${types[i]}`);
  }
  off += n;
  const bonds = [];
  for (let k = 0; k < b; k++) {
    const i = bytes[off], j = bytes[off + 1];
    if (i >= j || j >= n) throw new Error('topology: bad bond row');
    bonds.push([i, j, dv.getUint16(off + 2, false)]);
    off += 4;
  }
  const pairs13 = [];
  for (let k = 0; k < p; k++) {
    const i = bytes[off], j = bytes[off + 1];
    if (i >= j || j >= n) throw new Error('topology: bad 1-3 row');
    pairs13.push([i, j, dv.getUint16(off + 2, false)]);
    off += 4;
  }
  const near = new BigUint64Array(n);
  const nearMat = new Uint8Array(n * n);
  const far = [];
  for (let i = 0; i < n; i++) {
    const hi = dv.getUint32(off, false), lo = dv.getUint32(off + 4, false);
    near[i] = (BigInt(hi) << 32n) | BigInt(lo);
    off += 8;
    for (let j = 0; j < n; j++) {
      const bit = j < 32 ? (lo >>> j) & 1 : (hi >>> (j - 32)) & 1;
      nearMat[i * n + j] = bit;
    }
  }
  for (let i = 0; i < n; i++) if (!nearMat[i * n + i]) throw new Error(`topology: near mask of atom ${i} lacks its own bit`);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (!nearMat[i * n + j]) far.push(i, j);
  return {
    n, types, bonds, pairs12: bonds, pairs13, nrot,
    hash: keccak256(bytes),
    near, nearMat, farPairs: Uint8Array.from(far),
    bondCount: b, pairCount: p, version, bytes,
  };
}

/** Int16Array(3n) -> pose bytes (6 bytes per atom, big-endian), the canonical `bytes pose` of submitRun. */
export function encodePose(poseCenti) {
  const out = new Uint8Array(poseCenti.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < poseCenti.length; i++) dv.setInt16(2 * i, poseCenti[i], false);
  return out;
}

/** pose bytes -> Int16Array(3n) */
export function decodePose(bytes) {
  if (bytes.length % 6) throw new Error('pose bytes length must be a multiple of 6');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(2 * i, false);
  return out;
}
