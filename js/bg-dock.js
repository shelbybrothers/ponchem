/*
 * js/bg-dock.js: keeps a docking run going when the visitor leaves the lab, on every other page of the site.
 *
 * The lab writes the running job (pair, method, seed) to js/lab-ui/jobs.js. When the lab page goes away, the next
 * page that opens finds the job without a live owner, loads the same inputs and runs the same search in its own
 * Web Worker, with a small progress chip in the corner. When it finishes, the result is stored and a dialog shows
 * it with "Open in the lab", where the docking test records it on Robinhood Chain.
 *
 * It also fills any [data-local-docks] host (the leaderboard and the report) with the visitor's latest docks from
 * this browser, each marked "Recorded" with its test link, or "Not recorded yet" with the link that records it.
 * Only chain-recorded tests enter the shared leaderboard and report tables; this list is the visitor's own.
 */
import { el } from './shell.js';
import * as jobs from './lab-ui/jobs.js';

const onLab = () => /^\/lab(\.html)?$/.test(location.pathname);
let running = false;
let chip = null;

const fmt = (milli) => (milli === null || milli === undefined ? '--' : (milli / 1000).toFixed(3));
const esc = encodeURIComponent;

export function startBackgroundDock() {
  renderLocalDocks();
  jobs.onChange(() => { renderLocalDocks(); maybeResume(); });
  if (onLab()) return; // the lab runs and resumes its own jobs
  maybeResume();
  setInterval(maybeResume, 3000);
}

async function maybeResume() {
  if (running || onLab()) return;
  const job = jobs.readJob();
  if (!job || !jobs.isOrphan(job)) return;
  running = true;
  jobs.writeJob({ ...job, status: 'running' }); // take ownership before anything slow
  const beatTimer = setInterval(() => jobs.beat(job), 2000);
  showChip(job, 0, null);
  try {
    const [catalogMod, engine, runMod] = await Promise.all([import('./catalog.js'), import('./engine/index.js'), import('./lab-ui/run.js')]);
    const cat = await catalogMod.loadCatalog();
    const target = cat.targets.find((t) => String(t.id) === String(job.targetId));
    const ligand = cat.ligands.find((l) => String(l.id) === String(job.ligandId));
    if (!target || !ligand) { jobs.clearJob(); return; }
    const runner = runMod.createRunner({ engine, catalog: catalogMod });
    const run = await runner.dock({
      target, ligand, depthKey: job.depthKey || 'standard', seed: job.seed >>> 0, method: job.method || null, methodName: job.methodName || null,
      onProgress: (p) => { job.progress = p.done; if (p.best !== null && p.best !== undefined) job.best = p.best; showChip(job, p.done, job.best); },
    });
    const saved = jobs.addResult(jobs.resultOfRun(run, { jobId: job.id, methodJson: run.result.methodCompact || '' }));
    jobs.clearJob();
    hideChip();
    showResultDialog(saved, engine);
  } catch (e) {
    console.warn('background dock', e);
    const cur = jobs.readJob();
    if (cur && cur.id === job.id) jobs.clearJob();
    hideChip();
  } finally {
    clearInterval(beatTimer);
    running = false;
  }
}

function showChip(job, done, best) {
  if (!chip) {
    chip = el('a', { class: 'pc-bgdock', href: '/lab', 'aria-live': 'polite' }, [
      el('span', { class: 'pc-bgdock-title' }, 'Docking in the background'),
      el('span', { class: 'pc-bgdock-pair', 'data-pair': '' }),
      el('span', { class: 'pc-bgdock-track' }, [el('span', { class: 'pc-bgdock-fill', 'data-fill': '' })]),
      el('span', { class: 'pc-bgdock-meta', 'data-meta': '' }),
    ]);
    document.body.append(chip);
  }
  const pct = Math.max(0, Math.min(100, Math.round((done || 0) * 100)));
  chip.querySelector('[data-pair]').textContent = `${job.ligandName || 'Ligand'} into ${job.gene || 'target'} (${job.pdbId || ''})`;
  chip.querySelector('[data-fill]').style.width = `${Math.max(3, pct)}%`;
  chip.querySelector('[data-meta]').textContent = `${pct}% · best so far ${fmt(best)} kcal/mol`;
}
function hideChip() { if (chip) { chip.remove(); chip = null; } }

function showResultDialog(saved, engine) {
  let d = null;
  try { d = saved.ok && engine.derived ? engine.derived(saved.scoreMilli, saved.heavyAtoms) : null; } catch { d = null; }
  const dialog = el('dialog', { class: 'pc-bgdock-dialog', 'aria-labelledby': 'pc-bgdock-h' }, [
    el('p', { class: 'pc-bgdock-eyebrow' }, 'Docking finished'),
    el('h2', { id: 'pc-bgdock-h' }, `${saved.ligandName} into ${saved.gene} (${saved.targetPdb})`),
    el('dl', { class: 'pc-bgdock-stats' }, [
      el('div', {}, [el('dt', {}, 'Binding free energy'), el('dd', {}, saved.ok ? `${fmt(saved.scoreMilli)} kcal/mol` : 'The pose failed the geometry checks')]),
      d ? el('div', {}, [el('dt', {}, 'pKd'), el('dd', {}, d.pKd.toFixed(2))]) : null,
      d ? el('div', {}, [el('dt', {}, 'Ligand efficiency'), el('dd', {}, `${d.le.toFixed(3)} kcal/mol per heavy atom`)]) : null,
      d && d.bandLabel ? el('div', {}, [el('dt', {}, 'Band'), el('dd', {}, d.bandLabel)]) : null,
    ].filter(Boolean)),
    el('p', { class: 'pc-bgdock-note' }, 'Open it in the lab and run the docking test to record it on Robinhood Chain. Recorded tests appear on the leaderboard and in the report.'),
    el('div', { class: 'pc-bgdock-actions' }, [
      el('a', { class: 'pc-btn', href: `/lab?result=${esc(saved.id)}` }, 'Open in the lab'),
      el('button', { class: 'pc-btn pc-btn--outline', type: 'button', 'data-close': '' }, 'Close'),
    ]),
  ]);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

function renderLocalDocks() {
  const hosts = document.querySelectorAll('[data-local-docks]');
  if (!hosts.length) return;
  const list = jobs.listResults();
  for (const host of hosts) {
    host.hidden = list.length === 0;
    if (!list.length) { host.replaceChildren(); continue; }
    const rows = list.slice(0, 10).map((r) => el('tr', {}, [
      el('td', {}, [el('span', { class: 'pc-mono' }, `${r.ligandName} into ${r.gene}`), el('span', { class: 'pc-local-sub' }, ` ${r.targetPdb}`)]),
      el('td', { class: 'pc-mono' }, r.ok ? fmt(r.scoreMilli) : 'failed'),
      el('td', {}, new Date(r.finishedAt).toLocaleString()),
      el('td', {}, r.recorded && r.recorded.runId
        ? el('a', { href: `/run?id=${esc(r.recorded.runId)}` }, `Recorded · test #${r.recorded.runId}`)
        : el('a', { href: `/lab?result=${esc(r.id)}` }, 'Not recorded yet · run docking test')),
    ]));
    host.replaceChildren(
      el('div', { class: 'pc-local-head' }, [
        el('h2', {}, 'Your latest docks'),
        el('p', {}, 'Kept in this browser. A dock joins the shared tables once its docking test is recorded on chain.'),
      ]),
      el('div', { class: 'pc-local-scroll' }, [el('table', { class: 'pc-local-table' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, 'Pair'), el('th', {}, 'dG kcal/mol'), el('th', {}, 'Finished'), el('th', {}, 'Status')])),
        el('tbody', {}, rows),
      ])]),
    );
  }
}
