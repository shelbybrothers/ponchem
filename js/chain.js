/*
 * js/chain.js: the read side of the lab. Every page and the lab read chain state through here; nothing here signs.
 * Reads go through js/rpc.js (the /api/rpc proxy, or the localhost ?rpc= override, or configure({ rpc }) in Node).
 * Browser ES module with no DOM access at import time; api/_lab.mjs imports the pure parts (decoding, the log
 * index, bests, the report) so the server and the browser compute the same numbers from the same logs.
 *
 * SHIPPED API (SPEC.md 8.4, extended to SPEC.md 9.1, 9.2, 9.3, 9.5, 9.7 and 9.8)
 *   labStatus({ signal, fresh } = {}) -> { live, reason, epoch, epochStart, epochEnd, epochLength, runFee (wei), runPrice (token
 *                                          base units), feeBps, token (null while unset), ethAllowed, tokenAllowed, tokenOpen,
 *                                          minHold (always 0n, v1 pages), runCount, targetCount, ligandCount, poolTotal (wei), head, generatedAt }
 *       live:false with a plain `reason` when LAB.address is null (NOT_LIVE) or the RPC fails (UNREACHABLE). Cached 10 s.
 *       The treasury is never read here and never exposed.
 *   runs({ target, ligand, wallet, limit, offset, order }) -> Run[]     runsPage(same) -> { runs, total, head, live, source }
 *       Run { id, wallet, targetId, ligandId, scoreMilli, epoch, time (unix s | null), block, tx, pose: Int16Array | null,
 *             methodHash ('0x..' | null), payment: { method: 'eth' | 'token', code, amount (bigint) } | null,
 *             reviews: { count, starSum, average (1..5 | null) }, analysisAttached: bool,
 *             and on a full run (runById, the log index): method (JSON text | null), reviewList: Review[] newest first,
 *             analysis: { provider, text, block, tx } | null }
 *       Review { runId, reviewer, stars, note, block, tx, logIndex }     latest per reviewer wins
 *       Served by GET /api/runs; falls back to eth_getLogs (from LAB.deployBlock, chunked by CHAIN.logsChunk)
 *       when the API is unreachable or the page runs against a local chain (?rpc= / ?contract= overrides).
 *   runById(id, { signal }) -> Run (full) | null        GET /api/runs?id=N, else the log index
 *   reviewsOf(runId) -> Review[]      reviewStats(runId) -> { count, starSum, average }      analysesOf(runId) -> Analysis[] (block order)
 *   testsOf(wallet, { signal }) -> Run[]  newest first, every docking test of one wallet (up to 1000)
 *   allRuns({ signal }) -> { runs (ascending id), total, head, partial }    every run, paged through the API, cached 10 s
 *   ledger({ signal }) -> { head, runs (ascending, no pose), settled, funded, reviews (resolved, block order), analyses, live }
 *       the whole record in one read (GET /api/runs?view=ledger, else the log index); what js/gamify.js consumes
 *   profileOf(address, { signal }) -> js/gamify.js computeProfile over ledger()      walletRanking({ signal }) -> rankWallets over ledger()
 *   bests({ signal })   -> { byTarget: Map<id, Run>, byPair: Map<'t:l', Run>, byLigand: Map<id, Run>, byTargetEpoch: Map<'t:e', Run>, partial }
 *   pools({ signal })   -> Map<targetId, wei>          pool(uint16) per target through one multicall, cached 10 s
 *   walletStats(address) -> { runs, best (scoreMilli | null), prizes (wei), owed (wei), sponsored: [{ targetId, amount, count, last }],
 *                             reviewsGiven, reviewsReceived, starsReceived, reviewAverage, won: Settled[], wonEpochs, live }
 *   report({ signal })  -> { generatedAt, head, runCount, wallets, cancers: [{ key, name, targets: [{ id, key, pdbId, best, runs, wallets, pool }],
 *                            bestPairs: Run[] (+ runId, url, reviews, analysisAttached) }], mostReviewed: [...] }
 *   onBlock(cb, { intervalMs = 4000 }) -> unsubscribe     polls eth_blockNumber while the tab is visible (no rAF)
 *   invalidate()        drop every cached read (call after a transaction lands)
 *
 *   Pure helpers (shared with api/_lab.mjs and the tests)
 *   RUN_SCORED, PAID, METHOD, REVIEWED, ANALYSIS, FUNDED, SETTLED, ROLLED     parsed event fragments (topic = .topic)
 *   decodeRunLog / decodePaidLog / decodeMethodLog / decodeReviewedLog / decodeAnalysisLog / decodeFundedLog / decodeSettledLog / decodeRolledLog
 *   poseToHex(Int16Array) / poseFromHex(hex)    the canonical pose bytes (int16 BE x 3 per atom) as 0x hex
 *   toJsonRun(run, { full }) / fromJsonRun(obj)   the wire shape of GET /api/runs (pose as hex, ints as numbers, wei as strings)
 *   toJsonLedger(ledger) / fromJsonLedger(obj)    the wire shape of GET /api/runs?view=ledger
 *   selectRuns(list, { target, ligand, wallet, limit, offset, order }) -> { runs, total }
 *   computeBests(runs) -> { byTarget, byPair, byLigand, byTargetEpoch }
 *   derivedOf(scoreMilli, heavyAtoms) -> { dG, pKd, kd, le }     display only (SPEC-ENGINE 3.6)
 *   runUrl(id) -> 'https://ponchem.ai/run?id=N'
 *   compileReport({ catalog, runs, pools, head, generatedAt, live, partial }) -> report
 *   renderReportMarkdown(report) -> string      the research report as Markdown (no dashes, reviews and links, method note)
 *   class LogIndex({ address, fromBlock, ttlMs })   incremental eth_getLogs index: sync(), runs, byId, funded, settled, rolled,
 *                                                   reviews (Map runId -> Map reviewer -> Review), analyses (Map runId -> Analysis[]), head
 *   ledgerOf(index) -> ledger                  the pure ledger shape of an index
 *   getLogsChunked({ address, topics, fromBlock, toBlock, signal }) -> logs     chunked and halved on "too many results"
 *   setRunsSource('api' | 'logs' | 'auto')     where runs() reads from (auto: the API unless an override is active)
 *   NOT_LIVE, UNREACHABLE                        the two reasons
 */
import { CHAIN, PROTOCOL, BRAND } from './config.js';
import { rpc, rpcBatch, multicall, fragment, decodeAbi, getAddress, isAddress, toHex, overrides, siteUrl, RpcError } from './rpc.js';
import { loadCatalog, CANCERS, cancersOf } from './catalog.js';
import { LAB_FRAGMENTS, labAddress, labDeployBlock, NOT_LIVE, paymentName } from './lab.js';
import { computeProfile, rankWallets } from './gamify.js';
import { date as fmtDate, units } from './format.js';

export { NOT_LIVE, labAddress, labDeployBlock };
export const UNREACHABLE = 'Could not reach Robinhood Chain. Reads will retry.';

const TTL_MS = 10_000;
const FN = (name) => fragment(LAB_FRAGMENTS, name);
export const RUN_SCORED = FN('RunScored');
export const PAID = FN('Paid');
export const METHOD = FN('Method');
export const REVIEWED = FN('Reviewed');
export const ANALYSIS = FN('Analysis');
export const FUNDED = FN('Funded');
export const SETTLED = FN('Settled');
export const ROLLED = FN('Rolled');
const ALL_TOPICS = [RUN_SCORED, PAID, METHOD, REVIEWED, ANALYSIS, FUNDED, SETTLED, ROLLED].map((f) => f.topic);

const hexNum = (h) => (h === null || h === undefined ? null : Number(BigInt(h)));
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addrTopic = (a) => '0x' + getAddress(a).slice(2).toLowerCase().padStart(64, '0');
const ZERO_HASH = /^0x0{64}$/i;

export const runUrl = (id) => `${BRAND.url}/run?id=${Number(id)}`;
const emptyReviews = () => ({ count: 0, starSum: 0, average: null });

// ---------------------------------------------------------------------------------------------------------
// poses and runs on the wire

export function poseToHex(pose) {
  if (!pose) return null;
  let s = '0x';
  for (let i = 0; i < pose.length; i++) {
    const v = Number(pose[i]) & 0xffff;
    s += v.toString(16).padStart(4, '0');
  }
  return s;
}

export function poseFromHex(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{4})*$/.test(hex)) return null;
  const n = (hex.length - 2) / 4;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (parseInt(hex.slice(2 + i * 4, 6 + i * 4), 16) << 16) >> 16;
  return out;
}

const toJsonReview = (v) => ({ runId: v.runId, reviewer: v.reviewer, stars: v.stars, note: v.note, block: v.block === undefined ? null : v.block, tx: v.tx || null, logIndex: v.logIndex === undefined ? null : v.logIndex });
const fromJsonReview = (o) => (o && isAddress(o.reviewer) ? { runId: Number(o.runId), reviewer: getAddress(o.reviewer), stars: Number(o.stars), note: typeof o.note === 'string' ? o.note : '', block: o.block === null || o.block === undefined ? null : Number(o.block), tx: typeof o.tx === 'string' ? o.tx : null, logIndex: o.logIndex === null || o.logIndex === undefined ? null : Number(o.logIndex) } : null);
const toJsonAnalysis = (a) => ({ runId: a.runId, provider: a.provider, text: a.text, block: a.block === undefined ? null : a.block, tx: a.tx || null });
const fromJsonAnalysis = (o) => (o && typeof o === 'object' ? { runId: Number(o.runId), provider: String(o.provider || ''), text: typeof o.text === 'string' ? o.text : '', block: o.block === null || o.block === undefined ? null : Number(o.block), tx: typeof o.tx === 'string' ? o.tx : null } : null);
const reviewsShape = (r) => ({ count: Number((r && r.count) || 0), starSum: Number((r && r.starSum) || 0), average: r && r.average !== null && r.average !== undefined && Number.isFinite(Number(r.average)) ? Number(r.average) : null });

export function toJsonRun(r, { full = false } = {}) {
  const out = {
    id: r.id, wallet: r.wallet, targetId: r.targetId, ligandId: r.ligandId, scoreMilli: r.scoreMilli, epoch: r.epoch,
    time: r.time === undefined ? null : r.time, block: r.block === undefined ? null : r.block, tx: r.tx || null,
    pose: r.pose instanceof Int16Array || Array.isArray(r.pose) ? poseToHex(r.pose) : (typeof r.pose === 'string' ? r.pose : null),
    methodHash: r.methodHash || null,
    payment: r.payment ? { method: r.payment.method, code: r.payment.code === undefined ? (r.payment.method === 'token' ? 1 : 0) : r.payment.code, amount: String(r.payment.amount) } : null,
    reviews: reviewsShape(r.reviews),
    analysisAttached: !!r.analysis,
  };
  if (full) {
    out.method = typeof r.method === 'string' ? r.method : null;
    out.reviewList = (r.reviewList || []).map(toJsonReview);
    out.analysis = r.analysis ? toJsonAnalysis(r.analysis) : null;
  }
  return out;
}

export function fromJsonRun(o) {
  if (!o || typeof o !== 'object') return null;
  const wallet = isAddress(o.wallet) ? getAddress(o.wallet) : null;
  if (!wallet) return null;
  const run = {
    id: Number(o.id), wallet, targetId: Number(o.targetId), ligandId: Number(o.ligandId), scoreMilli: Number(o.scoreMilli),
    epoch: Number(o.epoch), time: o.time === null || o.time === undefined ? null : Number(o.time),
    block: o.block === null || o.block === undefined ? null : Number(o.block), tx: typeof o.tx === 'string' ? o.tx : null,
    pose: typeof o.pose === 'string' ? poseFromHex(o.pose) : (o.pose instanceof Int16Array ? o.pose : null),
    methodHash: typeof o.methodHash === 'string' ? o.methodHash : null,
    payment: null,
    reviews: reviewsShape(o.reviews),
    analysisAttached: !!(o.analysisAttached || o.analysis),
  };
  if (o.payment && typeof o.payment === 'object') {
    let amount = 0n;
    try { amount = BigInt(o.payment.amount); } catch { amount = 0n; }
    const code = o.payment.code === undefined || o.payment.code === null ? (o.payment.method === 'token' ? 1 : 0) : Number(o.payment.code);
    run.payment = { method: paymentName(code), code, amount };
  }
  if ('method' in o) run.method = typeof o.method === 'string' ? o.method : null;
  if (Array.isArray(o.reviewList)) run.reviewList = o.reviewList.map(fromJsonReview).filter(Boolean);
  if ('analysis' in o && o.analysis && typeof o.analysis === 'object') run.analysis = fromJsonAnalysis(o.analysis);
  else if ('analysis' in o) run.analysis = null;
  return run;
}

// ---------------------------------------------------------------------------------------------------------
// log decoding

const topicOf = (log, i) => (log && Array.isArray(log.topics) && typeof log.topics[i] === 'string' ? log.topics[i].toLowerCase() : null);
const base = (log) => ({ block: hexNum(log.blockNumber), tx: log.transactionHash || null, logIndex: hexNum(log.logIndex) });

export function decodeRunLog(log) {
  if (topicOf(log, 0) !== RUN_SCORED.topic || !log.topics || log.topics.length !== 4) return null;
  try {
    const [ligandId, scoreMilli, epoch, pose] = decodeAbi(['uint16', 'int32', 'uint32', 'int16[]'], log.data);
    return {
      id: Number(BigInt(log.topics[1])),
      wallet: getAddress('0x' + log.topics[2].slice(-40)),
      targetId: Number(BigInt(log.topics[3])),
      ligandId: Number(ligandId),
      scoreMilli: Number(scoreMilli),
      epoch: Number(epoch),
      time: null,
      ...base(log),
      pose: Int16Array.from(pose, (v) => Number(v)),
      methodHash: null,
      payment: null,
      method: null,
      reviews: emptyReviews(),
      reviewList: [],
      analysis: null,
      analysisAttached: false,
    };
  } catch {
    return null;
  }
}

export function decodePaidLog(log) {
  if (topicOf(log, 0) !== PAID.topic || !log.topics || log.topics.length !== 3) return null;
  try {
    const [method, amount] = decodeAbi(['uint8', 'uint256'], log.data);
    const code = Number(method);
    return { runId: Number(BigInt(log.topics[1])), wallet: getAddress('0x' + log.topics[2].slice(-40)), code, method: paymentName(code), amount, ...base(log) };
  } catch { return null; }
}

export function decodeMethodLog(log) {
  if (topicOf(log, 0) !== METHOD.topic || !log.topics || log.topics.length !== 2) return null;
  try {
    const [json] = decodeAbi(['string'], log.data);
    return { runId: Number(BigInt(log.topics[1])), json: String(json), ...base(log) };
  } catch { return null; }
}

export function decodeReviewedLog(log) {
  if (topicOf(log, 0) !== REVIEWED.topic || !log.topics || log.topics.length !== 3) return null;
  try {
    const [stars, note] = decodeAbi(['uint8', 'string'], log.data);
    return { runId: Number(BigInt(log.topics[1])), reviewer: getAddress('0x' + log.topics[2].slice(-40)), stars: Number(stars), note: String(note), ...base(log) };
  } catch { return null; }
}

export function decodeAnalysisLog(log) {
  if (topicOf(log, 0) !== ANALYSIS.topic || !log.topics || log.topics.length !== 2) return null;
  try {
    const [provider, text] = decodeAbi(['string', 'string'], log.data);
    return { runId: Number(BigInt(log.topics[1])), provider: String(provider), text: String(text), ...base(log) };
  } catch { return null; }
}

export function decodeFundedLog(log) {
  if (topicOf(log, 0) !== FUNDED.topic || !log.topics || log.topics.length !== 3) return null;
  try {
    const [amount, pool] = decodeAbi(['uint256', 'uint256'], log.data);
    return { targetId: Number(BigInt(log.topics[1])), from: getAddress('0x' + log.topics[2].slice(-40)), amount, pool, ...base(log) };
  } catch { return null; }
}

export function decodeSettledLog(log) {
  if (topicOf(log, 0) !== SETTLED.topic || !log.topics || log.topics.length !== 3) return null;
  try {
    const [winner, runId, amount] = decodeAbi(['address', 'uint256', 'uint256'], log.data);
    return { targetId: Number(BigInt(log.topics[1])), epoch: Number(BigInt(log.topics[2])), winner, runId: Number(runId), amount, ...base(log) };
  } catch { return null; }
}

export function decodeRolledLog(log) {
  if (topicOf(log, 0) !== ROLLED.topic || !log.topics || log.topics.length !== 3) return null;
  try {
    const [pool] = decodeAbi(['uint256'], log.data);
    return { targetId: Number(BigInt(log.topics[1])), epoch: Number(BigInt(log.topics[2])), pool, ...base(log) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------
// eth_getLogs, chunked and halved when the node refuses a span

const TOO_MANY = /more than|too many|too large|exceed|response size|block range|limit|query timeout|timeout/i;

export async function getLogsChunked({ address, topics, fromBlock, toBlock, signal, chunk = CHAIN.logsChunk || 10_000_000 }) {
  const out = [];
  const span = Math.max(1, Number(chunk) || 1);
  const one = async (from, to) => {
    const filter = { address, fromBlock: toHex(from), toBlock: toHex(to) };
    if (topics) filter.topics = topics;
    try {
      const logs = await rpc('eth_getLogs', [filter], { signal });
      for (const l of logs || []) out.push(l);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (to > from && TOO_MANY.test(String((e && e.message) || ''))) {
        const mid = from + Math.floor((to - from) / 2);
        await one(from, mid);
        await one(mid + 1, to);
        return;
      }
      throw e;
    }
  };
  for (let from = fromBlock; from <= toBlock; from += span) await one(from, Math.min(toBlock, from + span - 1));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// reviews and analyses, resolved per run

const byBlockDesc = (a, b) => ((b.block || 0) - (a.block || 0)) || ((b.logIndex || 0) - (a.logIndex || 0));
const byBlockAsc = (a, b) => ((a.block || 0) - (b.block || 0)) || ((a.logIndex || 0) - (b.logIndex || 0));

function summarize(map) {
  if (!map || !map.size) return emptyReviews();
  let starSum = 0;
  for (const v of map.values()) starSum += v.stars;
  return { count: map.size, starSum, average: Math.round((starSum / map.size) * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------------------
// the log index: every run, payment, method, review, analysis, sponsorship and settlement, rebuilt from events
// and kept up to date incrementally

export class LogIndex {
  constructor({ address, fromBlock = 0, ttlMs = TTL_MS } = {}) {
    this.address = getAddress(address);
    this.fromBlock = Math.max(0, Number(fromBlock) || 0);
    this.ttlMs = ttlMs;
    this.synced = this.fromBlock - 1; // last block whose logs are in
    this.head = null;
    this.lastSync = 0;
    this.inflight = null;
    this.runs = []; // ascending id
    this.byId = new Map();
    this.funded = [];
    this.settled = [];
    this.rolled = [];
    this.reviews = new Map(); // runId -> Map<reviewer, Review>
    this.analyses = new Map(); // runId -> Analysis[] in block order
    this.payments = new Map(); // runId -> Paid (kept for logs that arrive before their run)
    this.methods = new Map(); // runId -> json
    this.seen = new Set(); // `${tx}:${logIndex}` of every non-run log taken
    this.error = null;
  }

  /** Bring the index up to the head. TTL-aware; concurrent callers share one sync. Throws when the chain cannot be read. */
  sync({ force = false, signal } = {}) {
    if (!force && this.lastSync && Date.now() - this.lastSync < this.ttlMs) return Promise.resolve(this);
    if (this.inflight) return this.inflight;
    this.inflight = this._sync(signal).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _sync(signal) {
    const head = Number(BigInt(await rpc('eth_blockNumber', [], { signal })));
    const span = Math.max(1, Number(CHAIN.logsChunk) || 10_000_000);
    let from = this.synced + 1;
    while (from <= head) {
      const to = Math.min(head, from + span - 1);
      const logs = await getLogsChunked({
        address: this.address,
        topics: [ALL_TOPICS],
        fromBlock: from,
        toBlock: to,
        signal,
        chunk: span,
      });
      this.ingest(logs);
      this.synced = to;
      from = to + 1;
    }
    this.head = head;
    await this.fillTimes(signal);
    this.lastSync = Date.now();
    this.error = null;
    return this;
  }

  _take(log) {
    const key = `${log.transactionHash || ''}:${log.logIndex || ''}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  _attach(run) {
    const p = this.payments.get(run.id);
    if (p) run.payment = { method: p.method, code: p.code, amount: p.amount };
    if (this.methods.has(run.id)) run.method = this.methods.get(run.id);
    const rv = this.reviews.get(run.id);
    run.reviews = summarize(rv);
    run.reviewList = rv ? [...rv.values()].sort(byBlockDesc) : [];
    const an = this.analyses.get(run.id);
    run.analysis = an && an.length ? an[an.length - 1] : null;
    run.analysisAttached = !!run.analysis;
  }

  ingest(logs) {
    let added = 0;
    const sorted = (logs || []).slice().sort((a, b) => (hexNum(a.blockNumber) - hexNum(b.blockNumber)) || (hexNum(a.logIndex) - hexNum(b.logIndex)));
    for (const log of sorted) {
      const t0 = topicOf(log, 0);
      if (t0 === RUN_SCORED.topic) {
        const r = decodeRunLog(log);
        if (r && !this.byId.has(r.id)) { this._attach(r); this.byId.set(r.id, r); this.runs.push(r); added++; }
      } else if (t0 === PAID.topic) {
        const p = decodePaidLog(log);
        if (p && this._take(log)) { this.payments.set(p.runId, p); const r = this.byId.get(p.runId); if (r) this._attach(r); }
      } else if (t0 === METHOD.topic) {
        const m = decodeMethodLog(log);
        if (m && this._take(log)) { this.methods.set(m.runId, m.json); const r = this.byId.get(m.runId); if (r) this._attach(r); }
      } else if (t0 === REVIEWED.topic) {
        const v = decodeReviewedLog(log);
        if (v && this._take(log)) {
          let m = this.reviews.get(v.runId);
          if (!m) { m = new Map(); this.reviews.set(v.runId, m); }
          m.set(v.reviewer, v); // the latest review by a wallet replaces its earlier one
          const r = this.byId.get(v.runId);
          if (r) this._attach(r);
        }
      } else if (t0 === ANALYSIS.topic) {
        const a = decodeAnalysisLog(log);
        if (a && this._take(log)) {
          const list = this.analyses.get(a.runId) || [];
          list.push(a);
          list.sort(byBlockAsc);
          this.analyses.set(a.runId, list);
          const r = this.byId.get(a.runId);
          if (r) this._attach(r);
        }
      } else if (t0 === FUNDED.topic) {
        const f = decodeFundedLog(log);
        if (f && this._take(log)) this.funded.push(f);
      } else if (t0 === SETTLED.topic) {
        const s = decodeSettledLog(log);
        if (s && this._take(log)) this.settled.push(s);
      } else if (t0 === ROLLED.topic) {
        const s = decodeRolledLog(log);
        if (s && this._take(log)) this.rolled.push(s);
      }
    }
    if (added) this.runs.sort((a, b) => a.id - b.id);
    return added;
  }

  /** Runs carry no timestamp or method hash in the event: read run(id) through one multicall per 500 runs, else the blocks. */
  async fillTimes(signal) {
    const pending = this.runs.filter((r) => r.time === null);
    if (!pending.length) return;
    let viaViews = false;
    try {
      const res = await multicall(pending.map((r) => ({ target: this.address, fn: FN('run'), args: [r.id] })), { signal, chunk: 500 });
      res.forEach((x, i) => {
        if (!x.ok) return;
        viaViews = true;
        const [, , , , , time, , methodHash] = x.value;
        pending[i].time = Number(time);
        pending[i].methodHash = typeof methodHash === 'string' && !ZERO_HASH.test(methodHash) ? methodHash : (pending[i].method ? pending[i].methodHash : null);
      });
    } catch { viaViews = false; }
    const still = pending.filter((r) => r.time === null);
    if (!still.length || (viaViews && still.length < pending.length)) return;
    // no Multicall3 (or the views failed): block timestamps for up to 60 distinct blocks per sync
    const blocks = [...new Set(still.map((r) => r.block).filter((b) => b !== null))].slice(0, 60);
    if (!blocks.length) return;
    const answers = await rpcBatch(blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [toHex(b), false] })), { signal });
    const stamp = new Map();
    answers.forEach((a, i) => { if (a.ok && a.result && a.result.timestamp) stamp.set(blocks[i], hexNum(a.result.timestamp)); });
    for (const r of still) if (stamp.has(r.block)) r.time = stamp.get(r.block);
  }

  /** Every resolved review (latest per reviewer per run), block order. */
  resolvedReviews() {
    const out = [];
    for (const m of this.reviews.values()) for (const v of m.values()) out.push(v);
    return out.sort(byBlockAsc);
  }
}

/** The ledger shape of an index: what js/gamify.js and the leaderboard consume. Runs keep every field but the pose. */
export function ledgerOf(idx) {
  const strip = ({ pose, reviewList, analysis, method, ...rest }) => ({ ...rest, pose: null });
  const analyses = [];
  for (const list of idx.analyses.values()) for (const a of list) analyses.push({ runId: a.runId, provider: a.provider, block: a.block, tx: a.tx, logIndex: a.logIndex });
  return {
    head: idx.head,
    live: true,
    runs: idx.runs.map(strip),
    settled: idx.settled.slice().sort(byBlockAsc),
    funded: idx.funded.slice().sort(byBlockAsc),
    reviews: idx.resolvedReviews(),
    analyses: analyses.sort(byBlockAsc),
  };
}

const bigStr = (v) => String(v === undefined || v === null ? '0' : v);
const bigOf = (v) => { try { return BigInt(v); } catch { return 0n; } };

export function toJsonLedger(l) {
  return {
    head: l.head === undefined ? null : l.head,
    runs: l.runs.map((r) => { const j = toJsonRun(r); j.pose = null; return j; }),
    settled: l.settled.map((s) => ({ targetId: s.targetId, epoch: s.epoch, winner: s.winner, runId: s.runId, amount: bigStr(s.amount), block: s.block, tx: s.tx || null, logIndex: s.logIndex === undefined ? null : s.logIndex })),
    funded: l.funded.map((f) => ({ targetId: f.targetId, from: f.from, amount: bigStr(f.amount), pool: bigStr(f.pool), block: f.block, tx: f.tx || null, logIndex: f.logIndex === undefined ? null : f.logIndex })),
    reviews: l.reviews.map(toJsonReview),
    analyses: (l.analyses || []).map((a) => ({ runId: a.runId, provider: a.provider, block: a.block === undefined ? null : a.block, tx: a.tx || null, logIndex: a.logIndex === undefined ? null : a.logIndex })),
  };
}

export function fromJsonLedger(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.runs)) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    head: num(o.head),
    live: o.live !== false,
    runs: o.runs.map(fromJsonRun).filter(Boolean).sort((a, b) => a.id - b.id),
    settled: (o.settled || []).filter((s) => s && isAddress(s.winner)).map((s) => ({ targetId: Number(s.targetId), epoch: Number(s.epoch), winner: getAddress(s.winner), runId: Number(s.runId), amount: bigOf(s.amount), block: num(s.block), tx: typeof s.tx === 'string' ? s.tx : null, logIndex: num(s.logIndex) })),
    funded: (o.funded || []).filter((f) => f && isAddress(f.from)).map((f) => ({ targetId: Number(f.targetId), from: getAddress(f.from), amount: bigOf(f.amount), pool: bigOf(f.pool), block: num(f.block), tx: typeof f.tx === 'string' ? f.tx : null, logIndex: num(f.logIndex) })),
    reviews: (o.reviews || []).map(fromJsonReview).filter(Boolean),
    analyses: (o.analyses || []).map((a) => ({ runId: Number(a.runId), provider: String(a.provider || ''), block: num(a.block), tx: typeof a.tx === 'string' ? a.tx : null, logIndex: num(a.logIndex) })),
  };
}

// ---------------------------------------------------------------------------------------------------------
// selecting runs (shared by the API route and the browser fallback)

export function selectRuns(list, { target, ligand, wallet, limit = 100, offset = 0, order = 'desc' } = {}) {
  const t = target === undefined || target === null || target === '' ? null : Number(target);
  const l = ligand === undefined || ligand === null || ligand === '' ? null : Number(ligand);
  const w = wallet && isAddress(wallet) ? getAddress(wallet) : null;
  let rows = list;
  if (t !== null || l !== null || w !== null) {
    rows = rows.filter((r) => (t === null || r.targetId === t) && (l === null || r.ligandId === l) && (w === null || r.wallet === w));
  }
  rows = rows.slice().sort((a, b) => (order === 'asc' ? a.id - b.id : b.id - a.id));
  const total = rows.length;
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  return { runs: rows.slice(off, off + lim), total };
}

// ---------------------------------------------------------------------------------------------------------
// small TTL cache for the page-level reads

const memoStore = new Map(); // key -> { at, value, promise }

function memo(key, ttl, fn) {
  const hit = memoStore.get(key);
  const now = Date.now();
  if (hit && (hit.promise || now - hit.at < ttl)) return hit.promise || Promise.resolve(hit.value);
  const promise = (async () => fn())();
  memoStore.set(key, { at: now, promise, value: undefined });
  promise.then((value) => { memoStore.set(key, { at: Date.now(), promise: null, value }); }, () => { memoStore.delete(key); });
  return promise;
}

export function invalidate() {
  memoStore.clear();
  for (const idx of indexes.values()) idx.lastSync = 0;
}

// ---------------------------------------------------------------------------------------------------------
// status

const emptyStatus = () => ({
  live: false,
  reason: null,
  epoch: 0,
  epochStart: 0,
  epochEnd: 0,
  epochLength: PROTOCOL.epochSeconds,
  runFee: 0n,
  runPrice: 0n,
  feeBps: PROTOCOL.feeBps,
  token: null,
  ethAllowed: true,
  tokenAllowed: false,
  tokenOpen: false,
  minHold: 0n, // the v1 token gate is gone (SPEC.md 9.1); kept at zero so v1 pages read "no requirement"
  runCount: 0,
  targetCount: 0,
  ligandCount: 0,
  poolTotal: 0n,
  poolsOk: false,
  head: null,
  generatedAt: new Date().toISOString(),
});

const STATUS_VIEWS = ['targetCount', 'ligandCount', 'runCount', 'currentEpoch', 'epochLength', 'genesis', 'runFee', 'runPrice', 'feeBps', 'token', 'ethAllowed', 'tokenAllowed'];
const ZERO_ADDR = /^0x0{40}$/;

export async function labStatus({ signal, fresh = false } = {}) {
  const address = labAddress();
  if (!address) return { ...emptyStatus(), reason: NOT_LIVE };
  try {
    return await memo(`status:${address}`, fresh ? 0 : TTL_MS, async () => {
      const [res, headHex] = await Promise.all([
        multicall(STATUS_VIEWS.map((n) => ({ target: address, fn: FN(n) })), { signal }),
        rpc('eth_blockNumber', [], { signal }).catch(() => null),
      ]);
      const bad = res.find((r) => !r.ok);
      if (bad) throw bad.error || new RpcError('the lab contract did not answer');
      const v = Object.fromEntries(STATUS_VIEWS.map((n, i) => [n, res[i].value]));
      const epoch = Number(v.currentEpoch);
      const epochLength = Number(v.epochLength);
      const genesis = Number(v.genesis);
      const epochStart = genesis + epoch * epochLength;
      let poolTotal = 0n;
      let poolsOk = true;
      try { for (const wei of (await pools({ signal })).values()) poolTotal += wei; } catch { poolsOk = false; }
      const token = ZERO_ADDR.test(String(v.token)) ? null : v.token;
      const tokenAllowed = !!v.tokenAllowed;
      return {
        ...emptyStatus(),
        live: true,
        epoch,
        epochStart,
        epochEnd: epochStart + epochLength,
        epochLength,
        genesis,
        runFee: BigInt(v.runFee),
        runPrice: BigInt(v.runPrice),
        feeBps: Number(v.feeBps),
        token,
        ethAllowed: !!v.ethAllowed,
        tokenAllowed,
        tokenOpen: !!token && tokenAllowed,
        runCount: Number(v.runCount),
        targetCount: Number(v.targetCount),
        ligandCount: Number(v.ligandCount),
        poolTotal,
        poolsOk,
        head: headHex ? hexNum(headHex) : null,
      };
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const transient = !e || e.transient !== false;
    return { ...emptyStatus(), reason: transient ? UNREACHABLE : 'The lab contract did not answer.', error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------------------------------------
// runs

let runsSource = 'auto';
export function setRunsSource(mode) {
  runsSource = ['api', 'logs', 'auto'].includes(mode) ? mode : 'auto';
}

function useApi() {
  if (runsSource !== 'auto') return runsSource === 'api';
  const o = overrides();
  return !(o.rpc || o.contract);
}

const indexes = new Map(); // address -> LogIndex
export function localIndex(address = labAddress(), fromBlock = labDeployBlock()) {
  if (!address) return null;
  const key = getAddress(address);
  let idx = indexes.get(key);
  if (!idx) { idx = new LogIndex({ address: key, fromBlock }); indexes.set(key, idx); }
  return idx;
}

async function apiGet(q, signal) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const url = `${siteUrl('/api/runs')}${params.toString() ? `?${params}` : ''}`;
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (r.status === 404 && j && j.error === 'no-run') return { status: 404, json: j };
  if (!r.ok) throw new RpcError(`GET /api/runs answered HTTP ${r.status}`, { transient: true, status: r.status });
  if (!j || typeof j !== 'object') throw new RpcError('GET /api/runs answered without JSON');
  return { status: r.status, json: j };
}

async function runsViaApi(q, signal) {
  const { json: j } = await apiGet(q, signal);
  if (!Array.isArray(j.runs)) throw new RpcError('GET /api/runs answered without runs');
  return { runs: j.runs.map(fromJsonRun).filter(Boolean), total: Number(j.total) || 0, head: j.head === null || j.head === undefined ? null : Number(j.head), live: j.live !== false, source: 'api' };
}

async function runsViaLogs(q, signal) {
  const idx = localIndex();
  await idx.sync({ signal });
  const { runs, total } = selectRuns(idx.runs, q);
  return { runs, total, head: idx.head, live: true, source: 'logs' };
}

export async function runsPage({ target, ligand, wallet, limit = 100, offset = 0, order = 'desc', signal } = {}) {
  if (!labAddress()) return { runs: [], total: 0, head: null, live: false, source: 'none' };
  const q = { target, ligand, wallet, limit, offset, order };
  if (useApi()) {
    try {
      const page = await runsViaApi(q, signal);
      if (page.live) return page;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }
  return runsViaLogs(q, signal);
}

export async function runs(opts = {}) {
  return (await runsPage(opts)).runs;
}

/** One docking test with everything the chain holds on it (method JSON, reviews, the attached analysis), or null. */
export async function runById(id, { signal } = {}) {
  const n = Number(id);
  if (!labAddress() || !Number.isInteger(n) || n < 1) return null;
  if (useApi()) {
    try {
      const { status, json: j } = await apiGet({ id: n }, signal);
      if (j.live !== false) {
        if (status === 404) return null;
        if (j.run) return fromJsonRun(j.run);
      }
      // a server that is not live (no LAB.address there) does not know: the logs decide below
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }
  const idx = localIndex();
  await idx.sync({ signal });
  return idx.byId.get(n) || null;
}

export async function reviewsOf(runId, opts = {}) {
  const r = await runById(runId, opts);
  return r && Array.isArray(r.reviewList) ? r.reviewList : [];
}

export async function reviewStats(runId, opts = {}) {
  const r = await runById(runId, opts);
  return r ? reviewsShape(r.reviews) : emptyReviews();
}

export async function analysesOf(runId, opts = {}) {
  const n = Number(runId);
  if (!labAddress() || !Number.isInteger(n) || n < 1) return [];
  if (useApi()) {
    const r = await runById(n, opts);
    return r && r.analysis ? [r.analysis] : [];
  }
  const idx = localIndex();
  await idx.sync(opts);
  return (idx.analyses.get(n) || []).slice();
}

export async function testsOf(wallet, { signal } = {}) {
  if (!isAddress(wallet)) throw new Error('not an address');
  return (await runsPage({ wallet: getAddress(wallet), limit: 1000, order: 'desc', signal })).runs;
}

const PAGE = 1000;
const MAX_PAGES = 20;

export function allRuns({ signal } = {}) {
  const address = labAddress();
  if (!address) return Promise.resolve({ runs: [], total: 0, head: null, partial: false, live: false });
  return memo(`runs:${address}`, TTL_MS, async () => {
    const out = [];
    let total = 0;
    let head = null;
    let pages = 0;
    for (;;) {
      const page = await runsPage({ limit: PAGE, offset: out.length, order: 'asc', signal });
      out.push(...page.runs);
      total = page.total;
      head = page.head;
      pages++;
      if (!page.runs.length || out.length >= total || pages >= MAX_PAGES) break;
    }
    out.sort((a, b) => a.id - b.id);
    return { runs: out, total, head, partial: out.length < total, live: true };
  });
}

/** The whole record: runs (no poses), settlements, sponsorships, resolved reviews and attached analyses. */
export function ledger({ signal } = {}) {
  const address = labAddress();
  if (!address) return Promise.resolve({ head: null, live: false, runs: [], settled: [], funded: [], reviews: [], analyses: [] });
  return memo(`ledger:${address}`, TTL_MS, async () => {
    if (useApi()) {
      try {
        const { json: j } = await apiGet({ view: 'ledger' }, signal);
        if (j.live !== false) {
          const l = fromJsonLedger(j);
          if (l) return l;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
      }
    }
    const idx = localIndex();
    await idx.sync({ signal });
    return ledgerOf(idx);
  });
}

export async function profileOf(address, opts = {}) {
  if (!isAddress(address)) throw new Error('not an address');
  return computeProfile(getAddress(address), await ledger(opts));
}

export async function walletRanking(opts = {}) {
  return rankWallets(await ledger(opts));
}

// ---------------------------------------------------------------------------------------------------------
// bests

const better = (a, b) => !b || a.scoreMilli < b.scoreMilli || (a.scoreMilli === b.scoreMilli && a.id < b.id);

export function computeBests(list) {
  const byTarget = new Map();
  const byPair = new Map();
  const byLigand = new Map();
  const byTargetEpoch = new Map();
  for (const r of list || []) {
    if (better(r, byTarget.get(r.targetId))) byTarget.set(r.targetId, r);
    const pk = `${r.targetId}:${r.ligandId}`;
    if (better(r, byPair.get(pk))) byPair.set(pk, r);
    if (better(r, byLigand.get(r.ligandId))) byLigand.set(r.ligandId, r);
    const ek = `${r.targetId}:${r.epoch}`;
    if (better(r, byTargetEpoch.get(ek))) byTargetEpoch.set(ek, r);
  }
  return { byTarget, byPair, byLigand, byTargetEpoch };
}

function runFromView(id, v) {
  const [wallet, targetId, ligandId, scoreMilli, epoch, time, , methodHash] = v;
  return {
    id: Number(id), wallet, targetId: Number(targetId), ligandId: Number(ligandId), scoreMilli: Number(scoreMilli), epoch: Number(epoch), time: Number(time), block: null, tx: null, pose: null,
    methodHash: typeof methodHash === 'string' && !ZERO_HASH.test(methodHash) ? methodHash : null, payment: null, reviews: emptyReviews(), analysisAttached: false,
  };
}

async function completeBests(b, signal) {
  const address = labAddress();
  const cat = await loadCatalog({ signal }).catch(() => null);
  const st = await labStatus({ signal });
  const n = Math.max(cat ? cat.targets.length : 0, st.targetCount || 0);
  if (!n) return b;
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const calls = [
    ...ids.map((t) => ({ target: address, fn: FN('bestOf'), args: [t] })),
    ...ids.map((t) => ({ target: address, fn: FN('bestOfEpoch'), args: [t, st.epoch] })),
  ];
  const res = await multicall(calls, { signal });
  const want = new Map(); // runId -> [{ map, key }]
  ids.forEach((t, i) => {
    const a = res[i].ok ? Number(res[i].value) : 0;
    const e = res[n + i].ok ? Number(res[n + i].value) : 0;
    if (a) want.set(a, [...(want.get(a) || []), ['byTarget', t]]);
    if (e) want.set(e, [...(want.get(e) || []), ['byTargetEpoch', `${t}:${st.epoch}`]]);
  });
  const known = new Map();
  for (const m of [b.byTarget, b.byPair, b.byLigand, b.byTargetEpoch]) for (const r of m.values()) known.set(r.id, r);
  const missing = [...want.keys()].filter((id) => !known.has(id));
  if (missing.length) {
    const views = await multicall(missing.map((id) => ({ target: address, fn: FN('run'), args: [id] })), { signal, chunk: 500 });
    views.forEach((x, i) => { if (x.ok) known.set(missing[i], runFromView(missing[i], x.value)); });
  }
  for (const [id, slots] of want) {
    const r = known.get(id);
    if (!r) continue;
    for (const [mapName, key] of slots) {
      const m = b[mapName];
      if (better(r, m.get(key))) m.set(key, r);
      const pk = `${r.targetId}:${r.ligandId}`;
      if (better(r, b.byPair.get(pk))) b.byPair.set(pk, r);
      if (better(r, b.byLigand.get(r.ligandId))) b.byLigand.set(r.ligandId, r);
    }
  }
  return b;
}

export async function bests({ signal } = {}) {
  const all = await allRuns({ signal });
  const b = computeBests(all.runs);
  b.partial = all.partial;
  b.head = all.head;
  b.runCount = all.total;
  if (all.partial && labAddress()) {
    try { await completeBests(b, signal); } catch (e) { if (e && e.name === 'AbortError') throw e; }
  }
  return b;
}

// ---------------------------------------------------------------------------------------------------------
// pools

export function pools({ signal } = {}) {
  const address = labAddress();
  if (!address) return Promise.resolve(new Map());
  return memo(`pools:${address}`, TTL_MS, async () => {
    const cat = await loadCatalog({ signal }).catch(() => null);
    const n0 = cat ? cat.targets.length : 0;
    const ids = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
    const first = await multicall([{ target: address, fn: FN('targetCount') }, ...ids(1, n0).map((i) => ({ target: address, fn: FN('pool'), args: [i] }))], { signal });
    if (!first[0].ok) throw first[0].error || new RpcError('targetCount did not answer');
    const count = Number(first[0].value);
    const map = new Map();
    ids(1, n0).forEach((i, k) => { const r = first[k + 1]; if (r.ok) map.set(i, BigInt(r.value)); });
    if (count > n0) {
      const more = await multicall(ids(n0 + 1, count).map((i) => ({ target: address, fn: FN('pool'), args: [i] })), { signal });
      ids(n0 + 1, count).forEach((i, k) => { if (more[k].ok) map.set(i, BigInt(more[k].value)); });
    }
    for (const i of map.keys()) if (i > count) map.delete(i);
    return map;
  });
}

// ---------------------------------------------------------------------------------------------------------
// wallet

export async function fundedBy(address, { signal } = {}) {
  const lab = labAddress();
  if (!lab) return [];
  const a = getAddress(address);
  const head = Number(BigInt(await rpc('eth_blockNumber', [], { signal })));
  const logs = await getLogsChunked({ address: lab, topics: [FUNDED.topic, null, addrTopic(a)], fromBlock: labDeployBlock(), toBlock: head, signal });
  return logs.map(decodeFundedLog).filter(Boolean);
}

/** Every Settled event (the winner is not indexed, so the list is read whole and cached 10 s). */
export function settledAll({ signal } = {}) {
  const lab = labAddress();
  if (!lab) return Promise.resolve([]);
  return memo(`settled:${lab}`, TTL_MS, async () => {
    const head = Number(BigInt(await rpc('eth_blockNumber', [], { signal })));
    const logs = await getLogsChunked({ address: lab, topics: [SETTLED.topic], fromBlock: labDeployBlock(), toBlock: head, signal });
    return logs.map(decodeSettledLog).filter(Boolean).sort(byBlockAsc);
  });
}

export async function wonBy(address, opts = {}) {
  const a = getAddress(address);
  return (await settledAll(opts)).filter((s) => s.winner === a);
}

export async function walletStats(address, { signal } = {}) {
  const lab = labAddress();
  const a = isAddress(address) ? getAddress(address) : null;
  if (!a) throw new Error('not an address');
  const empty = { runs: 0, best: null, prizes: 0n, owed: 0n, sponsored: [], reviewsGiven: 0, reviewsReceived: 0, starsReceived: 0, reviewAverage: null, won: [], wonEpochs: 0, live: false };
  if (!lab) return empty;
  const [res, funded, won] = await Promise.all([
    multicall([{ target: lab, fn: FN('stats'), args: [a] }, { target: lab, fn: FN('owed'), args: [a] }], { signal }),
    fundedBy(a, { signal }).catch(() => []),
    wonBy(a, { signal }).catch(() => []),
  ]);
  if (!res[0].ok) throw res[0].error || new RpcError('stats did not answer');
  const [runsN, best, prizes, reviewsGiven, reviewsReceived, starsReceived] = res[0].value;
  const byTarget = new Map();
  for (const f of funded) {
    const s = byTarget.get(f.targetId) || { targetId: f.targetId, amount: 0n, count: 0, last: null };
    s.amount += BigInt(f.amount);
    s.count++;
    s.last = f.block;
    byTarget.set(f.targetId, s);
  }
  const received = Number(reviewsReceived || 0);
  const stars = Number(starsReceived || 0);
  return {
    ...empty,
    runs: Number(runsN),
    best: Number(runsN) > 0 ? Number(best) : null,
    prizes: BigInt(prizes),
    owed: res[1].ok ? BigInt(res[1].value) : 0n,
    sponsored: [...byTarget.values()].sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0)),
    reviewsGiven: Number(reviewsGiven || 0),
    reviewsReceived: received,
    starsReceived: stars,
    reviewAverage: received > 0 ? Math.round((stars / received) * 100) / 100 : null,
    won,
    wonEpochs: won.length,
    live: true,
  };
}

// ---------------------------------------------------------------------------------------------------------
// display numbers (SPEC-ENGINE.md 3.6, float, never on chain)

const RT_LN10 = 1.36423;

export function derivedOf(scoreMilli, heavyAtoms) {
  const dG = Number(scoreMilli) / 1000;
  const pKd = -dG / RT_LN10;
  const n = Number(heavyAtoms);
  return { dG, pKd, kd: 10 ** -pKd, le: n > 0 ? -dG / n : null };
}

// ---------------------------------------------------------------------------------------------------------
// the research report

export function compileReport({ catalog, runs: list = [], pools: poolMap = new Map(), head = null, generatedAt = new Date().toISOString(), live = true, partial = false, epoch = null } = {}) {
  const targets = catalog ? catalog.targets : [];
  const ligandById = catalog ? catalog.ligandById : new Map();
  const targetById = catalog ? catalog.targetById : new Map();
  const tStats = new Map(); // targetId -> { runs, wallets:Set, best }
  const pStats = new Map(); // 't:l' -> { runs, wallets:Set, best }
  const walletsAll = new Set();
  for (const r of list) {
    walletsAll.add(r.wallet);
    let ts = tStats.get(r.targetId);
    if (!ts) { ts = { runs: 0, wallets: new Set(), best: null }; tStats.set(r.targetId, ts); }
    ts.runs++;
    ts.wallets.add(r.wallet);
    if (better(r, ts.best)) ts.best = r;
    const pk = `${r.targetId}:${r.ligandId}`;
    let ps = pStats.get(pk);
    if (!ps) { ps = { runs: 0, wallets: new Set(), best: null }; pStats.set(pk, ps); }
    ps.runs++;
    ps.wallets.add(r.wallet);
    if (better(r, ps.best)) ps.best = r;
  }
  const poolOf = (id) => (poolMap.get(id) === undefined ? 0n : BigInt(poolMap.get(id)));
  const enrich = (run, ps) => {
    const t = targetById.get(run.targetId) || null;
    const l = ligandById.get(run.ligandId) || null;
    const heavy = l ? (l.atoms || l.heavyAtoms || 0) : 0;
    const { pose, reviewList, analysis, method, ...plain } = run;
    return {
      ...plain,
      runId: run.id,
      url: runUrl(run.id),
      target: t ? { id: t.id, key: t.key, pdbId: t.pdbId, gene: t.gene || null, name: t.name || t.gene || t.key } : { id: run.targetId, key: null, pdbId: null, gene: null, name: `Target ${run.targetId}` },
      ligand: l ? { id: l.id, key: l.key, name: l.name, heavyAtoms: heavy } : { id: run.ligandId, key: null, name: `Ligand ${run.ligandId}`, heavyAtoms: 0 },
      ...derivedOf(run.scoreMilli, heavy),
      reviews: reviewsShape(run.reviews),
      analysisAttached: !!(run.analysisAttached || run.analysis),
      pairRuns: ps ? ps.runs : 0,
      pairWallets: ps ? ps.wallets.size : 0,
      pool: poolOf(run.targetId),
    };
  };
  let poolTotal = 0n;
  for (const t of targets) poolTotal += poolOf(t.id);
  const cancers = CANCERS.map((c) => {
    const group = targets.filter((t) => cancersOf(t).includes(c));
    const idSet = new Set(group.map((t) => t.id));
    const groupWallets = new Set();
    let groupRuns = 0;
    let groupPool = 0n;
    const rows = group.map((t) => {
      const ts = tStats.get(t.id);
      if (ts) { groupRuns += ts.runs; for (const w of ts.wallets) groupWallets.add(w); }
      groupPool += poolOf(t.id);
      return { id: t.id, key: t.key, pdbId: t.pdbId, gene: t.gene || null, name: t.name || t.gene || t.key, best: ts ? enrich(ts.best, pStats.get(`${ts.best.targetId}:${ts.best.ligandId}`)) : null, runs: ts ? ts.runs : 0, wallets: ts ? ts.wallets.size : 0, pool: poolOf(t.id) };
    });
    const bestPairs = [];
    for (const ps of pStats.values()) if (idSet.has(ps.best.targetId)) bestPairs.push(enrich(ps.best, ps));
    bestPairs.sort((a, b) => a.scoreMilli - b.scoreMilli || a.id - b.id);
    return { key: c.key, name: c.name, bit: c.bit, targets: rows, bestPairs, runs: groupRuns, wallets: groupWallets.size, pool: groupPool, targetCount: rows.length };
  });
  const reviewed = list.filter((r) => r.reviews && r.reviews.count > 0);
  reviewed.sort((a, b) => (b.reviews.count - a.reviews.count) || ((b.reviews.average || 0) - (a.reviews.average || 0)) || (a.id - b.id));
  const mostReviewed = reviewed.slice(0, 10).map((r) => enrich(r, pStats.get(`${r.targetId}:${r.ligandId}`)));
  return {
    generatedAt,
    head,
    live,
    partial,
    epoch,
    runCount: list.length,
    wallets: walletsAll.size,
    targetCount: targets.length,
    ligandCount: catalog ? catalog.ligands.length : 0,
    poolTotal,
    reviewCount: list.reduce((n, r) => n + ((r.reviews && r.reviews.count) || 0), 0),
    cancers,
    mostReviewed,
  };
}

export const REPORT_METHOD = Object.freeze([
  'Binding free energy, written dG, is the energy released when a compound settles into a pocket. More negative is better. Ponchem estimates it with an empirical scoring function of the AutoDock Vina family: five terms over heavy atom pairs, weighted with the values Trott and Olson fitted on about 1,300 PDBbind complexes in 2010. Our engine is an independent implementation of that function, written in integers so a contract can run it. It is not AutoDock Vina.',
  'From dG we estimate potency: pKd, and Kd from dG = RT ln Kd at 298.15 K. We also show ligand efficiency, the energy per heavy atom, because a small molecule with a fair score is often a better lead than a large one with a great score.',
  'These are computational estimates. They rank candidates for further study. They do not say a compound works in a cell, an animal or a person.',
]);

const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/[‒-―]/g, '-').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const fix = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '');
const ethOf = (wei) => units(wei, 18, 6);
const reviewsCell = (r) => (r && r.count > 0 ? `${r.count} (${fix(r.average, 1)})` : '0');
const linkCell = (id) => `[Test #${id}](${runUrl(id)})`;

export function renderReportMarkdown(report) {
  const r = report || compileReport({});
  const when = fmtDate(r.generatedAt);
  const lines = [];
  lines.push('# Ponchem cancer research report', '');
  lines.push(`Ponchem cancer research report, compiled from Robinhood Chain${r.head !== null && r.head !== undefined ? ` at block ${r.head}` : ''} on ${when}. Estimates from computational screening with a Vina-style scoring function. Not clinical results.`, '');
  lines.push(`Generated ${String(r.generatedAt).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}. ${r.runCount} docking tests, ${r.wallets} wallets, ${r.targetCount} targets, ${r.ligandCount} ligands, ${r.reviewCount || 0} reviews, ${ethOf(r.poolTotal || 0n)} ETH in prize pools.${r.partial ? ' The run list was cut at the page limit, so counts are lower bounds.' : ''}`, '');
  if (!r.live) lines.push(NOT_LIVE, '');
  if (!r.runCount) lines.push('No runs recorded yet. The first recorded run on a target starts its leaderboard.', '');
  for (const g of r.cancers || []) {
    lines.push(`## ${g.name}`, '');
    if (!g.bestPairs.length) {
      lines.push('Nothing recorded for this group yet. Dock any of its targets and the report fills in.', '');
      lines.push(`${g.targetCount} targets in this group`, '');
      continue;
    }
    lines.push('Top ten pairs by binding free energy', '');
    lines.push('| Rank | Target | Ligand | dG (kcal/mol) | pKd | LE | Runs | Wallets | Reviews | Pool (ETH) | Link |');
    lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|');
    g.bestPairs.slice(0, 10).forEach((p, i) => {
      const tName = clean(p.target.pdbId ? `${p.target.name} (${p.target.pdbId})` : p.target.name);
      lines.push(`| ${i + 1} | ${tName} | ${clean(p.ligand.name)} | ${fix(p.dG, 3)} | ${fix(p.pKd, 2)} | ${p.le === null ? '' : fix(p.le, 2)} | ${p.pairRuns} | ${p.pairWallets} | ${reviewsCell(p.reviews)} | ${ethOf(p.pool)} | ${linkCell(p.id)} |`);
    });
    lines.push('', `${g.runs} runs, ${g.wallets} wallets, ${g.targetCount} targets in this group`, '');
  }
  if (r.mostReviewed && r.mostReviewed.length) {
    lines.push('## Most reviewed docking tests', '');
    lines.push('| Test | Target | Ligand | dG (kcal/mol) | Reviews | Average stars | Link |');
    lines.push('|---:|---|---|---:|---:|---:|---|');
    for (const p of r.mostReviewed) {
      const tName = clean(p.target.pdbId ? `${p.target.name} (${p.target.pdbId})` : p.target.name);
      lines.push(`| ${p.id} | ${tName} | ${clean(p.ligand.name)} | ${fix(p.dG, 3)} | ${p.reviews.count} | ${fix(p.reviews.average, 1)} | ${linkCell(p.id)} |`);
    }
    lines.push('');
  }
  lines.push('## Method', '');
  for (const p of REPORT_METHOD) lines.push(p, '');
  lines.push(`${BRAND.footer}, compiled from Robinhood Chain`, '');
  return lines.join('\n');
}

export async function report({ signal } = {}) {
  const address = labAddress();
  const catalog = await loadCatalog({ signal });
  if (!address) return compileReport({ catalog, live: false });
  const [all, poolMap, st] = await Promise.all([allRuns({ signal }), pools({ signal }).catch(() => new Map()), labStatus({ signal })]);
  return compileReport({ catalog, runs: all.runs, pools: poolMap, head: all.head !== null ? all.head : st.head, live: true, partial: all.partial, epoch: st.live ? st.epoch : null });
}

// ---------------------------------------------------------------------------------------------------------
// block polling, only while the tab is visible (the Claude browser pane runs pages hidden, so no rAF here)

export function onBlock(cb, { intervalMs = 4000 } = {}) {
  let last = null;
  let stopped = false;
  let busy = false;
  const hasDoc = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function';
  const visible = () => !hasDoc || document.visibilityState !== 'hidden';
  const tick = async () => {
    if (stopped || busy || !visible()) return;
    busy = true;
    try {
      const n = Number(BigInt(await rpc('eth_blockNumber', [], { timeoutMs: 8000 })));
      if (!stopped && n !== last) { last = n; try { cb(n); } catch { /* listener bug */ } }
    } catch { /* unreachable: the next tick retries */ } finally { busy = false; }
  };
  const onVis = () => { if (visible()) tick(); };
  if (hasDoc) document.addEventListener('visibilitychange', onVis);
  const timer = setInterval(tick, Math.max(1000, Number(intervalMs) || 4000));
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (hasDoc) document.removeEventListener('visibilitychange', onVis);
  };
}
