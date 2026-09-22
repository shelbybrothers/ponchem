/*
 * js/engine/score.js: the bit-exact integer scorer and geometry proof (SPEC-ENGINE.md sections 1, 3 and 6).
 *
 *   scoreInt(pocket, topology, poseCenti: Int16Array, { grid = true } = {})
 *       -> { ok, reason, code, scoreMilli, terms: { g1, g2, rep, hyd, hb, pairs, ePico }, detail }
 *       reason is 'OK' | 'ATOM_COUNT' | 'BOX' | 'BOND' | 'PAIR13' | 'CLASH' (first failing check decides);
 *       scoreMilli and terms are null when ok is false. Grid scan and full scan give identical sums.
 *   checkGeometry(topology, poseCenti, halfCenti) -> { code, reason, detail }
 *   pairTerms(ta, tb, r2) -> { r, d, g1, g2, rep, hyd, hb, ePico } | null (skipped, r2 > 640000)
 *   isqrt(r2) exact floor square root through the frozen table
 *
 * Numbers carry everything below 2^53 (coordinates, r2, d, table values, the five sums); BigInt carries the
 * five products, E_pico and the final division, which truncates toward zero like Solidity.
 * The tables must be loaded first (await ensureTables() from ./tables.js).
 */
import { getTables } from './tables.js';

export const RADIUS_CENTI = [190, 190, 180, 180, 180, 180, 170, 170, 170, 200, 210, 150, 180, 200, 220, 120];
export const HYD_MASK = 0x7801;
export const DON_MASK = 0x81a8;   // bits 3, 5, 7, 8, 15 (N_D, N_DA, O_D, O_DA, Met_D); SPEC-ENGINE.md prints 0x8128, the reference and terms.json use 0x81A8
export const ACC_MASK = 0x0170;
export const TYPE_NAMES = ['C_H', 'C_P', 'N_P', 'N_D', 'N_A', 'N_DA', 'O_A', 'O_D', 'O_DA', 'S_P', 'P_P', 'F_H', 'Cl_H', 'Br_H', 'I_H', 'Met_D'];
export const CUTOFF_R2 = 640000;
export const CLASH_FLOOR_R2 = 48400;
export const TERM_ONE = 1000000;
export const W_G1 = -35600n;
export const W_G2 = -5160n;
export const W_REP = 840000n;
export const W_HYD = -35100n;
export const W_HB = -587000n;
export const NROT_NUM = 585;
export const NROT_DEN = 10000;
export const CELL_CENTI = 800;
export const REACH_CENTI = 800;
export const CODES = ['OK', 'ATOM_COUNT', 'BOX', 'BOND', 'PAIR13', 'CLASH'];
export const OK = 0, ERR_ATOM_COUNT = 1, ERR_BOX = 2, ERR_BOND = 3, ERR_PAIR13 = 4, ERR_CLASH = 5;

// 16 x 16 pair class: 0 none, 1 hydrophobic pair, 2 hydrogen bond pair (the two never overlap)
export const PAIR_CLASS = new Uint8Array(256);
for (let a = 0; a < 16; a++) {
  for (let b = 0; b < 16; b++) {
    const hyd = ((HYD_MASK >> a) & 1) && ((HYD_MASK >> b) & 1);
    const hb = (((DON_MASK >> a) & 1) && ((ACC_MASK >> b) & 1)) || (((ACC_MASK >> a) & 1) && ((DON_MASK >> b) & 1));
    PAIR_CLASS[a * 16 + b] = hyd ? 1 : hb ? 2 : 0;
  }
}

export function isqrt(r2) {
  const sq = getTables().sq;
  let r = sq[r2 >> 8];
  while ((r + 1) * (r + 1) <= r2) r++;
  return r;
}

export function hydrophobicMicro(d) {
  if (d <= 50) return TERM_ONE;
  if (d >= 150) return 0;
  return (150 - d) * 10000;
}

export function hbondMicro(d) {
  if (d <= -70) return TERM_ONE;
  if (d >= 0) return 0;
  return Math.floor(((-d) * 100000) / 7);
}

export function repulsionMicro(d) {
  return d < 0 ? d * d * 100 : 0;
}

export function tolerance(ideal) {
  return 6 + Math.floor((ideal * 2) / 100);
}

/** One pair's intermediates (for the terms vector). null when the pair is outside the cutoff. */
export function pairTerms(ta, tb, r2) {
  if (r2 > CUTOFF_R2) return null;
  const t = getTables();
  const r = isqrt(r2);
  const d = r - (RADIUS_CENTI[ta] + RADIUS_CENTI[tb]);
  const g1 = t.g1[d + 440];
  const g2 = t.g2[d + 440];
  const rep = repulsionMicro(d);
  const cls = PAIR_CLASS[ta * 16 + tb];
  const hyd = cls === 1 ? hydrophobicMicro(d) : 0;
  const hb = cls === 2 ? hbondMicro(d) : 0;
  const ePico = W_G1 * BigInt(g1) + W_G2 * BigInt(g2) + W_REP * BigInt(rep) + W_HYD * BigInt(hyd) + W_HB * BigInt(hb);
  return { r, d, g1, g2, rep, hyd, hb, ePico };
}

function dist2(P, i, j) {
  const dx = P[3 * i] - P[3 * j], dy = P[3 * i + 1] - P[3 * j + 1], dz = P[3 * i + 2] - P[3 * j + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Geometry proof in the contract's order. poseCenti: Int16Array(3n). */
export function checkGeometry(topology, poseCenti, halfCenti) {
  const n = topology.n;
  if (!poseCenti || poseCenti.length !== 3 * n) {
    return { code: ERR_ATOM_COUNT, reason: 'ATOM_COUNT', detail: { expected: n, got: poseCenti ? poseCenti.length / 3 : 0 } };
  }
  const P = poseCenti;
  const [hx, hy, hz] = halfCenti;
  for (let i = 0; i < n; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    if (x < -hx || x > hx || y < -hy || y > hy || z < -hz || z > hz) return { code: ERR_BOX, reason: 'BOX', detail: { atom: i } };
  }
  const bonds = topology.bonds;
  for (let k = 0; k < bonds.length; k++) {
    const [i, j, ideal] = bonds[k];
    const r2 = dist2(P, i, j);
    const tol = tolerance(ideal);
    const lo = ideal > tol ? ideal - tol : 0, hi = ideal + tol;
    if (r2 < lo * lo || r2 > hi * hi) return { code: ERR_BOND, reason: 'BOND', detail: { i, j, ideal, r2, lo, hi } };
  }
  const pairs = topology.pairs13;
  for (let k = 0; k < pairs.length; k++) {
    const [i, j, ideal] = pairs[k];
    const r2 = dist2(P, i, j);
    const tol = tolerance(ideal);
    const lo = ideal > tol ? ideal - tol : 0, hi = ideal + tol;
    if (r2 < lo * lo || r2 > hi * hi) return { code: ERR_PAIR13, reason: 'PAIR13', detail: { i, j, ideal, r2, lo, hi } };
  }
  const far = topology.farPairs;
  for (let k = 0; k < far.length; k += 2) {
    const i = far[k], j = far[k + 1];
    if (dist2(P, i, j) < CLASH_FLOOR_R2) return { code: ERR_CLASH, reason: 'CLASH', detail: { i, j, r2: dist2(P, i, j) } };
  }
  return { code: OK, reason: 'OK', detail: null };
}

/** The five term sums over all pairs inside the cutoff. sums: Float64Array(6) [g1, g2, rep, hyd, hb, pairs]. */
export function accumulateTerms(pocket, topology, P, sums, useGrid = true) {
  const t = getTables();
  const G1 = t.g1, G2 = t.g2, SQ = t.sq;
  const atoms = pocket.atoms, ptypes = pocket.types, ltypes = topology.types;
  const n = topology.n;
  let s1 = 0, s2 = 0, sr = 0, sh = 0, sb = 0, pairs = 0;
  const scan = (a, from, to) => {
    const xa = P[3 * a], ya = P[3 * a + 1], za = P[3 * a + 2];
    const ta = ltypes[a];
    const Ra = RADIUS_CENTI[ta];
    const rowClass = ta * 16;
    for (let k = from; k < to; k++) {
      const dx = xa - atoms[3 * k], dy = ya - atoms[3 * k + 1], dz = za - atoms[3 * k + 2];
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > CUTOFF_R2) continue;
      let r = SQ[r2 >> 8];
      while ((r + 1) * (r + 1) <= r2) r++;
      const tb = ptypes[k];
      const d = r - (Ra + RADIUS_CENTI[tb]);
      s1 += G1[d + 440];
      s2 += G2[d + 440];
      if (d < 0) sr += d * d * 100;
      const cls = PAIR_CLASS[rowClass + tb];
      if (cls === 1) sh += d <= 50 ? TERM_ONE : d >= 150 ? 0 : (150 - d) * 10000;
      else if (cls === 2) sb += d <= -70 ? TERM_ONE : d >= 0 ? 0 : Math.floor(((-d) * 100000) / 7);
      pairs++;
    }
  };
  if (!useGrid) {
    for (let a = 0; a < n; a++) scan(a, 0, pocket.n);
  } else {
    const [hx, hy, hz] = pocket.halfCenti;
    const [nx, ny, nz] = pocket.grid;
    const off = pocket.offsets;
    for (let a = 0; a < n; a++) {
      const cx = ((P[3 * a] + hx + REACH_CENTI) / CELL_CENTI) | 0;
      const cy = ((P[3 * a + 1] + hy + REACH_CENTI) / CELL_CENTI) | 0;
      const cz = ((P[3 * a + 2] + hz + REACH_CENTI) / CELL_CENTI) | 0;
      const x0 = Math.max(cx - 1, 0), x1 = Math.min(cx + 1, nx - 1);
      const y0 = Math.max(cy - 1, 0), y1 = Math.min(cy + 1, ny - 1);
      const z0 = Math.max(cz - 1, 0), z1 = Math.min(cz + 1, nz - 1);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          for (let iz = z0; iz <= z1; iz++) {
            const c = (ix * ny + iy) * nz + iz;
            scan(a, off[c], off[c + 1]);
          }
        }
      }
    }
  }
  sums[0] = s1; sums[1] = s2; sums[2] = sr; sums[3] = sh; sums[4] = sb; sums[5] = pairs;
  return sums;
}

/** E_pico and score_milli from the five sums and Nrot. */
export function scoreFromSums(sums, nrot) {
  const ePico = W_G1 * BigInt(sums[0]) + W_G2 * BigInt(sums[1]) + W_REP * BigInt(sums[2]) + W_HYD * BigInt(sums[3]) + W_HB * BigInt(sums[4]);
  const den = 100000n * BigInt(NROT_DEN + NROT_NUM * nrot);
  return { ePico, scoreMilli: Number(ePico / den) };
}

/** The contract's evaluate(): geometry proof, then the integer score. */
export function scoreInt(pocket, topology, poseCenti, { grid = true } = {}) {
  const g = checkGeometry(topology, poseCenti, pocket.halfCenti);
  if (g.code !== OK) return { ok: false, reason: g.reason, code: g.code, scoreMilli: null, terms: null, detail: g.detail };
  const sums = accumulateTerms(pocket, topology, poseCenti, new Float64Array(6), grid);
  const { ePico, scoreMilli } = scoreFromSums(sums, topology.nrot);
  return {
    ok: true, reason: 'OK', code: OK, scoreMilli,
    terms: { g1: sums[0], g2: sums[1], rep: sums[2], hyd: sums[3], hb: sums[4], pairs: sums[5], ePico },
    detail: null,
  };
}

/** Integer score only (no geometry proof), for the lattice polish where the proof is checked separately. */
export function scoreOnly(pocket, topology, poseCenti, sums = new Float64Array(6)) {
  accumulateTerms(pocket, topology, poseCenti, sums, true);
  return scoreFromSums(sums, topology.nrot).scoreMilli;
}
