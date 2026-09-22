#!/usr/bin/env node
/*
 * verify.mjs: the gate a build has to pass before it ships. A working skeleton: the site builder extends it
 * (more routes, page-specific checks, the 3D views, the lab flow) without loosening what is here.
 *
 *   node tools/verify.mjs                          files, then every page on http://127.0.0.1:6130
 *   node tools/verify.mjs https://ponchem.ai       the same pages on production
 *   node tools/verify.mjs --files                  only the file gates (no browser)
 *   node tools/verify.mjs --widths 390,1440        fewer widths
 *
 * File gates (everything that ships text: the root pages, partials, js, css, api, data JSON, manifest, robots,
 * sitemap, vercel.json, package.json; lib/ is third party and exempt):
 *   pages     every page SPEC.md names exists: index lab targets target ligands ligand leaderboard report wallet docs 404 run dashboard (v2)
 *   dashes    no em dash or en dash (nor their \u escapes in JSON)       emoji     none
 *   words     nothing called a demo, mock, larp, preview, sample or placeholder (input placeholder attributes aside); nothing left from ponbio
 *   address   no 0x address in a page, a partial, data JSON or js/ (js/config.js is the one place an address lives),
 *             except the coin's CA inside the buy link once the coin is live
 *   scripts   no inline script, no on*="" attribute              links   external links carry rel="noopener";
 *                                                                          internal links resolve to a page or a file
 *   head      lang="en", viewport, title "Ponchem · ...", description, canonical, og:image, twitter:card per page
 *   footer    the footer line and the X link on every page       shell   node tools/shell.mjs --check
 *   csp       vercel.json's CSP is exactly as strict as SPEC asks (no unsafe-eval, only RCSB beyond 'self')
 *   content   per page, the key headings and strings of docs/copy.md are in the HTML (pages builder)
 *   Links to /api/<name>[.ext] resolve when api/<name>.js exists (a route, not a file).
 * Browser gates (real headless Chrome, each page at 360, 390, 430, 768, 1024, 1280, 1440):
 *   status, no horizontal overflow, no console error, no failed request, the brand mark loads (svg or png), the footer line,
 *   the X link (BRAND.x, https://x.com/PonchemAI), the blank $PONCHEM state (or the live one: Copy CA copies TOKEN.ca and says so), no visible
 *   0x address, every <title> starts with "Ponchem · ", exactly one visible h1, the page's key heading rendered,
 *   the nav collapsed to its toggle under 900 px. A 404 for a file another builder has not shipped yet (the
 *   OPTIONAL list below, checked against the disk) is noted, not failed, until the file exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = (args.find((a) => /^https?:/.test(a)) || 'http://127.0.0.1:6130').replace(/\/$/, '');
const widths = flag('widths', '360,390,430,768,1024,1280,1440').split(',').map(Number);
const filesOnly = args.includes('--files');
const CHROME_PORT = Number(process.env.CHROME_PORT || 9530);

const fails = [];
const fail = (gate, msg) => { fails.push(`${gate}: ${msg}`); };
const ok = (gate, msg) => console.log(`  pass  ${gate}${msg ? `  ${msg}` : ''}`);
const note = (msg) => console.log(`  note  ${msg}`);

// ---------------------------------------------------------------------------------------------------------
// files

const exists = (f) => fs.existsSync(path.join(ROOT, f));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const where = (text, index) => `line ${text.slice(0, index).split('\n').length}`;
const walk = (dir, keep = () => true) => {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return keep(rel, true) ? walk(rel, keep) : [];
    return keep(rel, false) ? [rel] : [];
  });
};

const SPEC_PAGES = ['index', 'lab', 'targets', 'target', 'ligands', 'ligand', 'leaderboard', 'report', 'wallet', 'docs', '404', 'run', 'dashboard'];
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const missingPages = SPEC_PAGES.filter((p) => !exists(`${p}.html`));
if (missingPages.length) fail('pages', `missing ${missingPages.map((p) => `${p}.html`).join(', ')}`);
else ok('pages', `${SPEC_PAGES.length} pages SPEC names exist`);

const partials = walk('partials');
const dataJson = walk('data', (rel, dir) => (dir ? path.basename(rel) !== 'vectors' : rel.endsWith('.json') && fs.statSync(path.join(ROOT, rel)).size < 8 * 1024 * 1024));
const code = ['js', 'css', 'api'].flatMap((d) => walk(d)).filter((f) => /\.(js|mjs|css)$/.test(f));
const misc = ['site.webmanifest', 'robots.txt', 'sitemap.xml', 'vercel.json', 'package.json'].filter(exists);
const shipped = [...pages, ...partials, ...code, ...dataJson, ...misc];

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const DASHES = /[\u2013\u2014]|\\u201[34]/;
const WORDS = /\b(demo|demos|mock|mocked|mockup|larp|preview|previews|sample|samples|placeholder|placeholders)\b|ponbio/i;
// the `placeholder` attribute of an input is not visible text: it is dropped before the words gate
const visibleOnly = (text) => text.replace(/\splaceholder="[^"]*"/g, '').replace(/\splaceholder: '[^']*'/g, '');
const counts = { dashes: 0, emoji: 0, words: 0 };
// a regular expression literal in a script is never visible copy (api/_llm.mjs strips dashes and emoji from model
// output with them): regex literals are dropped from js and mjs before the dashes and emoji gates
const stripRegexLiterals = (text) => text.replace(/(^|[=(,:;!&|?{}[\s])\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuvy]*/g, '$1');
for (const f of shipped) {
  const text = /\.m?js$/.test(f) ? stripRegexLiterals(read(f)) : read(f);
  const gates = [['dashes', DASHES], ['emoji', EMOJI]];
  if (/\.(html|json)$/.test(f)) gates.push(['words', WORDS]);
  for (const [gate, re] of gates) {
    const m = re.exec(gate === 'words' ? visibleOnly(text) : text);
    if (m) { counts[gate]++; fail(gate, `${f} ${where(text, m.index)}: "${text.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}"`); }
  }
}
for (const gate of Object.keys(counts)) if (!counts[gate]) ok(gate, `${shipped.length} files`);

const config = await import(path.join(ROOT, 'js/config.js'));
const tokenLive = !!(config.TOKEN.ca && config.TOKEN.buyUrl);
if (!!config.TOKEN.ca !== !!config.TOKEN.buyUrl) fail('token', 'TOKEN.ca and TOKEN.buyUrl must be set together');
if (tokenLive && !config.TOKEN.buyUrl.toLowerCase().endsWith(config.TOKEN.ca.toLowerCase())) fail('token', 'TOKEN.buyUrl does not end with TOKEN.ca: the buy page and Copy CA would name different coins');
if (config.TOKEN_BUY_BLANK !== 'Buy $PONCHEM · soon' || config.TOKEN_CA_BLANK !== 'CA posts here at launch') fail('token', 'the blank strings in js/config.js are not what SPEC asks');

// The coin's CA is the one address a page may carry (inside the buy link). Anything else, the lab above all, is a
// failure: visitors take any 0x string for the coin. js/config.js is where addresses live; no other script.
let addressBad = 0;
for (const f of [...pages, ...partials, ...dataJson, ...code.filter((c) => c.startsWith('js/') && c !== 'js/config.js')]) {
  const text = read(f);
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}\b/g)) {
    if (tokenLive && m[0] === config.TOKEN.ca) continue;
    addressBad++;
    fail('address', `${f} ${where(text, m.index)} carries ${m[0].slice(0, 10)}…`);
  }
}
if (!addressBad) ok('address', tokenLive ? 'only the $PONCHEM CA, inside the buy link' : 'none');

const STATIC_OK = (p) => exists(p.slice(1)) && !/^\/(tools|partials|contracts|reference|notes|docs\/|data\/vectors)/.test(p);
function linkResolves(href) {
  const p = href.split(/[?#]/)[0];
  if (!p || p === '/') return exists('index.html');
  if (p.startsWith('/api/')) return exists(`api/${p.slice(5).split('.')[0]}.js`);
  if (path.extname(p)) return STATIC_OK(p);
  return exists(`${p.slice(1)}.html`);
}
let scriptBad = 0;
let linkBad = 0;
let headBad = 0;
for (const f of [...pages, ...partials]) {
  const html = read(f);
  const isPage = !f.startsWith('partials');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(m[1]) && !/type="application\/ld\+json"/.test(m[1])) { scriptBad++; fail('scripts', `${f}: inline script`); }
  }
  const on = /\son[a-z]+\s*=\s*["']/i.exec(html);
  if (on) { scriptBad++; fail('scripts', `${f} ${where(html, on.index)}: inline event handler`); }
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>/g)) {
    const href = m[1];
    if (/^https?:\/\//.test(href)) {
      if (!/rel="[^"]*noopener/.test(m[0])) { linkBad++; fail('links', `${f}: ${m[0].slice(0, 90)} has no rel="noopener"`); }
      continue;
    }
    if (/^(mailto:|tel:|#)/.test(href) || href === '') continue;
    if (!href.startsWith('/')) { linkBad++; fail('links', `${f}: relative link "${href}" (use a root path)`); continue; }
    const target = href.split(/[?#]/)[0].slice(1) || 'index';
    if (!linkResolves(href)) {
      if (SPEC_PAGES.includes(target) && missingPages.includes(target)) continue; // the pages gate lists it already
      linkBad++;
      fail('links', `${f}: "${href}" does not resolve to a page or a shipped file`);
    }
  }
  if (!isPage) continue;
  const need = [
    [/<html[^>]*\slang="en"/, 'lang="en"'],
    [/<meta name="viewport" content="width=device-width[^"]*"/, 'viewport'],
    [/<title>Ponchem · [^<]+<\/title>/, 'title "Ponchem · ..."'],
    [/<meta name="description" content="[^"]{20,}"/, 'meta description'],
  ];
  if (f !== '404.html') need.push([/<link rel="canonical" href="https:\/\/ponchem\.ai\//, 'canonical'], [/property="og:image" content="https:\/\/ponchem\.ai\/og\.png"/, 'og:image'], [/name="twitter:card" content="summary_large_image"/, 'twitter:card']);
  for (const [re, what] of need) if (!re.test(html)) { headBad++; fail('head', `${f}: no ${what}`); }
  if (!html.includes(config.BRAND.footer)) fail('footer', `${f}: footer line missing`);
  if (!html.includes(`href="${config.BRAND.x}"`)) fail('footer', `${f}: X link missing`);
}
if (!scriptBad) ok('scripts');
if (!linkBad) ok('links');
if (!headBad) ok('head', `${pages.length} pages`);

// per page: the key headings and strings of docs/copy.md, in the static HTML (before any script runs)
const CONTENT = {
  'index.html': ['Computer-aided drug design, scored on chain.', 'Pons Lab CADD · Robinhood Chain', 'Open the lab', 'How it works', 'Three things you can trust', 'Real structures', 'A scorer you can audit', 'Every docking test is paid, scored and reviewed', '100 $PONCHEM or 0.0001 ETH', 'Four steps, one record', 'What the number means', 'Score bands', 'Five terms', 'Divided by 1 + 0.0585 x rotatable bonds.', 'What the contract checks before it believes a pose', 'Read the contract source', 'Targets people are docking this week', 'All targets', '$PONCHEM is live on ponsfamily.com', 'Buy $PONCHEM', 'Copy CA', 'Dock something today.', 'Sponsor a target', 'Docking tests', 'Reviews', 'In prize pools'],
  'targets.html': ['<h1 class="pc-h1">Targets</h1>', 'Cancer targets from the RCSB Protein Data Bank.', 'Search targets or PDB id', 'Best dG', 'Load more'],
  'target.html': ['Prize pool', 'Amount (ETH)', 'Sponsor', 'Dock this target', 'Sponsor pool', 'Settle epoch', 'Leaderboard', '3D', 'Runs', 'About', 'View on RCSB'],
  'run.html': ['Docking test', 'Post on X', 'Copy link', 'Download report', 'Chain score', 'Browser check', 'Provenance', 'Docking method', 'AI analysis', 'Reviews', 'Docking test not found', 'href="https://x.com/intent/post"'],
  'dashboard.html': ['Connect a wallet to open your dashboard', 'Your level, XP and badges', 'Connect wallet', '<h1 class="pc-h1">Dashboard</h1>', 'Copy address', 'Level', 'Badges', 'Docking tests', 'Best dG', 'Reviews received', 'Prizes to claim', 'My docking tests', 'Best scores', 'Reviews written', 'Prizes and withdraw', 'Sponsorships', 'Payment', '100 $PONCHEM or 0.0001 ETH', 'Buy $PONCHEM', 'Copy CA'],
  'ligands.html': ['<h1 class="pc-h1">Ligands</h1>', 'Bioactive plant compounds with their 3D topology on chain.', 'Search compounds or plants', 'Heavy atoms'],
  'ligand.html': ['Dock this ligand', 'Screen against all targets', 'Best targets', 'Runs', 'About'],
  'leaderboard.html': ['<h1 class="pc-h1">Leaderboard</h1>', 'Best binders by target, by cancer group and by ligand.', 'By target', 'By cancer group', 'By ligand', 'Wallets', 'Most reviewed', 'Pools', 'Download CSV'],
  'report.html': ['Cancer research report', 'Best computational binders by cancer group', 'Compiled from Robinhood Chain', 'Download Markdown', 'Print', 'Jump to', 'compiled from Robinhood Chain'],
  'wallet.html': ['<meta http-equiv="refresh" content="3; url=/dashboard" />', 'Your lab record moved to the Dashboard', 'href="/dashboard"', 'Open the dashboard'],
  'docs.html': ['id="how-it-works"', 'id="payment"', 'id="scoring"', 'id="verification"', 'id="methods"', 'id="reviews"', 'id="levels"', 'id="ai-analysis"', 'id="post-on-x"', 'id="claims"', 'id="wallet"', 'id="api"', 'id="glossary"', 'Payment', 'Scoring explained', 'What the chain checks', 'Docking methods', 'Reviews', 'Levels and badges', 'AI analysis', 'Post on X', 'What is and is not claimed', 'Wallet and network', 'Glossary', 'chain id 4663', 'GET /api/status', 'GET /api/runs', 'GET /api/analyze', 'Binding free energy (dG)', 'Reference ligand', 'It is not the AutoDock Vina program', '100 $PONCHEM', '0.0001 ETH', 'after the $PONCHEM launch', 'Principal Investigator', 'Lab Head', 'Well reviewed', 'moves.translate', 'Reproducible', 'not connected', 'Keys never reach the browser'],
  '404.html': ['>404<', 'Nothing binds here', 'The page you asked for is not in the library.', 'Back to the lab', '>Home<'],
};
let contentBad = 0;
for (const [f, needles] of Object.entries(CONTENT)) {
  if (!exists(f)) continue;
  const html = read(f);
  const missing = needles.filter((n) => !html.includes(n));
  if (missing.length) { contentBad++; fail('content', `${f}: missing ${JSON.stringify(missing)}`); }
}
if (!contentBad) ok('content', `${Object.keys(CONTENT).filter(exists).length} pages carry their copy deck strings`);

try { execFileSync('node', ['tools/shell.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }); ok('shell'); } catch (e) { fail('shell', String(e.stderr || e.message).trim()); }

// the CSP: as strict as SPEC asks, nothing looser
{
  const cfg = JSON.parse(read('vercel.json'));
  const all = (cfg.headers || []).find((h) => h.source === '/(.*)');
  const csp = all && (all.headers || []).find((h) => /^content-security-policy$/i.test(h.key));
  if (!csp) fail('csp', 'vercel.json has no Content-Security-Policy on /(.*)');
  else {
    const d = Object.fromEntries(csp.value.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const [k, ...v] = s.split(/\s+/); return [k, v]; }));
    const want = {
      'script-src': ["'self'"],
      'connect-src': ["'self'", 'https://files.rcsb.org', 'https://data.rcsb.org'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://cdn.rcsb.org'],
      'worker-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
    };
    for (const [k, v] of Object.entries(want)) {
      const got = (d[k] || []).slice().sort().join(' ');
      if (got !== v.slice().sort().join(' ')) fail('csp', `${k} is "${(d[k] || []).join(' ')}", want "${v.join(' ')}"`);
    }
    if (/unsafe-eval|\*/.test(csp.value)) fail('csp', "the CSP carries 'unsafe-eval' or a wildcard");
    if (cfg.cleanUrls !== true) fail('csp', 'vercel.json must keep cleanUrls true');
    if (!fails.some((f) => f.startsWith('csp:'))) ok('csp');
  }
}

// ---------------------------------------------------------------------------------------------------------
// browser

function firstId(file, key = null) {
  try {
    const j = JSON.parse(read(file));
    const list = Array.isArray(j) ? j : (key && j[key]) || j.items || j.targets || j.ligands || Object.values(j).find(Array.isArray) || [];
    const hit = list.find((x) => x && typeof x === 'object' && (typeof x.id === 'string' || typeof x.id === 'number'));
    return hit ? String(hit.id) : null;
  } catch { return null; }
}

if (!filesOnly && !pages.length) {
  note('no root *.html yet: browser gates skipped');
} else if (!filesOnly) {
  const { launchChrome, openPage, sleep } = await import('./lib/cdp.mjs');
  // ids: registry ids when data/registry.json exists, else catalog order (1-based): both make id 1 a real entry
  const targetId = exists('data/registry.json') ? firstId('data/registry.json', 'targets') : exists('data/catalog/targets.json') ? '1' : exists('data/targets.json') ? firstId('data/targets.json') : null;
  const ligandId = exists('data/registry.json') ? firstId('data/registry.json', 'ligands') : exists('data/catalog/ligands.json') ? '1' : exists('data/ligands.json') ? firstId('data/ligands.json') : null;
  // files other builders may not have shipped yet: a 404 for one of these is a note while it is absent on disk
  const OPTIONAL = ['js/catalog.js', 'js/chain.js', 'js/lab.js', 'js/viewer.js', 'js/engine/derived.js', 'js/engine/score.js', 'data/registry.json',
    'js/gamify.js', 'js/engine/method.js', 'js/engine/index.js', 'api/analyze.js',
    'img/brand/icon-192.png', 'img/brand/icon-512.png', 'img/brand/icon-maskable-192.png', 'img/brand/icon-maskable-512.png'];
  const absent = OPTIONAL.filter((f) => !exists(f));
  const tolerated = (url) => { try { const p = new URL(url, base).pathname.slice(1); return absent.includes(p) || (p === 'api/report.md' && !exists('api/report.js')) || (p === 'api/analyze' && !exists('api/analyze.js')); } catch { return false; } };
  const noted = new Set();
  if (absent.length) note(`absent while building, a 404 is tolerated: ${absent.join(', ')}`);
  const KEY = { '/': 'Computer-aided drug design, scored on chain.', '/targets': 'Targets', '/ligands': 'Ligands', '/leaderboard': 'Leaderboard', '/report': 'Best computational binders by cancer group', '/docs': 'Docs', '/wallet': 'Dashboard', '/dashboard': 'Connect a wallet to open your dashboard', '/run': 'Docking test', '/lab': null, '/this-page-does-not-exist': 'Nothing binds here' };
  const routes = ['/', '/lab', '/targets', '/ligands', '/leaderboard', '/report', '/wallet', '/dashboard', '/docs']
    .filter((r) => r === '/' ? exists('index.html') : exists(`${r.slice(1)}.html`));
  if (exists('run.html')) routes.push('/run?id=1');
  if (exists('target.html')) { if (targetId) routes.push(`/target?id=${encodeURIComponent(targetId)}`); else note('target.html exists but data/targets.json gave no id: /target skipped'); }
  if (exists('ligand.html')) { if (ligandId) routes.push(`/ligand?id=${encodeURIComponent(ligandId)}`); else note('ligand.html exists but data/ligands.json gave no id: /ligand skipped'); }
  routes.push('/this-page-does-not-exist');
  const chrome = await launchChrome({ port: CHROME_PORT });
  let checks = 0;
  for (const route of routes) {
    for (const w of widths) {
      const page = await openPage({ port: CHROME_PORT, width: w, height: w < 700 ? 844 : 900 });
      await page.emulate({ width: w, height: w < 700 ? 844 : 900, dpr: 1 });
      const r = await page.goto(base + route, { settle: 900 });
      await page.scrollThrough({ pause: 60, end: 300 });
      await sleep(400);
      const tag = `${route} @${w}`;
      const wantStatus = route.startsWith('/this') ? 404 : 200;
      if (r.status !== wantStatus) fail('status', `${tag}: ${r.status}, want ${wantStatus}`);
      const got = await page.eval((xUrl) => {
        const vw = document.documentElement.clientWidth;
        const ca = document.querySelector('[data-shell="ca"]');
        const buy = document.querySelector('[data-shell="buy"]');
        const mark = document.querySelector('nav a[href="/"] img');
        return {
          title: document.title,
          overflow: document.documentElement.scrollWidth - vw,
          footer: (document.querySelector('footer') || {}).textContent || '',
          caDisabled: ca ? ca.disabled : null,
          buyHref: buy ? buy.getAttribute('href') : null,
          buyText: buy ? buy.textContent.replace(/\s+/g, ' ').trim() : '',
          mark: mark ? new URL(mark.src).pathname : null,
          markOk: mark ? mark.complete : false,
          x: !!document.querySelector(`a[href="${xUrl}"]`),
          address: /0x[0-9a-fA-F]{40}/.test(document.body.innerText),
          h1s: [...document.querySelectorAll('h1')].filter((h) => !h.closest('[hidden]')).length,
          text: document.body.textContent.replace(/\s+/g, ' '),
          toggleShown: !!document.querySelector('[data-nav-toggle]') && getComputedStyle(document.querySelector('[data-nav-toggle]')).display !== 'none',
          linksShown: !!document.querySelector('.pc-nav-links') && getComputedStyle(document.querySelector('.pc-nav-links')).display !== 'none',
        };
      }, config.BRAND.x);
      if (got.h1s !== 1) fail('h1', `${tag}: ${got.h1s} visible h1 elements`);
      const key = KEY[route.split('?')[0]];
      if (key && !got.text.includes(key)) fail('content', `${tag}: "${key}" is not rendered`);
      if (w < 900 ? !(got.toggleShown && !got.linksShown) : !(!got.toggleShown && got.linksShown)) fail('nav', `${tag}: toggle ${got.toggleShown}, links ${got.linksShown}`);
      if (!/^Ponchem · /.test(got.title)) fail('title', `${tag}: "${got.title}"`);
      if (got.overflow > 0) fail('overflow', `${tag}: page is ${got.overflow}px wider than the screen`);
      if (!got.footer.includes(config.BRAND.footer)) fail('footer', `${tag}: footer line missing`);
      if (!got.x) fail('footer', `${tag}: X link missing`);
      // the brand mark: the SVG or the PNG the plumbing renders from it (partials/nav.html), and it must have loaded
      if (!/^\/img\/brand\/mark\.(svg|png)$/.test(got.mark || '') || !got.markOk) fail('logo', `${tag}: nav mark is ${got.mark}${got.mark && !got.markOk ? ' (not loaded)' : ''}`);
      if (tokenLive ? got.caDisabled !== false || got.buyHref !== config.TOKEN.buyUrl || !/Buy \$PONCHEM/.test(got.buyText) : got.caDisabled !== true || got.buyHref || got.buyText !== config.TOKEN_BUY_BLANK) {
        fail('token', `${tag}: Copy CA disabled=${got.caDisabled}, buy "${got.buyText}" -> ${got.buyHref} while TOKEN is ${tokenLive ? 'live' : 'blank'}`);
      }
      if (got.address) fail('address', `${tag}: a full 0x address is visible`);
      // once per page, at the widest size: Copy CA really copies the coin's CA and says so
      if (tokenLive && w === widths[widths.length - 1] && !route.startsWith('/this')) {
        // headless Chrome has no real clipboard to read back, so the write itself is watched
        const copied = await page.eval(async () => {
          let clip = null;
          navigator.clipboard.writeText = async (text) => { clip = text; };
          document.querySelector('[data-shell="ca"]').click();
          await new Promise((r) => setTimeout(r, 500));
          const toast = [...document.querySelectorAll('.pc-toast')].map((t) => t.textContent.trim()).pop() || '';
          return { toast, clip };
        });
        if (copied.toast !== `$${config.TOKEN.symbol} CA copied`) fail('token', `${tag}: Copy CA toast reads "${copied.toast}"`);
        if (copied.clip !== config.TOKEN.ca) fail('token', `${tag}: Copy CA copied "${copied.clip}", want the coin's CA`);
      }
      for (const e of page.errors) {
        if (route.startsWith('/this') && e.kind === 'log.network' && /404/.test(e.text)) continue; // the 404 page's own status
        if (e.kind === 'log.network' && /404/.test(e.text) && tolerated(e.url || '')) { noted.add(e.url); continue; }
        fail('console', `${tag}: ${e.kind} ${e.text.slice(0, 160)}`);
      }
      for (const q of page.requests.values()) {
        const expected404 = route.startsWith('/this') && q.type === 'Document';
        if (((q.failed && !q.canceled) || (q.status && q.status >= 400)) && !expected404) {
          if (q.status === 404 && tolerated(q.url)) { noted.add(q.url); continue; }
          fail('requests', `${tag}: ${q.status || q.errorText} ${q.url}`);
        }
      }
      checks++;
      await page.close();
    }
  }
  await chrome.close();
  if (noted.size) note(`404 tolerated while the file is absent on disk: ${[...noted].map((u) => new URL(u).pathname).join(', ')}`);
  ok('browser', `${checks} page loads on ${base}`);
}

if (fails.length) {
  console.log(`\n${fails.length} failed`);
  for (const f of fails.slice(0, 80)) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('\nevery gate passes');
