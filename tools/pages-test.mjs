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
  for (const p of PAGES) {
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
} finally {
  await chrome.close();
  await stopServer();
}

console.log(`\n${passed} passed, ${failures.length} failed${absent.length ? `\n  tolerated while absent: ${absent.join(', ')}` : ''}\n  screenshots in ${path.relative(ROOT, SHOTS)}/`);
if (failures.length) { for (const f of failures.slice(0, 60)) console.log(`  FAIL  ${f}`); process.exit(1); }
