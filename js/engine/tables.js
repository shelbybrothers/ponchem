/*
 * js/engine/tables.js: the frozen lookup tables (SPEC-ENGINE.md 3.4), loaded from data/tables/tables.bin and
 * verified by keccak256 before use. Never recomputed.
 *
 *   parseTables(bytes, { verify = true }) -> { g1: Int32Array(1001), g2: Int32Array(1001), sq: Uint16Array(2501), hash, bytes }
 *   setTables(tables) / getTables()          the module-wide tables the integer scorer uses (throws when unset)
 *   ensureTables({ bytes?, url? })           async: loads once (fetch in the browser, fs in Node) and sets them
 *   tablesFromJson(desc)                     from data/tables/tables.json (encodes the arrays and verifies the hash)
 */
import { keccak256 } from './keccak.js';

export const TABLES_KECCAK = '0x0ecc4dd8e9494c3eb87f910dec144d463f5dc8e285fbbbbeaded5061d0365e93';
export const GAUSS1_KECCAK = '0x2d78d458de239d3fd5208a3c5d79bf69414dbd8fb51984a6ed436bb7a2b8e44d';
export const GAUSS2_KECCAK = '0xbdf14b4cc7cef153bd7471694f84bb518260944b351c42da0abd743b99532e54';
export const SQRT_KECCAK = '0xa74503d512f76f4912e777c490ea0dcbc94a1f40ac68928470d63cdca39c10d0';
export const TABLES_BYTES = 13010;
export const GAUSS_LEN = 1001;
export const SQRT_LEN = 2501;
export const D_MIN = -440;
export const D_MAX = 560;
export const TABLES_URL = new URL('../../data/tables/tables.bin', import.meta.url);

// spot values from SPEC-ENGINE.md 3.4 and data/vectors/tables.json, indexed by d + 440 or by k
const SPOT_G1 = [[0, 0], [240, 0], [340, 18316], [390, 367879], [439, 999600], [440, 1000000], [460, 852144], [630, 1], [640, 0], [1000, 0]];
const SPOT_G2 = [[0, 1], [240, 1930], [440, 105399], [740, 1000000], [860, 697676], [1000, 184520]];
const SPOT_SQ = [[0, 0], [1, 16], [63, 126], [64, 128], [624, 399], [625, 400], [2500, 800]];

let current = null;

export function parseTables(bytes, { verify = true } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error('tables: expected a Uint8Array');
  if (bytes.length !== TABLES_BYTES) throw new Error(`tables.bin has ${bytes.length} bytes, expected ${TABLES_BYTES}`);
  const hash = keccak256(bytes);
  if (verify && hash !== TABLES_KECCAK) throw new Error(`tables.bin keccak256 ${hash} does not match ${TABLES_KECCAK}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const g1 = new Int32Array(GAUSS_LEN);
  const g2 = new Int32Array(GAUSS_LEN);
  const sq = new Uint16Array(SQRT_LEN);
  for (let i = 0; i < GAUSS_LEN; i++) g1[i] = dv.getUint32(4 * i, false);
  for (let i = 0; i < GAUSS_LEN; i++) g2[i] = dv.getUint32(4004 + 4 * i, false);
  for (let k = 0; k < SQRT_LEN; k++) sq[k] = dv.getUint16(8008 + 2 * k, false);
  for (const [i, v] of SPOT_G1) if (g1[i] !== v) throw new Error(`gauss1[${i}] = ${g1[i]}, expected ${v}`);
  for (const [i, v] of SPOT_G2) if (g2[i] !== v) throw new Error(`gauss2[${i}] = ${g2[i]}, expected ${v}`);
  for (const [k, v] of SPOT_SQ) if (sq[k] !== v) throw new Error(`sqrt[${k}] = ${sq[k]}, expected ${v}`);
  return { g1, g2, sq, hash, bytes };
}

export function tablesFromJson(desc) {
  const out = new Uint8Array(TABLES_BYTES);
  const dv = new DataView(out.buffer);
  const a1 = desc.gauss1_values, a2 = desc.gauss2_values, s = desc.sqrt_values;
  if (!a1 || !a2 || !s || a1.length !== GAUSS_LEN || a2.length !== GAUSS_LEN || s.length !== SQRT_LEN) throw new Error('tables.json: bad arrays');
  for (let i = 0; i < GAUSS_LEN; i++) dv.setUint32(4 * i, a1[i], false);
  for (let i = 0; i < GAUSS_LEN; i++) dv.setUint32(4004 + 4 * i, a2[i], false);
  for (let k = 0; k < SQRT_LEN; k++) dv.setUint16(8008 + 2 * k, s[k], false);
  return parseTables(out);
}

export function setTables(t) {
  if (!t || !t.g1 || !t.g2 || !t.sq) throw new Error('setTables: not a tables object');
  current = t;
  return t;
}

export function getTables() {
  if (!current) throw new Error('tables not loaded: await ensureTables() first');
  return current;
}

export function tablesLoaded() { return current !== null; }

let loading = null;

/** Load the tables once. bytes: a Uint8Array of tables.bin; url: where to fetch it (default: data/tables/tables.bin next to the site). */
export function ensureTables({ bytes = null, url = TABLES_URL } = {}) {
  if (current) return Promise.resolve(current);
  if (bytes) return Promise.resolve(setTables(parseTables(bytes)));
  if (!loading) {
    loading = (async () => {
      const u = url instanceof URL ? url : new URL(String(url), typeof location !== 'undefined' ? location.href : 'file:///');
      let data;
      if (u.protocol === 'file:') {
        const fs = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        data = new Uint8Array(await fs.readFile(fileURLToPath(u)));
      } else {
        const res = await fetch(u.href);
        if (!res.ok) throw new Error(`tables: HTTP ${res.status} for ${u.href}`);
        data = new Uint8Array(await res.arrayBuffer());
      }
      return setTables(parseTables(data));
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}
