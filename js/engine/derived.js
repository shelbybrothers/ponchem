/*
 * js/engine/derived.js: display-only numbers from a chain score (SPEC-ENGINE.md 3.6, SPEC-DESIGN.md 1.5). Float, never on chain.
 *
 *   derived(scoreMilli, heavyAtoms) -> { dG (kcal/mol), pKd, kd (mol/L), le (kcal/mol per heavy atom), band, bandLabel }
 *   band(dG)      -> 'strong' | 'moderate' | 'weak' | 'none'
 *   bandLabel(dG) -> 'strong binder' | 'moderate binder' | 'weak binder' | 'no binding'   (copy deck strings)
 *   formatKd(kd)  -> { value, unit, text }   units pM nM uM mM M (copy deck), value with 3 significant digits
 *   formatDg(dG)  -> string with three decimals, e.g. '-8.412'
 */

export const RT_LN10 = 1.36423;   // RT ln 10 at 298.15 K, kcal/mol

export const BANDS = Object.freeze([
  Object.freeze({ key: 'strong', label: 'strong binder', badge: 'strong', test: (dG) => dG <= -9 }),
  Object.freeze({ key: 'moderate', label: 'moderate binder', badge: 'moderate', test: (dG) => dG <= -6 }),
  Object.freeze({ key: 'weak', label: 'weak binder', badge: 'weak', test: (dG) => dG < 0 }),
  Object.freeze({ key: 'none', label: 'no binding', badge: 'no binding', test: () => true }),
]);

export function band(dG) {
  if (!Number.isFinite(dG)) return 'none';
  for (const b of BANDS) if (b.test(dG)) return b.key;
  return 'none';
}

export function bandLabel(dG) {
  const key = band(dG);
  return BANDS.find((b) => b.key === key).label;
}

export function derived(scoreMilli, heavyAtoms) {
  const dG = Number(scoreMilli) / 1000;
  const pKd = -dG / RT_LN10;
  const kd = Math.pow(10, -pKd);
  const le = heavyAtoms > 0 ? -dG / heavyAtoms : 0;
  return { dG, pKd, kd, le, band: band(dG), bandLabel: bandLabel(dG) };
}

const KD_UNITS = [
  ['pM', 1e-12], ['nM', 1e-9], ['uM', 1e-6], ['mM', 1e-3], ['M', 1],
];

export function formatKd(kd) {
  if (!Number.isFinite(kd) || kd <= 0) return { value: NaN, unit: 'M', text: '' };
  let pick = KD_UNITS[KD_UNITS.length - 1];
  for (const u of KD_UNITS) { if (kd < u[1] * 1000) { pick = u; break; } }
  if (kd >= 1) pick = KD_UNITS[KD_UNITS.length - 1];
  const value = kd / pick[1];
  const text = `${Number(value.toPrecision(3))} ${pick[0]}`;
  return { value, unit: pick[0], text };
}

export function formatDg(dG) {
  return Number.isFinite(dG) ? dG.toFixed(3) : '';
}
