/*
 * js/engine/core.js: one docking run from bytes to Result, shared by the worker and the in-thread fallback.
 *
 *   runDock({ pocket | pocketBytes, topology | topologyBytes, ligand, method, seed, budgetMs, steps, tables,
 *             onProgress, shouldCancel, yieldFn, chains, candidates }) -> Promise<Result>
 *   resolveDockMethod(params) -> { method, seed }   the merge rule below, shared with index.js dock()
 *
 * The method (js/engine/method.js, SPEC.md 9.7) steers the search: budget (ms or steps), chains, temperature,
 * the three move sizes, the local iteration count, the start placement, rigid or flexible ligand, the number of
 * candidates polished and the lattice switch. A value in the method beats the same value passed as a parameter
 * (budgetMs, steps, chains, candidates, seed); a parameter fills a key the method leaves out; then the schema
 * defaults apply. The Result carries `method` in its reproducible form (budget as the steps actually run, the
 * chain count used, the seed) so dock({ method: result.method }) replays the run exactly, and `methodRequested`,
 * the resolved method as it was asked.
 *
 * Stages: prepare (parse, tables, models) -> search (Monte Carlo, in blocks that yield to the event loop so
 * progress and cancel get through) -> refine (long BFGS on the best distinct minima) -> score (integer polish of
 * each candidate, the best integer score wins). budget.ms mode: a discarded PROBE_MS warm-up measures the step
 * rate, then the total step count is set so the run ends near the budget; the Result carries `steps`, and the
 * same run replays exactly with budget { steps } on any machine.
 */
import { parseSdf } from './sdf.js';
import { loadPocket, loadTopology } from './format.js';
import { ensureTables, getTables } from './tables.js';
import { makeLigandModel } from './ligand.js';
import { makeEnergyModel } from './energy.js';
import { makeSearch, bfgs, FINAL_ITER, SPREAD_BOX, SPREAD_CENTER } from './search.js';
import { polish } from './polish.js';
import { makeRng } from './prng.js';
import { validateMethod, methodToCompact } from './method.js';

export const PROBE_MS = 300;
export const MIN_STEPS = 60;
export const MAX_STEPS = 5_000_000;
export const BUDGET_MIN_MS = 1000;
export const BUDGET_MAX_MS = 600000;
export const RESERVE_FRACTION = 0.06;   // share of the budget kept for refine + polish

/**
 * Default chain count from the steps available: one chain per about 600 + 60 Nrot steps, between 4 and 16, so a
 * longer run means more restarts and a flexible ligand keeps enough steps per chain to fold into the pocket.
 */
export function chainsForSteps(totalSteps, nrot) {
  const perChain = 600 + 60 * nrot;
  return Math.max(4, Math.min(16, Math.round(totalSteps / perChain)));
}

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; this.cancelled = true; }
}

/** An invalid method: message is the first error sentence, .errors holds all of them. */
export class MethodError extends Error {
  constructor(errors) { super(errors[0] || 'The method is not valid.'); this.name = 'MethodError'; this.errors = errors.slice(); }
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v))));

/**
 * Merge the dock() parameters and the method (object or JSON text) into one resolved method plus the seed.
 * Legacy parameters are clamped into their bounds as before (budgetMs 1000..600000, steps 60..5000000); values
 * inside the method are validated against the schema and rejected with a MethodError.
 */
export function resolveDockMethod(params) {
  const { method = null, budgetMs = null, steps = null, chains, candidates, seed } = params || {};
  let raw = method;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { throw new MethodError(['The method is not valid JSON.']); }
  }
  if (raw == null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new MethodError(['The method must be a JSON object.']);
  const merged = { ...raw };
  if (merged.budget == null) {
    if (steps != null) merged.budget = { steps: clampInt(steps, MIN_STEPS, MAX_STEPS) };
    else if (budgetMs != null) merged.budget = { ms: clampInt(budgetMs, BUDGET_MIN_MS, BUDGET_MAX_MS) };
  }
  if (merged.chains == null && chains != null) merged.chains = clampInt(chains, 1, 32);
  if (merged.candidates == null && candidates != null) merged.candidates = clampInt(candidates, 1, 16);
  if (merged.seed == null && seed != null) merged.seed = Number(seed) >>> 0;
  const v = validateMethod(merged);
  if (!v.ok) throw new MethodError(v.errors);
  return { method: v.method, seed: v.method.seed != null ? v.method.seed >>> 0 : 1 };
}

/** The search knobs of a resolved method, in the units makeSearch takes. */
export function searchKnobs(method) {
  return {
    kT: method.temperature,
    moveT: method.moves.translate,
    moveR: method.moves.rotate * Math.PI / 180,
    moveTor: method.moves.torsion * Math.PI / 180,
    localIter: method.local.steps,
    spread: method.placement === 'center' ? SPREAD_CENTER : SPREAD_BOX,
    pool: method.candidates,
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const defaultYield = () => new Promise((r) => setTimeout(r, 0));

export async function runDock(params) {
  const { ligand, tables = null, onProgress = null, shouldCancel = () => false, yieldFn = defaultYield } = params;
  const t0 = now();
  const { method, seed: seedU32 } = resolveDockMethod(params);
  const knobs = searchKnobs(method);
  const nCandidates = method.candidates;
  const report = (stage, done, best, evaluations, stepsDone) => {
    if (onProgress) onProgress({ stage, done, best, evaluations, steps: stepsDone });
  };
  const checkCancel = () => { if (shouldCancel()) throw new CancelledError(); };

  // ---- prepare
  report('prepare', 0, null, 0, 0);
  await ensureTables(tables ? { bytes: tables } : {});
  const T = getTables();
  const pocket = params.pocket && params.pocket.atoms ? params.pocket : loadPocket(params.pocketBytes || params.pocket);
  const topology = params.topology && params.topology.types ? params.topology : loadTopology(params.topologyBytes || params.topology);
  const sdf = typeof ligand === 'string' ? parseSdf(ligand) : ligand;
  if (!sdf || !sdf.atoms) throw new Error('ligand must be parseSdf output (or SDF text)');
  const lig = makeLigandModel(sdf, topology, { flexible: method.flexible });
  const en = makeEnergyModel(pocket, topology, lig, T);
  let total = method.budget.steps != null ? method.budget.steps : null;
  const budget = method.budget.ms != null ? method.budget.ms : null;
  // time kept back for the refine and polish stages: they grow with the atom count (polish re-scores the pose many times)
  const reserveMs = budget != null ? Math.min(budget * RESERVE_FRACTION, 100 + 8 * lig.n + 4 * lig.nrot * lig.n) : 0;
  const givenChains = method.chains != null ? method.chains : null;
  let chains = givenChains != null ? givenChains : total != null ? chainsForSteps(total, lig.nrot) : 6;
  let probe = null;
  const tPrep = now();
  checkCancel();

  // ---- budget mode: a discarded PROBE_MS warm-up measures the step rate, which sets the chain count and the first
  // step estimate; the real search then starts fresh from the seed (a replay passes { seed, steps, chains })
  if (budget != null) {
    const warm = makeSearch({ pocket, topology, lig, en, seed: seedU32, chains: 6, ...knobs });
    const p0 = now();
    let n = 0;
    while (now() - p0 < PROBE_MS) { warm.run(4); n += 4; }
    const ms = now() - p0;
    const rate = n / ms;
    const est = Math.floor(Math.max(0, budget - (now() - t0) - reserveMs) * rate);
    if (givenChains == null) chains = chainsForSteps(est, lig.nrot);
    probe = { steps: n, ms: Math.round(ms), stepsPerSecond: Math.round(rate * 1000), estimatedSteps: est, evaluations: en.evaluations };
    en.evaluations = 0;
    checkCancel();
    await yieldFn();
  }
  const search = makeSearch({ pocket, topology, lig, en, seed: seedU32, chains, ...knobs });

  // ---- search
  const searchStart = now();
  let lastReport = searchStart;
  let stepsPerMs = probe ? probe.steps / probe.ms : 0;
  let block = probe ? Math.max(1, Math.round(stepsPerMs * 40)) : 4;
  let lastEstimate = searchStart;
  const estimate = (t) => {
    const elapsedSearch = t - searchStart;
    if (elapsedSearch > PROBE_MS) stepsPerMs = search.stats.steps / elapsedSearch;
    const remaining = budget - (t - t0) - reserveMs;
    return Math.max(MIN_STEPS, Math.min(MAX_STEPS, search.stats.steps + Math.floor(Math.max(0, remaining) * stepsPerMs)));
  };
  if (budget != null) total = estimate(now());
  while (true) {
    const stepsDone = search.stats.steps;
    if (stepsDone >= total) break;
    const blockStart = now();
    const want = Math.min(block, total - stepsDone);
    search.run(want);
    const blockMs = now() - blockStart;
    // size the next block to about 40 ms of work
    const rate = want / Math.max(blockMs, 0.01);
    block = Math.max(1, Math.min(2000, Math.round(rate * 40)));
    const t = now();
    if (budget != null && t - lastEstimate > 500) {
      // the trajectory never depends on `total` (round-robin chains), so refining the estimate keeps the replay exact
      total = estimate(t);
      lastEstimate = t;
    }
    if (t - lastReport > 100 || search.stats.steps >= total) {
      lastReport = t;
      const done = Math.min(0.95, 0.02 + 0.93 * search.stats.steps / total);
      const b = search.best.energy < Infinity ? Math.round(search.best.affinity * 1000) : null;
      report('search', done, b, en.evaluations, search.stats.steps);
    }
    checkCancel();
    await yieldFn();
  }
  const tSearch = now();
  const searchMs = tSearch - searchStart;

  // ---- refine
  report('refine', 0.96, Math.round(search.best.affinity * 1000), en.evaluations, search.stats.steps);
  const cands = search.candidates(Math.max(1, nCandidates));
  const work = search.work;
  for (const c of cands) {
    c.energy = bfgs(en, lig, c.state, work, FINAL_ITER);
    c.inter = en.inter;
    c.key = en.inter + 20 * en.violation;
  }
  cands.sort((a, b) => a.key - b.key);
  checkCancel();
  await yieldFn();
  const tRefine = now();

  // ---- integer polish and score
  report('score', 0.98, Math.round((cands[0].inter / en.nrotPenalty) * 1000), en.evaluations, search.stats.steps);
  checkCancel();
  const rng = makeRng(seedU32 ^ 0x9e3779b9);
  const polished = [];
  for (const c of cands) {
    polished.push({ ...polish({ pocket, topology, lig, en, state: c.state, work, rng, lattice: method.lattice }), floatEnergy: c.energy, floatInter: c.inter });
  }
  const good = polished.filter((p) => p.ok).sort((a, b) => a.scoreMilli - b.scoreMilli);
  const pick = good[0] || polished[0];
  const tEnd = now();
  lig.build(pick.state, work.X);
  en.evaluate(work.X, null);
  const nudgeCount = polished.filter((p) => p.stats.nudged).length;
  const poseAbs = new Float64Array(3 * lig.n);
  for (let i = 0; i < lig.n; i++) {
    poseAbs[3 * i] = pocket.center[0] + pick.poseCenti[3 * i] / 100;
    poseAbs[3 * i + 1] = pocket.center[1] + pick.poseCenti[3 * i + 1] / 100;
    poseAbs[3 * i + 2] = pocket.center[2] + pick.poseCenti[3 * i + 2] / 100;
  }
  // the reproducible form of the method: the steps actually run, the chain count used and the seed
  const methodRun = { ...method, budget: { steps: search.stats.steps }, chains, seed: seedU32 };
  const result = {
    poseCenti: pick.poseCenti,
    scoreMilli: pick.scoreMilli,
    poseAbs,
    checks: { ok: pick.ok, reason: pick.reason, detail: pick.detail },
    elapsedMs: Math.round(tEnd - t0),
    evaluations: en.evaluations,
    seed: seedU32,
    steps: search.stats.steps,
    chains,
    method: methodRun,
    methodCompact: methodToCompact(methodRun),
    methodRequested: method,
    probe,
    terms: pick.terms,
    nrot: topology.nrot,
    nrotSearch: lig.nrot,
    heavyAtoms: lig.n,
    pocketHash: pocket.hash,
    topologyHash: topology.hash,
    float: { total: en.inter + en.intra + en.box, inter: en.inter, intra: en.intra, box: en.box, affinity: en.affinity() },
    polish: {
      nudged: pick.stats.nudged, nudgeRounds: pick.stats.nudgeRounds, kicks: pick.stats.kicks, failures: pick.stats.failures,
      latticeTried: pick.stats.latticeTried, latticeAccepted: pick.stats.latticeAccepted, latticeGain: pick.stats.latticeGain,
      candidates: polished.length, candidatesOk: good.length, candidatesNudged: nudgeCount,
      candidateScores: polished.map((p) => (p.ok ? p.scoreMilli : null)),
    },
    search: {
      accepted: search.stats.accepted, moves: search.stats.moves.slice(), stepsPerSecond: Math.round(search.stats.steps / Math.max(searchMs, 1) * 1000),
      bestFloatTotal: search.best.energy, bestFloatAffinity: search.best.affinity, chainBests: search.chainBests(),
    },
    timings: { prepareMs: Math.round(tPrep - t0), searchMs: Math.round(searchMs), refineMs: Math.round(tRefine - tSearch), polishMs: Math.round(tEnd - tRefine) },
  };
  report('done', 1, pick.ok ? pick.scoreMilli : null, en.evaluations, search.stats.steps);
  return result;
}
