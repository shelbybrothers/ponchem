#!/usr/bin/env node
/*
 * pages-test.mjs: every page (pages builder) in real headless Chrome at 390 and 1280, including the v2 pages
 * /run?id=1 (the not-found state without a chain), /dashboard (the no-wallet state) and the /wallet forwarder.
 *
 *   node tools/pages-test.mjs                         starts its own dev server on PORT (default 6131) unless one answers
 *   node tools/pages-test.mjs --base http://127.0.0.1:6131
 *   node tools/pages-test.mjs --rpc http://127.0.0.1:8545 --contract 0x...    drive the pages against a local chain
 *                                                     (the localhost-only ?rpc= and ?contract= overrides of js/rpc.js)
 *   CHROME_PORT=9540 (default)                        the DevTools port
 *
 * Per page and width: HTTP status, no horizontal overflow, no console error, no failed request (the modules other
 * builders have not shipped yet are listed and their 404s tolerated ONLY while the file is absent on disk), the copy
 * deck's key strings, the blank $PONCHEM state, the footer line, and a full-page screenshot in .tmp/shots/ (not shipped).
 * Without a chain the pages must show the not-live state; with --rpc/--contract the chain data must render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage, sleep } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(process.env.PORT || 6131);
const base = (flag('base', `http://127.0.0.1:${PORT}`)).replace(/\/$/, '');
const CHROME_PORT = Number(process.env.CHROME_PORT || 9540);
const RPC = flag('rpc', null);
const CONTRACT = flag('contract', null);
const withChain = !!(RPC && CONTRACT);
const ONLY = flag('only', null); // --only H runs only the stubbed live-chain scenario
const SHOTS = path.join(ROOT, '.tmp', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const exists = (f) => fs.existsSync(path.join(ROOT, f));
// modules the pages import that other builders may not have shipped yet: a 404 for one of these is tolerated while
// the file is absent on disk, and named in the report
const OPTIONAL = ['js/catalog.js', 'js/chain.js', 'js/lab.js', 'js/viewer.js', 'js/engine/derived.js', 'js/engine/score.js', 'js/engine/index.js', 'js/engine/method.js', 'js/gamify.js', 'data/registry.json', 'api/report.js', 'api/runs.js', 'api/status.js', 'api/analyze.js',
  // the manifest's PNG icons (the plumbing author renders them from img/brand/favicon.svg); Chrome fetches one per page load
  'img/brand/icon-192.png', 'img/brand/icon-512.png', 'img/brand/icon-maskable-192.png', 'img/brand/icon-maskable-512.png'];
const absent = OPTIONAL.filter((f) => !exists(f));
const tolerated = (url) => {
  const p = new URL(url, base).pathname;
  if (absent.includes(p.slice(1))) return true;
  if (p === '/api/report.md' && !exists('api/report.js')) return true;
  if (p === '/api/analyze' && !exists('api/analyze.js')) return true;
  return false;
};

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => { if (cond) { passed++; console.log(`  ok    ${name}`); } else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); } };

// ---------------------------------------------------------------------------------------------------------
// dev server

async function listening(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.status > 0; } catch { return false; } }
let server = null;
if (!(await listening(`${base}/robots.txt`))) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) { console.error(`nothing answers at ${base}`); process.exit(2); }
  server = spawn(process.execPath, ['tools/dev.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(new URL(base).port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`  dev: ${d}`));
  for (let i = 0; i < 50 && !(await listening(`${base}/robots.txt`)); i++) await sleep(100);
  if (!(await listening(`${base}/robots.txt`))) { console.error('the dev server did not start'); process.exit(2); }
}
const stopServer = async () => { if (server) { server.kill('SIGTERM'); await sleep(200); if (server.exitCode === null) server.kill('SIGKILL'); server = null; } };
process.on('exit', () => { if (server) try { server.kill('SIGKILL'); } catch { /* gone */ } });

// ---------------------------------------------------------------------------------------------------------
// what each page must show (strings from docs/copy.md)

const FOOTER = '2026 Pons Lab CADD (Computer-aided Drug Design)';
const suffix = withChain ? `rpc=${encodeURIComponent(RPC)}&contract=${encodeURIComponent(CONTRACT)}` : '';
const withQuery = (route) => (suffix ? `${route}${route.includes('?') ? '&' : '?'}${suffix}` : route);

const PAGES = [
  { route: '/', title: 'Ponchem · On-chain drug design', h1: 'Computer-aided drug design, scored on chain.',
    texts: ['Three things you can trust', 'Every docking test is paid, scored and reviewed', 'Four steps, one record', 'What the number means', 'What the contract checks before it believes a pose', 'Targets people are docking this week', 'The lab token launches on ponsfamily.com', '100 $PONCHEM or 0.0001 ETH', 'Dock something today.', 'Buy $PONCHEM · soon', 'CA posts here at launch', 'Docking tests', 'Reviews', 'In prize pools'],
    ready: () => !!document.querySelector('[data-featured] .pc-card--link') && /^\d/.test(document.querySelector('[data-stat="targets"]').textContent.trim()),
    settle: 2500,
    extra: () => ({
      featured: document.querySelectorAll('[data-featured] .pc-card--link').length,
      targets: document.querySelector('[data-stat="targets"]').textContent.trim(),
      hero: document.querySelector('[data-hero-viewer] canvas') ? 'canvas' : document.querySelector('[data-hero-viewer] .pc-viewer-img--solo') ? 'image' : document.querySelector('[data-hero-viewer] img') ? 'loading' : 'empty',
      caption: document.querySelector('[data-hero-caption]').textContent,
      weights: [...document.querySelectorAll('[data-weight]')].map((c) => c.textContent),
    }),
    assert: (x, tag) => {
      check(`${tag}: six featured targets`, x.featured === 6, `got ${x.featured}`);
      check(`${tag}: hero caption names a structure`, /^In the viewer: [0-9][A-Z0-9]{3} · .+ · [\d.]+ A · /.test(x.caption), x.caption);
      check(`${tag}: five weights printed`, x.weights.join(',') === '-0.0356,-0.00516,0.84,-0.0351,-0.587', x.weights.join(','));
      check(`${tag}: hero shows 3D or the RCSB image`, x.hero === 'canvas' || x.hero === 'image', x.hero);
    } },
  { route: '/targets', title: 'Ponchem · Targets', h1: 'Targets', texts: ['Cancer targets from the RCSB Protein Data Bank', 'Best dG', 'Pool', 'Load more'],
    ready: () => document.querySelectorAll('[data-grid] .pc-card--link').length > 0,
    extra: () => ({ cards: document.querySelectorAll('[data-grid] .pc-card--link').length, count: document.querySelector('[data-count]').textContent, pills: document.querySelectorAll('[data-pills] .pc-pill').length }),
    assert: (x, tag) => { check(`${tag}: cards and a count`, x.cards >= 12 && /^\d+ targets$/.test(x.count), `${x.cards} cards, "${x.count}"`); check(`${tag}: cancer filter pills`, x.pills > 5, `${x.pills}`); } },
  { route: '/target?id=1', title: /^Ponchem · .+ \([0-9][A-Z0-9]{3}\)$/, h1: null, texts: ['Prize pool', 'Amount (ETH)', 'Sponsor', 'Leaderboard', '3D', 'Runs', 'About', 'Dock this target', 'Sponsor pool', 'Settle epoch', 'View on RCSB', 'Reference ligand', 'Resolution', 'Method', 'Cancer groups'],
    ready: () => document.querySelectorAll('[data-ladder] dt').length > 3,
    extra: () => ({ rows: document.querySelectorAll('[data-ladder] dt').length, pdb: document.querySelector('[data-pdb-id]').textContent, lb: document.querySelector('[data-panel="leaderboard"]').textContent.trim().slice(0, 80),
      links: [...document.querySelectorAll('a[href^="https://www.rcsb.org/"]')].map((a) => a.textContent.trim()) }),
    assert: (x, tag) => { check(`${tag}: provenance ladder`, x.rows >= 5 && /^[0-9][A-Z0-9]{3}$/.test(x.pdb), `${x.rows} rows, id ${x.pdb}`); check(`${tag}: leaderboard state`, x.lb.length > 0, x.lb);
      check(`${tag}: direct RCSB links name their destination`, x.links.some((t) => new RegExp(`^RCSB ${x.pdb}$`).test(t)) && x.links.some((t) => /^RCSB [A-Z0-9]{1,5}$/.test(t) && !t.endsWith(x.pdb)), x.links.join(' | ')); } },
  { route: '/ligands', title: 'Ponchem · Ligands', h1: 'Ligands', texts: ['Bioactive plant compounds with their 3D topology on chain', 'Best dG', 'Best target'],
    ready: () => document.querySelectorAll('[data-grid] .pc-card--link').length > 0,
    extra: () => ({ cards: document.querySelectorAll('[data-grid] .pc-card--link').length, count: document.querySelector('[data-count]').textContent }),
    assert: (x, tag) => check(`${tag}: cards and a count`, x.cards >= 12 && /^\d+ ligands$/.test(x.count), `${x.cards} cards, "${x.count}"`) },
  { route: '/ligand?id=1', title: /^Ponchem · .+$/, h1: null, texts: ['Source', 'Formula', 'Weight', 'Heavy atoms', 'Rotatable bonds', 'Best targets', 'Runs', 'About', 'Dock this ligand', 'Screen against all targets'],
    ready: () => document.querySelectorAll('[data-ladder] dt').length > 3 && (!!document.querySelector('[data-viewer] canvas') || !!document.querySelector('[data-viewer] .pc-viewer-caption')),
    settle: 2500,
    extra: () => ({ rows: document.querySelectorAll('[data-ladder] dt').length, view: document.querySelector('[data-viewer] canvas') ? 'canvas' : document.querySelector('[data-viewer] img') ? 'image' : 'tile',
      links: [...document.querySelectorAll('[data-image-links] a, [data-ladder] a')].map((a) => a.textContent.trim()) }),
    assert: (x, tag) => { check(`${tag}: provenance ladder`, x.rows >= 5, `${x.rows} rows`); check(`${tag}: 3D or the depiction`, ['canvas', 'image', 'tile'].includes(x.view), x.view);
      check(`${tag}: source links name their destination`, x.links.some((t) => /^(RCSB [A-Z0-9]{1,5}|PubChem \d+)$/.test(t)), x.links.join(' | ')); } },
  { route: '/leaderboard', title: 'Ponchem · Leaderboard', h1: 'Leaderboard', texts: ['Best binders by target, by cancer group and by ligand', 'By target', 'By cancer group', 'By ligand', 'Wallets', 'Most reviewed', 'Pools', 'Download CSV'],
    ready: () => !document.querySelector('[data-board] .pc-skel'),
    extra: () => ({ board: document.querySelector('[data-board]').textContent.trim().slice(0, 60) }),
    assert: (x, tag) => check(`${tag}: board rendered`, x.board.length > 0, x.board) },
  { route: '/report', title: 'Ponchem · Cancer research report', h1: 'Best computational binders by cancer group', texts: ['Cancer research report', 'Compiled from Robinhood Chain', 'Download Markdown', 'Print', 'Jump to'],
    ready: () => document.querySelectorAll('.pc-report-group').length > 0,
    extra: () => ({ groups: document.querySelectorAll('.pc-report-group').length, first: (document.querySelector('.pc-report-group h2') || {}).textContent }),
    assert: (x, tag) => check(`${tag}: twenty cancer groups`, x.groups === 20 && x.first === 'lung', `${x.groups} groups, first "${x.first}"`) },
  // /wallet forwards to /dashboard (meta refresh, 3 s): the test waits for the dashboard's no-wallet state
  { route: '/wallet', title: 'Ponchem · Dashboard', h1: 'Connect a wallet to open your dashboard', texts: ['Connect a wallet to open your dashboard', 'Your level, XP and badges', 'Connect wallet'],
    ready: () => location.pathname === '/dashboard' && !!document.querySelector('[data-disconnected]:not([hidden])'), settle: 800,
    extra: () => ({ path: location.pathname }), assert: (x, tag) => check(`${tag}: forwarded to /dashboard`, x.path === '/dashboard', x.path) },
  { route: '/dashboard', title: 'Ponchem · Dashboard', h1: 'Connect a wallet to open your dashboard', texts: ['Connect a wallet to open your dashboard', 'Your level, XP and badges', 'Your docking tests with their chain scores and reviews', 'Reviews you received and reviews you wrote', 'Prizes to claim and pools you sponsored', 'How docking tests are paid', 'Connect wallet'],
    ready: () => !!document.querySelector('[data-disconnected]:not([hidden])'),
    extra: () => ({ connectedHidden: document.querySelector('[data-connected]').hidden, h1s: [...document.querySelectorAll('h1')].filter((h) => !h.closest('[hidden]')).length }),
    assert: (x, tag) => check(`${tag}: no-wallet state (the connected sections stay hidden)`, x.connectedHidden === true && x.h1s === 1, `connected hidden ${x.connectedHidden}, h1s ${x.h1s}`) },
  { route: '/run?id=1', title: 'Ponchem · Docking test not found', h1: 'Docking test not found', texts: ['Docking test not found', 'No docking test with this id is recorded on chain.', 'Leaderboard', 'Open the lab'],
    ready: () => !!document.querySelector('[data-notfound]:not([hidden])'),
    extra: () => ({ pageHidden: document.querySelector('[data-page]').hidden, note: (document.querySelector('[data-notfound-note]') || {}).textContent || '', noteHidden: (document.querySelector('[data-notfound-note]') || {}).hidden }),
    assert: (x, tag) => { check(`${tag}: not-found state without a chain`, x.pageHidden === true, `page hidden ${x.pageHidden}`); if (!withChain) check(`${tag}: the not-live reason is shown`, x.noteHidden === false && x.note.length > 10, x.note); } },
  { route: '/run', title: 'Ponchem · Docking test not found', h1: 'Docking test not found', texts: ['Docking test not found', 'Unknown docking test id.'],
    ready: () => !!document.querySelector('[data-notfound]:not([hidden])'), extra: () => ({}), assert: () => {} },
  { route: '/docs', title: 'Ponchem · Docs', h1: 'Docs', texts: ['How it works', 'Payment', 'Scoring explained', 'What the chain checks', 'Docking methods', 'Reviews', 'Levels and badges', 'AI analysis', 'Post on X', 'What is and is not claimed', 'Wallet and network', 'API', 'Glossary', 'Binding free energy (dG)', 'Reference ligand', 'GET /api/runs', 'GET /api/analyze', 'chain id 4663', '100 $PONCHEM', '0.0001 ETH', 'Principal Investigator', 'moves.translate', 'Well reviewed'],
    ready: () => document.querySelectorAll('[data-badges-docs] .pc-badge-tile').length >= 10,
    extra: () => ({ anchors: ['scoring', 'verification', 'api', 'glossary', 'payment', 'methods', 'reviews', 'levels', 'ai-analysis', 'post-on-x'].map((id) => !!document.getElementById(id)), weights: [...document.querySelectorAll('[data-weight]')].map((c) => c.textContent),
      badges: document.querySelectorAll('[data-badges-docs] .pc-badge-tile').length, levels: document.querySelectorAll('[data-levels] tbody tr').length, schemaRows: document.querySelectorAll('[data-method-schema] tbody tr').length, presets: document.querySelectorAll('[data-method-presets] tbody tr').length }),
    assert: (x, tag) => { check(`${tag}: anchors #scoring #verification #api #glossary #payment #methods #reviews #levels #ai-analysis #post-on-x`, x.anchors.every(Boolean), x.anchors.join(',')); check(`${tag}: five weights printed`, x.weights.join(',') === '-0.0356,-0.00516,0.84,-0.0351,-0.587', x.weights.join(','));
      check(`${tag}: ten badges, six levels, the method schema and the presets`, x.badges === 10 && x.levels === 6 && x.schemaRows >= 12 && x.presets >= 7, `${x.badges} badges, ${x.levels} levels, ${x.schemaRows} schema rows, ${x.presets} presets`); } },
  { route: '/nothing-here', status: 404, title: 'Ponchem · Not found', h1: 'Nothing binds here', texts: ['404', 'The page you asked for is not in the library.', 'Back to the lab', 'Home'], ready: () => true, extra: () => ({}), assert: () => {} },
];

// ---------------------------------------------------------------------------------------------------------

console.log(`Ponchem pages test\n  base   ${base}\n  chain  ${withChain ? `${RPC} contract ${CONTRACT.slice(0, 10)}…` : 'none (not-live state expected)'}\n  absent modules tolerated: ${absent.length ? absent.join(', ') : 'none'}\n`);

const chrome = await launchChrome({ port: CHROME_PORT });
try {
  for (const p of (ONLY ? [] : PAGES)) {
    for (const w of [390, 1280]) {
      const tag = `${p.route} @${w}`;
      const page = await openPage({ port: CHROME_PORT, width: w, height: w < 700 ? 844 : 900 });
      const r = await page.goto(base + withQuery(p.route), { settle: 600 });
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < 25000) { try { ready = await page.eval(p.ready); } catch { ready = false; } if (ready) break; await sleep(250); }
      await sleep(p.settle || 800);
      await page.scrollThrough({ pause: 50, end: 300 });
      await sleep(300);
      check(`${tag}: status ${p.status || 200}`, r.status === (p.status || 200), `got ${r.status}`);
      check(`${tag}: ready in time`, ready, 'the page did not reach its ready state in 25 s');
      const got = await page.eval(() => ({
        title: document.title,
        h1: [...document.querySelectorAll('h1')].filter((h) => !h.closest('[hidden]')).map((h) => h.textContent.trim()),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        text: document.body.textContent.replace(/\s+/g, ' '),
        footer: (document.querySelector('footer') || {}).textContent || '',
        buy: (document.querySelector('[data-shell="buy"]') || {}).textContent || '',
        ca: document.querySelector('[data-shell="ca"]') ? document.querySelector('[data-shell="ca"]').disabled : null,
        navToggleVisible: !!document.querySelector('[data-nav-toggle]') && getComputedStyle(document.querySelector('[data-nav-toggle]')).display !== 'none',
        linksVisible: !!document.querySelector('.pc-nav-links') && getComputedStyle(document.querySelector('.pc-nav-links')).display !== 'none',
        address: /0x[0-9a-fA-F]{40}/.test(document.body.innerText),
        dashes: /[–—]/.test(document.body.innerText),
        skip: !!document.querySelector('.pc-skip'),
        main: !!document.querySelector('main#main'),
        smallTargets: [...document.querySelectorAll('button, a.pc-btn, .pc-pill, .pc-tab')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 36; }).length,
      }));
      check(`${tag}: title`, typeof p.title === 'string' ? got.title === p.title : p.title.test(got.title), got.title);
      check(`${tag}: one h1`, got.h1.length === 1 && (p.h1 === null || got.h1[0] === p.h1), JSON.stringify(got.h1));
      check(`${tag}: no horizontal overflow`, got.overflow <= 0, `${got.overflow}px wider than the viewport`);
      const missing = p.texts.filter((t) => !got.text.includes(t));
      check(`${tag}: copy deck strings`, !missing.length, `missing ${JSON.stringify(missing)}`);
      check(`${tag}: footer line`, got.footer.includes(FOOTER));
      check(`${tag}: blank token state`, got.buy.replace(/\s+/g, ' ').trim() === 'Buy $PONCHEM · soon' && got.ca === true, `buy "${got.buy.trim()}", ca disabled ${got.ca}`);
      check(`${tag}: no 0x address, no dashes`, !got.address && !got.dashes, `address ${got.address}, dashes ${got.dashes}`);
      check(`${tag}: landmarks`, got.skip && got.main);
      check(`${tag}: nav ${w < 900 ? 'collapsed to the toggle' : 'links visible'}`, w < 900 ? got.navToggleVisible && !got.linksVisible : !got.navToggleVisible && got.linksVisible, `toggle ${got.navToggleVisible}, links ${got.linksVisible}`);
      if (w < 768) check(`${tag}: tap targets at least 36 px`, got.smallTargets === 0, `${got.smallTargets} controls under 36 px`);
      const extra = await page.eval(p.extra);
      p.assert(extra, tag);
      const pageUrl = base + withQuery(p.route);
      const errors = page.errors.filter((e) => !(e.kind === 'log.network' && /404/.test(e.text) && (tolerated(e.url || (e.text.match(/https?:\S+/) || [''])[0]) || (p.status === 404 && (!e.url || e.url === pageUrl)))));
      check(`${tag}: no console errors`, !errors.length, errors.map((e) => `${e.kind} ${e.text.slice(0, 160)}`).join(' | '));
      const failed = [...page.requests.values()].filter((q) => ((q.failed && !q.canceled) || (q.status && q.status >= 400)) && !(p.status === 404 && q.type === 'Document') && !tolerated(q.url));
      check(`${tag}: no failed requests`, !failed.length, failed.map((q) => `${q.status || q.errorText} ${q.url}`).join(' | '));
      const file = path.join(SHOTS, `${p.route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}-${w}.png`);
      await page.screenshot(file, { fullPage: true });
      await page.close();
    }
  }
  // -------------------------------------------------------------------------------------------------------
  // H. the found state of /run, the connected dashboard and the wallet views with a STUBBED live chain
  // (js/chain.js is served from a stub kept only in this file, through DevTools request interception; the engine, the
  // data files, js/gamify.js and js/lab.js are the real ones). The pose is docked here in Node with the real engine,
  // so the browser check has a real integer score to agree with. Nothing is written to disk and nothing is sent.
  if (!withChain) {
    console.log('\nH. the docking test page, the dashboard and the wallet views with a stubbed live chain');
    const A1 = '0x1111111111111111111111111111111111111111';
    const A2 = '0x2222222222222222222222222222222222222222';
    const A3 = '0x3333333333333333333333333333333333333333';
    const SIM = fs.readFileSync(path.join(ROOT, 'tools/sim-wallet.js'), 'utf8');
    const { pathToFileURL } = await import('node:url');
    const E = await import(pathToFileURL(path.join(ROOT, 'js/engine/index.js')).href);
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/registry.json'), 'utf8'));
    const T = reg.targets.find((x) => x.key === 'EGFR') || reg.targets[0];
    const T2 = reg.targets.find((x) => x.id !== T.id);
    const L = reg.ligands.find((x) => x.key === 'QUERCETIN') || reg.ligands[0];
    const pocket = E.loadPocket(new Uint8Array(fs.readFileSync(path.join(ROOT, T.pocket))));
    const topology = E.loadTopology(new Uint8Array(fs.readFileSync(path.join(ROOT, L.topology))));
    const ligand = E.parseSdf(fs.readFileSync(path.join(ROOT, L.file), 'utf8'));
    await E.ensureTables({ bytes: new Uint8Array(fs.readFileSync(path.join(ROOT, 'data/tables/tables.bin'))) });
    const docked = await E.dock({ pocket, topology, ligand, seed: 11, steps: 200 });
    check('H: a pose docked in Node passes the geometry proof', !!(docked.checks && docked.checks.ok), JSON.stringify(docked.checks));
    const SCORE = Number(docked.scoreMilli);
    const POSE = Array.from(docked.poseCenti);
    let methodJson = '{"name":"Standard","version":1,"budget":{"ms":30000},"chains":8,"temperature":1.2,"moves":{"translate":1,"rotate":20,"torsion":60},"local":{"steps":30},"placement":"box","flexible":true,"candidates":4,"lattice":true}';
    try { const M = await import(pathToFileURL(path.join(ROOT, 'js/engine/method.js')).href); const std = (M.METHOD_PRESETS || []).find((p) => p.name === 'Standard'); if (std) methodJson = JSON.stringify(std); } catch { /* the hand JSON */ }
    const ANALYSIS = 'Quercetin sits deep in the ATP site of the EGFR kinase domain in this pose. The hydrogen bond term carries most of the estimate, which is typical for a flavonol against a hinge region. Limits: the receptor is rigid, no water, no entropy beyond the rotor penalty. Next steps: rescore with a second function, then a biochemical kinase assay. Literature recall, unverified: quercetin is reported as a weak EGFR inhibitor in cell assays.';
    const NOTE_HTML = 'Solid pose. <b>bold</b> should show as text, not markup.';
    const RUNS = [
      { id: 1, wallet: A1, targetId: T.id, ligandId: L.id, scoreMilli: SCORE, epoch: 3, time: 1758540000, block: 120, logIndex: 0, tx: '0x' + '11'.repeat(32), pose: POSE, methodHash: '0x' + 'ab'.repeat(32), payment: { method: 'eth', code: 0, amount: '100000000000000' }, reviews: { count: 2, starSum: 9, average: 4.5 }, analysisAttached: true, method: methodJson, analysis: { runId: 1, provider: 'gpt', text: ANALYSIS, block: 130, tx: '0x' + '33'.repeat(32) } },
      { id: 2, wallet: A2, targetId: T.id, ligandId: L.id, scoreMilli: SCORE + 1500, epoch: 3, time: 1758541000, block: 125, logIndex: 0, tx: '0x' + '22'.repeat(32), pose: POSE, methodHash: null, payment: { method: 'eth', code: 0, amount: '100000000000000' }, reviews: { count: 1, starSum: 3, average: 3 }, analysisAttached: false, method: null, analysis: null },
      { id: 3, wallet: A1, targetId: T2.id, ligandId: L.id, scoreMilli: -4200, epoch: 3, time: 1758542000, block: 128, logIndex: 0, tx: '0x' + '44'.repeat(32), pose: null, methodHash: null, payment: { method: 'eth', code: 0, amount: '100000000000000' }, reviews: { count: 0, starSum: 0, average: null }, analysisAttached: false, method: null, analysis: null },
    ];
    const REVIEWS = [
      { runId: 1, reviewer: A2, stars: 5, note: NOTE_HTML, block: 126, logIndex: 1, tx: '0x' + '55'.repeat(32) },
      { runId: 1, reviewer: A3, stars: 4, note: 'Good fit.\nThe hinge contact looks right.', block: 127, logIndex: 0, tx: '0x' + '66'.repeat(32) },
      { runId: 2, reviewer: A1, stars: 3, note: '', block: 129, logIndex: 0, tx: '0x' + '77'.repeat(32) },
    ];
    const SETTLED = [{ targetId: T.id, epoch: 2, winner: A1, runId: 1, amount: '2000000000000000', block: 119, logIndex: 0, tx: '0x' + '88'.repeat(32) }];
    const FUNDED = [{ targetId: T.id, from: A2, amount: '5000000000000000', pool: '5000000000000000', block: 100, logIndex: 0, tx: '0x' + '99'.repeat(32) }];
    const STUB_CHAIN = `
export const NOT_LIVE = 'The lab opens when the contract is live.';
export const UNREACHABLE = 'Could not reach Robinhood Chain. Reads will retry.';
const REVIEWS = ${JSON.stringify(REVIEWS)};
const RUNS = ${JSON.stringify(RUNS)}.map((r) => ({ ...r, pose: r.pose ? Int16Array.from(r.pose) : null, payment: r.payment ? { ...r.payment, amount: BigInt(r.payment.amount) } : null, reviewList: REVIEWS.filter((v) => v.runId === r.id).sort((a, b) => b.block - a.block) }));
const SETTLED = ${JSON.stringify(SETTLED)}.map((s) => ({ ...s, amount: BigInt(s.amount) }));
const FUNDED = ${JSON.stringify(FUNDED)}.map((f) => ({ ...f, amount: BigInt(f.amount), pool: BigInt(f.pool) }));
const now = () => Math.floor(Date.now() / 1000);
export async function labStatus() { return { live: true, reason: null, epoch: 3, epochStart: now() - 1000, epochEnd: now() + 600000, epochLength: 604800, genesis: now() - 2000000, runFee: 100000000000000n, runPrice: 100000000000000000000n, feeBps: 500, token: null, ethAllowed: true, tokenAllowed: false, tokenOpen: false, minHold: 0n, runCount: 3, targetCount: 100, ligandCount: 152, poolTotal: 5000000000000000n, head: 130, generatedAt: new Date().toISOString() }; }
export async function runById(id) { const r = RUNS.find((x) => x.id === Number(id)); return r ? { ...r } : null; }
const select = ({ target, ligand, wallet, limit = 100, offset = 0, order = 'desc' } = {}) => { let rows = RUNS.filter((r) => (target === undefined || target === null || r.targetId === Number(target)) && (ligand === undefined || ligand === null || r.ligandId === Number(ligand)) && (!wallet || r.wallet.toLowerCase() === String(wallet).toLowerCase())); rows = rows.slice().sort((a, b) => (order === 'asc' ? a.id - b.id : b.id - a.id)); return { runs: rows.slice(offset, offset + limit), total: rows.length, head: 130, live: true, source: 'stub' }; };
export async function runsPage(q) { return select(q); }
export async function runs(q) { return select(q).runs; }
export async function allRuns() { return { runs: RUNS.slice().sort((a, b) => a.id - b.id), total: RUNS.length, head: 130, partial: false, live: true }; }
export async function ledger() { return { head: 130, live: true, runs: RUNS.map(({ pose, reviewList, analysis, method, ...rest }) => ({ ...rest, pose: null })).sort((a, b) => a.id - b.id), settled: SETTLED, funded: FUNDED, reviews: REVIEWS.slice(), analyses: [{ runId: 1, provider: 'gpt', block: 130, tx: RUNS[0].analysis.tx, logIndex: 0 }] }; }
export async function reviewsOf(id) { return REVIEWS.filter((v) => v.runId === Number(id)); }
export async function analysesOf(id) { const r = RUNS.find((x) => x.id === Number(id)); return r && r.analysis ? [r.analysis] : []; }
export async function settledAll() { return SETTLED; }
export async function walletStats(a) { const mine = RUNS.filter((r) => r.wallet.toLowerCase() === String(a).toLowerCase()); const won = SETTLED.filter((s) => s.winner.toLowerCase() === String(a).toLowerCase()); return { runs: mine.length, best: mine.length ? Math.min(...mine.map((r) => r.scoreMilli)) : null, prizes: won.reduce((n, s) => n + s.amount, 0n), owed: won.length ? 2000000000000000n : 0n, sponsored: FUNDED.filter((f) => f.from.toLowerCase() === String(a).toLowerCase()).map((f) => ({ targetId: f.targetId, amount: f.amount, count: 1, last: f.block })), reviewsGiven: REVIEWS.filter((v) => v.reviewer.toLowerCase() === String(a).toLowerCase()).length, reviewsReceived: REVIEWS.filter((v) => (RUNS.find((r) => r.id === v.runId) || {}).wallet === a).length, starsReceived: 9, reviewAverage: 4.5, won, wonEpochs: won.length, live: true }; }
export async function bests() { const byTarget = new Map(); const byPair = new Map(); const byLigand = new Map(); const byTargetEpoch = new Map(); for (const r of RUNS.slice().sort((a, b) => a.id - b.id)) { const b = (m, k) => { const c = m.get(k); if (!c || r.scoreMilli < c.scoreMilli) m.set(k, r); }; b(byTarget, r.targetId); b(byPair, r.targetId + ':' + r.ligandId); b(byLigand, r.ligandId); b(byTargetEpoch, r.targetId + ':' + r.epoch); } return { byTarget, byPair, byLigand, byTargetEpoch, partial: false }; }
export async function pools() { return new Map([[${T.id}, 5000000000000000n]]); }
export function onBlock() { return () => {}; }
export function invalidate() {}
`;
    const STUB_PROVIDERS = JSON.stringify({ ok: true, providers: [{ id: 'claude-fable', label: 'Claude Fable 5.1', model: 'claude-fable-5-1', connected: false }, { id: 'gpt', label: 'GPT', model: 'gpt-5', connected: true }, { id: 'kimi', label: 'Kimi', model: 'kimi-k2', connected: false }, { id: 'jev', label: 'Jev AI', model: 'jev', connected: false }] });
    const STUBS = [{ test: /\/js\/chain\.js(\?|$)/, body: STUB_CHAIN }, { test: /\/api\/analyze(\?|$)/, body: STUB_PROVIDERS, type: 'application/json; charset=utf-8' }];
    async function intercept(page, table) {
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      page.on('Fetch.requestPaused', async (p) => {
        const hit = table.find((t) => t.test.test(p.request.url));
        try {
          if (!hit) { await page.send('Fetch.continueRequest', { requestId: p.requestId }); return; }
          await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: hit.type || 'text/javascript; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }], body: Buffer.from(hit.body).toString('base64') });
        } catch { /* the page went away */ }
      });
    }
    // a page with the stubbed chain; wallet: an address the simulated MetaMask is already connected with on Robinhood Chain
    async function openStubbed(route, { width = 1280, wallet = null } = {}) {
      const page = await openPage({ port: CHROME_PORT, width, height: width < 700 ? 844 : 900 });
      await page.emulate({ width, height: width < 700 ? 844 : 900, dpr: 1 });
      await intercept(page, STUBS);
      await page.goto(`${base}/robots.txt`, { settle: 50 });
      await page.eval(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* fine */ } });
      if (wallet) {
        await page.eval((a) => { sessionStorage.setItem('sim.io.metamask.allowed', 'true'); sessionStorage.setItem('sim.io.metamask.chain', '"0x1237"'); sessionStorage.setItem('sim.io.metamask.known', '["0x1237"]'); sessionStorage.setItem('sim.io.metamask.account', JSON.stringify(a)); localStorage.setItem('ponchem.wallet', 'io.metamask'); }, wallet);
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__walletSim = ${JSON.stringify({ account: wallet, startChain: '0x1237' })};\n${SIM}` });
      }
      await page.goto(base + route, { settle: 700 });
      const t = {
        page,
        eval: (fn, ...a) => page.eval(fn, ...a),
        text: (sel) => page.eval((s) => { const n = document.querySelector(s); return n ? n.innerText.replace(/\s+/g, ' ').trim() : null; }, sel),
        count: (sel) => page.eval((s) => document.querySelectorAll(s).length, sel),
        until: async (fn, what, ms = 30000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = await fn(); } catch { v = false; } if (v) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } },
        errors: () => page.errors.filter((e) => !(e.kind === 'log.network' && /404/.test(e.text) && tolerated(e.url || (e.text.match(/https?:\S+/) || [''])[0]))).map((e) => ({ ...e, text: `${e.text} ${e.url || ''}` })),
        shot: (name) => page.screenshot(path.join(SHOTS, name), { fullPage: true }),
        close: () => page.close(),
      };
      return t;
    }
    const tryCheck = async (name, fn) => { try { const r = await fn(); check(name, r === true || (r && r.ok), r && r.detail ? r.detail : typeof r === 'string' ? r : ''); } catch (e) { check(name, false, String((e && e.message) || e)); } };

    // H1. /run?id=1 without a wallet: the found state, the browser check agrees, links, method, reviews, analysis, actions
    {
      const t = await openStubbed('/run?id=1');
      await tryCheck('H1: the test page reaches the found state (h1, title, canonical)', async () => {
        await t.until(async () => (await t.text('[data-h1]')) === 'Docking test #1', 'the h1');
        const got = await t.eval(() => ({ title: document.title, canon: document.querySelector('link[rel="canonical"]').getAttribute('href'), og: document.querySelector('meta[property="og:url"]').getAttribute('content'), pair: document.querySelector('[data-pair]').textContent.trim() }));
        return { ok: got.title === 'Ponchem · Docking test #1' && got.canon === 'https://ponchem.ai/run?id=1' && got.og === got.canon && /Quercetin into EGFR \(4WKQ\)/.test(got.pair), detail: JSON.stringify(got) };
      });
      await tryCheck('H1: the chain score with its band, pKd, Kd, LE and the payment', async () => {
        const s = await t.text('[data-score]');
        const dg = (SCORE / 1000).toFixed(3);
        return { ok: s.includes(dg) && /kcal\/mol/.test(s) && /Estimated pKd/.test(s) && /Estimated Kd/.test(s) && /Ligand efficiency/.test(s) && /Paid with 0\.0001 ETH/.test(s) && /Heavy atoms 22/.test(s), detail: s.slice(0, 200) };
      });
      await tryCheck('H1: the browser re-scores the event pose and agrees with the chain (real engine, real pocket and topology bytes)', async () => {
        await t.until(async () => !!(await t.eval(() => document.querySelector('[data-agree]'))), 'the browser check', 40000);
        const got = await t.eval(() => ({ agree: document.querySelector('[data-agree]').dataset.agree, text: document.querySelector('[data-agree]').textContent.trim(), geo: [...document.querySelectorAll('.pc-geo-row')].map((r) => r.dataset.ok), terms: document.querySelectorAll('#check .pc-terms tbody tr').length, score: [...document.querySelectorAll('#check .pc-terms tr')].map((r) => r.textContent).find((x) => /browser score/.test(x)) || '' }));
        return { ok: got.agree === 'yes' && got.text === 'Chain and browser agree' && got.geo.length === 4 && got.geo.every((g) => g === 'yes') && got.terms === 8 && got.score.includes((SCORE / 1000).toFixed(3)), detail: JSON.stringify(got) };
      });
      await tryCheck('H1: the pose is drawn on the receptor (3D canvas or the RCSB image fallback)', async () => {
        await t.until(async () => !!(await t.eval(() => document.querySelector('[data-viewer] canvas') || document.querySelector('[data-viewer] .pc-viewer-img--solo'))), 'the viewer', 40000);
        const got = await t.eval(() => ({ canvas: !!document.querySelector('[data-viewer] canvas'), pose: (document.querySelector('[data-viewer] .pc-viewer-host') || {}).dataset ? (document.querySelector('[data-viewer] .pc-viewer-host').dataset.pose || '') : '', image: !!document.querySelector('[data-viewer] .pc-viewer-img--solo'), title: document.querySelector('[data-viewer-title]').textContent }));
        return { ok: (got.canvas || got.image) && /4WKQ/.test(got.title), detail: JSON.stringify(got) };
      });
      await tryCheck('H1: provenance links name their destination (RCSB 4WKQ, the reference ligand, PubChem or RCSB for the compound)', async () => {
        const links = await t.eval(() => [...document.querySelectorAll('#provenance a[target="_blank"]')].map((a) => `${a.textContent.trim()}|${a.getAttribute('rel')}`));
        return { ok: links.some((l) => l.startsWith('RCSB 4WKQ|')) && links.some((l) => /^RCSB IRE\|/.test(l)) && links.some((l) => /^(RCSB QUE|PubChem 5280343)\|/.test(l)) && links.every((l) => /noopener/.test(l)), detail: links.join(' ') };
      });
      await tryCheck('H1: the method block shows the JSON as text and offers Use this method', async () => {
        const got = await t.eval(() => ({ pre: (document.querySelector('#method pre') || {}).textContent || '', link: (document.querySelector('#method a.pc-btn') || {}).getAttribute ? document.querySelector('#method a.pc-btn').getAttribute('href') : null, text: (document.querySelector('#method a.pc-btn') || {}).textContent || '' }));
        return { ok: /"name": "Standard"/.test(got.pre) && typeof got.link === 'string' && got.link.startsWith('/lab?method=') && got.text === 'Use this method', detail: JSON.stringify(got).slice(0, 200) };
      });
      await tryCheck('H1: the reviews list (newest first, stars, notes as text) and the average', async () => {
        const got = await t.eval(() => ({ summary: document.querySelector('[data-review-summary]').textContent.replace(/\s+/g, ' ').trim(), n: document.querySelectorAll('[data-reviews] .pc-review').length, first: document.querySelector('[data-reviews] .pc-review .pc-review-note') ? document.querySelector('[data-reviews] .pc-review .pc-review-note').textContent : '', bold: document.querySelectorAll('[data-reviews] b').length, lit: document.querySelectorAll('[data-reviews] .pc-review:nth-child(2) .pc-star[data-lit]').length, gate: (document.querySelector('[data-review-form]') || {}).textContent || '' }));
        return { ok: /4\.5 of 5/.test(got.summary) && /from 2 reviews/.test(got.summary) && got.n === 2 && /hinge contact/.test(got.first) && got.bold === 0 && got.lit === 5 && /Connect a wallet to write a review/.test(got.gate), detail: JSON.stringify(got).slice(0, 300) };
      });
      await tryCheck('H1: the attached analysis shows as text with its provider, and the picker lists the four providers with three not connected', async () => {
        const got = await t.eval(() => ({ attached: !!document.querySelector('.pc-analysis--attached'), text: (document.querySelector('.pc-analysis--attached .pc-text-block') || {}).textContent || '', providers: [...document.querySelectorAll('.pc-provider')].map((p) => `${p.dataset.connected}:${p.querySelector('.pc-provider-name').textContent}`), notConnected: document.querySelectorAll('.pc-provider .pc-chip').length, analyze: document.querySelector('#analysis .pc-btn--primary') ? document.querySelector('#analysis .pc-btn--primary').disabled : null, attachBtn: [...document.querySelectorAll('#analysis button')].some((b) => /Attach/.test(b.textContent)) }));
        return { ok: got.attached && /ATP site/.test(got.text) && got.providers.length === 4 && got.providers.includes('1:GPT') && got.notConnected === 3 && got.analyze === false && got.attachBtn === false, detail: JSON.stringify(got).slice(0, 300) };
      });
      await tryCheck('H1: Post on X carries the SPEC text, the analysis excerpt and the page URL; Copy link and Download report work', async () => {
        const got = await t.eval(async () => {
          const href = document.querySelector('[data-x]').getAttribute('href');
          const u = new URL(href);
          let clip = null;
          navigator.clipboard.writeText = async (s) => { clip = s; };
          document.querySelector('[data-copy]').click();
          await new Promise((r) => setTimeout(r, 300));
          document.querySelector('[data-download]').click();
          await new Promise((r) => setTimeout(r, 300));
          return { origin: u.origin + u.pathname, text: u.searchParams.get('text'), url: u.searchParams.get('url'), clip, toasts: [...document.querySelectorAll('.pc-toast')].map((x) => x.textContent.trim()) };
        });
        const dg = (SCORE / 1000).toFixed(3);
        return { ok: got.origin === 'https://x.com/intent/post' && got.text.startsWith(`Docking test #1 on Ponchem: Quercetin into EGFR (4WKQ). dG ${dg} kcal/mol, pKd `) && /scored on Robinhood Chain\. gpt: Quercetin sits deep/.test(got.text) && !/[–—]/.test(got.text) && got.url === 'https://ponchem.ai/run?id=1' && got.clip === `${base}/run?id=1` && got.toasts.includes('Link copied') && got.toasts.includes('Report downloaded'), detail: JSON.stringify(got).slice(0, 400) };
      });
      await tryCheck('H1: no console errors and no failed requests on the found state', async () => { const errs = t.errors(); return { ok: !errs.length, detail: errs.map((e) => `${e.kind} ${e.text.slice(0, 120)}`).join(' | ') }; });
      await t.shot('run_id_1-live-1280.png');
      await t.close();
    }
    // H2. /run?id=1 at 390: no overflow in the found state
    {
      const t = await openStubbed('/run?id=1', { width: 390 });
      await tryCheck('H2: the found state fits a phone (no horizontal overflow, one h1)', async () => {
        await t.until(async () => (await t.text('[data-h1]')) === 'Docking test #1', 'the h1');
        await t.until(async () => !!(await t.eval(() => document.querySelector('[data-agree]'))), 'the browser check', 40000);
        await t.page.scrollThrough({ pause: 40, end: 200 });
        const got = await t.eval(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, h1s: [...document.querySelectorAll('h1')].filter((h) => !h.closest('[hidden]')).length }));
        return { ok: got.overflow <= 0 && got.h1s === 1, detail: JSON.stringify(got) };
      });
      await t.shot('run_id_1-live-390.png');
      await t.close();
    }
    // H3. /run?id=1 with a connected wallet that is not the author: the review form; as the author: the refusal
    {
      const t = await openStubbed('/run?id=1', { wallet: A3 });
      await tryCheck('H3: a connected wallet that is not the author gets Write a review (stars picker, 280 counter)', async () => {
        await t.until(async () => !!(await t.eval(() => document.querySelector('.pc-review-form'))), 'the review form', 20000);
        await t.eval(() => { const ta = document.querySelector('.pc-review-form textarea'); ta.value = 'x'.repeat(300).slice(0, ta.maxLength); ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelectorAll('.pc-star-btn')[3].click(); });
        const got = await t.eval(() => ({ stars: document.querySelectorAll('.pc-star-btn').length, checked: [...document.querySelectorAll('.pc-star-btn')].map((b) => b.getAttribute('aria-checked')).join(''), counter: document.querySelector('.pc-counter').textContent, heading: document.querySelector('.pc-review-form h3').textContent, button: document.querySelector('.pc-review-form button[type="submit"]').textContent, wallet: document.querySelector('[data-wallet-button]').textContent.trim() }));
        return { ok: got.stars === 5 && got.checked === 'falsefalsefalsetruefalse' && got.counter === '280/280' && got.heading === 'Write a review' && got.button === 'Send review' && /0x3333/.test(got.wallet), detail: JSON.stringify(got) };
      });
      await t.close();
      const u = await openStubbed('/run?id=1', { wallet: A1 });
      await tryCheck('H3: the author cannot review the own test', async () => {
        await u.until(async () => /cannot review your own/.test((await u.text('[data-review-form]')) || ''), 'the refusal', 20000);
        return true;
      });
      await u.close();
    }
    // H4. the dashboard connected as A1: profile, badges, tests, best, reviews, prizes, sponsorships, payment
    {
      const t = await openStubbed('/dashboard', { wallet: A1 });
      await tryCheck('H4: the connected dashboard shows the profile from js/gamify.js (level, XP, badges)', async () => {
        await t.until(async () => (await t.count('[data-panel="tests"] tbody tr')) === 2, 'the tests table', 20000);
        const got = await t.eval(() => ({ h1: document.querySelector('[data-connected] h1').textContent, level: document.querySelector('[data-level-name]').textContent, xp: document.querySelector('[data-xp]').textContent, next: document.querySelector('[data-xp-next]').textContent, bar: document.querySelector('[data-xp-bar]').getAttribute('aria-valuenow'), badges: document.querySelectorAll('[data-badges] .pc-badge-tile').length, earned: [...document.querySelectorAll('[data-badges] .pc-badge-tile[data-earned] .pc-badge-name')].map((n) => n.textContent), stats: [...document.querySelectorAll('.pc-wallet-stats .pc-stat-num')].map((n) => n.textContent.trim()), hidden: document.querySelector('[data-disconnected]').hidden }));
        // A1: 2 tests (20) + 2 targets (10) + 2 bests at recording (30) + 1 review written (3) + 2 good reviews received (10) + 1 epoch won (25) = 98 XP, Assistant
        return { ok: got.h1 === 'Dashboard' && got.level === 'Assistant' && got.xp === '98' && /52 XP to Researcher/.test(got.next) && Number(got.bar) > 0 && got.badges === 10 && got.earned.includes('First test') && got.earned.includes('Strong binder') && got.earned.includes('Epoch winner') && got.earned.includes('Best on a target') && got.stats[0] === '2' && got.stats[2] === '2' && got.hidden === true, detail: JSON.stringify(got).slice(0, 400) };
      });
      await tryCheck('H4: my docking tests, best scores, reviews received and written, prizes, sponsorships, payment', async () => {
        const got = await t.eval(() => ({
          tests: [...document.querySelectorAll('[data-panel="tests"] tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
          testLinks: [...document.querySelectorAll('[data-panel="tests"] a')].map((a) => a.getAttribute('href')),
          best: document.querySelectorAll('[data-panel="best"] tbody tr').length,
          received: document.querySelectorAll('[data-panel="reviews-received"] .pc-review').length,
          receivedBold: document.querySelectorAll('[data-panel="reviews-received"] b').length,
          written: document.querySelectorAll('[data-panel="reviews-written"] .pc-review').length,
          prizes: document.querySelector('[data-panel="prizes"]').textContent.replace(/\s+/g, ' ').trim(),
          claim: !![...document.querySelectorAll('[data-panel="prizes"] button')].find((b) => b.textContent.trim() === 'Claim'),
          sponsorships: document.querySelector('[data-panel="sponsorships"]').textContent.replace(/\s+/g, ' ').trim(),
          payment: document.querySelector('[data-payment-line]').textContent + ' ' + document.querySelector('[data-payment-token]').textContent,
          buy: document.querySelector('#payment [data-shell="buy"]').textContent.replace(/\s+/g, ' ').trim(),
        }));
        return { ok: got.tests.length === 2 && /#3/.test(got.tests[0]) && /#1/.test(got.tests[1]) && got.testLinks.some((h) => h.startsWith('https://x.com/intent/post')) && got.testLinks.includes('/run?id=1') && got.best === 2 && got.received === 2 && got.receivedBold === 0 && got.written === 1 && /Prizes to claim · 0\.002 ETH/.test(got.prizes) && got.claim && /No sponsorships yet/.test(got.sponsorships) && /100 \$PONCHEM or 0\.0001 ETH/.test(got.payment) && /after the \$PONCHEM launch/.test(got.payment) && got.buy === 'Buy $PONCHEM · soon', detail: JSON.stringify(got).slice(0, 500) };
      });
      await tryCheck('H4: no console errors and no failed requests on the connected dashboard', async () => { const errs = t.errors(); return { ok: !errs.length, detail: errs.map((e) => `${e.kind} ${e.text.slice(0, 120)}`).join(' | ') }; });
      await t.shot('dashboard-live-1280.png');
      await t.close();
    }
    // H5. the leaderboard's Wallets and Most reviewed views, the report's Test and Reviews columns
    {
      const t = await openStubbed('/leaderboard#wallets');
      await tryCheck('H5: the Wallets view ranks by XP with level, XP, tests and dG', async () => {
        await t.until(async () => (await t.count('[data-board] tbody tr')) >= 3, 'the wallets table', 20000);
        const rows = await t.eval(() => [...document.querySelectorAll('[data-board] tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
        const head = await t.eval(() => [...document.querySelectorAll('[data-board] thead th')].map((h) => h.textContent.trim()).join(','));
        return { ok: head === 'Rank,Wallet,Level,XP,Tests,dG (kcal/mol)' && /0x11.*Assistant.*98.*2/.test(rows[0]) && /0x22.*Observer/.test(rows[1]), detail: `${head} | ${rows.join(' | ')}` };
      });
      await tryCheck('H5: the Most reviewed view lists test #1 first with two reviews', async () => {
        await t.eval(() => document.querySelector('[data-view="reviewed"]').click());
        await t.until(async () => /Most reviewed tests/.test((await t.text('[data-board]')) || ''), 'the most reviewed list', 10000);
        const rows = await t.eval(() => [...document.querySelectorAll('[data-board] tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
        const link = await t.eval(() => (document.querySelector('[data-board] tbody a') || {}).getAttribute ? document.querySelector('[data-board] tbody a').getAttribute('href') : null);
        return { ok: rows.length === 2 && /#1/.test(rows[0]) && /Quercetin into EGFR/.test(rows[0]) && /\b2$/.test(rows[0]) && link === '/run?id=1', detail: rows.join(' | ') };
      });
      await tryCheck('H5: the By target view links every row to its test page and carries the Reviews column', async () => {
        await t.eval(() => document.querySelector('[data-view="target"]').click());
        await t.until(async () => (await t.count('[data-board] .pc-lb-table tbody tr')) >= 1, 'the target board', 10000);
        const got = await t.eval(() => ({ head: [...document.querySelectorAll('[data-board] .pc-lb-table thead th')].map((h) => h.textContent.trim()), links: [...document.querySelectorAll('[data-board] .pc-lb-table a.pc-run-link')].map((a) => a.getAttribute('href')) }));
        return { ok: got.head.includes('Reviews') && got.head.includes('Test') && got.links.includes('/run?id=1'), detail: JSON.stringify(got) };
      });
      await t.close();
    }
  }
} finally {
  await chrome.close();
  await stopServer();
}

console.log(`\n${passed} passed, ${failures.length} failed${absent.length ? `\n  tolerated while absent: ${absent.join(', ')}` : ''}\n  screenshots in ${path.relative(ROOT, SHOTS)}/`);
if (failures.length) { for (const f of failures.slice(0, 60)) console.log(`  FAIL  ${f}`); process.exit(1); }
