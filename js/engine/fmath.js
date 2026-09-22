/*
 * js/engine/fmath.js: deterministic transcendental functions for the float search.
 *
 * IEEE 754 addition, subtraction, multiplication, division and square root are correctly rounded on every
 * JavaScript engine, but Math.exp, Math.sin and Math.cos are not (V8 and JavaScriptCore differ in the last
 * bits). The search only uses the functions below, so the same seed walks the same trajectory on any machine
 * ("Same seed, same pose, on any machine."). Accuracy is about 1e-16 relative on the ranges the engine uses.
 */

const LN2_HI = 0.693147180369123816490;   // ln 2 split so that k * LN2_HI is exact for |k| < 2^20
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;
const PIO2_HI = 1.5707963267341256e+00;    // pi/2 in three parts (fdlibm)
const PIO2_MID = 6.0771005065061922e-11;
const PIO2_LO = 2.0222662487959506e-21;
const TWO_OVER_PI = 0.63661977236758138;

const pow2buf = new Float64Array(1);
const pow2view = new DataView(pow2buf.buffer);

/** 2^k for integer k in [-1022, 1023] by writing the exponent bits (exact). */
export function pow2(k) {
  if (k > 1023) return Infinity;
  if (k < -1022) return 0;
  pow2view.setUint32(0, (k + 1023) << 20, false);
  pow2view.setUint32(4, 0, false);
  return pow2view.getFloat64(0, false);
}

/** exp(x), deterministic. */
export function fexp(x) {
  if (x !== x) return x;
  if (x > 709.7) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;   // |r| <= 0.3466
  // Taylor series to r^13 (error below 1e-17 for |r| <= 0.35)
  let s = 1 / 6227020800;                    // 1/13!
  s = s * r + 1 / 479001600;
  s = s * r + 1 / 39916800;
  s = s * r + 1 / 3628800;
  s = s * r + 1 / 362880;
  s = s * r + 1 / 40320;
  s = s * r + 1 / 5040;
  s = s * r + 1 / 720;
  s = s * r + 1 / 120;
  s = s * r + 1 / 24;
  s = s * r + 1 / 6;
  s = s * r + 0.5;
  s = s * r + 1;
  s = s * r + 1;
  if (k > 1000) return s * pow2(1000) * pow2(k - 1000);
  if (k < -1000) return s * pow2(-1000) * pow2(k + 1000);
  return s * pow2(k);
}

function sinKernel(r) {
  const r2 = r * r;
  let s = -1 / 355687428096000;             // -1/17!
  s = s * r2 + 1 / 1307674368000;
  s = s * r2 - 1 / 6227020800;
  s = s * r2 + 1 / 39916800;
  s = s * r2 - 1 / 362880;
  s = s * r2 + 1 / 5040;
  s = s * r2 - 1 / 120;
  s = s * r2 + 1 / 6;
  return r - r * r2 * s;
}

function cosKernel(r) {
  const r2 = r * r;
  let s = 1 / 20922789888000;               // 1/16!
  s = s * r2 - 1 / 87178291200;
  s = s * r2 + 1 / 479001600;
  s = s * r2 - 1 / 3628800;
  s = s * r2 + 1 / 40320;
  s = s * r2 - 1 / 720;
  s = s * r2 + 1 / 24;
  return 1 - r2 * 0.5 + r2 * r2 * s;
}

/** [sin x, cos x] written into out (Float64Array or array), deterministic. |x| should stay below 1e6. */
export function fsincos(x, out) {
  if (x !== x || x === Infinity || x === -Infinity) { out[0] = NaN; out[1] = NaN; return out; }
  const k = Math.round(x * TWO_OVER_PI);
  const r = ((x - k * PIO2_HI) - k * PIO2_MID) - k * PIO2_LO;   // |r| <= pi/4
  const s = sinKernel(r);
  const c = cosKernel(r);
  switch (((k % 4) + 4) % 4) {
    case 0: out[0] = s; out[1] = c; break;
    case 1: out[0] = c; out[1] = -s; break;
    case 2: out[0] = -s; out[1] = -c; break;
    default: out[0] = -c; out[1] = s; break;
  }
  return out;
}

const sc = new Float64Array(2);
export function fsin(x) { fsincos(x, sc); return sc[0]; }
export function fcos(x) { fsincos(x, sc); return sc[1]; }
