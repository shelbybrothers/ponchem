#!/usr/bin/env node
/*
 * tools/engine-bench.mjs: speed and reach of the browser docking engine.
 *
 *   node tools/engine-bench.mjs                       AQ4, QUE, TA1 on 1M17 in Node, budgets 10 s and 30 s, seed 1
 *   node tools/engine-bench.mjs --budgets 10,30,60    other budgets (seconds)
 *   node tools/engine-bench.mjs --ligands QUE         a subset (AQ4 erlotinib, QUE quercetin, TA1 paclitaxel)
 *   node tools/engine-bench.mjs --seed 3
 *   node tools/engine-bench.mjs --chrome              the same runs in headless Chrome through the Worker path, served
 *                                                     by this script's own static server on port 6134 (production CSP)
 *                                                     with Chrome on CDP port 9543 (env ENGINE_PORT / ENGINE_CDP)
 *   node tools/engine-bench.mjs --chrome-only         the Chrome runs without the Node runs
 *   node tools/engine-bench.mjs --json out.json       also write every run's numbers
 *   node tools/engine-bench.mjs --method "Wide search"  dock with a preset (by name), a method JSON text or a ?method= value
 *                                                     instead of the plain budgets (the budgets list is ignored)
 *   node tools/engine-bench.mjs --presets             every preset on every ligand (the presets table of notes/engine.md)
 *
 * For every run it prints steps/s, evaluations, the best browser estimate against elapsed time (samples from the
 * progress callback) and the final integer score with the polish statistics. The pocket and topologies come from
 * data/vectors (the 1M17 pocket bytes and the AQ4 / QUE / TA1 topology bytes registered there), the ligand
 * coordinates from tools/engine/fixtures/<CCD>_ideal.sdf.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_PORT = Number(process.env.ENGINE_PORT || 6134);
export const ENGINE_CDP = Number(process.env.ENGINE_CDP || 9543);

export const LIGANDS = {
  AQ4: { name: 'erlotinib', vector: 'real_02_1M17_AQ4_refined.json', sdf: 'tools/engine/fixtures/AQ4_ideal.sdf' },
  QUE: { name: 'quercetin', vector: 'real_03_1M17_QUE_docked.json', sdf: 'tools/engine/fixtures/QUE_ideal.sdf' },
  TA1: { name: 'paclitaxel', vector: 'real_04_1M17_TA1_docked.json', sdf: 'tools/engine/fixtures/TA1_ideal.sdf' },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.bin': 'application/octet-stream', '.sdf': 'chemical/x-mdl-sdfile', '.pdb': 'chemical/x-pdb', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// The bench page: no inline script (CSP), one module that reads its job from the query string.
const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ponchem engine bench</title></head>
<body><p id="status">engine bench</p><script type="module" src="/__engine-bench.js"></script></body></html>
`;
const PAGE_JS = `
import { dock, scoreInt, loadPocket, loadTopology, decodePose, parseSdf, ensureTables, lastRunMode, methodFromQuery } from '/js/engine/index.js';
import { hexToBytes } from '/js/engine/keccak.js';
const q = new URLSearchParams(location.search);
const log = (tag, obj) => console.log(tag + ' ' + JSON.stringify(obj));
const status = document.getElementById('status');
(async () => {
  try {
    const mode = q.get('mode') || 'dock';
    if (mode === 'vectors') {
      await ensureTables();
      const idx = await (await fetch('/data/vectors/index.json')).json();
      const out = [];
      for (const f of idx.files) {
        if (f.kind === 'tables' || f.kind === 'terms') continue;
        const v = await (await fetch('/data/vectors/' + f.file)).json();
        const r = scoreInt(loadPocket(hexToBytes(v.pocket_hex)), loadTopology(hexToBytes(v.topology_hex)), decodePose(hexToBytes(v.pose_hex)));
        out.push({ name: f.name, code: r.code, scoreMilli: r.scoreMilli, expect_code: v.expect_code, expect: v.expect_score_milli });
      }
      log('ENGINE_RESULT', { mode, vectors: out });
      return;
    }
    const v = await (await fetch('/data/vectors/' + q.get('vector'))).json();
    const lig = parseSdf(await (await fetch('/' + q.get('sdf'))).text());
    const seed = q.get('seed') ? Number(q.get('seed')) : undefined;
    const budgetMs = q.get('budget') ? Number(q.get('budget')) : null;
    const steps = q.get('steps') ? Number(q.get('steps')) : null;
    let method = null;
    if (q.get('method')) {
      const m = methodFromQuery(q.get('method'));
      if (!m.ok) throw Object.assign(new Error(m.errors[0]), { name: 'MethodError', errors: m.errors });
      method = m.method;
    }
    const t0 = performance.now();
    const samples = [];
    const r = await dock({ pocket: hexToBytes(v.pocket_hex), topology: hexToBytes(v.topology_hex), ligand: lig, seed, budgetMs, steps, method,
      onProgress: (p) => { samples.push({ t: Math.round(performance.now() - t0), stage: p.stage, done: p.done, best: p.best, steps: p.steps, evaluations: p.evaluations }); status.textContent = p.stage + ' ' + p.done.toFixed(2); } });
    log('ENGINE_RESULT', { mode, runMode: lastRunMode(), samples,
      result: { ...r, poseCenti: Array.from(r.poseCenti), poseAbs: Array.from(r.poseAbs), terms: r.terms ? { ...r.terms, ePico: String(r.terms.ePico) } : null } });
  } catch (e) {
    log('ENGINE_ERROR', { message: e.message, name: e.name, stack: String(e.stack).slice(0, 600) });
  }
})();
`;

/** Static server over the project root with the production CSP plus the two virtual bench files. */
export async function serveSite(port = ENGINE_PORT) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const csp = cfg.headers.find((h) => h.source === '/(.*)').headers.find((h) => /^content-security-policy$/i.test(h.key)).value;
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    res.setHeader('content-security-policy', csp);
    res.setHeader('cache-control', 'no-store');
    if (p === '/__engine-bench.html') { res.setHeader('content-type', MIME['.html']); return res.end(PAGE_HTML); }
    if (p === '/__engine-bench.js') { res.setHeader('content-type', MIME['.js']); return res.end(PAGE_JS); }
    if (p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`port ${port} is not free (${e.code}); this bench only uses port ${port}`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Headless Chrome on the engine's CDP port. run(query, timeoutMs) opens the bench page and returns its ENGINE_RESULT. */
export async function chromeSession({ base, cdpPort = ENGINE_CDP } = {}) {
  const { launchChrome, openPage, sleep } = await import('./lib/cdp.mjs');
  const tmpRoot = fs.existsSync(path.join(ROOT, '.tmp')) ? path.join(ROOT, '.tmp') : os.tmpdir();
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'chrome-engine-'));
  const chrome = await launchChrome({ port: cdpPort, profile });
  return {
    version: chrome.version,
    async run(query, timeoutMs = 120000) {
      const page = await openPage({ port: cdpPort, width: 800, height: 600 });
      let result = null, error = null;
      const violations = [];
      page.on('Runtime.consoleAPICalled', (p) => {
        const text = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
        if (text.startsWith('ENGINE_RESULT ')) { try { result = JSON.parse(text.slice('ENGINE_RESULT '.length)); } catch (e) { error = 'bad ENGINE_RESULT json'; } }
        if (text.startsWith('ENGINE_ERROR ')) { try { error = JSON.parse(text.slice('ENGINE_ERROR '.length)); } catch (e) { error = text; } }
      });
      page.on('Log.entryAdded', (p) => { const e = p.entry || {}; if (/Content Security Policy/i.test(e.text || '')) violations.push(e.text); });
      await page.goto(`${base}/__engine-bench.html?${query}`, { settle: 100 });
      const t0 = Date.now();
      while (!result && !error && Date.now() - t0 < timeoutMs) await sleep(100);
      const errors = page.errors.map((e) => `${e.kind}: ${e.text.slice(0, 300)}`);
      await page.close();
      if (!result && !error) error = `no ENGINE_RESULT within ${timeoutMs} ms`;
      return { result, error, violations, errors };
    },
    async close() {
      await chrome.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

export function loadCase(code) {
  const c = LIGANDS[code];
  if (!c) throw new Error(`unknown ligand ${code}; use ${Object.keys(LIGANDS).join(', ')}`);
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vectors', c.vector), 'utf8'));
  return { code, ...c, vector: c.vector, v, sdfText: fs.readFileSync(path.join(ROOT, c.sdf), 'utf8') };
}

function fmtSamples(samples, budgetMs) {
  // best browser estimate at about 10 %, 25 %, 50 %, 75 %, 100 % of the budget
  const marks = [0.1, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * budgetMs));
  const out = [];
  for (const m of marks) {
    let pick = null;
    for (const s of samples) { if (s.t <= m && s.best != null) pick = s; }
    out.push(`${(m / 1000).toFixed(0)}s ${pick ? (pick.best / 1000).toFixed(2) : '-'}`);
  }
  return out.join('  ');
}

/** A --method value: a preset name, a method JSON text or a ?method= base64url value; null when not given. */
export async function parseMethodArg(text) {
  if (!text) return null;
  const { presetByName, validateMethod, methodFromQuery } = await import('../js/engine/method.js');
  const preset = presetByName(text);
  if (preset) return preset;
  const r = text.trim().startsWith('{') ? validateMethod(text) : methodFromQuery(text);
  if (!r.ok) throw new Error(`--method: ${r.errors.join(' ')}`);
  return r.method;
}

async function runNode(code, budgetS, seed, method = null) {
  const { dock } = await import('../js/engine/index.js');
  const { parseSdf } = await import('../js/engine/sdf.js');
  const { hexToBytes } = await import('../js/engine/keccak.js');
  const c = loadCase(code);
  const lig = parseSdf(c.sdfText);
  const t0 = performance.now();
  const samples = [];
  const r = await dock({ pocket: hexToBytes(c.v.pocket_hex), topology: hexToBytes(c.v.topology_hex), ligand: lig, seed, budgetMs: method ? null : budgetS * 1000, method,
    onProgress: (p) => samples.push({ t: Math.round(performance.now() - t0), best: p.best, stage: p.stage, steps: p.steps }) });
  return { r, samples };
}

/** The label of a run: "10 s" for a budget, the method name plus its budget for a method run. */
function labelOf(budgetS, method) {
  if (!method) return `${budgetS} s`;
  return `${method.name} (${method.budget.ms != null ? `${method.budget.ms / 1000} s` : `${method.budget.steps} steps`})`;
}

function printRun(where, code, budgetS, r, samples, method = null) {
  const c = LIGANDS[code];
  console.log(`  ${where} ${code} ${c.name} ${labelOf(budgetS, method)}: score ${r.scoreMilli} (${r.checks.reason})  steps ${r.steps}  chains ${r.chains}  ${r.search.stepsPerSecond} steps/s  ${r.evaluations} evals  ${Math.round(r.evaluations / Math.max(r.timings.searchMs, 1) * 1000)} evals/s  elapsed ${r.elapsedMs} ms`);
  console.log(`      best vs time: ${fmtSamples(samples, budgetS * 1000)}   final integer ${(r.scoreMilli / 1000).toFixed(3)}`);
  console.log(`      polish: nudged ${r.polish.nudged} (rounds ${r.polish.nudgeRounds}, kicks ${r.polish.kicks}), lattice ${r.polish.latticeAccepted}/${r.polish.latticeTried} gain ${r.polish.latticeGain} milli, candidates ok ${r.polish.candidatesOk}/${r.polish.candidates} nudged ${r.polish.candidatesNudged}  scores ${JSON.stringify(r.polish.candidateScores)}`);
  console.log(`      timings ${JSON.stringify(r.timings)}  float inter ${r.float.inter.toFixed(3)} intra ${r.float.intra.toFixed(3)} box ${r.float.box.toFixed(3)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const budgets = opt('--budgets', '10,30').split(',').map(Number).filter((x) => x > 0);
  const ligands = opt('--ligands', 'AQ4,QUE,TA1').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const seed = Number(opt('--seed', 1));
  const chromeOnly = args.includes('--chrome-only');
  const chrome = args.includes('--chrome') || chromeOnly;
  const jsonOut = opt('--json', null);
  const { METHOD_PRESETS, methodToQuery } = await import('../js/engine/method.js');
  const oneMethod = await parseMethodArg(opt('--method', null));
  // each job is a budget (method null) or a method; --presets runs every preset, --method one method
  const jobs = args.includes('--presets') ? METHOD_PRESETS.map((m) => ({ budgetS: m.budget.ms != null ? m.budget.ms / 1000 : 0, method: m }))
    : oneMethod ? [{ budgetS: oneMethod.budget.ms != null ? oneMethod.budget.ms / 1000 : 0, method: oneMethod }]
      : budgets.map((b) => ({ budgetS: b, method: null }));
  const rows = [];
  console.log(`engine bench: node ${process.version}, ${os.cpus()[0]?.model || 'cpu'}, seed ${seed}, ${jobs[0].method ? `methods ${jobs.map((j) => j.method.name).join(' / ')}` : `budgets ${budgets.join('/')} s`}, ligands ${ligands.join(', ')}`);
  if (!chromeOnly) console.log('Node (in-thread fallback path):');
  for (const code of chromeOnly ? [] : ligands) {
    for (const { budgetS, method } of jobs) {
      const { r, samples } = await runNode(code, budgetS, seed, method);
      printRun('node', code, budgetS, r, samples, method);
      rows.push({ where: 'node', ligand: code, budgetS, method: method ? method.name : null, seed, scoreMilli: r.scoreMilli, steps: r.steps, chains: r.chains, stepsPerSecond: r.search.stepsPerSecond, evaluations: r.evaluations, elapsedMs: r.elapsedMs, polish: r.polish, timings: r.timings, samples });
    }
  }
  if (chrome) {
    console.log(`Chrome (Worker path) via http://127.0.0.1:${ENGINE_PORT} and CDP ${ENGINE_CDP}:`);
    const site = await serveSite(ENGINE_PORT);
    let session = null;
    try {
      session = await chromeSession({ base: site.base, cdpPort: ENGINE_CDP });
      console.log(`  ${session.version}`);
      for (const code of ligands) {
        for (const { budgetS: b, method } of jobs) {
          const c = LIGANDS[code];
          const q = method ? `mode=dock&vector=${c.vector}&sdf=${c.sdf}&seed=${seed}&method=${methodToQuery(method)}` : `mode=dock&vector=${c.vector}&sdf=${c.sdf}&seed=${seed}&budget=${b * 1000}`;
          const out = await session.run(q, (b || 120) * 1000 + 90000);
          if (!out.result) { console.log(`  chrome ${code} ${labelOf(b, method)}: FAILED ${JSON.stringify(out.error)} ${out.errors.join(' | ')} ${out.violations.join(' | ')}`); continue; }
          const r = out.result.result;
          printRun(`chrome[${out.result.runMode}]`, code, b, r, out.result.samples, method);
          if (out.violations.length) console.log(`      CSP violations: ${out.violations.join(' | ')}`);
          if (out.errors.length) console.log(`      console errors: ${out.errors.join(' | ')}`);
          rows.push({ where: `chrome-${out.result.runMode}`, ligand: code, budgetS: b, method: method ? method.name : null, seed, scoreMilli: r.scoreMilli, steps: r.steps, chains: r.chains, stepsPerSecond: r.search.stepsPerSecond, evaluations: r.evaluations, elapsedMs: r.elapsedMs, polish: r.polish, timings: r.timings, samples: out.result.samples });
        }
      }
    } finally {
      if (session) await session.close();
      await site.close();
    }
  }
  console.log('summary:');
  for (const row of rows) console.log(`  ${row.where.padEnd(14)} ${row.ligand} ${(row.method ? row.method : `${row.budgetS} s`).padEnd(14)} score ${String(row.scoreMilli).padStart(6)}  ${String(row.stepsPerSecond).padStart(5)} steps/s  ${row.steps} steps  ${row.chains} chains  ${row.elapsedMs} ms`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
