/*
 * js/engine/worker.js: the docking Web Worker (module worker). One job at a time.
 *
 * main -> worker
 *   { type: 'start', id, pocket: Uint8Array (pocket bytes), topology: Uint8Array, ligand: parseSdf output,
 *     method?: resolved method object (SPEC.md 9.7), seed, budgetMs | steps,
 *     tables?: Uint8Array (tables.bin; fetched from data/tables/tables.bin when absent), chains?, candidates? }
 *   { type: 'cancel', id }
 * worker -> main
 *   { type: 'ready' }                                            once, at load
 *   { type: 'progress', id, stage, done, best, evaluations, steps }
 *   { type: 'result', id, result }                               Result of SPEC.md 8.1 (typed arrays cloned)
 *   { type: 'error', id, message, cancelled }
 * The search yields to the event loop between blocks (~40 ms), so a cancel message is honoured within a block.
 */
import { runDock, CancelledError } from './core.js';

let current = null;   // { id, cancelled }

const yieldFn = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'cancel') {
    if (current && current.id === msg.id) current.cancelled = true;
    return;
  }
  if (msg.type !== 'start') return;
  if (current) {
    self.postMessage({ type: 'error', id: msg.id, message: 'worker busy', cancelled: false });
    return;
  }
  const job = { id: msg.id, cancelled: false };
  current = job;
  try {
    const result = await runDock({
      pocketBytes: msg.pocket,
      topologyBytes: msg.topology,
      ligand: msg.ligand,
      method: msg.method ?? null,
      seed: msg.seed,
      budgetMs: msg.budgetMs ?? null,
      steps: msg.steps ?? null,
      tables: msg.tables || null,
      chains: msg.chains,
      candidates: msg.candidates,
      shouldCancel: () => job.cancelled,
      yieldFn,
      onProgress: (p) => self.postMessage({ type: 'progress', id: job.id, ...p }),
    });
    self.postMessage({ type: 'result', id: job.id, result });
  } catch (e) {
    const cancelled = e instanceof CancelledError || !!(e && e.cancelled);
    self.postMessage({ type: 'error', id: job.id, message: cancelled ? 'cancelled' : (e && e.message) || String(e), cancelled });
  } finally {
    current = null;
  }
};

self.postMessage({ type: 'ready' });
