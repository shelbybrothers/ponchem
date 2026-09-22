#!/usr/bin/env node
/*
 * lab-test.mjs: does the lab page (/lab) work end to end in real headless Chrome?
 *
 *   node tools/lab-test.mjs                          against http://127.0.0.1:6132 (starts node tools/dev.mjs on
 *                                                    PORT=6132 itself when nothing listens there, and stops it after)
 *   node tools/lab-test.mjs --base http://127.0.0.1:6130    another server (must be running)
 *   node tools/lab-test.mjs --quick                  skip the screening scenario (the longest one)
 *   node tools/lab-test.mjs --only C,C2,G            run these scenarios only (letters below)
 *
 * Scenarios (screenshots land in .tmp/shots-lab/):
 *   A  1280, the real modules: loads without console errors, pickers filter and select (deep link, cancer pill,
 *      search), the direct RCSB and PubChem links in the rows (SPEC 9.4) open in a new tab without taking the tap,
 *      a Quick run completes with a negative score and the pose in the viewer, geometry rows pass, the not-live
 *      docking test state shows while LAB.address is null, Share copies the URL, the Method panel state
 *   B  390, the real modules plus the method stub: pair bar, full-screen picker sheet, 240 px viewer, sticky Find a
 *      pose bar, the Method sheet, no overflow at 390 and 360
 *   C  1280, the simulated wallet (tools/sim-wallet.js) with a stubbed live chain (js/chain.js, js/lab.js and
 *      js/engine/method.js are served from stubs kept ONLY in this file, through DevTools request interception):
 *      the payment cards (ETH checked, $PONCHEM disabled until launch), the fee line of SPEC 9.1, connect from the
 *      test button, quote() attempted and its number shown, buildSubmitRun called with { payWithToken, methodJson,
 *      runFee } (SPEC 9.1 and 9.7), sendTx reaches the simulated wallet with msg.value == runFee, the pending state
 *      carries the explorer link. Nothing is signed or sent anywhere.
 *   C2 the token allowed and the allowance short: the $PONCHEM card works, Approve reaches the wallet first
 *   C3 the token allowed and the allowance enough: submitRun with payWithToken true and msg.value 0
 *   D  the engine module answering 404: the run button is disabled and the engine line shows
 *   E  screening: one target against two ligands, a ranked table sortable by dG with Run test buttons
 *   F  js/engine/method.js answering 404: the Method panel shows the engine-unavailable line, the depth control
 *      still drives the run
 *   G  the Method panel with the stub: presets, the depth control mirror, live validation and the plain error
 *      list, two Reproducible runs with different step counts, the share link round trip, export and import,
 *      save as my method and remove
 * Console errors are failures, except the ones listed in ALLOWED_404 (files other builders may not have shipped yet).
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage, sleep } from './lib/cdp.mjs';
import { MULTICALL3 } from '../js/config.js';
import { encodeCall } from '../js/rpc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = flag('base', 'http://127.0.0.1:6132').replace(/\/$/, '');
const QUICK = args.includes('--quick');
const ONLY = flag('only', null) ? flag('only', null).split(',').map((x) => x.trim().toUpperCase()) : null;
const want = (key) => !ONLY || ONLY.includes(key);
const PORT = Number(new URL(base).port || 80);
const CHROME_PORT = Number(process.env.CHROME_PORT || 9541);
const SHOTS = path.join(ROOT, '.tmp/shots-lab');
fs.mkdirSync(SHOTS, { recursive: true });
const SIM = fs.readFileSync(path.join(ROOT, 'tools/sim-wallet.js'), 'utf8');
const A1 = '0x1111111111111111111111111111111111111111';
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const METHOD_MODULE_ON_DISK = fs.existsSync(path.join(ROOT, 'js/engine/method.js'));
const ALLOWED_404 = [/\/img\/brand\/icon-\d+\.png$/, /\/img\/brand\/apple-touch-icon\.png$/, /\/favicon\.ico$/, /\/og\.png$/, ...(METHOD_MODULE_ON_DISK ? [] : [/\/js\/engine\/method\.js$/])];
const ENGINE_MISSING = 'The docking engine could not be loaded. Reload the page.';
const FEE_LINE = /^Docking test fee 100 \$PONCHEM or 0\.0001 ETH \+ gas · paid to the lab treasury$/;

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n          ${String((e && e.message) || e).split('\n').slice(0, 5).join('\n          ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const eq = (a, b, msg) => { if (show(a) !== show(b)) throw new Error(`${msg || 'not equal'}: got ${show(a)}, want ${show(b)}`); };
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
// key order is not part of a method: the engine's canonical compact JSON sorts keys, an editor may not
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const eqJson = (a, b, msg) => eq(canon(a), canon(b), msg);

// ---------------------------------------------------------------------------------------------------------
// the dev server (only when the default port is free)

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
let dev = null;
if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) && await portFree(PORT)) {
  dev = spawn(process.execPath, [path.join(ROOT, 'tools/dev.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(100);
    try { up = (await fetch(`${base}/robots.txt`)).ok; } catch { /* not yet */ }
  }
  if (!up) { console.error(`dev server did not start on ${base}`); process.exit(2); }
  console.log(`  note  started node tools/dev.mjs on ${base}`);
}
const stopDev = () => { if (dev) { try { dev.kill('SIGTERM'); } catch { /* gone */ } dev = null; } };
process.on('exit', stopDev);

// ---------------------------------------------------------------------------------------------------------
// stubs for scenarios B, C, F and G (served through Fetch interception; never written to disk)

// js/chain.js: a live status. token / tokenAllowed / runPrice are the v2 fields of SPEC.md 9.1.
const STUB_CHAIN = ({ token = null, tokenAllowed = false, ethAllowed = true, runPrice = '100000000000000000000' } = {}) => `
export const NOT_LIVE = 'The lab opens when the contract is live.';
export const UNREACHABLE = 'Could not reach Robinhood Chain. Reads will retry.';
window.__labStatusCalls = 0;
export async function labStatus() {
  window.__labStatusCalls++;
  const now = Math.floor(Date.now() / 1000);
  return { live: true, reason: null, epoch: 3, epochStart: now - 1000, epochEnd: now + 600000, epochLength: 604800, runFee: 100000000000000n, feeBps: 500,
    token: ${token ? `'${token}'` : 'null'}, tokenAllowed: ${tokenAllowed ? 'true' : 'false'}, ethAllowed: ${ethAllowed ? 'true' : 'false'}, runPrice: ${runPrice}n,
    runCount: 12, targetCount: 100, ligandCount: 152, poolTotal: 5000000000000000n, head: 1 };
}
export function onBlock() { return () => {}; }
export function invalidate() {}
export async function runs() { return []; }
export async function bests() { return { byTarget: new Map(), byPair: new Map(), byLigand: new Map(), byTargetEpoch: new Map() }; }
export async function pools() { return new Map(); }
`;

// js/lab.js: the v2 write side of SPEC.md 9.1 and 9.7 (buildSubmitRun with { payWithToken, methodJson, runFee },
// allowanceOf(token, owner, spender), tokenBalanceOf(token, owner) and buildApprove(token, spender, amount), the
// signatures js/lab.js ships). `data` is calldata the gas estimate accepts against `to`.
const STUB_LAB = (to, data, { allowance = '0' } = {}) => `
export const NOT_LIVE = 'The lab opens when the contract is live.';
export const GEOMETRY_FAIL = 'This pose fails a geometry check, so the chain would reject it. Run again.';
window.__quoteCalls = [];
window.__buildCalls = [];
window.__allowanceCalls = [];
window.__approveCalls = [];
export function labAddress() { return '${to}'; }
export function labDeployBlock() { return 0; }
export function registerRevertExplainer() { return () => {}; }
export function explainRevert() { return null; }
export async function quote(targetId, ligandId, pose) {
  window.__quoteCalls.push({ targetId, ligandId, atoms: pose.length / 3 });
  // the same integer the browser showed, so the dry run line reads as a match (a stub knows no pocket)
  const shown = document.querySelector('[data-dg]');
  const milli = shown ? Math.round(parseFloat(shown.textContent) * 1000) : -1234;
  return { ok: true, scoreMilli: milli };
}
export function buildSubmitRun(targetId, ligandId, pose, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  window.__buildCalls.push({ targetId, ligandId, atoms: pose.length / 3, payWithToken: o.payWithToken, methodJson: o.methodJson, runFee: String(o.runFee) });
  return { to: '${to}', data: '${data}', value: o.payWithToken ? '0x0' : '0x' + BigInt(o.runFee).toString(16) };
}
export async function allowanceOf(token, owner, spender) {
  window.__allowanceCalls.push({ token, owner, spender });
  return ${allowance}n;
}
export async function tokenBalanceOf(token, owner) { return 10000000000000000000000n; }
export function buildApprove(token, spender, amount) {
  window.__approveCalls.push({ token, spender, amount: String(amount) });
  return { to: token, data: '${data}', value: '0x0' };
}
export function buildFund() { throw new Error('stub'); }
export function buildSettle() { throw new Error('stub'); }
export function buildWithdraw() { throw new Error('stub'); }
`;

// js/engine/method.js: the SPEC.md 9.7 API (METHOD_PRESETS, validateMethod, methodToCompact, methodToQuery,
// methodFromQuery) with the schema's bounds, so the panel can be exercised before the engine ships its own. It is
// served ONLY while js/engine/method.js is absent on disk: the v2 engine index imports the real module, and a stub
// in its place would break the engine itself.
const STUB_METHOD = `
const DEF = { version: 1, temperature: 1.2, moves: { translate: 1.0, rotate: 20, torsion: 60 }, local: { steps: 30 }, placement: 'box', flexible: true, candidates: 4, lattice: true };
const P = (name, extra) => ({ key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, method: { name, version: 1, ...extra } });
export const METHOD_PRESETS = [
  P('Quick', { budget: { ms: 10000 } }),
  P('Standard', { budget: { ms: 30000 } }),
  P('Deep', { budget: { ms: 90000 } }),
  P('Rigid ligand', { budget: { ms: 30000 }, flexible: false }),
  P('Wide search', { budget: { ms: 30000 }, chains: 16, moves: { translate: 2, rotate: 40, torsion: 90 }, local: { steps: 12 } }),
  P('Fine local', { budget: { ms: 30000 }, chains: 4, moves: { translate: 0.5, rotate: 10, torsion: 30 }, local: { steps: 80 } }),
  P('Reproducible', { budget: { steps: 12000 } }),
];
export const METHOD_SCHEMA = { version: 1 };
const KEYS = ['name', 'version', 'budget', 'chains', 'temperature', 'moves', 'local', 'placement', 'flexible', 'candidates', 'lattice', 'seed'];
const num = (v, lo, hi, what, errors) => { if (v === undefined) return; if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) errors.push(what + ' must be between ' + lo + ' and ' + hi + '.'); };
export function validateMethod(json) {
  const errors = [];
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, method: null, errors: ['A method is a JSON object.'] };
  for (const k of Object.keys(m)) if (!KEYS.includes(k)) errors.push('Unknown key "' + k + '".');
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('name must be a short text.');
  if (m.version !== 1) errors.push('version must be 1.');
  const b = m.budget;
  if (!b || typeof b !== 'object') errors.push('budget must be { "ms": n } or { "steps": n }.');
  else { if ((b.ms === undefined) === (b.steps === undefined)) errors.push('budget takes ms or steps, not both.'); num(b.ms, 5000, 120000, 'budget.ms', errors); num(b.steps, 100, 200000, 'budget.steps', errors); }
  num(m.chains, 1, 32, 'chains', errors); num(m.temperature, 0.1, 5, 'temperature', errors); num(m.candidates, 1, 16, 'candidates', errors);
  if (m.moves !== undefined) { if (!m.moves || typeof m.moves !== 'object') errors.push('moves must be an object.'); else { num(m.moves.translate, 0.05, 5, 'moves.translate', errors); num(m.moves.rotate, 1, 180, 'moves.rotate', errors); num(m.moves.torsion, 1, 180, 'moves.torsion', errors); } }
  if (m.local !== undefined) { if (!m.local || typeof m.local !== 'object') errors.push('local must be an object.'); else num(m.local.steps, 0, 300, 'local.steps', errors); }
  if (m.placement !== undefined && !['box', 'center'].includes(m.placement)) errors.push('placement must be box or center.');
  if (m.flexible !== undefined && typeof m.flexible !== 'boolean') errors.push('flexible must be true or false.');
  if (m.lattice !== undefined && typeof m.lattice !== 'boolean') errors.push('lattice must be true or false.');
  num(m.seed, 0, 4294967295, 'seed', errors);
  if (errors.length) return { ok: false, method: null, errors };
  const method = { ...DEF, ...m, moves: { ...DEF.moves, ...(m.moves || {}) }, local: { ...DEF.local, ...(m.local || {}) } };
  if (method.chains === undefined) method.chains = b.steps ? Math.max(4, Math.min(16, Math.round(b.steps / 900))) : 8;
  return { ok: true, method, errors: [] };
}
export function methodToCompact(m) { return JSON.stringify(m); }
const enc = (t) => btoa(unescape(encodeURIComponent(t))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
const dec = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
export function methodToQuery(m) { return enc(JSON.stringify(m)); }
export function methodFromQuery(s) { try { return validateMethod(JSON.parse(dec(s))); } catch (e) { return { ok: false, method: null, errors: ['not valid'] }; } }
`;
const METHOD_STUBS = METHOD_MODULE_ON_DISK ? [] : [{ test: /\/js\/engine\/method\.js(\?|$)/, body: STUB_METHOD }];
// a short reproducible search (300 steps, about a second) for the chain scenarios
const FAST_METHOD = { name: 'Reproducible', version: 1, budget: { steps: 300 } };
const FAST_QUERY = b64url(JSON.stringify(FAST_METHOD));

async function intercept(page, table) {
  // table: [{ test: RegExp, body: string | null (404), type }]
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  page.on('Fetch.requestPaused', async (p) => {
    const hit = table.find((t) => t.test.test(p.request.url));
    try {
      if (!hit) { await page.send('Fetch.continueRequest', { requestId: p.requestId }); return; }
      if (hit.body === null) {
        await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: Buffer.from('not found').toString('base64') });
        return;
      }
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: hit.type || 'text/javascript; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }], body: Buffer.from(hit.body).toString('base64') });
    } catch { /* the page went away */ }
  });
}

// ---------------------------------------------------------------------------------------------------------

const chrome = await launchChrome({ port: CHROME_PORT });

async function open({ width = 1280, route = '/lab', wallet = null, stubs = null, settle = 1500, keepStorage = false } = {}) {
  const page = await openPage({ port: CHROME_PORT, width, height: width < 700 ? 844 : 900 });
  await page.emulate({ width, height: width < 700 ? 844 : 900, dpr: 1 });
  if (stubs) await intercept(page, stubs);
  await page.goto(`${base}/robots.txt`, { settle: 50 });
  if (!keepStorage) await page.eval(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* fine */ } });
  if (wallet) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__walletSim = ${JSON.stringify(wallet)};\n${SIM}` });
  await page.goto(base + route, { settle });
  const t = {
    page,
    eval: (fn, ...a) => page.eval(fn, ...a),
    text: (sel) => page.eval((s) => { const n = document.querySelector(s); return n ? n.innerText.replace(/\s+/g, ' ').trim() : null; }, sel),
    attr: (sel, name) => page.eval((s, n) => { const e = document.querySelector(s); return e ? e.getAttribute(n) : null; }, sel, name),
    click: async (sel) => { const hit = await page.eval((s) => { const n = document.querySelector(s); if (n) n.click(); return !!n; }, sel); assert(hit, `nothing to click at ${sel}`); },
    type: async (sel, value) => { await page.eval((s, v) => { const n = document.querySelector(s); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }, sel, value); },
    until: async (fn, what, ms = 8000) => { const t0 = Date.now(); for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(120); } },
    ready: async () => { await t.until(async () => (await t.attr('[data-lab]', 'data-state')) === 'ready', 'data-state=ready'); },
    finished: async (ms = 60000) => { await t.until(async () => (await t.text('[data-run]')) === 'Run again', 'the run to finish', ms); },
    toasts: () => page.eval(() => [...document.querySelectorAll('.pc-toast')].map((x) => x.textContent.trim())),
    shot: (name, { fullPage = false } = {}) => page.screenshot(path.join(SHOTS, name), { fullPage }),
    errors: (extraAllowed = []) => page.errors.filter((e) => {
      const url = e.url || (e.text.match(/https?:\/\/\S+/) || [''])[0];
      if (e.kind === 'log.network' && /404/.test(e.text) && [...ALLOWED_404, ...extraAllowed].some((re) => re.test(url))) return false;
      if (/Refused to apply style/.test(e.text)) return false;
      return true;
    }).map((e) => `${e.kind}: ${e.text.slice(0, 160)} ${e.url}`),
    close: () => page.close(),
  };
  return t;
}

// choose a method preset (or a saved method) in the panel's select by the option's visible text
const pickOption = (t, text, scope = '') => t.eval((s, txt) => {
  const sel = document.querySelector(s + '[data-method-preset]');
  const o = [...sel.options].find((x) => x.textContent === txt);
  if (!o) return null;
  sel.value = o.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
}, scope, text);

// the wallet menu -> MetaMask, until the address shows on the button
async function connect(t) {
  await t.click('[data-lab-action] [data-record]');
  await t.until(async () => t.eval(() => !document.querySelector('[data-wallet-menu]').hidden), 'the wallet menu');
  const hit = await t.eval(() => { const n = [...document.querySelectorAll('[data-wallet-menu] [role="menuitem"]')].find((x) => /MetaMask/.test(x.textContent)); if (n) n.click(); return !!n; });
  assert(hit, 'MetaMask is listed');
  await t.until(async () => (await t.text('[data-wallet-button]')) === short(A1), 'the address on the wallet button');
  await t.until(async () => (await t.attr('[data-lab-action]', 'data-record-state')) === 'ready', 'the ready state');
}

// ---------------------------------------------------------------------------------------------------------

console.log(`Ponchem lab test\n  base   ${base}\n  method module on disk: ${METHOD_MODULE_ON_DISK ? 'yes' : 'no (the panel shows the engine-unavailable line with the real modules)'}\n`);
if (want('A')) {
console.log('A. desktop 1280, real modules');
{
  const t = await open({ width: 1280, route: '/lab?target=EGFR&ligand=QUERCETIN&depth=quick&seed=7' });
  await check('the page loads: title, ready state, no horizontal overflow', async () => {
    await t.ready();
    eq(await t.eval(() => document.title), 'Ponchem · Lab');
    eq(await t.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'overflow');
    assert(await t.eval(() => !!document.querySelector('[data-wallet-root] [data-wallet-button]')), 'the wallet button is in the nav');
  });
  await check('the deep link selects the target and the ligand (rows, chips, URL ids)', async () => {
    eq(await t.attr('[data-picker="target"] .lab-row[aria-selected="true"]', 'data-badge'), '4WKQ', 'the EGFR row is selected');
    assert(/Quercetin/.test(await t.text('[data-picker="ligand"] .lab-row[aria-selected="true"]')), 'the quercetin row is selected');
    eq(await t.text('[data-chip-target]'), '4WKQ · EGFR');
    eq(await t.text('[data-chip-ligand]'), 'QUE · Quercetin');
    const u = new URL(await t.eval(() => location.href));
    assert(/^\d+$/.test(u.searchParams.get('target')) && /^\d+$/.test(u.searchParams.get('ligand')), `the URL carries registry ids: ${u.search}`);
    eq(u.searchParams.get('depth'), 'quick');
    eq(u.searchParams.get('seed'), '7');
    eq(u.searchParams.get('method'), null, 'a depth preset carries no ?method=');
    eq(await t.eval(() => document.querySelector('[data-seed]').value), '7', 'the seed field shows the seed');
  });
  await check('the rows carry the direct RCSB and PubChem links (SPEC 9.4): new tab, named, without taking the tap', async () => {
    const link = (sel) => t.eval((s) => { const a = document.querySelector(s); return a ? { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), label: a.getAttribute('aria-label'), text: a.textContent.trim(), tag: a.tagName } : null; }, sel);
    const tl = await link('[data-picker="target"] .lab-row[aria-selected="true"] a.lab-row-link');
    eq(tl, { href: 'https://www.rcsb.org/structure/4WKQ', target: '_blank', rel: 'noopener noreferrer', label: 'RCSB 4WKQ', text: 'RCSB 4WKQ', tag: 'A' });
    const ll = await link('[data-picker="ligand"] .lab-row[aria-selected="true"] a.lab-row-link');
    eq(ll.href, 'https://www.rcsb.org/ligand/QUE');
    eq(ll.label, 'RCSB QUE');
    await t.type('[data-picker="ligand"] .lab-search-input', 'evodiamine');
    const pl = await link('[data-picker="ligand"] .lab-row:not([hidden]) a.lab-row-link');
    eq(pl.href, 'https://pubchem.ncbi.nlm.nih.gov/compound/442088', 'a ligand without a CCD links to PubChem');
    eq(pl.label, 'PubChem 442088');
    await t.type('[data-picker="ligand"] .lab-search-input', '');
    // a click on the link of another row must not select that row (the tap stays the row's)
    const changed = await t.eval(() => {
      document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a.lab-row-link'); if (a) e.preventDefault(); }, true);
      const before = document.querySelector('[data-picker="target"] .lab-row[aria-selected="true"]').dataset.badge;
      const other = [...document.querySelectorAll('[data-picker="target"] .lab-row')].find((r) => r.getAttribute('aria-selected') !== 'true' && !r.hidden);
      other.querySelector('a.lab-row-link').click();
      return { before, after: document.querySelector('[data-picker="target"] .lab-row[aria-selected="true"]').dataset.badge, otherHref: other.querySelector('a.lab-row-link').getAttribute('href') };
    });
    eq(changed.after, changed.before, 'the selection did not move');
    assert(/^https:\/\/www\.rcsb\.org\/structure\/[0-9A-Z]{4}$/.test(changed.otherHref), changed.otherHref);
    eq(await t.text('[data-chip-target]'), '4WKQ · EGFR');
    eq(await t.attr('[data-viewer-rcsb]', 'href'), 'https://www.rcsb.org/structure/4WKQ', 'the viewer strip link');
    eq(await t.text('[data-viewer-rcsb]'), 'RCSB 4WKQ');
  });
  await check('the structure loads from RCSB into the 3D viewer, with the pocket box', async () => {
    await t.until(async () => (await t.attr('[data-viewer-host]', 'data-structure')) === '4WKQ', 'data-structure=4WKQ', 30000);
    eq(await t.attr('[data-lab-viewer-card]', 'data-viewer'), 'on');
    eq(await t.attr('[data-viewer-host]', 'data-box'), 'on', 'the box is drawn');
    assert(await t.eval(() => { const c = document.querySelector('[data-viewer-host] canvas'); return c && c.clientHeight > 100; }), 'the canvas has a size');
  });
  await check('the target picker filters: search by name and PDB id, a cancer pill, the empty state', async () => {
    const visible = () => t.eval(() => [...document.querySelectorAll('[data-picker="target"] .lab-row')].filter((r) => !r.hidden).length);
    const all = await visible();
    assert(all >= 90, `${all} target rows`);
    await t.type('[data-picker="target"] .lab-search-input', '4wkq');
    eq(await visible(), 1, 'one row for 4wkq');
    await t.type('[data-picker="target"] .lab-search-input', 'zzzz-no-such');
    eq(await visible(), 0);
    eq(await t.text('[data-picker="target"] .lab-picker-empty h4'), 'No matches');
    await t.click('[data-picker="target"] .lab-picker-empty button');
    eq(await visible(), all, 'Clear search restores every row');
    await t.click('[data-picker="target"] .lab-pill[data-group="lung"]');
    const lung = await visible();
    assert(lung > 0 && lung < all, `${lung} lung rows of ${all}`);
    await t.click('[data-picker="target"] .lab-pill[data-group=""]');
    eq(await visible(), all);
  });
  await check('picking another target changes the chip, the URL and the structure; picking EGFR back (Enter on the row too)', async () => {
    const idBefore = new URL(await t.eval(() => location.href)).searchParams.get('target');
    await t.type('[data-picker="target"] .lab-search-input', 'vegfr');
    await t.click('[data-picker="target"] .lab-row:not([hidden])');
    const chip = await t.text('[data-chip-target]');
    assert(/^[0-9A-Z]{4} · KDR$/.test(chip), `the KDR (VEGFR2) chip: ${chip}`);
    assert(new URL(await t.eval(() => location.href)).searchParams.get('target') !== idBefore, 'the URL id changed');
    await t.until(async () => (await t.attr('[data-viewer-host]', 'data-structure')) === chip.slice(0, 4), 'the new structure', 30000);
    await t.type('[data-picker="target"] .lab-search-input', '4wkq');
    await t.eval(() => { const r = document.querySelector('[data-picker="target"] .lab-row:not([hidden])'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    eq(await t.text('[data-chip-target]'), '4WKQ · EGFR');
    await t.until(async () => (await t.attr('[data-viewer-host]', 'data-structure')) === '4WKQ', '4WKQ again', 30000);
  });
  await check('the run controls read Dock / Find a pose and name the active method', async () => {
    eq(await t.text('.lab-run-head .lab-eyebrow'), 'DOCK');
    eq(await t.text('[data-run]'), 'Find a pose');
    eq(await t.text('[data-method-name]'), 'Quick');
    eq(await t.text('[data-lab-results] .lab-empty p'), 'Choose a target and a ligand, then find a pose.');
  });
  await check('a Quick run completes: negative integer score, pose in the viewer, geometry rows pass, terms shown', async () => {
    eq(await t.attr('[data-depth-key="quick"]', 'aria-pressed'), 'true');
    assert(!(await t.eval(() => document.querySelector('[data-run]').disabled)), 'Find a pose is enabled');
    await t.click('[data-run]');
    await t.until(async () => (await t.text('[data-run]')) === 'Stop', 'the Stop button');
    await t.until(async () => /Pose search · \d+% · best so far/.test(await t.text('[data-progress-caption]')), 'the progress caption');
    await t.finished();
    const dg = parseFloat(await t.text('[data-dg]'));
    assert(Number.isFinite(dg) && dg < 0, `dG is negative: ${dg}`);
    eq(await t.attr('[data-viewer-host]', 'data-pose'), '1', 'the pose is shown');
    eq(await t.eval(() => [...document.querySelectorAll('.lab-geo-list li')].map((li) => li.dataset.ok)), ['pass', 'pass', 'pass', 'pass']);
    const rows = await t.eval(() => [...document.querySelectorAll('.lab-rows dt')].map((dt) => dt.firstChild.textContent.trim()));
    for (const label of ['Estimated pKd', 'Estimated Kd', 'Ligand efficiency', 'Heavy atoms', 'Rotatable bonds', 'Method', 'Seed', 'Elapsed', 'gauss 1', 'gauss 2', 'repulsion', 'hydrophobic', 'hydrogen bond']) assert(rows.includes(label), `row ${label}`);
    eq(await t.text('[data-lab-results] [data-row="method"]'), 'Quick');
    eq(await t.text('[data-lab-results] [data-row="seed"]'), '7');
    eq(await t.text('[data-lab-results] .lab-chip[data-source="browser"]'), 'browser estimate');
    assert(/^(strong|moderate|weak) binder$/.test(await t.text('.lab-band-label')), await t.text('.lab-band-label'));
    await t.shot('A-run-1280.png');
  });
  await check('the not-live state: Run docking test disabled with the lab line while LAB.address is null, no payment cards', async () => {
    eq(await t.attr('[data-lab-action]', 'data-record-state'), 'not-live');
    eq(await t.text('[data-lab-action] [data-record]'), 'Run docking test');
    assert(await t.eval(() => document.querySelector('[data-lab-action] [data-record]').disabled), 'disabled');
    eq(await t.text('[data-record-note]'), 'The lab opens when the contract is live.');
    eq(await t.eval(() => document.querySelectorAll('[data-lab-action] .lab-pay').length), 0, 'no payment cards while not live');
  });
  await check(METHOD_MODULE_ON_DISK ? 'the Method panel is ready with the engine presets' : 'the Method panel shows the engine-unavailable line while js/engine/method.js is absent', async () => {
    if (METHOD_MODULE_ON_DISK) {
      eq(await t.attr('[data-lab]', 'data-methods'), 'on');
      eq(await t.attr('[data-method-panel]', 'data-state'), 'ready');
      const names = await t.eval(() => [...document.querySelectorAll('[data-method-preset] optgroup:first-of-type option')].map((o) => o.textContent));
      for (const n of ['Quick', 'Standard', 'Deep', 'Rigid ligand', 'Wide search', 'Fine local', 'Reproducible']) assert(names.includes(n), `preset ${n} in ${show(names)}`);
    } else {
      eq(await t.attr('[data-lab]', 'data-methods'), 'off');
      eq(await t.attr('[data-method-panel]', 'data-state'), 'unavailable');
      eq(await t.text('[data-method-unavailable]'), ENGINE_MISSING);
    }
    await t.click('[data-method-open]');
    assert(!(await t.eval(() => document.querySelector('[data-lab-method]').hidden)), 'the method card opens');
    eq(await t.attr('[data-method-open]', 'aria-expanded'), 'true');
    await t.click('[data-method-close]');
    assert(await t.eval(() => document.querySelector('[data-lab-method]').hidden), 'Hide closes it');
  });
  await check('Share this run copies the URL and says so', async () => {
    const r = await t.eval(async () => {
      let clip = null;
      navigator.clipboard.writeText = async (text) => { clip = text; };
      document.querySelector('.lab-share').click();
      await new Promise((r) => setTimeout(r, 400));
      return { clip, toast: [...document.querySelectorAll('.pc-toast')].map((x) => x.textContent.trim()).pop() };
    });
    eq(r.toast, 'Link copied');
    assert(r.clip && /\/lab\?.*seed=7/.test(r.clip), `the copied link: ${r.clip}`);
  });
  await check('no visible 0x address, no dash glyphs, no banned words, no console errors', async () => {
    const text = await t.eval(() => document.body.innerText);
    assert(!/0x[0-9a-fA-F]{40}/.test(text), 'a full address is visible');
    assert(!/[\u2013\u2014]/.test(text), 'a dash glyph is visible');
    assert(!/\b(demo|mock|preview|larp|sample|placeholder)\b/i.test(text), 'a banned word is visible');
    eq(t.errors(), []);
  });
  await t.close();
}
}

if (want('B')) {
console.log('\nB. phone 390, real modules plus the method stub');
{
  const t = await open({ width: 390, route: '/lab?ligand=QUERCETIN', stubs: METHOD_STUBS });
  await check('pair bar with two 44 px chips, the viewer 240 px tall, the sticky Find a pose bar, no overflow', async () => {
    await t.ready();
    const got = await t.eval(() => ({
      bar: getComputedStyle(document.querySelector('[data-lab-pairbar]')).display,
      chips: [...document.querySelectorAll('[data-chip]')].map((c) => [c.textContent.trim(), Math.round(c.getBoundingClientRect().height)]),
      viewer: Math.round(document.querySelector('[data-lab-viewer-card]').getBoundingClientRect().height),
      dock: getComputedStyle(document.querySelector('[data-lab-dock]')).display,
      dockText: document.querySelector('[data-lab-dock]').innerText.replace(/\s+/g, ' ').trim(),
      rail: getComputedStyle(document.querySelector('[data-picker-host="target"]')).display,
      methodCard: getComputedStyle(document.querySelector('[data-lab-method]')).display,
      chipH: Math.round(document.querySelector('[data-method-open]').getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    eq(got.bar, 'grid');
    eq(got.chips, [['Choose target', 44], ['Ligand: Quercetin', 44]]);
    eq(got.viewer, 240);
    eq(got.dock, 'block');
    eq(got.dockText, 'Find a pose');
    eq(got.rail, 'none', 'the rail pickers are hidden on a phone');
    eq(got.methodCard, 'none', 'the method card is not a card on a phone');
    assert(got.chipH >= 44, `the method chip is ${got.chipH} px tall`);
    eq(got.overflow, 0);
  });
  await check('the target chip opens a full-screen sheet; search, pick, the sheet closes and the picker returns', async () => {
    await t.click('[data-chip="target"]');
    await t.until(async () => !(await t.eval(() => document.querySelector('[data-lab-sheet]').hidden)), 'the sheet');
    eq(await t.text('[data-lab-sheet] .lab-sheet-title'), 'Choose a target');
    assert(await t.eval(() => !!document.querySelector('[data-lab-sheet] [data-picker="target"]')), 'the picker moved into the sheet');
    eq(await t.eval(() => getComputedStyle(document.querySelector('[data-lab-dock]')).display), 'none', 'the dock hides under the sheet');
    const h = await t.eval(() => document.querySelector('.lab-sheet-panel').getBoundingClientRect().height / innerHeight);
    assert(h > 0.8, `sheet height ${h}`);
    await t.type('[data-lab-sheet] .lab-search-input', 'egfr');
    await t.click('[data-lab-sheet] .lab-row:not([hidden])');
    await t.until(async () => t.eval(() => document.querySelector('[data-lab-sheet]').hidden), 'the sheet to close');
    eq(await t.text('[data-chip="target"]'), 'Target: EGFR');
    assert(await t.eval(() => !!document.querySelector('[data-picker-host="target"] [data-picker="target"]')), 'the picker is back in the rail');
    eq(await t.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'overflow');
    await t.shot('B-phone-390.png');
  });
  await check('the method chip opens the Method sheet; a preset picked there shows on the chip; Done puts the panel back', async () => {
    await t.click('[data-method-open]');
    await t.until(async () => !(await t.eval(() => document.querySelector('[data-lab-sheet]').hidden)), 'the method sheet');
    eq(await t.text('[data-lab-sheet] .lab-sheet-title'), 'Docking method');
    assert(await t.eval(() => !!document.querySelector('[data-lab-sheet] [data-method-panel][data-state="ready"]')), 'the panel moved into the sheet');
    assert(await pickOption(t, 'Wide search', '[data-lab-sheet] '), 'Wide search is listed');
    eq(await t.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'overflow with the sheet open');
    await t.shot('B-method-sheet-390.png');
    await t.click('[data-lab-sheet] .lab-sheet-done');
    await t.until(async () => t.eval(() => document.querySelector('[data-lab-sheet]').hidden), 'the sheet to close');
    assert(await t.eval(() => !!document.querySelector('[data-method-host] [data-method-panel]')), 'the panel is back in its card');
    eq(await t.text('[data-method-name]'), 'Wide search');
    eq(await t.eval(() => [...document.querySelectorAll('[data-depth-key]')].map((b) => b.getAttribute('aria-pressed'))), ['false', 'false', 'false'], 'no depth pressed for a non-depth preset');
    assert(new URL(await t.eval(() => location.href)).searchParams.get('method'), 'the URL carries ?method=');
  });
  await check('at 360 nothing overflows either', async () => {
    await t.page.emulate({ width: 360, height: 780, dpr: 1 });
    await sleep(300);
    eq(await t.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'overflow at 360');
    await t.click('[data-method-open]');
    await sleep(200);
    eq(await t.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'overflow at 360 with the method sheet');
    await t.shot('B-phone-360.png');
    await t.click('[data-lab-sheet] .lab-sheet-done');
  });
  await check('no console errors', async () => eq(t.errors(), []));
  await t.close();
}
}

console.log('\nC. the docking test with the simulated wallet and a stubbed live chain, paid in ETH (nothing is sent)');
const to = MULTICALL3;
// a payable call that succeeds with msg.value, so the gas estimate through /api/rpc does not revert
const data = encodeCall('function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)', [[]]);
if (want('C')) {
  const stubs = [{ test: /\/js\/chain\.js(\?|$)/, body: STUB_CHAIN() }, { test: /\/js\/lab\.js(\?|$)/, body: STUB_LAB(to, data) }, ...METHOD_STUBS];
  const t = await open({ width: 1280, route: `/lab?target=EGFR&ligand=QUERCETIN&seed=11&method=${FAST_QUERY}`, wallet: { account: A1, startChain: '0x1' }, stubs });
  await check('with a live status: the fee line of SPEC 9.1, the payment cards (ETH checked, $PONCHEM disabled until launch), the button asks for a wallet', async () => {
    await t.ready();
    eq(await t.text('[data-method-name]'), 'Reproducible');
    await t.click('[data-run]');
    await t.finished();
    eq(await t.text('[data-lab-results] [data-row="steps"]'), '300', 'the reproducible method ran 300 steps');
    eq(await t.attr('[data-lab-action]', 'data-record-state'), 'connect');
    eq(await t.text('[data-lab-action] [data-record]'), 'Connect wallet to run the test');
    assert(FEE_LINE.test(await t.text('[data-lab-action] [data-fee]')), await t.text('[data-lab-action] [data-fee]'));
    const cards = await t.eval(() => [...document.querySelectorAll('[data-lab-action] .lab-pay [role="radio"]')].map((c) => ({ pay: c.dataset.pay, checked: c.getAttribute('aria-checked'), disabled: c.disabled, label: c.querySelector('.lab-pay-label').textContent, note: (c.querySelector('.lab-pay-note') || {}).textContent || '' })));
    eq(cards, [
      { pay: 'eth', checked: 'true', disabled: false, label: 'Pay 0.0001 ETH', note: '' },
      { pay: 'token', checked: 'false', disabled: true, label: 'Pay 100 $PONCHEM', note: 'after the $PONCHEM launch' },
    ]);
    eq(await t.attr('[data-lab-action] .lab-pay', 'role'), 'radiogroup');
    await t.shot('C-payment-cards.png', { fullPage: true });
  });
  await check('the test button opens the wallet menu; connecting moves the button to Run docking test', async () => {
    await connect(t);
    eq(await t.text('[data-lab-action] [data-record]'), 'Run docking test');
  });
  await check('Run docking test: quote() is attempted and its number shown, buildSubmitRun gets { payWithToken: false, methodJson, runFee }, sendTx reaches the wallet with msg.value == runFee, pending with the explorer link', async () => {
    await t.click('[data-lab-action] [data-record]');
    await t.until(async () => (await t.eval(() => window.__quoteCalls.length)) === 1, 'quote()');
    const q = await t.eval(() => window.__quoteCalls[0]);
    assert(q.targetId > 0 && q.ligandId > 0 && q.atoms === 22, `quote args ${show(q)}`);
    await t.until(async () => (await t.attr('[data-lab-action]', 'data-record-state')) === 'pending', 'the pending state', 20000);
    eq(await t.text('[data-lab-action] [data-record]'), 'Waiting for the chain');
    const line = await t.text('[data-lab-action] [data-quote]');
    assert(/^Chain dry run -?\d+\.\d{3} kcal\/mol$/.test(line), `the dry run line: ${line}`);
    const link = await t.attr('[data-lab-action] a.lab-link', 'href');
    assert(link && link.startsWith('https://robinhoodchain.blockscout.com/tx/0x'), `explorer link ${link}`);
    const sent = await t.eval(() => window.__walletSent());
    eq(sent.length, 1, 'one transaction reached the wallet');
    eq(sent[0].chainAtSend, '0x1237', 'on Robinhood Chain when signing');
    eq(sent[0].tx.to.toLowerCase(), to.toLowerCase());
    eq(sent[0].tx.value, '0x5af3107a4000', 'msg.value is the run fee');
    const built = await t.eval(() => window.__buildCalls[0]);
    eq(built.payWithToken, false);
    eq(built.runFee, '100000000000000');
    const m = JSON.parse(built.methodJson);
    eq(m.name, 'Reproducible', 'the compact method JSON names the method');
    eq(m.budget.steps, 300);
    eq(m.seed, 11, 'the seed is filled in');
    assert(Buffer.byteLength(built.methodJson) <= 1024 && !/\s/.test(built.methodJson), `compact JSON: ${built.methodJson}`);
    eq(await t.eval(() => window.__allowanceCalls.length), 0, 'no allowance read on the ETH path');
    assert(await t.eval(() => [...document.querySelectorAll('[data-lab-action] .lab-pay [role="radio"]')].every((c) => c.disabled)), 'the cards lock while pending');
    assert((await t.toasts()).includes('Transaction sent. Waiting for confirmation.'), `toasts ${show(await t.toasts())}`);
    await t.shot('C-record-pending.png');
  });
  await check('no console errors in the ETH session', async () => eq(t.errors(), []));
  await t.close();
}

if (want('C2')) {
console.log('\nC2. the token allowed, the allowance short: Approve first');
{
  const stubs = [{ test: /\/js\/chain\.js(\?|$)/, body: STUB_CHAIN({ token: MULTICALL3, tokenAllowed: true }) }, { test: /\/js\/lab\.js(\?|$)/, body: STUB_LAB(to, data, { allowance: '0' }) }, ...METHOD_STUBS];
  const t = await open({ width: 1280, route: `/lab?target=EGFR&ligand=QUERCETIN&seed=11&method=${FAST_QUERY}`, wallet: { account: A1, startChain: '0x1' }, stubs });
  await check('the $PONCHEM card is enabled and can be chosen', async () => {
    await t.ready();
    await t.click('[data-run]');
    await t.finished();
    const tok = await t.eval(() => { const c = document.querySelector('[data-lab-action] .lab-pay [data-pay="token"]'); return { disabled: c.disabled, note: !!c.querySelector('.lab-pay-note') }; });
    eq(tok, { disabled: false, note: false });
    await t.click('[data-lab-action] .lab-pay [data-pay="token"]');
    eq(await t.attr('[data-lab-action] .lab-pay [data-pay="token"]', 'aria-checked'), 'true');
    eq(await t.attr('[data-lab-action] .lab-pay [data-pay="eth"]', 'aria-checked'), 'false');
    eq(await t.attr('[data-lab-action]', 'data-pay'), 'token');
  });
  await check('after connect: allowance read, Approve reaches the wallet (to the token, value 0), the state reads Approving $PONCHEM', async () => {
    await connect(t);
    eq(await t.attr('[data-lab-action]', 'data-pay'), 'token', 'the choice survives the connect');
    await t.click('[data-lab-action] [data-record]');
    await t.until(async () => (await t.attr('[data-lab-action]', 'data-record-state')) === 'approving', 'the approving state', 20000);
    eq(await t.text('[data-lab-action] [data-record]'), 'Approving $PONCHEM');
    const allowance = await t.eval(() => window.__allowanceCalls);
    eq(allowance.length, 1);
    eq(allowance[0].owner.toLowerCase(), A1);
    eq(allowance[0].token.toLowerCase(), MULTICALL3.toLowerCase());
    const approve = await t.eval(() => window.__approveCalls);
    eq(approve.length, 1);
    eq(approve[0].token, MULTICALL3);
    eq(approve[0].spender.toLowerCase(), to.toLowerCase(), 'the lab is the spender');
    eq(approve[0].amount, '100000000000000000000', '100 $PONCHEM approved');
    eq(allowance[0].spender.toLowerCase(), to.toLowerCase());
    await t.until(async () => (await t.eval(() => window.__walletSent().length)) === 1, 'the approve at the wallet', 20000);
    const sent = await t.eval(() => window.__walletSent());
    eq(sent.length, 1, 'only the approve reached the wallet so far');
    eq(sent[0].tx.to.toLowerCase(), MULTICALL3.toLowerCase());
    eq(sent[0].tx.value, '0x0');
    eq(await t.eval(() => window.__buildCalls.length), 0, 'submitRun waits for the approval');
    assert(!!(await t.attr('[data-lab-action] a.lab-link', 'href')), 'the approve transaction link shows');
    assert((await t.toasts()).includes('Approval sent. Waiting for confirmation.'), `toasts ${show(await t.toasts())}`);
    await t.shot('C2-approving.png', { fullPage: true });
  });
  await check('no console errors in the approve session', async () => eq(t.errors(), []));
  await t.close();
}
}

if (want('C3')) {
console.log('\nC3. the token allowed, the allowance enough: submitRun paid with $PONCHEM');
{
  const stubs = [{ test: /\/js\/chain\.js(\?|$)/, body: STUB_CHAIN({ token: MULTICALL3, tokenAllowed: true }) }, { test: /\/js\/lab\.js(\?|$)/, body: STUB_LAB(to, data, { allowance: '1000000000000000000000' }) }, ...METHOD_STUBS];
  const t = await open({ width: 1280, route: `/lab?target=EGFR&ligand=QUERCETIN&seed=11&method=${FAST_QUERY}`, wallet: { account: A1, startChain: '0x1' }, stubs });
  await check('buildSubmitRun gets payWithToken true and runFee 0; the wallet sees msg.value 0; no Approve', async () => {
    await t.ready();
    await t.click('[data-run]');
    await t.finished();
    await t.click('[data-lab-action] .lab-pay [data-pay="token"]');
    await connect(t);
    await t.click('[data-lab-action] [data-record]');
    await t.until(async () => (await t.attr('[data-lab-action]', 'data-record-state')) === 'pending', 'the pending state', 20000);
    eq(await t.eval(() => window.__approveCalls.length), 0, 'no approve needed');
    const built = await t.eval(() => window.__buildCalls[0]);
    eq(built.payWithToken, true);
    eq(built.runFee, '0');
    eq(JSON.parse(built.methodJson).name, 'Reproducible');
    const sent = await t.eval(() => window.__walletSent());
    eq(sent.length, 1);
    eq(sent[0].tx.to.toLowerCase(), to.toLowerCase());
    eq(sent[0].tx.value, '0x0', 'msg.value is zero on the token path');
    eq(t.errors(), []);
  });
  await t.close();
}
}

if (want('D')) {
console.log('\nD. the engine module missing');
{
  const t = await open({ width: 1280, route: '/lab?target=EGFR&ligand=QUERCETIN', stubs: [{ test: /\/js\/engine\/index\.js(\?|$)/, body: null }] });
  await check('Find a pose is disabled and the engine line explains', async () => {
    await t.ready();
    eq(await t.attr('[data-lab]', 'data-engine'), 'off');
    assert(await t.eval(() => document.querySelector('[data-run]').disabled), 'Run is disabled');
    eq(await t.text('[data-run-note]'), ENGINE_MISSING);
    eq(t.errors([/\/js\/engine\/index\.js/]), []);
  });
  await t.close();
}
}

if (!QUICK && want('E')) {
  console.log('\nE. screening: one target against two ligands');
  const t = await open({ width: 1280, route: '/lab?target=EGFR&depth=quick&seed=5&mode=target-many' });
  await check('Target vs many: the ligand picker becomes a multi-select; two ticks; a ranked table with Run test buttons', async () => {
    await t.ready();
    eq(await t.attr('button[data-mode="target-many"]', 'aria-pressed'), 'true');
    assert(await t.eval(() => document.querySelector('[data-picker="ligand"]').classList.contains('lab-picker-multi')), 'multi select');
    assert(await t.eval(() => document.querySelector('[data-run]').disabled), 'Run waits for ticks');
    await t.type('[data-picker="ligand"] .lab-search-input', 'quercetin');
    await t.click('[data-picker="ligand"] .lab-row:not([hidden])');
    await t.type('[data-picker="ligand"] .lab-search-input', 'harmine');
    await t.click('[data-picker="ligand"] .lab-row:not([hidden])');
    eq(await t.eval(() => document.querySelectorAll('[data-picker="ligand"] .lab-row[aria-checked="true"]').length), 2);
    assert(!(await t.eval(() => document.querySelector('[data-run]').disabled)), 'Run is enabled');
    await t.click('[data-run]');
    await t.finished(120000);
    const rows = await t.eval(() => [...document.querySelectorAll('.lab-table tbody tr')].map((r) => ({ state: r.dataset.state, name: r.querySelector('.lab-td-name').textContent, dg: parseFloat(r.querySelector('.lab-td-dg').textContent), rank: r.querySelector('.lab-td-rank').textContent, action: r.querySelector('.lab-td-act').innerText.trim() })));
    eq(rows.length, 2);
    eq(rows.map((r) => r.state), ['done', 'done']);
    assert(rows.every((r) => r.dg < 0), `scores ${show(rows)}`);
    assert(rows[0].dg <= rows[1].dg, 'sorted best first');
    eq(rows.map((r) => r.rank), ['1', '2']);
    eq(rows.map((r) => r.action), ['Run test', 'Run test']);
    eq(await t.text('.lab-screen-caption'), 'Ranked by binding free energy');
    eq(await t.text('[data-record-best]'), 'Test best');
    await t.click('[data-sort="dg"]');
    const after = await t.eval(() => [...document.querySelectorAll('.lab-table tbody tr')].map((r) => ({ dg: parseFloat(r.querySelector('.lab-td-dg').textContent), rank: r.querySelector('.lab-td-rank').textContent })));
    assert(after[0].dg >= after[1].dg, 'sorted the other way');
    eq(after.map((r) => r.rank), ['2', '1'], 'rank 1 stays the best score');
    await t.shot('E-screening.png');
  });
  await check('no console errors', async () => eq(t.errors(), []));
  await t.close();
}

if (want('F')) {
console.log('\nF. js/engine/method.js missing');
{
  const t = await open({ width: 1280, route: '/lab?target=EGFR&ligand=QUERCETIN&depth=deep&seed=3', stubs: [{ test: /\/js\/engine\/method\.js(\?|$)/, body: null }] });
  await check('the Method panel shows the engine-unavailable line; the depth control still names the method', async () => {
    await t.ready();
    eq(await t.attr('[data-lab]', 'data-methods'), 'off');
    eq(await t.attr('[data-method-panel]', 'data-state'), 'unavailable');
    eq(await t.text('[data-method-unavailable]'), ENGINE_MISSING);
    eq(await t.text('[data-method-name]'), 'Deep');
    eq(await t.attr('[data-depth-key="deep"]', 'aria-pressed'), 'true');
    // the v2 engine index imports the method module, so its absence takes the engine down too (scenario D's state);
    // a v1 engine keeps running on the depth control
    const engineOff = (await t.attr('[data-lab]', 'data-engine')) === 'off';
    if (engineOff) {
      assert(await t.eval(() => document.querySelector('[data-run]').disabled), 'Find a pose is disabled without the engine');
      eq(await t.text('[data-run-note]'), ENGINE_MISSING);
    } else {
      assert(!(await t.eval(() => document.querySelector('[data-run]').disabled)), 'Find a pose is enabled');
    }
    await t.click('[data-depth-key="quick"]');
    eq(await t.text('[data-method-name]'), 'Quick');
    eq(new URL(await t.eval(() => location.href)).searchParams.get('depth'), 'quick');
    eq(t.errors([/\/js\/engine\/method\.js/, ...(engineOff ? [/\/js\/engine\/index\.js/] : [])]), []);
  });
  await t.close();
}
}

if (want('G')) {
console.log('\nG. the Method panel (SPEC 9.7) with the engine method stub');
{
  const route = '/lab?target=EGFR&ligand=QUERCETIN&seed=21';
  const t = await open({ width: 1280, route, stubs: METHOD_STUBS });
  const jsonText = () => t.eval(() => document.querySelector('[data-method-json]').value);
  const errorsList = () => t.eval(() => [...document.querySelectorAll('[data-method-errors] li')].map((li) => li.textContent));
  const runDisabled = () => t.eval(() => document.querySelector('[data-run]').disabled);
  await check('the presets are listed, Standard is active, the depth control mirrors Quick / Standard / Deep', async () => {
    await t.ready();
    eq(await t.attr('[data-lab]', 'data-methods'), 'on');
    const names = await t.eval(() => [...document.querySelectorAll('[data-method-preset] optgroup:first-of-type option')].map((o) => o.textContent));
    eq(names, ['Quick', 'Standard', 'Deep', 'Rigid ligand', 'Wide search', 'Fine local', 'Reproducible']);
    eq(await t.text('[data-method-name]'), 'Standard');
    const selectedText = () => t.eval(() => { const s = document.querySelector('[data-method-preset]'); return s.selectedOptions[0] ? s.selectedOptions[0].textContent : null; });
    eq(await selectedText(), 'Standard');
    eq(JSON.parse(await jsonText()).budget, { ms: 30000 });
    assert(/^Valid method · \d+ bytes$/.test(await t.text('[data-method-status]')), await t.text('[data-method-status]'));
    await t.click('[data-depth-key="quick"]');
    eq(await selectedText(), 'Quick', 'the depth control selects the Quick preset');
    eq(JSON.parse(await jsonText()).budget, { ms: 10000 });
    eq(await t.text('[data-method-name]'), 'Quick');
    eq(new URL(await t.eval(() => location.href)).searchParams.get('depth'), 'quick');
    await t.click('[data-method-open]');
    assert(await pickOption(t, 'Fine local'), 'Fine local is listed');
    eq(await t.text('[data-method-name]'), 'Fine local');
    eq(await t.eval(() => [...document.querySelectorAll('[data-depth-key]')].map((b) => b.getAttribute('aria-pressed'))), ['false', 'false', 'false']);
    const u = new URL(await t.eval(() => location.href));
    eq(u.searchParams.get('depth'), null);
    eq(JSON.parse(Buffer.from(u.searchParams.get('method'), 'base64url').toString('utf8')).name, 'Fine local', 'the URL carries the method');
    await t.shot('G-method-panel.png', { fullPage: true });
  });
  await check('invalid JSON shows the error sentence and disables Find a pose; an unknown key and a bound are named; Reset to preset repairs it', async () => {
    await t.type('[data-method-json]', '{');
    const e1 = await errorsList();
    assert(e1.length === 1 && e1[0].startsWith('This is not valid JSON: '), show(e1));
    assert(await runDisabled(), 'Find a pose is disabled while the JSON is invalid');
    eq(await t.text('[data-run-note]'), 'Fix the method JSON before finding a pose.');
    eq(await t.attr('[data-method-json]', 'aria-invalid'), 'true');
    await t.type('[data-method-json]', JSON.stringify({ name: 'Odd', version: 1, budget: { ms: 10 }, foo: 1 }));
    const e2 = await errorsList();
    assert(e2.some((x) => /\bfoo\b/.test(x)), `the unknown key is named: ${show(e2)}`);
    assert(e2.some((x) => /\bms\b/.test(x) && /\d/.test(x)), `the bound is named: ${show(e2)}`);
    assert(e2.every((x) => !/[\u2013\u2014]/.test(x)), 'no dash in an error sentence');
    eq(await t.text('[data-method-name]'), 'Odd', 'the name follows the JSON even while invalid');
    await t.type('[data-method-json]', '[1, 2]');
    eq(await errorsList(), ['A method is a JSON object with curly braces.']);
    await t.click('[data-method-reset]');
    eq(await errorsList(), []);
    eq(JSON.parse(await jsonText()).name, 'Fine local');
    eq(await t.eval(() => document.querySelector('[data-method-preset]').selectedOptions[0].textContent), 'Fine local');
    assert(!(await runDisabled()), 'Find a pose is enabled again');
    const text = await t.eval(() => document.body.innerText);
    assert(!/[\u2013\u2014]/.test(text), 'a dash glyph is visible');
  });
  await check('two Reproducible methods with different step counts change the run (300 steps, then 500)', async () => {
    await t.type('[data-method-json]', JSON.stringify({ name: 'Reproducible', version: 1, budget: { steps: 300 } }));
    eq(await t.eval(() => document.querySelector('[data-method-preset]').selectedOptions[0].textContent), 'Edited method', 'an edited preset reads as edited');
    eq(await t.text('[data-method-name]'), 'Reproducible');
    await t.click('[data-run]');
    await t.finished();
    eq(await t.text('[data-lab-results] [data-row="steps"]'), '300');
    eq(await t.text('[data-lab-results] [data-row="method"]'), 'Reproducible');
    const dg1 = await t.text('[data-dg]');
    await t.type('[data-method-json]', JSON.stringify({ name: 'Reproducible', version: 1, budget: { steps: 500 } }));
    await t.click('[data-run]');
    await t.finished();
    eq(await t.text('[data-lab-results] [data-row="steps"]'), '500');
    const dg2 = await t.text('[data-dg]');
    assert(/^-\d+\.\d{3}$/.test(dg1) && /^-\d+\.\d{3}$/.test(dg2), `${dg1} ${dg2}`);
    await t.shot('G-method-run.png');
  });
  await check('Share link copies a URL with ?method= that opens to the same method', async () => {
    const r = await t.eval(async () => {
      let clip = null;
      navigator.clipboard.writeText = async (text) => { clip = text; };
      document.querySelector('[data-method-share]').click();
      await new Promise((r) => setTimeout(r, 400));
      return { clip, toast: [...document.querySelectorAll('.pc-toast')].map((x) => x.textContent.trim()).pop() };
    });
    eq(r.toast, 'Link copied');
    const u = new URL(r.clip);
    const q = u.searchParams.get('method');
    assert(q, `no method in ${r.clip}`);
    eqJson(JSON.parse(Buffer.from(q, 'base64url').toString('utf8')), { name: 'Reproducible', version: 1, budget: { steps: 500 } });
    const t2 = await open({ width: 1280, route: `${u.pathname}${u.search}`, stubs: METHOD_STUBS });
    await t2.ready();
    eq(await t2.text('[data-method-name]'), 'Reproducible');
    eqJson(JSON.parse(await t2.eval(() => document.querySelector('[data-method-json]').value)), { name: 'Reproducible', version: 1, budget: { steps: 500 } });
    eq(await t2.eval(() => document.querySelector('[data-method-preset]').selectedOptions[0].textContent), 'Edited method');
    eq(await t2.eval(() => document.querySelector('[data-seed]').value), '21');
    eq(t2.errors(), []);
    await t2.close();
    // an invalid method in the link: Standard with a toast
    const t3 = await open({ width: 1280, route: `/lab?target=EGFR&ligand=QUERCETIN&method=${b64url('{"name":"Bad","version":1,"budget":{"ms":10},"nope":true}')}`, stubs: METHOD_STUBS });
    await t3.ready();
    eq(await t3.text('[data-method-name]'), 'Standard');
    assert((await t3.toasts()).includes('The method in this link is not valid. Standard is selected instead.'), show(await t3.toasts()));
    eq(new URL(await t3.eval(() => location.href)).searchParams.get('method'), null, 'the bad method left the URL');
    eq(t3.errors(), []);
    await t3.close();
  });
  await check('Export JSON downloads the editor JSON; Import JSON loads a valid file and refuses an invalid one', async () => {
    const exported = await t.eval(async () => {
      window.__exported = null;
      URL.createObjectURL = (b) => { b.text().then((x) => { window.__exported = x; }); return 'blob:ponchem-test'; };
      document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[download]'); if (a) { window.__downloadName = a.getAttribute('download'); e.preventDefault(); } }, true);
      document.querySelector('[data-method-export]').click();
      await new Promise((r) => setTimeout(r, 400));
      return { text: window.__exported, name: window.__downloadName, toast: [...document.querySelectorAll('.pc-toast')].map((x) => x.textContent.trim()).pop() };
    });
    eq(exported.toast, 'Method JSON downloaded');
    eq(exported.name, 'ponchem-method-reproducible.json');
    eqJson(JSON.parse(exported.text), { name: 'Reproducible', version: 1, budget: { steps: 500 } });
    const importFile = (text, name) => t.eval((json, n) => {
      const input = document.querySelector('[data-method-file]');
      const dt = new DataTransfer();
      dt.items.add(new File([json], n, { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, text, name);
    await importFile(JSON.stringify({ name: 'Imported one', version: 1, budget: { ms: 12000 }, chains: 6 }, null, 2), 'mine.json');
    await t.until(async () => (await t.text('[data-method-name]')) === 'Imported one', 'the imported method');
    assert((await t.toasts()).includes('Method loaded: Imported one'), show(await t.toasts()));
    eq(JSON.parse(await jsonText()).chains, 6);
    await importFile('{"name":"Nope","version":2,"budget":{"ms":12000},"nope":true}', 'bad.json');
    await t.until(async () => (await errorsList()).length > 0, 'the errors of the bad file');
    assert((await errorsList()).some((x) => /\bnope\b|\bversion\b/.test(x)), show(await errorsList()));
    assert((await t.toasts()).includes('That file is not a valid method.'), show(await t.toasts()));
    await importFile('not json at all', 'worse.json');
    await t.until(async () => (await errorsList())[0] && (await errorsList())[0].startsWith('This is not valid JSON'), 'the parse error');
  });
  await check('Save as my method keeps it in localStorage ponchem.methods, lists it after a reload, Remove drops it', async () => {
    await t.type('[data-method-json]', JSON.stringify({ name: 'My wide', version: 1, budget: { ms: 15000 }, chains: 12 }, null, 2));
    await t.click('[data-method-save]');
    assert((await t.toasts()).includes('Method saved as My wide'), show(await t.toasts()));
    eq(await t.eval(() => document.querySelector('[data-method-preset]').selectedOptions[0].textContent), 'My wide');
    const stored = await t.eval(() => JSON.parse(localStorage.getItem('ponchem.methods')));
    eq(stored.length, 1);
    eq(stored[0].name, 'My wide');
    eq(stored[0].method, { name: 'My wide', version: 1, budget: { ms: 15000 }, chains: 12 });
    assert(!(await t.eval(() => document.querySelector('[data-method-remove]').hidden)), 'Remove shows for a saved method');
    // saving without a name is refused
    await t.type('[data-method-json]', JSON.stringify({ version: 1, budget: { ms: 15000 } }));
    await t.click('[data-method-save]');
    assert((await t.toasts()).some((x) => /name must be a short text|Give the method a name/.test(x)), show(await t.toasts()));
    // a reload keeps it (the storage is not cleared here)
    await t.page.goto(base + route, { settle: 1200 });
    await t.ready();
    const mine = await t.eval(() => [...document.querySelectorAll('[data-method-preset] optgroup')].map((g) => ({ label: g.label, hidden: g.hidden, options: [...g.querySelectorAll('option')].map((o) => o.value) })));
    const mineGroup = mine.find((g) => g.label === 'My methods');
    eq(mineGroup.hidden, false);
    eq(mineGroup.options, ['saved:My wide']);
    assert(await pickOption(t, 'My wide'), 'My wide is listed');
    eq(await t.text('[data-method-name]'), 'My wide');
    eq(JSON.parse(await jsonText()).chains, 12);
    await t.click('[data-method-remove]');
    eq(await t.eval(() => JSON.parse(localStorage.getItem('ponchem.methods'))), []);
    eq(await t.text('[data-method-name]'), 'Standard');
    eq(await t.eval(() => document.querySelector('[data-method-preset] optgroup:nth-of-type(2)').hidden), true, 'My methods hides when empty');
    assert((await t.toasts()).includes('Method removed'), show(await t.toasts()));
  });
  await check('no console errors in the method session', async () => eq(t.errors(), []));
  await t.close();
}
}

await chrome.close();
stopDev();
console.log(`\n${'-'.repeat(72)}`);
if (failures.length) { console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks failed`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log(`PASSED  ${passed} of ${passed} checks passed`);
