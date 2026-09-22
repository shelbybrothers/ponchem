/*
 * js/engine/polish.js: from a float state to the int16 pose the chain will accept (SPEC-ENGINE.md section 7).
 *
 *   polish({ pocket, topology, lig, en, state, work, rng, lattice = true }) -> { ok, reason, poseCenti, scoreMilli, terms, stats, X }
 *   lattice false (the method's switch) skips step 3: the rounded, proof-checked pose is scored as it is.
 *
 * 1. Round the float coordinates to centi-angstrom (nearest) and run the geometry proof.
 * 2. If it fails: nudge. Minimise the float objective with the box and clash margins widened (the atoms are pushed
 *    a little further inside the box and further apart than the integer floors), re-round, re-check; on repeated
 *    failure add a small seeded random kick to the rigid body and the torsions and retry. Every retry is counted.
 * 3. Lattice moves on the integer pose: whole-pose translations by 1 and 2 centi-A along each axis keep every
 *    intramolecular distance exactly (only the box check can fail), then tiny rigid rotations and torsion nudges
 *    (0.25 degrees) re-rounded and proof-checked. A move is kept when the integer score improves. This is a
 *    discrete descent on the very number that gets submitted.
 * The reported score is the integer scorer's number for the final int16 pose, nothing else.
 */
import { checkGeometry, scoreInt, scoreOnly, OK } from './score.js';
import { bfgs } from './search.js';
import { CLASH_MARGIN, BOX_MARGIN } from './energy.js';

const NUDGE_ROUNDS = 12;
const KICK_ROUNDS = 40;
const LATTICE_ROUNDS = 40;
const ROT_STEP = 0.25 * Math.PI / 180;

export function roundPose(X, out) {
  for (let i = 0; i < X.length; i++) {
    const v = Math.round(X[i] * 100);
    if (v < -32768 || v > 32767) throw new Error('pose does not fit int16');
    out[i] = v;
  }
  return out;
}

export function polish({ pocket, topology, lig, en, state, work, rng, lattice = true }) {
  const n = lig.n;
  const X = new Float64Array(3 * n);
  const pose = new Int16Array(3 * n);
  const stats = { nudged: false, nudgeRounds: 0, kicks: 0, latticeTried: 0, latticeAccepted: 0, latticeGain: 0, failures: [] };
  const st = Float64Array.from(state);
  const delta = new Float64Array(lig.dim);
  const trial = new Float64Array(lig.stateLength);

  const attempt = () => {
    lig.build(st, X);
    roundPose(X, pose);
    return checkGeometry(topology, pose, pocket.halfCenti);
  };

  let g = attempt();
  if (g.code !== OK) {
    stats.nudged = true;
    const half0 = en.half.slice();
    const floor0 = en.floor;
    for (let round = 0; round < NUDGE_ROUNDS + KICK_ROUNDS && g.code !== OK; round++) {
      stats.failures.push(g.reason);
      const extra = 0.03 + 0.02 * Math.min(round, 6);
      en.half[0] = half0[0] + BOX_MARGIN - (BOX_MARGIN + extra);
      en.half[1] = half0[1] + BOX_MARGIN - (BOX_MARGIN + extra);
      en.half[2] = half0[2] + BOX_MARGIN - (BOX_MARGIN + extra);
      en.floor = floor0 - CLASH_MARGIN + (CLASH_MARGIN + extra);
      if (round >= NUDGE_ROUNDS) {
        stats.kicks++;
        delta.fill(0);
        delta[0] = 0.15 * rng.sym(); delta[1] = 0.15 * rng.sym(); delta[2] = 0.15 * rng.sym();
        delta[3] = 0.05 * rng.sym(); delta[4] = 0.05 * rng.sym(); delta[5] = 0.05 * rng.sym();
        for (let k = 0; k < lig.nrot; k++) delta[6 + k] = 0.2 * rng.sym();
        lig.step(st, delta, trial);
        st.set(trial);
      }
      bfgs(en, lig, st, work, 60);
      stats.nudgeRounds++;
      g = attempt();
    }
    en.half[0] = half0[0]; en.half[1] = half0[1]; en.half[2] = half0[2];
    en.floor = floor0;
  }
  if (g.code !== OK) {
    return { ok: false, reason: g.reason, detail: g.detail, poseCenti: pose, scoreMilli: null, terms: null, stats, X, state: st };
  }

  // lattice descent on the integer score
  const sums = new Float64Array(6);
  let score = scoreOnly(pocket, topology, pose, sums);
  const start = score;
  const cand = new Int16Array(3 * n);
  const [hx, hy, hz] = pocket.halfCenti;
  const tryPose = (p) => {
    stats.latticeTried++;
    const gg = checkGeometry(topology, p, pocket.halfCenti);
    if (gg.code !== OK) return false;
    const s = scoreOnly(pocket, topology, p, sums);
    if (s < score) { score = s; pose.set(p); stats.latticeAccepted++; return true; }
    return false;
  };
  for (let round = 0; round < (lattice ? LATTICE_ROUNDS : 0); round++) {
    let improved = false;
    // integer translations
    for (const step of [1, 2]) {
      for (let axis = 0; axis < 3; axis++) {
        for (const sign of [1, -1]) {
          const d = sign * step;
          let inBox = true;
          for (let i = 0; i < n; i++) {
            const v = pose[3 * i + axis] + d;
            const lim = axis === 0 ? hx : axis === 1 ? hy : hz;
            if (v < -lim || v > lim) { inBox = false; break; }
          }
          if (!inBox) continue;
          cand.set(pose);
          for (let i = 0; i < n; i++) cand[3 * i + axis] += d;
          if (tryPose(cand)) { improved = true; st[axis] += d / 100; }
        }
      }
    }
    // tiny rigid rotations and torsion nudges, re-rounded from the float state
    lig.build(st, X);
    let bestSt = null;
    for (let k = 0; k < lig.dim; k++) {
      if (k < 3) continue;   // translations are covered by the integer moves
      for (const sign of [1, -1]) {
        delta.fill(0);
        delta[k] = sign * ROT_STEP;
        lig.step(st, delta, trial);
        lig.build(trial, X);
        let fits = true;
        for (let i = 0; i < 3 * n; i++) { const v = Math.round(X[i] * 100); if (v < -32768 || v > 32767) { fits = false; break; } cand[i] = v; }
        if (!fits) continue;
        if (tryPose(cand)) { bestSt = Float64Array.from(trial); improved = true; }
      }
    }
    if (bestSt) st.set(bestSt);
    if (!improved) break;
  }
  stats.latticeGain = start - score;
  const final = scoreInt(pocket, topology, pose);
  lig.build(st, X);
  return { ok: final.ok, reason: final.reason, detail: final.detail, poseCenti: pose, scoreMilli: final.scoreMilli, terms: final.terms, stats, X, state: st };
}
