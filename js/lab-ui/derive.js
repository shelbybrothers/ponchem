/*
 * js/lab-ui/derive.js: display numbers for a run (SPEC-ENGINE.md 3.6 and SPEC-DESIGN.md 1.5). No DOM.
 *
 *   derivedOf(scoreMilli, heavyAtoms, engine?) -> { dG, pKd, kd, le }   uses engine.derived when the engine has it
 *   bandOf(dG)            -> { key: 'strong' | 'moderate' | 'weak' | 'none', label }
 *   fmtDg(scoreMilli)     -> '-9.289'        three decimals, sign kept, from the integer milli value
 *   fmtDgOf(dG)           -> '-9.289'        from a float
 *   fmtPkd(pKd)           -> '6.81'
 *   fmtKd(kdMolar)        -> '155 nM'        auto unit pM / nM / uM / mM / M, never scientific notation
 *   fmtLe(le)             -> '0.42'
 *   fmtElapsed(ms)        -> '12.4 s'
 *   termEnergies(terms, nrot) -> { g1, g2, rep, hyd, hb, sum } kcal/mol contributions from the five micro sums
 *   checkRows(checks)     -> [{ key, ok: true | false | null }] in the order BOND, PAIR13, CLASH, BOX
 */
import { S, KD_UNITS } from './strings.js';

const RT_LN10 = 1.36423; // kcal/mol at 298.15 K

export function derivedOf(scoreMilli, heavyAtoms, engine = null) {
  const milli = Number(scoreMilli);
  if (engine && typeof engine.derived === 'function') {
    try {
      const d = engine.derived(milli, heavyAtoms);
      if (d && Number.isFinite(d.dG)) return { dG: d.dG, pKd: d.pKd, kd: d.kd, le: d.le };
    } catch { /* fall through to the local formulas */ }
  }
  const dG = milli / 1000;
  const pKd = -dG / RT_LN10;
  const kd = Math.pow(10, -pKd);
  const le = heavyAtoms > 0 ? -dG / heavyAtoms : NaN;
  return { dG, pKd, kd, le };
}

export function bandOf(dG) {
  if (!Number.isFinite(dG)) return { key: 'none', label: S.bandNone };
  if (dG >= 0) return { key: 'none', label: S.bandNone };
  if (dG <= -9) return { key: 'strong', label: S.bandStrong };
  if (dG <= -6) return { key: 'moderate', label: S.bandModerate };
  return { key: 'weak', label: S.bandWeak };
}

export function fmtDg(scoreMilli) {
  const n = Number(scoreMilli);
  if (!Number.isFinite(n)) return '--';
  const neg = n < 0;
  const abs = Math.abs(Math.trunc(n));
  const int = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
}

export const fmtDgOf = (dG) => (Number.isFinite(dG) ? fmtDg(Math.round(dG * 1000)) : '--');

export const fmtPkd = (pKd) => (Number.isFinite(pKd) ? pKd.toFixed(2) : '--');
export const fmtLe = (le) => (Number.isFinite(le) ? le.toFixed(2) : '--');

function sig(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function fmtKd(kd) {
  if (!Number.isFinite(kd) || kd <= 0) return '--';
  const scales = [1e12, 1e9, 1e6, 1e3, 1];
  for (let i = 0; i < scales.length; i++) {
    const v = kd * scales[i];
    if (v < 1000 || i === scales.length - 1) return `${sig(v)} ${KD_UNITS[i]}`;
  }
  return '--';
}

export function fmtElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

const W = { g1: -0.0356, g2: -0.00516, rep: 0.84, hyd: -0.0351, hb: -0.587 };
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v));

/** Weighted kcal/mol per term from the five micro sums of scoreInt().terms, before the rotor division. */
export function termEnergies(terms, nrot = 0) {
  if (!terms) return null;
  const out = {};
  let sum = 0;
  for (const k of ['g1', 'g2', 'rep', 'hyd', 'hb']) {
    const s = num(terms[k]);
    const e = Number.isFinite(s) ? (W[k] * s) / 1e6 : NaN;
    out[k] = e;
    if (Number.isFinite(e)) sum += e;
  }
  out.sum = sum;
  out.divisor = 1 + 0.0585 * (Number(nrot) || 0);
  out.total = sum / out.divisor;
  return out;
}

export const fmtTerm = (e) => (Number.isFinite(e) ? (e >= 0 ? '+' : '') + e.toFixed(3) : '--');

const CODES = ['OK', 'ATOM_COUNT', 'BOX', 'BOND', 'PAIR13', 'CLASH'];
const ORDER = ['ATOM_COUNT', 'BOX', 'BOND', 'PAIR13', 'CLASH'];

/** The four geometry rows from a scoreInt/dock checks object ({ ok, reason } with a code number or name). */
export function checkRows(checks) {
  const ok = !!(checks && checks.ok);
  let reason = checks ? checks.reason : null;
  if (typeof reason === 'number') reason = CODES[reason] || String(reason);
  reason = reason ? String(reason).toUpperCase().replace(/[^A-Z0-9_]/g, '') : null;
  const failIdx = ok || !reason ? -1 : ORDER.indexOf(reason.replace('PAIR_13', 'PAIR13'));
  const status = (name) => {
    if (ok) return true;
    const i = ORDER.indexOf(name);
    if (failIdx < 0) return false; // failed for a reason we cannot place: nothing passes
    if (i < failIdx) return true; // checked before the failing one
    if (i === failIdx) return false;
    return null; // never reached
  };
  return [
    { key: 'BOND', label: S.geoBond, ok: status('BOND') },
    { key: 'PAIR13', label: S.geoPair13, ok: status('PAIR13') },
    { key: 'CLASH', label: S.geoClash, ok: status('CLASH') },
    { key: 'BOX', label: S.geoBox, ok: status('BOX') },
  ];
}
