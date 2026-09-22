/*
 * js/format.js: number and text formatting for every Ponchem page. No DOM, no imports.
 * Every function returns a string and never renders NaN, undefined, Infinity or an empty string: a value that
 * cannot be shown comes back as EMPTY ('--').
 *
 * SHIPPED API
 *   EMPTY                                   '--', what an unusable input renders as
 *   num(n, { digits, compact } = {})        plain grouped number '1,234.5'; compact: '2.86M' / '48.2K' from 10,000
 *   pct(fraction, { digits, sign } = {})    0.1 -> '10%', 0.0005 -> '0.05%' (argument is a FRACTION)
 *   units(bigint, decimals, digits = 4)     exact token amount from base units: (1234567n, 6) -> '1.2346'
 *                                           (trailing zeros trimmed, grouped, sign kept, exact BigInt math)
 *   eth(wei, digits = 5)                    '0.00002 ETH' from wei (bigint, number or decimal string)
 *   kcal(milli, digits = 2)                 a binding free energy from the chain's milli-kcal/mol integer:
 *                                           -9874n -> '-9.87 kcal/mol'; kcal(milli, 2, false) drops the unit
 *   fixed(n, digits)                        a plain float with exactly `digits` decimals: 7.2 -> '7.20'
 *   ago(date, now = Date.now())             '4s ago', '3m ago', '2h ago', '5d ago'; future or invalid -> 'just now'
 *   date(d)                                 'Sep 22, 2026'
 *   countdown(seconds)                      '6d 4h', '3h 12m', '48s', '0s' for what is left of an epoch
 *   shortHash(h)                            '0x1234…abcd' for a tx hash (or any long hex)
 *   shortAddr(a)                            '0x12…abcd' for the visitor's own address (render inside data-user-address)
 *   block(n)                                '#12,345,678'
 */

export const EMPTY = '--';

const finite = (n) => typeof n === 'number' ? Number.isFinite(n) : typeof n === 'bigint';
const toNum = (n) => (typeof n === 'bigint' ? Number(n) : typeof n === 'string' && n.trim() !== '' ? Number(n) : n);

const fmtCache = new Map();
function nf(min, max, compact = false) {
  const key = `${min}|${max}|${compact}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', compact
      ? { notation: 'compact', minimumFractionDigits: min, maximumFractionDigits: max }
      : { minimumFractionDigits: min, maximumFractionDigits: max });
    fmtCache.set(key, f);
  }
  return f;
}

// decimals that keep `sig` significant digits for 0 < |n| < 1
function smallDigits(abs, sig = 2) {
  const lead = Math.floor(-Math.log10(abs)); // zeros after the point before the first significant digit
  return Math.min(8, Math.max(2, lead + sig));
}

function signOf(n, sign) {
  if (n < 0) return '-';
  if (sign && n > 0) return '+';
  return '';
}

export function num(n, { digits, compact = false } = {}) {
  n = toNum(n);
  if (!finite(n)) return EMPTY;
  const abs = Math.abs(n);
  if (compact && abs >= 10000) return signOf(n) + nf(0, 2, true).format(abs);
  let d = digits;
  if (d === undefined) d = abs === 0 ? 0 : abs < 1 ? smallDigits(abs, 3) : abs < 100 ? 2 : abs < 10000 ? 1 : 0;
  return signOf(n) + nf(0, d).format(abs);
}

export function pct(fraction, { digits, sign = false } = {}) {
  const n = toNum(fraction);
  if (!finite(n)) return EMPTY;
  const p = Math.abs(n) * 100;
  let d = digits;
  if (d === undefined) d = p === 0 ? 0 : p < 0.1 ? 3 : p < 1 ? 2 : p < 10 ? 1 : 0;
  const rounded = Number(p.toFixed(d));
  if (rounded === 0) return '0%';
  return signOf(n, sign) + nf(0, d).format(rounded) + '%';
}

export function fixed(n, digits = 2) {
  n = toNum(n);
  if (!finite(n)) return EMPTY;
  const d = Math.max(0, Math.min(8, Number(digits) || 0));
  const s = nf(d, d).format(Math.abs(n));
  return (n < 0 && Number(s.replace(/,/g, '')) !== 0 ? '-' : '') + s;
}

export function units(value, decimals = 18, digits = 4) {
  let v;
  try { v = BigInt(value); } catch { return EMPTY; }
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 77) return EMPTY;
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(dec);
  let int = v / base;
  let frac = v % base;
  let keep = Math.max(0, Math.min(dec, Number(digits)));
  // round half up at `keep` decimals
  if (keep < dec) {
    const cut = 10n ** BigInt(dec - keep);
    let f = frac / cut;
    if ((frac % cut) * 2n >= cut) f += 1n;
    if (f >= 10n ** BigInt(keep)) { int += 1n; f = 0n; }
    frac = f;
  }
  let fs = keep ? frac.toString().padStart(keep, '0').replace(/0+$/, '') : '';
  if (!fs && int === 0n && v > 0n) {
    // a positive amount too small for `digits`: show its first significant digit instead of 0
    const full = (v % base).toString().padStart(dec, '0');
    const firstNz = full.search(/[1-9]/);
    if (firstNz >= 0) fs = full.slice(0, Math.min(dec, firstNz + 1));
  }
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = fs ? `${intStr}.${fs}` : intStr;
  return (neg && out !== '0' ? '-' : '') + out;
}

export function eth(wei, digits = 5) {
  const s = units(wei, 18, digits);
  return s === EMPTY ? EMPTY : `${s} ETH`;
}

/** The chain stores energies as integers in milli-kcal/mol. -9874 -> '-9.87 kcal/mol'. */
export function kcal(milli, digits = 2, unit = true) {
  let v;
  try { v = BigInt(milli); } catch { return EMPTY; }
  const s = units(v, 3, digits);
  if (s === EMPTY) return EMPTY;
  // units() trims trailing zeros; energies read better at a fixed width
  const [i, f = ''] = s.split('.');
  const d = Math.max(0, Math.min(3, Number(digits) || 0));
  const out = d ? `${i}.${f.padEnd(d, '0')}` : i;
  return unit ? `${out} kcal/mol` : out;
}

export function ago(d, now = Date.now()) {
  const t = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(d);
  if (!Number.isFinite(t)) return 'just now';
  const s = Math.floor((now - t) / 1000);
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function date(d) {
  if (d === null || d === undefined || d === '') return EMPTY;
  const t = d instanceof Date ? d : new Date(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d);
  if (!Number.isFinite(t.getTime())) return EMPTY;
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
}

/** What is left of an epoch: 532800 -> '6d 4h', 11520 -> '3h 12m', 48 -> '48s', anything gone -> '0s'. */
export function countdown(seconds) {
  const s = Math.floor(toNum(seconds));
  if (!Number.isFinite(s) || s <= 0) return '0s';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function shortHash(h) {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(h)) return EMPTY;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

export function shortAddr(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) return EMPTY;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function block(n) {
  n = toNum(n);
  if (!finite(n) || n < 0) return EMPTY;
  return '#' + nf(0, 0).format(n);
}
