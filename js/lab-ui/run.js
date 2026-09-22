/*
 * js/lab-ui/run.js: the run controller. It prepares the engine inputs for a pair (ligand SDF, pocket bytes,
 * topology bytes, cached), runs dock() with the method's budget (or the depth's) and the seed, then always
 * evaluates the final pose with the integer scorer (scoreInt) and derives the display numbers. A screening queue
 * runs pairs one after another in the same worker.
 *
 *   createRunner({ engine, catalog })
 *   -> { prepare(target, ligand) -> Promise<Inputs>,
 *        dock({ target, ligand, depthKey, seed, method, methodName, onProgress, onStage }) -> Promise<Run>,
 *        queue(pairs, { depthKey, seed, method, methodName, onRow, onProgress, onStage, onStart }) -> Promise<Run[]>,
 *        cancel(), running(), pocketOf(target) -> Promise<Pocket> }
 *   Inputs { sdf, ligand (parseSdf), pocket (loadPocket), topology (loadTopology) }
 *   Run { key, target, ligand, inputs, result (engine Result), score (scoreInt), poseAbs, view, chain: null,
 *         method (the resolved method the run was asked with, or null), methodJson: '' (the page fills it) }
 *
 * Engine API per SPEC.md 8.1 plus 9.7 (js/engine/index.js): dock({ ..., method }) on the v2 engine; the budget,
 * chains and candidates of the method are also passed as the plain v1 parameters (budgetMs | steps, chains,
 * candidates) so an engine without method support still runs the method's search size. Pocket and topology bytes
 * come from js/catalog.js (fetchPocket(pdbId), fetchTopology(key)); the SDF from fetchLigandSdf(key).
 */
import { DEPTHS, S } from './strings.js';

const budgetOf = (depthKey) => (DEPTHS.find((d) => d.key === depthKey) || DEPTHS[1]).budgetMs;
const labelOf = (depthKey) => (DEPTHS.find((d) => d.key === depthKey) || DEPTHS[1]).label;
const posInt = (v, max) => { const n = Number(v); return Number.isInteger(n) && n > 0 && (!max || n <= max) ? n : null; };

/** The plain engine parameters a method asks for: { budgetMs | steps, chains?, candidates? }. */
export function engineParamsOf(method, depthKey) {
  const out = {};
  const b = method && typeof method === 'object' && method.budget && typeof method.budget === 'object' ? method.budget : null;
  const steps = b ? posInt(b.steps) : null;
  const ms = b ? posInt(b.ms) : null;
  if (steps) out.steps = steps;
  else out.budgetMs = ms || budgetOf(depthKey);
  if (method && posInt(method.chains, 32)) out.chains = posInt(method.chains, 32);
  if (method && posInt(method.candidates, 16)) out.candidates = posInt(method.candidates, 16);
  return out;
}

export function createRunner({ engine, catalog }) {
  const sdfCache = new Map();
  const pocketCache = new Map();
  const topoCache = new Map();
  let active = null; // { key, cancelled }
  let queueActive = null;

  const cached = async (map, key, load) => {
    if (map.has(key)) return map.get(key);
    const p = load().catch((e) => { map.delete(key); throw e; });
    map.set(key, p);
    return p;
  };

  const pocketOf = (target) => cached(pocketCache, target.pdbId, async () => engine.loadPocket(await catalog.fetchPocket(target.pdbId)));
  const topologyOf = (ligand) => cached(topoCache, ligand.key, async () => engine.loadTopology(await catalog.fetchTopology(ligand.key)));
  const sdfOf = (ligand) => cached(sdfCache, ligand.key, () => catalog.fetchLigandSdf(ligand.key));

  let tablesReady = null;
  const tables = () => {
    if (!tablesReady) tablesReady = typeof engine.ensureTables === 'function' ? Promise.resolve(engine.ensureTables()).catch((e) => { tablesReady = null; throw e; }) : Promise.resolve(null);
    return tablesReady;
  };

  async function prepare(target, ligand) {
    if (!engine) throw new Error(S.engineMissing);
    const [sdf, pocket, topology] = await Promise.all([sdfOf(ligand), pocketOf(target), topologyOf(ligand), tables()]);
    const parsed = engine.parseSdf(sdf);
    return { sdf, ligand: parsed, pocket, topology };
  }

  const STAGES = { prepare: S.stagePreparing, search: S.stageSearch, refine: S.stageRefining, polish: S.stageRefining, score: S.stageFinal, done: S.stageFinal };
  const isCancelled = (e) => !!e && (e.code === 'cancelled' || e.name === 'CancelledError');

  /** Absolute coordinates (angstrom) of a centi pose around the pocket centre. */
  function toAbs(pocket, poseCenti) {
    const n = poseCenti.length / 3;
    const out = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      out[3 * i] = pocket.center[0] + poseCenti[3 * i] / 100;
      out[3 * i + 1] = pocket.center[1] + poseCenti[3 * i + 1] / 100;
      out[3 * i + 2] = pocket.center[2] + poseCenti[3 * i + 2] / 100;
    }
    return out;
  }

  function viewOf({ target, ligand, inputs, result, score, depthKey, seed, methodName }) {
    const heavyAtoms = inputs.topology && inputs.topology.n ? inputs.topology.n : ligand.heavyAtoms;
    const nrot = inputs.topology && inputs.topology.nrot !== undefined ? inputs.topology.nrot : ligand.rotatableBonds;
    return {
      target: { id: target.id, key: target.key, pdbId: target.pdbId, protein: target.protein },
      ligand: { id: ligand.id, key: ligand.key, name: ligand.name, code: ligand.ccd || ligand.key },
      scoreMilli: Number(score.scoreMilli),
      heavyAtoms,
      nrot,
      depthLabel: labelOf(depthKey),
      methodName: methodName || labelOf(depthKey),
      seed,
      steps: result.steps ?? null,
      evaluations: result.evaluations ?? null,
      elapsedMs: result.elapsedMs,
      terms: score.terms || null,
      checks: { ok: !!score.ok, reason: score.reason },
      chain: null,
    };
  }

  async function dock({ target, ligand, depthKey = 'standard', seed, method = null, methodName = null, onProgress, onStage }) {
    if (!engine) throw new Error(S.engineMissing);
    if (active) throw new Error('a run is already in progress');
    const key = `${target.id}:${ligand.id}`;
    const run = { key, cancelled: false };
    active = run;
    try {
      if (onStage) onStage(S.stagePreparing);
      const inputs = await prepare(target, ligand);
      if (run.cancelled) throw Object.assign(new Error(S.errStopped), { code: 'cancelled' });
      if (onStage) onStage(S.stageSearch);
      const params = engineParamsOf(method, depthKey);
      let lastStage = null;
      let result;
      try {
        result = await engine.dock({
          pocket: inputs.pocket,
          topology: inputs.topology,
          ligand: inputs.ligand,
          seed: seed >>> 0,
          ...params,
          ...(method ? { method } : {}),
          onProgress: (p) => {
            if (run.cancelled) return;
            if (p && p.stage && p.stage !== lastStage && STAGES[p.stage] && onStage) { lastStage = p.stage; onStage(STAGES[p.stage]); }
            if (onProgress) onProgress(p);
          },
        });
      } catch (e) {
        if (isCancelled(e)) throw Object.assign(new Error(S.errStopped), { code: 'cancelled' });
        throw e;
      }
      if (!result || !result.poseCenti) throw Object.assign(new Error(S.errStopped), { code: 'cancelled' });
      if (onStage) onStage(S.stageFinal);
      // the final number is always the integer scorer's, never the float search energy
      const poseCenti = result.poseCenti instanceof Int16Array ? result.poseCenti : Int16Array.from(result.poseCenti);
      const score = engine.scoreInt(inputs.pocket, inputs.topology, poseCenti);
      const poseAbs = result.poseAbs && result.poseAbs.length === poseCenti.length ? result.poseAbs : toAbs(inputs.pocket, poseCenti);
      const out = {
        key,
        target,
        ligand,
        inputs,
        result: { ...result, poseCenti },
        score,
        poseAbs,
        depthKey,
        seed: seed >>> 0,
        method: method || null,
        methodJson: '',
        chain: null,
        cancelled: run.cancelled,
      };
      out.view = viewOf({ target, ligand, inputs, result: out.result, score, depthKey, seed: seed >>> 0, methodName });
      return out;
    } finally {
      if (active === run) active = null;
    }
  }

  function cancel() {
    if (active) active.cancelled = true;
    if (queueActive) queueActive.cancelled = true;
    try { if (engine && typeof engine.cancel === 'function') engine.cancel(); } catch { /* nothing running */ }
  }

  /** One target against many ligands (or the reverse), one after another. onRow(i, run | { error }) per pair. */
  async function queue(pairs, { depthKey, seed, method = null, methodName = null, onRow, onProgress, onStage, onStart }) {
    if (queueActive) throw new Error('a screening is already in progress');
    const q = { cancelled: false };
    queueActive = q;
    const runs = [];
    try {
      for (let i = 0; i < pairs.length; i++) {
        if (q.cancelled) break;
        const { target, ligand } = pairs[i];
        if (onStart) onStart(i, pairs[i]);
        try {
          const run = await dock({ target, ligand, depthKey, seed, method, methodName, onProgress: (p) => onProgress && onProgress(i, p), onStage });
          runs.push(run);
          if (onRow) onRow(i, run);
        } catch (e) {
          if (q.cancelled || isCancelled(e)) break;
          runs.push(null);
          if (onRow) onRow(i, { error: e });
        }
      }
      return runs;
    } finally {
      if (queueActive === q) queueActive = null;
    }
  }

  return {
    prepare,
    dock,
    queue,
    cancel,
    running: () => !!active || !!queueActive,
    pocketOf,
    toAbs,
  };
}
