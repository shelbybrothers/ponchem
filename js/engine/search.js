/*
 * js/engine/search.js: the float pose search (SPEC-ENGINE.md section 7; not specified bit for bit).
 *
 * Monte Carlo over rigid body plus torsions, C interleaved chains (random restarts inside the box), one move per
 * step (translate moveT angstrom along a random direction, rotate moveR about a random axis, or turn one torsion
 * by up to moveTor), a short BFGS local optimisation with analytic gradients after every move, Metropolis at
 * kT (1.2 kcal/mol by default) on the total float energy, best pose kept per chain and overall. Step i belongs
 * to chain i mod C, so the trajectory up to any step count is independent of the total (a run cut at N steps
 * replays with steps = N). Everything random comes from the seeded PRNG; nothing here calls Math.random,
 * Math.exp or Math.sin. The knobs (kT, the three move sizes, the local iteration count, the start spread and
 * the pool size) come from the docking method (js/engine/method.js); the constants below are the defaults.
 *
 *   bfgs(en, lig, state, work, maxIter) -> energy (state updated in place)
 *   makeSearch({ pocket, topology, lig, en, seed, chains, kT, moveT, moveR, moveTor, localIter, spread, pool })
 *       -> { run(nSteps), best, candidates(k), stats }
 */
import { makeRng } from './prng.js';
import { fexp } from './fmath.js';

export const KT = 1.2;
export const MOVE_T = 1.0;                         // angstrom
export const MOVE_R = 20 * Math.PI / 180;          // radians
export const MOVE_TOR = 60 * Math.PI / 180;        // radians
export const LOCAL_ITER = 30;                      // BFGS iterations after a Monte Carlo move
export const FINAL_ITER = 300;                     // BFGS iterations on the final candidates
export const SPREAD_BOX = 1.0;                     // placement "box": the ligand centre anywhere in the box
export const SPREAD_CENTER = 0.35;                 // placement "center": within 35 percent of the half size
export const POOL_SIZE = 12;                       // distinct minima kept for the final stage (at least)
const C1 = 1e-4;

export function makeWork(lig, n) {
  const dim = lig.dim;
  return {
    dim,
    X: new Float64Array(3 * n), gX: new Float64Array(3 * n),
    g: new Float64Array(dim), gNew: new Float64Array(dim), p: new Float64Array(dim),
    s: new Float64Array(dim), y: new Float64Array(dim), Hy: new Float64Array(dim),
    H: new Float64Array(dim * dim),
    trial: new Float64Array(lig.stateLength), delta: new Float64Array(dim),
  };
}

function resetH(H, dim) {
  H.fill(0);
  for (let i = 0; i < dim; i++) H[i * dim + i] = 1;
}

/** BFGS with backtracking line search on the state manifold. Returns the final energy; state is updated in place. */
export function bfgs(en, lig, state, w, maxIter) {
  const dim = w.dim, H = w.H, g = w.g, gNew = w.gNew, p = w.p, s = w.s, y = w.y, Hy = w.Hy;
  const X = w.X, gX = w.gX, trial = w.trial, delta = w.delta;
  resetH(H, dim);
  lig.build(state, X);
  let f = en.evaluate(X, gX);
  lig.project(X, state, gX, g);
  for (let iter = 0; iter < maxIter; iter++) {
    // p = -H g
    let gp = 0, pt = 0, pr = 0, ptor = 0;
    for (let i = 0; i < dim; i++) {
      let v = 0;
      const row = i * dim;
      for (let j = 0; j < dim; j++) v += H[row + j] * g[j];
      p[i] = -v;
      gp += p[i] * g[i];
    }
    if (gp >= 0) {           // not a descent direction: restart from steepest descent
      resetH(H, dim);
      gp = 0;
      for (let i = 0; i < dim; i++) { p[i] = -g[i]; gp += p[i] * g[i]; }
      if (gp >= -1e-14) break;
    }
    pt = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    pr = Math.sqrt(p[3] * p[3] + p[4] * p[4] + p[5] * p[5]);
    for (let k = 6; k < dim; k++) ptor = Math.max(ptor, Math.abs(p[k]));
    let alpha = 1;
    if (pt * alpha > 0.4) alpha = 0.4 / pt;
    if (pr * alpha > 0.3) alpha = 0.3 / pr;
    if (ptor * alpha > 0.5) alpha = 0.5 / ptor;
    let accepted = false, fNew = f;
    for (let ls = 0; ls < 12; ls++) {
      for (let i = 0; i < dim; i++) delta[i] = alpha * p[i];
      lig.step(state, delta, trial);
      lig.build(trial, X);
      fNew = en.evaluate(X, gX);
      if (fNew <= f + C1 * alpha * gp) { accepted = true; break; }
      alpha *= 0.5;
    }
    if (!accepted) break;
    lig.project(X, trial, gX, gNew);
    state.set(trial);
    let ys = 0;
    for (let i = 0; i < dim; i++) { s[i] = delta[i]; y[i] = gNew[i] - g[i]; ys += y[i] * s[i]; }
    f = fNew;
    g.set(gNew);
    let gn = 0;
    for (let i = 0; i < dim; i++) gn += g[i] * g[i];
    if (gn < 1e-8) break;
    if (ys > 1e-10) {
      // H = (I - rho s y') H (I - rho y s') + rho s s'
      const rho = 1 / ys;
      let yHy = 0;
      for (let i = 0; i < dim; i++) {
        let v = 0;
        const row = i * dim;
        for (let j = 0; j < dim; j++) v += H[row + j] * y[j];
        Hy[i] = v;
        yHy += y[i] * v;
      }
      const k2 = (1 + rho * yHy) * rho;
      for (let i = 0; i < dim; i++) {
        const row = i * dim;
        for (let j = 0; j < dim; j++) {
          H[row + j] += k2 * s[i] * s[j] - rho * (Hy[i] * s[j] + s[i] * Hy[j]);
        }
      }
    }
  }
  return f;
}

function perturb(lig, state, out, rng, dir, moveT, moveR, moveTor) {
  out.set(state);
  const m = lig.nrot ? rng.int(3) : rng.int(2);
  if (m === 0) {
    rng.unitVector(dir);
    out[0] += moveT * dir[0]; out[1] += moveT * dir[1]; out[2] += moveT * dir[2];
  } else if (m === 1) {
    rng.unitVector(dir);
    const d = lig._delta || (lig._delta = new Float64Array(lig.dim));
    d.fill(0);
    d[3] = moveR * dir[0]; d[4] = moveR * dir[1]; d[5] = moveR * dir[2];
    lig.step(state, d, out);
  } else {
    const k = rng.int(lig.nrot);
    let th = out[7 + k] + moveTor * rng.sym();
    if (th > Math.PI) th -= 2 * Math.PI; else if (th < -Math.PI) th += 2 * Math.PI;
    out[7 + k] = th;
  }
  return m;
}

/**
 * The Monte Carlo search object. run(n) advances n steps (round robin over the chains) and can be called again;
 * best is the lowest total-energy state seen; candidates(k) returns up to k distinct low-energy states.
 */
export function makeSearch({
  pocket, topology, lig, en, seed, chains = 6, spread = SPREAD_BOX, localIter = LOCAL_ITER,
  kT = KT, moveT = MOVE_T, moveR = MOVE_R, moveTor = MOVE_TOR, pool: poolSize = POOL_SIZE,
}) {
  const rng = makeRng(seed);
  const n = lig.n;
  const w = makeWork(lig, n);
  const half = pocket.half;
  const dir = new Float64Array(3);
  const trial = new Float64Array(lig.stateLength);
  const chainList = [];
  const best = { state: new Float64Array(lig.stateLength), energy: Infinity, inter: 0, affinity: 0, chain: -1, step: -1 };
  const stats = { steps: 0, accepted: 0, moves: [0, 0, 0], evaluations: 0 };
  // Minima kept for the final stage: { state, energy, inter, key }. The chain scores the intermolecular part
  // only, so the pool ranks by inter plus a penalty for box and clash violations (a legal pose with a good inter
  // beats one with a better total but a worse inter); the Metropolis test still uses the total.
  const pool = [];
  const POOL = Math.max(POOL_SIZE, poolSize | 0);
  const poolKey = (inter, violation) => inter + 20 * violation;

  function initChain(c) {
    const st = new Float64Array(lig.stateLength);
    lig.randomState(rng, half, st, spread);
    const e = bfgs(en, lig, st, w, localIter);
    const ch = { cur: st, curE: e, curInter: en.inter, best: Float64Array.from(st), bestE: e, bestInter: en.inter, id: c };
    chainList[c] = ch;
    consider(ch, st, e, en.inter, en.violation, c);
  }

  const XA = new Float64Array(3 * n), XB = new Float64Array(3 * n);
  function poseRmsd(sa, sb) {
    lig.build(sa, XA); lig.build(sb, XB);
    let s = 0;
    for (let i = 0; i < 3 * n; i++) { const d = XA[i] - XB[i]; s += d * d; }
    return Math.sqrt(s / n);
  }

  function consider(ch, st, e, inter, violation, c) {
    if (e < best.energy) {
      best.energy = e; best.inter = inter; best.affinity = inter / en.nrotPenalty; best.chain = c; best.step = stats.steps;
      best.state.set(st);
    }
    const key = poolKey(inter, violation);
    if (pool.length < POOL || key < pool[pool.length - 1].key) {
      let dup = -1;
      for (let q = 0; q < pool.length; q++) if (poseRmsd(pool[q].state, st) < 1.0) { dup = q; break; }
      if (dup >= 0) {
        if (key < pool[dup].key) { pool[dup].energy = e; pool[dup].inter = inter; pool[dup].key = key; pool[dup].state.set(st); }
      } else {
        pool.push({ state: Float64Array.from(st), energy: e, inter, key });
      }
      pool.sort((a, b) => a.key - b.key);
      if (pool.length > POOL) pool.length = POOL;
    }
  }

  return {
    best, stats, chains, rng,
    knobs: { kT, moveT, moveR, moveTor, localIter, spread, pool: POOL },
    run(nSteps) {
      const e0 = en.evaluations;
      for (let q = 0; q < nSteps; q++) {
        const c = stats.steps % chains;
        if (!chainList[c]) initChain(c);
        const ch = chainList[c];
        const m = perturb(lig, ch.cur, trial, rng, dir, moveT, moveR, moveTor);
        stats.moves[m]++;
        const e = bfgs(en, lig, trial, w, localIter);
        const inter = en.inter;
        const dE = e - ch.curE;
        if (dE <= 0 || rng.float() < fexp(-dE / kT)) {
          ch.cur.set(trial); ch.curE = e; ch.curInter = inter;
          stats.accepted++;
          if (e < ch.bestE) { ch.bestE = e; ch.bestInter = inter; ch.best.set(trial); }
          consider(ch, trial, e, inter, en.violation, c);
        }
        stats.steps++;
      }
      stats.evaluations += en.evaluations - e0;
      return stats.steps;
    },
    candidates(k) {
      return pool.slice(0, k).map((p) => ({ state: Float64Array.from(p.state), energy: p.energy, inter: p.inter, key: p.key }));
    },
    chainBests() {
      return chainList.filter(Boolean).map((ch) => ({ chain: ch.id, energy: ch.bestE, inter: ch.bestInter }));
    },
    work: w,
  };
}
