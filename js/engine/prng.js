/*
 * js/engine/prng.js: xoshiro128** seeded from a uint32 by splitmix32. Never Math.random.
 *
 *   const rng = makeRng(seed);   rng.u32() uint32 | rng.float() [0,1) with 53 bits | rng.int(n) 0..n-1
 *   rng.sym() (-1,1) | rng.unitVector(out) uniform direction | rng.quaternion(out) uniform rotation [w,x,y,z]
 */

export function makeRng(seed) {
  let s = (Number(seed) >>> 0);
  const sm = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  let a = sm(), b = sm(), c = sm(), d = sm();
  if ((a | b | c | d) === 0) d = 1;
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const u32 = () => {
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };
  const float = () => {
    const hi = u32() >>> 5;   // 27 bits
    const lo = u32() >>> 6;   // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  };
  const rng = {
    seed: s >>> 0,
    u32,
    float,
    int: (n) => Math.floor(float() * n),
    sym: () => 2 * float() - 1,
    unitVector(out = new Float64Array(3)) {
      for (;;) {
        const x = 2 * float() - 1, y = 2 * float() - 1, z = 2 * float() - 1;
        const r2 = x * x + y * y + z * z;
        if (r2 > 1e-6 && r2 <= 1) {
          const inv = 1 / Math.sqrt(r2);
          out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
          return out;
        }
      }
    },
    // Marsaglia (1972): uniform random rotation, no trigonometry
    quaternion(out = new Float64Array(4)) {
      let x1, y1, s1, x2, y2, s2;
      do { x1 = 2 * float() - 1; y1 = 2 * float() - 1; s1 = x1 * x1 + y1 * y1; } while (s1 >= 1 || s1 === 0);
      do { x2 = 2 * float() - 1; y2 = 2 * float() - 1; s2 = x2 * x2 + y2 * y2; } while (s2 >= 1 || s2 === 0);
      const f = Math.sqrt((1 - s1) / s2);
      out[0] = x1; out[1] = y1; out[2] = x2 * f; out[3] = y2 * f;
      return out;
    },
  };
  return rng;
}
