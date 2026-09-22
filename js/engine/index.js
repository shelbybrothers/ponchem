/*
 * js/engine/index.js: the browser docking engine, main-thread API (SPEC.md section 8.1).
 *
 *   parseSdf(text)                        -> { atoms: [{ el, x, y, z }], bonds: [[i, j, order]] }   heavy atoms only, SDF order
 *   loadPocket(bytes)                     -> Pocket   { pdbId, n, center, half, atoms, types, hash, ... }
 *   loadTopology(bytes)                   -> Topology { n, types, bonds, pairs12, pairs13, nrot, hash, ... }
 *   ensureTables({ bytes?, url? })        -> Promise<tables>   loads data/tables/tables.bin once and verifies its keccak256
 *   scoreInt(pocket, topology, poseCenti) -> { ok, reason, scoreMilli, terms: { g1, g2, rep, hyd, hb, pairs } }   (tables must be loaded)
 *   dock({ pocket, topology, ligand, method?, seed, budgetMs | steps, onProgress, tables?, chains?, candidates? }) -> Promise<Result>
 *       method: a method object or its compact JSON (SPEC.md 9.7, js/engine/method.js); a value in the method beats the
 *       same value passed as a parameter (budgetMs, steps, chains, candidates, seed), a parameter fills a key the method
 *       leaves out, then the schema defaults apply. An invalid method rejects with an Error named 'MethodError' whose
 *       .errors lists every sentence. chains defaults to one chain per about 600 + 60 Nrot steps (4 to 16), from the
 *       probe's step estimate in budget.ms mode or from the step count; the Result records `chains`.
 *       runs in a module Worker (js/engine/worker.js); falls back to the main thread when Workers are unavailable
 *       or the worker fails to load. One run at a time: a second dock() while one runs rejects with 'engine busy'.
 *       onProgress({ stage, done: 0..1, best: scoreMilli | null, evaluations, steps })
 *         stage 'prepare' | 'search' | 'refine' | 'score' | 'done'; best during the search is the browser estimate
 *         (float affinity in milli kcal/mol); at 'done' it is the integer score.
 *       Result { poseCenti: Int16Array, scoreMilli, poseAbs: Float64Array, checks: { ok, reason }, elapsedMs, evaluations,
 *                seed, steps, chains, method, methodCompact, methodRequested, terms, nrot, heavyAtoms, float, polish,
 *                search, timings, pocketHash, topologyHash }
 *         method is the reproducible form (budget as the steps run, the chain count used, the seed): dock({ method: result.method })
 *         replays the run exactly; methodCompact is its canonical JSON (the on-chain string); methodRequested is the
 *         resolved method as asked (budget in ms when it was).
 *   cancel()                              -> rejects the pending dock() with an Error named 'CancelledError'
 *   derived(scoreMilli, heavyAtoms)       -> { dG, pKd, kd, le, band, bandLabel }   plus band(), bandLabel(), formatKd(), formatDg()
 *   encodePose / decodePose               -> the 6-bytes-per-atom pose bytes of submitRun
 *   METHOD_SCHEMA, METHOD_PRESETS, METHOD_DEFAULTS, validateMethod, resolveMethod, methodToCompact, methodToQuery,
 *   methodFromQuery, methodEquals, presetByName   (re-exported from ./method.js)
 *
 * Determinism: same pocket, topology, ligand, method and seed give the same pose and score on any machine.
 * budget.ms picks the step count from a timing probe; the Result records `steps` so the run can be replayed.
 */
import { parseSdf } from './sdf.js';
import { loadPocket, loadTopology, encodePose, decodePose } from './format.js';
import { ensureTables, getTables, tablesLoaded, TABLES_KECCAK } from './tables.js';
import { scoreInt, checkGeometry, pairTerms, CODES, TYPE_NAMES } from './score.js';
import { derived, band, bandLabel, formatKd, formatDg, BANDS } from './derived.js';
import { runDock, CancelledError, MethodError, resolveDockMethod } from './core.js';
import { rotatableBonds } from './ligand.js';
import {
  METHOD_SCHEMA, METHOD_PRESETS, METHOD_DEFAULTS, METHOD_VERSION, METHOD_MAX_BYTES, METHOD_NAME_MAX,
  validateMethod, resolveMethod, methodToCompact, methodToQuery, methodFromQuery, methodEquals, presetByName,
} from './method.js';

export {
  parseSdf, loadPocket, loadTopology, encodePose, decodePose,
  ensureTables, getTables, tablesLoaded, TABLES_KECCAK,
  scoreInt, checkGeometry, pairTerms, CODES, TYPE_NAMES,
  derived, band, bandLabel, formatKd, formatDg, BANDS,
  rotatableBonds, CancelledError, MethodError, resolveDockMethod,
  METHOD_SCHEMA, METHOD_PRESETS, METHOD_DEFAULTS, METHOD_VERSION, METHOD_MAX_BYTES, METHOD_NAME_MAX,
  validateMethod, resolveMethod, methodToCompact, methodToQuery, methodFromQuery, methodEquals, presetByName,
};

export const WORKER_URL = new URL('./worker.js', import.meta.url);
const READY_TIMEOUT_MS = 4000;

let worker = null;        // { w, ready: Promise<boolean> }
let job = null;           // { id, reject, cancelled, inThread }
let nextId = 1;
let runMode = null;       // 'worker' | 'thread' for the last dock() that started

/** 'worker' when the last dock() ran in the Web Worker, 'thread' when it ran on the main thread, null before any run. */
export function lastRunMode() { return runMode; }

function hasWorkers() {
  return typeof Worker === 'function' && typeof window !== 'undefined';
}

function spawn() {
  if (worker) return worker;
  let w;
  try {
    w = new Worker(WORKER_URL, { type: 'module' });
  } catch (e) {
    return null;
  }
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const timer = setTimeout(() => resolveReady(false), READY_TIMEOUT_MS);
  w.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'ready') { clearTimeout(timer); resolveReady(true); return; }
    if (!job || m.id !== job.id) return;
    if (m.type === 'progress') { if (job.onProgress) job.onProgress({ stage: m.stage, done: m.done, best: m.best, evaluations: m.evaluations, steps: m.steps, poseAbs: m.poseAbs || null }); }
    else if (m.type === 'result') { const j = job; job = null; j.resolve(m.result); }
    else if (m.type === 'error') { const j = job; job = null; j.reject(m.cancelled ? new CancelledError() : new Error(m.message)); }
  });
  w.addEventListener('error', (ev) => {
    clearTimeout(timer);
    resolveReady(false);
    if (job && !job.inThread) { const j = job; job = null; j.reject(new Error(`engine worker failed: ${ev.message || 'load error'}`)); }
  });
  worker = { w, ready };
  return worker;
}

function bytesOf(x, what) {
  if (x instanceof Uint8Array) return x;
  if (x && x.bytes instanceof Uint8Array) return x.bytes;
  throw new Error(`${what}: pass the loaded object (from loadPocket/loadTopology) or its bytes`);
}

/** Start a docking run. See the header for parameters and the Result shape. */
export function dock(params) {
  if (job) return Promise.reject(new Error('engine busy'));
  const { pocket, topology, ligand, method = null, budgetMs = null, steps = null, onProgress = null, tables = null } = params || {};
  let pocketBytes, topologyBytes, lig, resolved;
  try {
    pocketBytes = bytesOf(pocket, 'pocket');
    topologyBytes = bytesOf(topology, 'topology');
    lig = typeof ligand === 'string' ? parseSdf(ligand) : ligand;
    if (!lig || !Array.isArray(lig.atoms)) throw new Error('ligand must be parseSdf output');
    if (budgetMs == null && steps == null && method == null) throw new Error('dock needs budgetMs, steps or a method');
    resolved = resolveDockMethod(params);   // the merge rule of core.js; throws MethodError with every sentence in .errors
  } catch (e) {
    return Promise.reject(e);
  }
  const seed = resolved.seed;
  const id = nextId++;
  return new Promise(async (resolve, reject) => {
    job = { id, resolve, reject, onProgress, cancelled: false, inThread: false };
    const inThread = async () => {
      job.inThread = true;
      runMode = 'thread';
      try {
        const result = await runDock({
          pocketBytes, topologyBytes, ligand: lig, method: resolved.method, seed, tables,
          onProgress: (p) => { if (job && job.id === id && onProgress) onProgress(p); },
          shouldCancel: () => !job || job.id !== id || job.cancelled,
        });
        if (job && job.id === id) { job = null; resolve(result); }
      } catch (e) {
        if (job && job.id === id) job = null;
        reject(e);
      }
    };
    if (!hasWorkers()) return inThread();
    const wk = spawn();
    if (!wk) return inThread();
    try {
      const ok = await wk.ready;
      if (!job || job.id !== id) return;   // already settled
      if (job.cancelled) { job = null; return reject(new CancelledError()); }   // cancelled while the worker was loading
      if (!ok) { worker = null; return inThread(); }
      runMode = 'worker';
      const plain = { atoms: lig.atoms.map((a) => ({ el: a.el, x: a.x, y: a.y, z: a.z, charge: a.charge || 0, hcount: a.hcount || 0 })), bonds: lig.bonds.map((b) => b.slice()) };
      wk.w.postMessage({ type: 'start', id, pocket: pocketBytes, topology: topologyBytes, ligand: plain, method: resolved.method, seed, tables });
    } catch (e) {
      if (job && job.id === id) job = null;
      reject(e);
    }
  });
}

/** Cancel the pending run (its promise rejects with CancelledError). A worker that does not answer in 1.5 s is terminated. */
export function cancel() {
  if (!job) return false;
  const j = job;
  j.cancelled = true;
  if (j.inThread) return true;
  if (worker) {
    worker.w.postMessage({ type: 'cancel', id: j.id });
    const w = worker;
    setTimeout(() => {
      if (job === j) {
        job = null;
        try { w.w.terminate(); } catch (e) { /* gone */ }
        if (worker === w) worker = null;
        j.reject(new CancelledError());
      }
    }, 1500);
  }
  return true;
}

/** true while a run is pending */
export function busy() { return job !== null; }
