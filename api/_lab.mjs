/*
 * api/_lab.mjs: the shared half of the Ponchem read API (api/status.js, api/runs.js, api/report.js, api/analyze.js).
 * Private: the leading underscore keeps it from being routed, on Vercel and in tools/dev.mjs alike. Restart the dev
 * server after editing it (route files are re-imported on change, this one is not).
 *
 * The routes read Robinhood Chain through the same js modules the pages use (js/rpc.js, js/chain.js, js/lab.js),
 * pointed straight at the upstream node instead of the /api/rpc proxy, with the DNS-over-HTTPS fallback of
 * api/_doh.mjs installed the way api/rpc.js does it. Nothing here signs or sends. The treasury is never read.
 *
 * ENV
 *   PONCHEM_RPC_URL       JSON-RPC URL the reads go to (default: RH_RPC_URL, else CHAIN.rpc). Never echoed.
 *   PONCHEM_LAB           PonchemLab address. Wins over LAB.address in js/config.js (a local chain for tests).
 *   PONCHEM_DEPLOY_BLOCK  first block to scan for logs when PONCHEM_LAB is set (default 0; LAB.deployBlock otherwise)
 *   PONCHEM_SITE_URL      where /data lives when the catalog files are not on disk (default: this deployment)
 *
 * SHIPPED API
 *   handle(run, { methods = ['GET', 'HEAD'] })  -> handler(req, res): the listed methods (405 otherwise), CORS *, JSON errors;
 *                                    run({ query, body (POST, parsed JSON), method, signal, req }) -> { status, body, type?, cache? }
 *   send(res, status, body, { type = 'json', cache = true })     JSON (bigints as decimal strings) or text/markdown
 *   CACHE_CONTROL                    'public, s-maxage=10, stale-while-revalidate=60' on every successful cacheable GET
 *   cached(key, fn, ttlMs = 10000)   in-memory per-instance cache with in-flight sharing
 *   index() -> LogIndex | null       the incremental event index for the lab (null when not live)
 *   catalog() -> Catalog             data/catalog/*.json + data/registry.json from disk (60 s), else over HTTP
 *   status() -> { status, body }     GET /api/status
 *   runsQuery(query) -> { status, body }   GET /api/runs (list, ?id= one run with everything, ?view=ledger the whole record)
 *   reportData() -> report           compileReport() over the index      reportMarkdown() -> string
 *   analysisFacts(runId) -> facts | null   everything api/analyze.js puts in front of a model (chain facts, catalog rows, rescoring)
 *   scoreOnServer(run, target, ligand) -> { ok, reason, scoreMilli, agrees, terms: { g1, g2, rep, hyd, hb } (kcal/mol), pairs } | null
 *   failure(err) -> { status, body } the HTTP answer for anything a route throws
 *   InputError(message, field)       400
 */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CHAIN, LAB, BRAND } from '../js/config.js';
import { configure, isAddress, getAddress } from '../js/rpc.js';
import { postJson, looksLikeDnsFailure } from './_doh.mjs';
import { useLab, labAddress, labDeployBlock } from '../js/lab.js';
import { LogIndex, selectRuns, toJsonRun, toJsonLedger, ledgerOf, labStatus, pools, compileReport, renderReportMarkdown, derivedOf, NOT_LIVE, UNREACHABLE } from '../js/chain.js';
import { assembleCatalog, loadCatalog } from '../js/catalog.js';
import { units } from '../js/format.js';

export const CACHE_CONTROL = 'public, s-maxage=10, stale-while-revalidate=60';
const TTL_MS = 10_000;
const RPC_TIMEOUT_MS = 12_000;
const READ_BUDGET_MS = 25_000;
const MAX_LIMIT = 1000;
const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------------------------------------
// one-time setup: where the chain is, where the lab is, where /data is

const UPSTREAM = String(process.env.PONCHEM_RPC_URL || process.env.RH_RPC_URL || CHAIN.rpc).trim();
const SITE = String(process.env.PONCHEM_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.VERCEL ? BRAND.url : `http://127.0.0.1:${process.env.PORT || 6130}`))).replace(/\/+$/, '');
configure({ rpc: UPSTREAM, base: SITE, timeoutMs: RPC_TIMEOUT_MS });

const wantedLab = String(process.env.PONCHEM_LAB || '').trim();
if (wantedLab) {
  if (isAddress(wantedLab) && !/^0x0{40}$/.test(wantedLab)) {
    const same = LAB.address && wantedLab.toLowerCase() === String(LAB.address).toLowerCase();
    useLab(wantedLab, { deployBlock: process.env.PONCHEM_DEPLOY_BLOCK !== undefined ? Number(process.env.PONCHEM_DEPLOY_BLOCK) || 0 : (same ? LAB.deployBlock : 0) });
  } else {
    console.error('PONCHEM_LAB is not a contract address: ignoring it.');
  }
}

/*
 * On some networks the chain's hostname resolves to a hijacked private address and a plain fetch() never reaches
 * the node. api/rpc.js works around that with DNS over HTTPS; these routes read through js/rpc.js, which has no
 * transport hook, so the fallback is a wrapper around the global fetch that only touches JSON POSTs to the upstream
 * URL. Production resolves normally and lands here only after a connection-shaped failure.
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((ok, fail) => {
    const onAbort = () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(ok, fail).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function installDohFallback(upstream) {
  let u;
  try { u = new URL(upstream); } catch { return; }
  if (u.protocol !== 'https:' || globalThis.fetch.ponchemDoh) return;
  const plain = globalThis.fetch;
  let dohUntil = 0;
  const viaDoh = async (init) => {
    const r = await raceAbort(postJson(upstream, init.body, { accept: 'application/json' }, RPC_TIMEOUT_MS), init.signal);
    const usable = r.status >= 200 && r.status <= 599 && ![204, 205, 304].includes(r.status);
    return new Response(r.text, { status: usable ? r.status : 502, headers: { 'content-type': 'application/json' } });
  };
  const wrapped = async (input, init) => {
    if (input !== upstream || !init || init.method !== 'POST' || typeof init.body !== 'string') return plain(input, init);
    if (Date.now() < dohUntil) return viaDoh(init);
    try {
      return await plain(input, init);
    } catch (e) {
      if ((init.signal && init.signal.aborted) || !looksLikeDnsFailure(e)) throw e;
      dohUntil = Date.now() + 10 * 60 * 1000;
      return viaDoh(init);
    }
  };
  wrapped.ponchemDoh = true;
  globalThis.fetch = wrapped;
}
installDohFallback(UPSTREAM);

export const deadline = () => AbortSignal.timeout(READ_BUDGET_MS);

// ---------------------------------------------------------------------------------------------------------
// errors

export class InputError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'InputError';
    this.field = field;
  }
}

export function failure(err) {
  if (err && err.name === 'InputError') return { status: 400, body: { ok: false, error: 'bad-input', message: err.message, field: err.field } };
  const name = err && err.name;
  const text = String((err && err.message) || err || '');
  if (name === 'RpcError' || name === 'AbortError' || name === 'TimeoutError' || /^ABI |not a hex string|fetch failed/i.test(text)) {
    console.error('chain read failed:', text.slice(0, 300));
    return { status: 502, body: { ok: false, error: 'chain-unavailable', message: UNREACHABLE } };
  }
  console.error('unexpected API error:', err);
  return { status: 500, body: { ok: false, error: 'internal', message: 'Something went wrong on our side. Try again in a moment.' } };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP

const jsonReplacer = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

export function send(res, status, body, { type = 'json', cache = true, head = false } = {}) {
  res.statusCode = status;
  res.setHeader('content-type', type === 'markdown' ? 'text/markdown; charset=utf-8' : type === 'text' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache && status === 200 ? CACHE_CONTROL : 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  const text = typeof body === 'string' ? body : JSON.stringify(body, jsonReplacer);
  res.setHeader('content-length', Buffer.byteLength(text, 'utf8'));
  res.end(head ? undefined : text);
}

export function queryOf(req) {
  const out = {};
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    for (const [k, v] of u.searchParams) if (!(k in out)) out[k] = v;
  } catch { /* no url */ }
  if (req.query && typeof req.query === 'object') for (const [k, v] of Object.entries(req.query)) if (!(k in out) && typeof v === 'string') out[k] = v;
  return out;
}

/** The parsed JSON body of a POST: Vercel and tools/dev.mjs put it on req.body; a bare Node request is read here. */
export async function bodyOf(req) {
  const parse = (text) => {
    const t = String(text || '').trim();
    if (!t) return {};
    try { return JSON.parse(t); } catch { throw new InputError('The request body must be JSON.', 'body'); }
  };
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return parse(req.body);
    if (Buffer.isBuffer(req.body)) return parse(req.body.toString('utf8'));
    if (typeof req.body === 'object') return req.body;
    return {};
  }
  if (typeof req.on !== 'function') return {};
  const text = await new Promise((ok, fail) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { fail(new InputError('The request body is too large.', 'body')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
  return parse(text);
}

/** A route: run({ query, body, method, signal, req }) returns { status, body, type?, cache? } or throws. */
export function handle(run, { methods = ['GET', 'HEAD'] } = {}) {
  const allowed = new Set(methods.map((m) => String(m).toUpperCase()));
  if (allowed.has('GET')) allowed.add('HEAD');
  const list = [...allowed].filter((m) => m !== 'HEAD');
  const allow = `${[...allowed].join(', ')}, OPTIONS`;
  return async function handler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', allow);
      res.setHeader('access-control-allow-headers', 'accept, content-type');
      res.setHeader('access-control-max-age', '86400');
      return res.end();
    }
    if (!allowed.has(method)) {
      res.setHeader('allow', allow);
      return send(res, 405, { ok: false, error: 'method', message: `This endpoint answers ${list.join(' and ')} only.` }, { cache: false });
    }
    try {
      const body = method === 'POST' ? await bodyOf(req) : null;
      const out = await run({ query: queryOf(req), body, method, signal: deadline(), req });
      return send(res, out.status || 200, out.body, { type: out.type || 'json', cache: out.cache !== false && method !== 'POST', head: method === 'HEAD' });
    } catch (e) {
      const f = failure(e);
      return send(res, f.status, f.body, { cache: false, head: method === 'HEAD' });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// cache and the log index

const store = new Map(); // key -> { at, value, promise }

export function cached(key, fn, ttlMs = TTL_MS) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && (hit.promise || now - hit.at < ttlMs)) return hit.promise || Promise.resolve(hit.value);
  const promise = (async () => fn())();
  store.set(key, { at: now, promise, value: undefined });
  promise.then((value) => store.set(key, { at: Date.now(), promise: null, value }), () => store.delete(key));
  return promise;
}

export function uncache() {
  store.clear();
}

let idx = null;
export function index() {
  const address = labAddress();
  if (!address) { idx = null; return null; }
  if (!idx || idx.address !== getAddress(address)) idx = new LogIndex({ address, fromBlock: labDeployBlock(), ttlMs: TTL_MS });
  return idx;
}

// ---------------------------------------------------------------------------------------------------------
// the catalog and the data files on the server: disk first (Vercel traces these paths), the deployment's own /data second

const ROOT = new URL('../', import.meta.url);
async function readJson(rel) {
  return JSON.parse(await fs.readFile(fileURLToPath(new URL(rel, ROOT)), 'utf8'));
}

export function catalog() {
  return cached('catalog', async () => {
    try {
      const [t, l] = await Promise.all([readJson('data/catalog/targets.json'), readJson('data/catalog/ligands.json')]);
      const r = await readJson('data/registry.json').catch(() => null);
      return assembleCatalog(t, l, r);
    } catch (e) {
      console.error('catalog not on disk, reading it over HTTP:', String(e && e.message).slice(0, 120));
      return loadCatalog({ registry: true, fresh: true });
    }
  }, 60_000);
}

const SAFE_REL = /^data\/(pockets|topologies|tables)\/[A-Za-z0-9_.-]+\.bin$/;
async function readBytes(rel) {
  if (!SAFE_REL.test(rel)) throw new Error(`not a data file: ${rel}`);
  return cached(`bytes:${rel}`, async () => {
    try {
      return new Uint8Array(await fs.readFile(fileURLToPath(new URL(rel, ROOT))));
    } catch {
      const r = await fetch(`${SITE}/${rel}`, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`${rel} answered HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }
  }, 60 * 60_000);
}

/*
 * The five terms and the geometry proof of a recorded pose, recomputed with the browser's integer scorer (the same
 * arithmetic as the contract). null when the engine or a data file is not available on this instance.
 */
let engine = null;
async function loadEngine() {
  if (engine) return engine;
  const [format, score, tables] = await Promise.all([import('../js/engine/format.js'), import('../js/engine/score.js'), import('../js/engine/tables.js')]);
  try {
    await tables.ensureTables();
  } catch {
    await tables.ensureTables({ bytes: await readBytes('data/tables/tables.bin') });
  }
  engine = { format, score };
  return engine;
}

export async function scoreOnServer(run, target, ligand) {
  if (!run || !run.pose || !target || !ligand || !target.pocket || !ligand.topology) return null;
  return cached(`score:${run.id}`, async () => {
    const { format, score } = await loadEngine();
    const [pocketBytes, topoBytes] = await Promise.all([readBytes(target.pocket), readBytes(ligand.topology)]);
    const pocket = format.loadPocket(pocketBytes);
    const topology = format.loadTopology(topoBytes);
    const r = score.scoreInt(pocket, topology, run.pose);
    if (!r.ok) return { ok: false, reason: r.reason, code: r.code, scoreMilli: null, agrees: false, terms: null, pairs: 0 };
    const nrot = Number(topology.nrot || 0);
    const den = 1e12 * (1 + 0.0585 * nrot);
    const kcal = (w, sum) => Number(w * BigInt(Math.round(sum))) / den;
    return {
      ok: true,
      reason: 'OK',
      code: 0,
      scoreMilli: r.scoreMilli,
      agrees: r.scoreMilli === Number(run.scoreMilli),
      terms: { g1: kcal(score.W_G1, r.terms.g1), g2: kcal(score.W_G2, r.terms.g2), rep: kcal(score.W_REP, r.terms.rep), hyd: kcal(score.W_HYD, r.terms.hyd), hb: kcal(score.W_HB, r.terms.hb) },
      pairs: Number(r.terms.pairs || 0),
      nrot,
    };
  }, 10 * 60_000);
}

// ---------------------------------------------------------------------------------------------------------
// the reads

const ethStr = (wei) => units(wei, 18, 8);

export async function status({ signal } = {}) {
  const s = await cached('status', () => labStatus({ signal, fresh: true }));
  const body = {
    ok: true,
    live: s.live,
    reason: s.live ? null : s.reason,
    chainId: CHAIN.id,
    chain: CHAIN.name,
    epoch: s.epoch,
    epochStart: s.epochStart,
    epochEnd: s.epochEnd,
    epochLength: s.epochLength,
    genesis: s.genesis === undefined ? null : s.genesis,
    runFee: s.runFee.toString(),
    runFeeEth: ethStr(s.runFee),
    runPrice: s.runPrice.toString(),
    runPriceTokens: units(s.runPrice, 18, 2),
    feeBps: s.feeBps,
    token: s.token,
    ethAllowed: s.ethAllowed,
    tokenAllowed: s.tokenAllowed,
    tokenOpen: s.tokenOpen,
    runCount: s.runCount,
    targetCount: s.targetCount,
    ligandCount: s.ligandCount,
    poolTotal: s.poolTotal.toString(),
    poolTotalEth: ethStr(s.poolTotal),
    poolsOk: s.poolsOk,
    head: s.head,
    generatedAt: s.generatedAt,
  };
  if (!s.live && s.reason === UNREACHABLE) return { status: 502, body: { ...body, ok: false, error: 'chain-unavailable', message: UNREACHABLE }, cache: false };
  return { status: 200, body };
}

function whole(v, field, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || (max !== undefined && n > max)) throw new InputError(`${field} must be a whole number${max !== undefined ? ` up to ${max}` : ''}.`, field);
  return n;
}

export function parseRunsQuery(query = {}) {
  const id = whole(query.id, 'id');
  if (id === 0) throw new InputError('id must be at least 1.', 'id');
  const view = query.view === undefined || query.view === '' ? 'list' : String(query.view).toLowerCase();
  if (view !== 'list' && view !== 'ledger') throw new InputError('view must be list or ledger.', 'view');
  const target = whole(query.target, 'target', 65535);
  const ligand = whole(query.ligand, 'ligand', 65535);
  let wallet = null;
  if (query.wallet !== undefined && query.wallet !== null && query.wallet !== '') {
    if (!isAddress(query.wallet)) throw new InputError('wallet must be a 0x address.', 'wallet');
    wallet = getAddress(query.wallet);
  }
  const limit = whole(query.limit, 'limit', MAX_LIMIT);
  const offset = whole(query.offset, 'offset');
  const order = query.order === undefined || query.order === '' ? 'desc' : String(query.order);
  if (order !== 'asc' && order !== 'desc') throw new InputError('order must be asc or desc.', 'order');
  if (limit === 0) throw new InputError('limit must be at least 1.', 'limit');
  return { id, view, target, ligand, wallet, limit: limit === null ? 100 : limit, offset: offset === null ? 0 : offset, order };
}

export async function runsQuery(query = {}, { signal } = {}) {
  const q = parseRunsQuery(query);
  const i = index();
  if (q.id !== null) {
    if (!i) return { status: 404, body: { ok: false, live: false, error: 'no-run', message: NOT_LIVE }, cache: false };
    await i.sync({ signal });
    const r = i.byId.get(q.id);
    if (!r) return { status: 404, body: { ok: false, live: true, error: 'no-run', message: 'Unknown run id.', head: i.head }, cache: false };
    return { status: 200, body: { ok: true, live: true, head: i.head, run: toJsonRun(r, { full: true }) } };
  }
  if (q.view === 'ledger') {
    if (!i) return { status: 200, body: { ok: true, live: false, reason: NOT_LIVE, head: null, runs: [], settled: [], funded: [], reviews: [], analyses: [] } };
    await i.sync({ signal });
    return { status: 200, body: { ok: true, live: true, ...toJsonLedger(ledgerOf(i)) } };
  }
  if (!i) return { status: 200, body: { ok: true, live: false, reason: NOT_LIVE, runs: [], total: 0, head: null, limit: q.limit, offset: q.offset, order: q.order } };
  await i.sync({ signal });
  const { runs, total } = selectRuns(i.runs, q);
  return { status: 200, body: { ok: true, live: true, runs: runs.map((r) => toJsonRun(r)), total, head: i.head, limit: q.limit, offset: q.offset, order: q.order } };
}

export async function reportData({ signal } = {}) {
  return cached('report', async () => {
    const cat = await catalog();
    const i = index();
    if (!i) return compileReport({ catalog: cat, live: false });
    const [, poolMap, st] = await Promise.all([i.sync({ signal }), pools({ signal }).catch(() => new Map()), labStatus({ signal })]);
    return compileReport({ catalog: cat, runs: i.runs, pools: poolMap, head: i.head, live: true, partial: false, epoch: st.live ? st.epoch : null });
  });
}

export async function reportMarkdown(opts) {
  return renderReportMarkdown(await reportData(opts));
}

// ---------------------------------------------------------------------------------------------------------
// what the analysis route puts in front of a model: chain facts, catalog rows, the rescoring; review notes are not
// part of it (they are other people's text)

const better = (a, b) => !b || a.scoreMilli < b.scoreMilli || (a.scoreMilli === b.scoreMilli && a.id < b.id);
const bestOf = (list) => list.reduce((b, r) => (better(r, b) ? r : b), null);

export async function analysisFacts(runId, { signal } = {}) {
  const i = index();
  if (!i) return null;
  await i.sync({ signal });
  const run = i.byId.get(Number(runId));
  if (!run) return null;
  const cat = await catalog();
  const target = cat.targetById.get(run.targetId) || null;
  const ligand = cat.ligandById.get(run.ligandId) || null;
  const onTarget = i.runs.filter((r) => r.targetId === run.targetId);
  const others = onTarget.filter((r) => r.id !== run.id);
  const pair = onTarget.filter((r) => r.ligandId === run.ligandId);
  const heavy = ligand ? Number(ligand.atoms || ligand.heavyAtoms || 0) : 0;
  let score = null;
  try { score = await scoreOnServer(run, target, ligand); } catch (e) { console.error('rescoring failed:', String((e && e.message) || e).slice(0, 160)); score = null; }
  return {
    run,
    target,
    ligand,
    heavyAtoms: heavy,
    derived: derivedOf(run.scoreMilli, heavy),
    score,
    others: { count: others.length, wallets: new Set(others.map((r) => r.wallet)).size, best: bestOf(onTarget), epochBest: bestOf(onTarget.filter((r) => r.epoch === run.epoch)) },
    pair: { count: pair.length, best: bestOf(pair) },
    method: typeof run.method === 'string' && run.method ? run.method : null,
    reviews: run.reviews || { count: 0, starSum: 0, average: null },
    head: i.head,
  };
}

export { NOT_LIVE, UNREACHABLE };
