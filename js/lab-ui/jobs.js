/*
 * js/lab-ui/jobs.js: the docking job that survives a page change, and the visitor's latest docking results.
 *
 * The site is a set of static pages, so leaving the lab ends its Web Worker. What survives is this record in the
 * browser's storage: which pair, which method and which seed. Any page of the site that opens next resumes the job
 * (js/bg-dock.js) with the same inputs, shows its progress, and pops the result up when it is done. Results are kept
 * here too (the last 20) so the leaderboard and the report can list "your latest docks" next to the chain's tests,
 * and the lab can reopen one with ?result=<id> to run the docking test that records it on chain.
 *
 * Storage is per browser and best effort: every access is wrapped, and the site works without it.
 *
 *   readJob() -> job | null          writeJob(job)          clearJob()
 *   beat(job)                          marks the job as owned by this page now (heartbeat for multi-tab safety)
 *   isOrphan(job) -> bool              running and nobody's heartbeat for 6 s: the page that ran it is gone
 *   listResults() -> result[]          newest first
 *   addResult(result) -> result        (assigns id and finishedAt)
 *   getResult(id) -> result | null     markRecorded(id, { runId, tx, scoreMilli })
 *   onChange(cb) -> unsubscribe        storage events from other tabs plus local writes
 */
const JOB_KEY = 'ponchem.job';
const RESULTS_KEY = 'ponchem.results';
const MAX_RESULTS = 20;
const ORPHAN_MS = 6000;

export const TAB_ID = Math.random().toString(36).slice(2, 10);

const listeners = new Set();
function emit() { for (const cb of listeners) { try { cb(); } catch { /* listener bug */ } } }
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (e) => { if (e.key === JOB_KEY || e.key === RESULTS_KEY) emit(); });
}
export function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

function read(key) {
  try { const t = localStorage.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode or full storage */ }
  emit();
}

export function readJob() {
  const j = read(JOB_KEY);
  return j && typeof j === 'object' && j.targetId && j.ligandId ? j : null;
}
export function writeJob(job) { write(JOB_KEY, { ...job, owner: TAB_ID, beatAt: Date.now() }); }
export function clearJob() { write(JOB_KEY, null); }
export function beat(job) {
  const cur = readJob();
  if (!cur || cur.id !== job.id) return;
  try { localStorage.setItem(JOB_KEY, JSON.stringify({ ...cur, owner: TAB_ID, beatAt: Date.now(), progress: job.progress ?? cur.progress, best: job.best ?? cur.best })); } catch { /* ignore */ }
}
export function isOrphan(job) {
  if (!job || job.status !== 'running') return false;
  return !job.beatAt || Date.now() - job.beatAt > ORPHAN_MS;
}
export function newJobId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

export function listResults() {
  const r = read(RESULTS_KEY);
  return Array.isArray(r) ? r.filter((x) => x && x.id && Array.isArray(x.poseCenti)) : [];
}
export function addResult(result) {
  const all = listResults().filter((r) => r.id !== result.id);
  const entry = { ...result, id: result.id || newJobId(), finishedAt: result.finishedAt || Date.now() };
  all.unshift(entry);
  write(RESULTS_KEY, all.slice(0, MAX_RESULTS));
  return entry;
}
export function getResult(id) { return listResults().find((r) => r.id === id) || null; }
export function markRecorded(id, { runId = null, tx = null, scoreMilli = null } = {}) {
  const all = listResults();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return;
  all[i] = { ...all[i], recorded: { runId: runId === null ? null : String(runId), tx, scoreMilli, at: Date.now() } };
  write(RESULTS_KEY, all);
}

/** A storable result from a lab run object (js/lab-ui/run.js dock() output). */
export function resultOfRun(run, { jobId = null, methodJson = '' } = {}) {
  return {
    id: jobId || newJobId(),
    targetId: run.target.id, targetKey: run.target.key, targetPdb: run.target.pdbId,
    targetName: run.target.protein || run.target.key, gene: run.target.gene || run.target.key,
    ligandId: run.ligand.id, ligandKey: run.ligand.key, ligandName: run.ligand.name,
    heavyAtoms: run.view && run.view.heavyAtoms ? run.view.heavyAtoms : run.ligand.heavyAtoms,
    scoreMilli: run.score && run.score.ok ? run.score.scoreMilli : null,
    ok: !!(run.score && run.score.ok),
    poseCenti: Array.from(run.result.poseCenti),
    depthKey: run.depthKey || null, seed: run.seed >>> 0,
    method: run.method || null, methodName: run.view && run.view.methodName ? run.view.methodName : null,
    methodJson: methodJson || run.methodJson || '',
    steps: run.result.steps || null, elapsedMs: run.result.elapsedMs || null,
  };
}
