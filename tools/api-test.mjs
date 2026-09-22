#!/usr/bin/env node
/*
 * tools/api-test.mjs: the test of the data layer (js/catalog.js, js/chain.js, js/lab.js, js/gamify.js) and the API
 * (api/status.js, api/runs.js, api/report.js, api/analyze.js with api/_llm.mjs). No dependencies beyond Node
 * (node:assert, node:http, global fetch).
 *
 *   node tools/api-test.mjs                          against http://127.0.0.1:6133 (PORT=6133 node tools/dev.mjs first)
 *   node tools/api-test.mjs --base http://127.0.0.1:6133
 *   node tools/api-test.mjs --only "fake,api"        run only the groups whose name contains one of these words
 *
 * Four layers, so the whole thing runs before the contract exists:
 *   1. pure: RunScored / Paid / Method / Reviewed / Analysis / Funded / Settled / Rolled logs encoded by hand with
 *      js/rpc.js encodeAbi and decoded back, pose hex, run selection and paging, bests, the report compiler and its
 *      Markdown (reviews and link columns), the calldata builders (submitRun with the payment flag and the method,
 *      approve, reviewRun, attachAnalysis), the revert decoder and its sentences, the catalog assembler, the filters,
 *      and js/gamify.js on synthetic ledgers (XP arithmetic, every level, every badge, the ranking).
 *   2. fake chain: a JSON-RPC node that lives inside this process (the global fetch is wrapped for one made-up
 *      URL, so no port is used). It answers eth_chainId, eth_blockNumber, eth_getLogs (with topic filters and a
 *      "too many results" refusal above a span), eth_call for Multicall3 and for every lab view (SPEC.md 9 shapes),
 *      quote reverts with BadPose, and eth_getBlockByNumber. js/chain.js and the API handlers (imported in-process
 *      with the env of api/_lab.mjs pointed at the fake) are driven end to end: status, runs, one run, the ledger,
 *      reviews, analyses, incremental sync, bests, pools, wallet stats, the report, the Markdown, the analyze route
 *      (providers listed, 409 without keys, the full path against a fake provider server that speaks the OpenAI
 *      and the Anthropic shapes on port 8692, else an ephemeral port).
 *   3. the dev server at --base: the not-live shapes of the routes over HTTP (or, when .data/local-chain.json exists
 *      and that server was started with PONCHEM_RPC_URL / PONCHEM_LAB, the live shapes), the cache and CORS headers,
 *      400 / 405 / 409 / HEAD / OPTIONS.
 *   4. the Node import smoke test: js/catalog.js and js/chain.js with configure({ base }) reading the catalog files
 *      from that server.
 *
 * Provider keys are removed from this process's environment before anything runs, so no real model is ever called.
 * Exit code 0 when everything passed, 1 otherwise. Prints the counts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN, MULTICALL3, LAB } from '../js/config.js';
import { configure, encodeAbi, decodeAbi, getAddress, keccak256, toHex, selector } from '../js/rpc.js';
import * as catalog from '../js/catalog.js';
import * as chain from '../js/chain.js';
import * as lab from '../js/lab.js';
import * as gamify from '../js/gamify.js';

for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|OPENAI_|MOONSHOT_|JEV_|PONCHEM_MODEL_)/.test(k)) delete process.env[k];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const BASE = String(option('--base', 'http://127.0.0.1:6133')).replace(/\/+$/, '');
const ONLY = option('--only') ? option('--only').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const chainFile = path.resolve(ROOT, option('--chain', '.data/local-chain.json'));
const local = fs.existsSync(chainFile) ? JSON.parse(fs.readFileSync(chainFile, 'utf8')) : null;
// the dash gate, assembled so this file never contains the characters it looks for
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const DASH = new RegExp(`[${EN}${EM}]`);
const EMOJI = /\p{Extended_Pictographic}/u;
const BANNED = new RegExp(['\\b(de', 'mo|mo', 'ck|la', 'rp|pre', 'view)\\b'].join(''), 'i');
const FAKE_PROVIDER_PORT = 8692;

// ---------------------------------------------------------------------------------------------------------
// harness

let passed = 0;
const failures = [];
const skipped = [];
let groupOn = true;
function group(name) {
  groupOn = !ONLY || ONLY.some((w) => name.toLowerCase().includes(w));
  if (groupOn) console.log(`\n${name}`);
  return groupOn;
}
async function check(name, fn) {
  if (!groupOn) return;
  try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) {
    failures.push({ name, error: e });
    console.log(`  FAIL  ${name}\n          ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n          ')}`);
  }
}
function skip(name, why) { if (!groupOn) return; skipped.push(name); console.log(`  skip  ${name} (${why})`); }
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Int16Array ? [...x] : x));
const eq = (a, b, msg) => { if (show(a) !== show(b)) throw new Error(`${msg || 'not equal'}: got ${show(a)}, want ${show(b)}`); };

// ---------------------------------------------------------------------------------------------------------
// fixtures: wallets, poses, logs built by hand

const W1 = getAddress('0x1111111111111111111111111111111111111111');
const W2 = getAddress('0x2222222222222222222222222222222222222222');
const W3 = getAddress('0x3333333333333333333333333333333333333333');
const FAKE_LAB = getAddress('0x4a6c0b1a0d3f0000000000000000000000000c0d');
const FAKE_TOKEN = getAddress('0x70c4e00000000000000000000000000000000c0e');
const FAKE_RPC = 'http://ponchem-fake-rpc.invalid/';
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addrTopic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const txHash = (i) => keccak256(`tx-${i}`);
const ZERO_HASH = '0x' + '0'.repeat(64);
const methodHashOf = (json) => (json ? keccak256(new TextEncoder().encode(json)) : ZERO_HASH);

const POSE_A = Int16Array.from([733, -234, 96, 664, -140, 88, 580, -24, 100]); // three atoms, mixed signs
const POSE_B = Int16Array.from([-32768, 32767, 0, 1, -1, 2]);
const METHOD_STD = '{"name":"Standard","version":1,"budget":{"ms":30000},"seed":7}';
const METHOD_REPRO = '{"name":"Reproducible","version":1,"budget":{"steps":12000},"chains":8,"seed":42}';
const RUN_FEE = 10n ** 14n;
const RUN_PRICE = 100n * 10n ** 18n;

function runLog(r) {
  return {
    address: FAKE_LAB.toLowerCase(),
    topics: [chain.RUN_SCORED.topic, word(r.id), addrTopic(r.wallet), word(r.targetId)],
    data: encodeAbi(['uint16', 'int32', 'uint32', 'int16[]'], [r.ligandId, r.scoreMilli, r.epoch, [...r.pose]]),
    blockNumber: toHex(r.block),
    transactionHash: r.tx || txHash(r.id),
    logIndex: toHex(r.logIndex || 0),
  };
}
function paidLog(r) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.PAID.topic, word(r.id), addrTopic(r.wallet)], data: encodeAbi(['uint8', 'uint256'], [r.pay.code, r.pay.amount]), blockNumber: toHex(r.block), transactionHash: r.tx || txHash(r.id), logIndex: '0x1' };
}
function methodLog(r) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.METHOD.topic, word(r.id)], data: encodeAbi(['string'], [r.method || '']), blockNumber: toHex(r.block), transactionHash: r.tx || txHash(r.id), logIndex: '0x2' };
}
function reviewedLog(v, i) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.REVIEWED.topic, word(v.runId), addrTopic(v.reviewer)], data: encodeAbi(['uint8', 'string'], [v.stars, v.note]), blockNumber: toHex(v.block), transactionHash: txHash(`v${i}`), logIndex: toHex(v.logIndex || 0) };
}
function analysisLog(a, i) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.ANALYSIS.topic, word(a.runId)], data: encodeAbi(['string', 'string'], [a.provider, a.text]), blockNumber: toHex(a.block), transactionHash: txHash(`a${i}`), logIndex: toHex(a.logIndex || 0) };
}
function fundedLog(f, i) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.FUNDED.topic, word(f.targetId), addrTopic(f.from)], data: encodeAbi(['uint256', 'uint256'], [f.amount, f.pool]), blockNumber: toHex(f.block), transactionHash: txHash(`f${i}`), logIndex: '0x0' };
}
function settledLog(s, i) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.SETTLED.topic, word(s.targetId), word(s.epoch)], data: encodeAbi(['address', 'uint256', 'uint256'], [s.winner, s.runId, s.amount]), blockNumber: toHex(s.block), transactionHash: txHash(`s${i}`), logIndex: '0x1' };
}
function rolledLog(s, i) {
  return { address: FAKE_LAB.toLowerCase(), topics: [chain.ROLLED.topic, word(s.targetId), word(s.epoch)], data: encodeAbi(['uint256'], [s.pool]), blockNumber: toHex(s.block), transactionHash: txHash(`r${i}`), logIndex: '0x2' };
}

const ETH = (amount = RUN_FEE) => ({ code: 0, amount });
const TOKEN = (amount = RUN_PRICE) => ({ code: 1, amount });
const RUNS = [
  { id: 1, wallet: W1, targetId: 1, ligandId: 2, scoreMilli: -5483, epoch: 3, time: 1_700_000_100, block: 10, pose: POSE_A, method: METHOD_STD, pay: ETH() },
  { id: 2, wallet: W2, targetId: 1, ligandId: 2, scoreMilli: -6446, epoch: 3, time: 1_700_000_200, block: 20, pose: POSE_A, method: '', pay: TOKEN() },
  { id: 3, wallet: W1, targetId: 2, ligandId: 1, scoreMilli: -9289, epoch: 3, time: 1_700_000_300, block: 30, pose: POSE_B, method: METHOD_REPRO, pay: ETH() },
  { id: 4, wallet: W3, targetId: 1, ligandId: 1, scoreMilli: -6446, epoch: 4, time: 1_700_000_400, block: 40, pose: POSE_B, method: METHOD_STD, pay: ETH() },
  { id: 5, wallet: W2, targetId: 3, ligandId: 2, scoreMilli: 7157, epoch: 4, time: 1_700_000_500, block: 50, pose: POSE_A, method: '', pay: ETH() },
];
const FUNDS = [
  { targetId: 1, from: W1, amount: 10n ** 16n, pool: 10n ** 16n, block: 12 },
  { targetId: 1, from: W1, amount: 2n * 10n ** 16n, pool: 3n * 10n ** 16n, block: 13 },
  { targetId: 2, from: W2, amount: 5n * 10n ** 15n, pool: 5n * 10n ** 15n, block: 14 },
];
const REVIEWS = [
  { runId: 2, reviewer: W1, stars: 5, note: 'Clean pose, plausible contacts with the hinge.', block: 21, logIndex: 0 },
  { runId: 2, reviewer: W3, stars: 3, note: 'Looks a little shallow in the pocket.', block: 22, logIndex: 0 },
  { runId: 2, reviewer: W3, stars: 4, note: 'Second look after the 3D view: better than I thought.', block: 23, logIndex: 0 },
  { runId: 3, reviewer: W2, stars: 2, note: `A note with a ${EM} dash and an emoji \u{1F9EA} that the site must render as text.`, block: 31, logIndex: 0 },
];
const ANALYSES = [
  { runId: 3, provider: 'gpt', text: 'First analysis: the pose fills the pocket.', block: 32, logIndex: 0 },
  { runId: 3, provider: 'claude-fable', text: 'Second analysis replaces the first. Plain sentences only.', block: 33, logIndex: 0 },
];
const SETTLED = [{ targetId: 1, epoch: 2, winner: W1, runId: 1, amount: 7n * 10n ** 15n, block: 9 }];

// ---------------------------------------------------------------------------------------------------------
// 1. pure

if (group('pure: log decoding')) {
  await check('RunScored encodes and decodes back, pose Int16Array with negative values kept, v2 fields empty', () => {
    const r = chain.decodeRunLog(runLog(RUNS[0]));
    eq(r.id, 1); eq(r.wallet, W1); eq(r.targetId, 1); eq(r.ligandId, 2); eq(r.scoreMilli, -5483); eq(r.epoch, 3);
    eq(r.block, 10); eq(r.tx, txHash(1)); eq(r.time, null);
    assert.ok(r.pose instanceof Int16Array); eq([...r.pose], [...POSE_A]);
    eq([r.methodHash, r.payment, r.method, r.reviews, r.analysis, r.analysisAttached], [null, null, null, { count: 0, starSum: 0, average: null }, null, false]);
  });
  await check('int16 extremes survive the event and the hex wire form', () => {
    const r = chain.decodeRunLog(runLog(RUNS[2]));
    eq([...r.pose], [...POSE_B]);
    const hex = chain.poseToHex(r.pose);
    eq(hex, '0x80007fff00000001ffff0002');
    eq([...chain.poseFromHex(hex)], [...POSE_B]);
    eq(chain.poseFromHex('0x123'), null);
    eq([...chain.fromJsonRun(chain.toJsonRun(r)).pose], [...POSE_B]);
  });
  await check('a log with another topic or a short topic list decodes to null', () => {
    eq(chain.decodeRunLog(fundedLog(FUNDS[0], 0)), null);
    const bad = runLog(RUNS[0]); bad.topics = bad.topics.slice(0, 3);
    eq(chain.decodeRunLog(bad), null);
    eq(chain.decodePaidLog(runLog(RUNS[0])), null); eq(chain.decodeReviewedLog(methodLog(RUNS[0])), null); eq(chain.decodeAnalysisLog(reviewedLog(REVIEWS[0], 0)), null);
  });
  await check('Paid: method code 0 eth / 1 token and the amount; Method: the JSON text (or empty)', () => {
    const p = chain.decodePaidLog(paidLog(RUNS[0]));
    eq([p.runId, p.wallet, p.code, p.method, p.amount, p.block, p.logIndex], [1, W1, 0, 'eth', RUN_FEE, 10, 1]);
    const t = chain.decodePaidLog(paidLog(RUNS[1]));
    eq([t.runId, t.code, t.method, t.amount], [2, 1, 'token', RUN_PRICE]);
    const m = chain.decodeMethodLog(methodLog(RUNS[2]));
    eq([m.runId, m.json, m.logIndex], [3, METHOD_REPRO, 2]);
    eq(chain.decodeMethodLog(methodLog(RUNS[1])).json, '');
  });
  await check('Reviewed: reviewer from the topic, stars and the note as text; Analysis: provider and text', () => {
    const v = chain.decodeReviewedLog(reviewedLog(REVIEWS[3], 3));
    eq([v.runId, v.reviewer, v.stars, v.block], [3, W2, 2, 31]);
    eq(v.note, REVIEWS[3].note, 'the note comes back byte for byte, dash and emoji included');
    const a = chain.decodeAnalysisLog(analysisLog(ANALYSES[1], 1));
    eq([a.runId, a.provider, a.text, a.block], [3, 'claude-fable', ANALYSES[1].text, 33]);
  });
  await check('Funded, Settled and Rolled decode', () => {
    const f = chain.decodeFundedLog(fundedLog(FUNDS[0], 0));
    eq(f.targetId, 1); eq(f.from, W1); eq(f.amount, 10n ** 16n); eq(f.pool, 10n ** 16n); eq(f.block, 12);
    const s = chain.decodeSettledLog(settledLog({ targetId: 1, epoch: 3, winner: W2, runId: 2, amount: 123n, block: 60 }, 0));
    eq(s.targetId, 1); eq(s.epoch, 3); eq(s.winner, W2); eq(s.runId, 2); eq(s.amount, 123n);
    const r = chain.decodeRolledLog(rolledLog({ targetId: 2, epoch: 3, pool: 5n, block: 61 }, 0));
    eq(r.targetId, 2); eq(r.epoch, 3); eq(r.pool, 5n);
  });
  await check('event topics match the SPEC 8.2 and SPEC 9 signatures', () => {
    eq(chain.RUN_SCORED.signature, 'RunScored(uint256,address,uint16,uint16,int32,uint32,int16[])');
    eq(chain.PAID.signature, 'Paid(uint256,address,uint8,uint256)');
    eq(chain.METHOD.signature, 'Method(uint256,string)');
    eq(chain.REVIEWED.signature, 'Reviewed(uint256,address,uint8,string)');
    eq(chain.ANALYSIS.signature, 'Analysis(uint256,string,string)');
    eq(chain.FUNDED.signature, 'Funded(uint16,address,uint256,uint256)');
    eq(chain.SETTLED.signature, 'Settled(uint16,uint32,address,uint256,uint256)');
    eq(chain.ROLLED.signature, 'Rolled(uint16,uint32,uint256)');
    eq(chain.RUN_SCORED.topic, keccak256(new TextEncoder().encode(chain.RUN_SCORED.signature)));
    eq(lab.labFragment('submitRun').signature, 'submitRun(uint16,uint16,int16[],bool,string)');
    eq(lab.labFragment('run').outputs.length, 8, 'run() ends with bytes32 methodHash');
    eq(lab.labFragment('stats').outputs, ['uint64', 'int32', 'uint256', 'uint32', 'uint32', 'uint32']);
    assert.ok(!lab.LAB_FRAGMENTS.some((f) => /minHold|setRunFee/.test(f)), 'the v1 token gate is gone');
  });
  await check('LogIndex.ingest attaches payments, methods, reviews (latest per reviewer) and analyses (latest wins) to runs, in any log order', () => {
    const idx = new chain.LogIndex({ address: FAKE_LAB });
    const logs = [...RUNS.map(runLog), ...RUNS.map(paidLog), ...RUNS.map(methodLog), ...REVIEWS.map(reviewedLog), ...ANALYSES.map(analysisLog)];
    idx.ingest(logs.slice().reverse());
    eq(idx.runs.map((r) => r.id), [1, 2, 3, 4, 5]);
    const r2 = idx.byId.get(2);
    eq(r2.payment, { method: 'token', code: 1, amount: RUN_PRICE }); eq(r2.method, ''); eq(r2.reviews, { count: 2, starSum: 9, average: 4.5 });
    eq(r2.reviewList.map((v) => [v.reviewer, v.stars]), [[W3, 4], [W1, 5]], 'newest first, the replaced review gone');
    const r3 = idx.byId.get(3);
    eq(r3.method, METHOD_REPRO); eq(r3.analysis.provider, 'claude-fable'); eq(r3.analysisAttached, true); eq(idx.analyses.get(3).length, 2);
    eq(r3.reviews, { count: 1, starSum: 2, average: 2 });
    eq(idx.ingest(logs), 0, 'a second ingest of the same logs adds nothing');
    eq(idx.byId.get(2).reviews.count, 2);
    const wire = chain.toJsonRun(r2);
    eq([wire.payment, wire.reviews, wire.analysisAttached, 'method' in wire], [{ method: 'token', code: 1, amount: String(RUN_PRICE) }, { count: 2, starSum: 9, average: 4.5 }, false, false]);
    const full = chain.fromJsonRun(chain.toJsonRun(r3, { full: true }));
    eq([full.method, full.analysis.provider, full.reviewList.length, full.payment.amount], [METHOD_REPRO, 'claude-fable', 1, RUN_FEE]);
    const l = chain.fromJsonLedger(chain.toJsonLedger(chain.ledgerOf(idx)));
    eq([l.runs.length, l.reviews.length, l.analyses.length, l.runs[1].payment.amount, l.runs[0].pose], [5, 3, 2, RUN_PRICE, null]);
  });
}

if (group('pure: selection, bests, report')) {
  const idx0 = new chain.LogIndex({ address: FAKE_LAB });
  idx0.ingest([...RUNS.map(runLog), ...RUNS.map(paidLog), ...RUNS.map(methodLog), ...REVIEWS.map(reviewedLog), ...ANALYSES.map(analysisLog)]);
  const list = idx0.runs;
  await check('selectRuns filters by target, ligand and wallet and pages newest first', () => {
    eq(chain.selectRuns(list, {}).runs.map((r) => r.id), [5, 4, 3, 2, 1]);
    eq(chain.selectRuns(list, { order: 'asc', limit: 2, offset: 1 }).runs.map((r) => r.id), [2, 3]);
    eq(chain.selectRuns(list, { target: 1 }).total, 3);
    eq(chain.selectRuns(list, { target: 1, ligand: 2 }).runs.map((r) => r.id), [2, 1]);
    eq(chain.selectRuns(list, { wallet: W2.toLowerCase() }).runs.map((r) => r.id), [5, 2]);
    eq(chain.selectRuns(list, { wallet: 'nope' }).total, 5, 'a malformed wallet filter is ignored, not fatal');
    eq(chain.selectRuns(list, { limit: 5000 }).runs.length, 5);
  });
  await check('computeBests: lowest score wins, ties go to the earlier run, epoch map keyed t:e', () => {
    const b = chain.computeBests(list);
    eq(b.byTarget.get(1).id, 2, 'target 1 best is run 2 (-6446 before run 4 at the same score)');
    eq(b.byTarget.get(2).id, 3); eq(b.byTarget.get(3).id, 5);
    eq(b.byPair.get('1:2').id, 2); eq(b.byPair.get('1:1').id, 4);
    eq(b.byLigand.get(1).id, 3); eq(b.byLigand.get(2).id, 2);
    eq(b.byTargetEpoch.get('1:3').id, 2); eq(b.byTargetEpoch.get('1:4').id, 4);
  });
  await check('derivedOf matches the vector display numbers', () => {
    const d = chain.derivedOf(-5483, 29);
    assert.ok(Math.abs(d.dG + 5.483) < 1e-9 && Math.abs(d.pKd - 4.0191) < 1e-3 && Math.abs(d.le - 0.18907) < 1e-4 && Math.abs(d.kd - 9.569e-5) < 1e-7);
    eq(chain.derivedOf(-1000, 0).le, null);
  });
  const targetsDoc = { targets: [
    { key: 'EGFR', gene: 'EGFR', pdbId: '1M17', protein: 'EGFR kinase', cancers: ['lung', 'head and neck'], class: 'kinase', ligand: { ccd: 'AQ4', name: 'Erlotinib' } },
    { key: 'ABL1', gene: 'ABL1', pdbId: '2HYY', protein: 'ABL1 kinase', cancers: ['leukemia'], class: 'kinase', ligand: { ccd: 'STI', name: 'Imatinib' } },
    { key: 'BCL2', gene: 'BCL2', pdbId: '4LVT', protein: 'Bcl-2', cancers: ['lymphoma', 'leukemia'], class: 'apoptosis', ligand: { ccd: 'ABT', name: 'Navitoclax' } },
  ] };
  const ligandsDoc = { ligands: [
    { key: 'QUERCETIN', name: 'Quercetin', plant: 'onion, apple', class: 'flavonol', heavyAtoms: 22, rotatableBonds: 1 },
    { key: 'CURCUMIN', name: 'Curcumin', plant: 'turmeric', class: 'curcuminoid', heavyAtoms: 27, rotatableBonds: 8 },
  ] };
  const cat = catalog.assembleCatalog(targetsDoc, ligandsDoc, null);
  await check('compileReport groups by cancer, ranks pairs, counts runs, wallets, reviews and pools, links run ids', () => {
    const poolMap = new Map([[1, 3n * 10n ** 16n], [2, 5n * 10n ** 15n]]);
    const rep = chain.compileReport({ catalog: cat, runs: list, pools: poolMap, head: 120, generatedAt: '2026-09-22T00:00:00.000Z' });
    eq(rep.runCount, 5); eq(rep.wallets, 3); eq(rep.targetCount, 3); eq(rep.poolTotal, 35n * 10n ** 15n); eq(rep.reviewCount, 3);
    const lung = rep.cancers.find((c) => c.key === 'lung');
    eq(lung.targets.map((t) => t.id), [1]); eq(lung.runs, 3); eq(lung.wallets, 3); eq(lung.pool, 3n * 10n ** 16n);
    eq(lung.bestPairs.map((p) => `${p.targetId}:${p.ligandId}:${p.id}`), ['1:2:2', '1:1:4']);
    eq(lung.bestPairs[0].pairRuns, 2); eq(lung.bestPairs[0].pairWallets, 2); eq(lung.bestPairs[0].ligand.name, 'Curcumin');
    eq(lung.bestPairs[0].target.pdbId, '1M17'); eq(lung.targets[0].best.id, 2);
    eq([lung.bestPairs[0].runId, lung.bestPairs[0].url, lung.bestPairs[0].reviews, lung.bestPairs[0].analysisAttached], [2, 'https://ponchem.ai/run?id=2', { count: 2, starSum: 9, average: 4.5 }, false]);
    assert.ok(!('pose' in lung.bestPairs[0]) && !('reviewList' in lung.bestPairs[0]), 'the report carries no poses and no review notes');
    assert.ok(Math.abs(lung.bestPairs[0].dG + 6.446) < 1e-9);
    const hn = rep.cancers.find((c) => c.key === 'head-and-neck');
    eq(hn.name, 'Head and neck'); eq(hn.bestPairs.length, 2);
    const leuk = rep.cancers.find((c) => c.key === 'leukemia');
    eq(leuk.targets.map((t) => t.id), [2, 3]); eq(leuk.bestPairs.map((p) => p.id), [3, 5]);
    eq(leuk.bestPairs[0].analysisAttached, true);
    eq(rep.cancers.find((c) => c.key === 'breast').bestPairs, []);
    eq(rep.cancers.map((c) => c.key), catalog.CANCERS.map((c) => c.key));
    eq(rep.mostReviewed.map((p) => [p.id, p.reviews.count, p.reviews.average, p.url]), [[2, 2, 4.5, 'https://ponchem.ai/run?id=2'], [3, 1, 2, 'https://ponchem.ai/run?id=3']]);
  });
  await check('renderReportMarkdown: title, compiled line, tables with Reviews and Link columns, most reviewed, empty groups, method note, no dashes', () => {
    const rep = chain.compileReport({ catalog: cat, runs: list, pools: new Map(), head: 120, generatedAt: '2026-09-22T00:00:00.000Z' });
    const md = chain.renderReportMarkdown(rep);
    assert.ok(md.startsWith('# Ponchem cancer research report\n'));
    assert.ok(md.includes('compiled from Robinhood Chain at block 120 on Sep 22, 2026. Estimates from computational screening with a Vina-style scoring function. Not clinical results.'));
    assert.ok(md.includes('5 docking tests, 3 wallets, 3 targets, 2 ligands, 3 reviews, 0 ETH in prize pools.'));
    assert.ok(md.includes('## Lung\n\nTop ten pairs by binding free energy\n\n| Rank | Target | Ligand | dG (kcal/mol) | pKd | LE | Runs | Wallets | Reviews | Pool (ETH) | Link |'));
    assert.ok(md.includes('| 1 | EGFR (1M17) | Curcumin | -6.446 | 4.73 | 0.24 | 2 | 2 | 2 (4.5) | 0 | [Test #2](https://ponchem.ai/run?id=2) |'), md.split('\n').find((l) => l.startsWith('| 1 |')));
    assert.ok(md.includes('| 2 | EGFR (1M17) | Quercetin | -6.446 | 4.73 | 0.29 | 1 | 1 | 0 | 0 | [Test #4](https://ponchem.ai/run?id=4) |'));
    assert.ok(md.includes('3 runs, 3 wallets, 1 targets in this group'));
    assert.ok(md.includes('## Breast\n\nNothing recorded for this group yet. Dock any of its targets and the report fills in.'));
    assert.ok(md.includes('## Most reviewed docking tests\n\n| Test | Target | Ligand | dG (kcal/mol) | Reviews | Average stars | Link |'));
    assert.ok(md.includes('| 2 | EGFR (1M17) | Curcumin | -6.446 | 2 | 4.5 | [Test #2](https://ponchem.ai/run?id=2) |'));
    assert.ok(md.includes('## Method\n\nBinding free energy, written dG,'));
    assert.ok(md.includes('These are computational estimates. They rank candidates for further study.'));
    assert.ok(md.trim().endsWith('2026 Pons Lab CADD (Computer-aided Drug Design), compiled from Robinhood Chain'));
    assert.ok(!DASH.test(md), 'a dash slipped into the Markdown');
    assert.ok(!EMOJI.test(md), 'an emoji slipped into the Markdown');
    assert.ok(!BANNED.test(md), 'a banned word slipped into the Markdown');
    assert.ok(!/0x[0-9a-fA-F]{40}/.test(md), 'an address slipped into the Markdown');
    assert.ok(!md.includes('Clean pose'), 'review notes never reach the research report');
  });
  await check('renderReportMarkdown with no runs says so, and a name with a pipe or a dash is cleaned', () => {
    const empty = chain.renderReportMarkdown(chain.compileReport({ catalog: cat, runs: [], live: false }));
    assert.ok(empty.includes('No runs recorded yet. The first recorded run on a target starts its leaderboard.'));
    assert.ok(empty.includes('The lab opens when the contract is live.'));
    assert.ok(!empty.includes('## Most reviewed'));
    const odd = catalog.assembleCatalog({ targets: [{ key: 'X', gene: 'X', pdbId: '1ABC', cancers: ['lung'], name: `Odd | name ${EM} here` }] }, { ligands: [{ key: 'L', name: 'Lig' }] }, null);
    const md = chain.renderReportMarkdown(chain.compileReport({ catalog: odd, runs: [{ id: 1, wallet: W1, targetId: 1, ligandId: 1, scoreMilli: -1000, epoch: 0, time: null, block: 1, tx: null, pose: null }] }));
    assert.ok(md.includes('| 1 | Odd name - here (1ABC) | Lig |'), md.split('\n').find((l) => l.startsWith('| 1 |')));
    assert.ok(md.includes('| 0 | 0 | [Test #1](https://ponchem.ai/run?id=1) |'), 'a v1-shaped run (no reviews field) still renders');
    assert.ok(!DASH.test(md));
  });
  await check('the top ten cap holds and rank order is by score', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, wallet: W1, targetId: 1, ligandId: (i % 2) + 1, scoreMilli: -100 * (i + 1), epoch: 0, time: null, block: i, tx: null, pose: null }));
    const cat2 = catalog.assembleCatalog({ targets: [{ key: 'T', pdbId: '1AAA', cancers: ['lung'] }] }, { ligands: Array.from({ length: 2 }, (_, i) => ({ key: `L${i + 1}`, name: `L${i + 1}` })) }, null);
    const md = chain.renderReportMarkdown(chain.compileReport({ catalog: cat2, runs: many }));
    const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    eq(rows.length, 2, 'one pair per ligand, best run each');
    assert.ok(rows[0].includes('| -1.400 |'));
  });
}

if (group('pure: catalog assembly and filters')) {
  await check('CANCERS: twenty groups in SPEC order, head-and-neck at bit 17 with its display name', () => {
    eq(catalog.CANCERS.length, 20);
    eq(catalog.CANCERS.map((c) => c.key), ['lung', 'colorectal', 'liver', 'breast', 'stomach', 'pancreatic', 'prostate', 'esophageal', 'cervical', 'leukemia', 'lymphoma', 'brain', 'melanoma', 'ovarian', 'bladder', 'kidney', 'myeloma', 'head-and-neck', 'thyroid', 'sarcoma']);
    eq(catalog.CANCERS[17], { bit: 17, key: 'head-and-neck', name: 'Head and neck' });
    eq(catalog.cancerByKey('head and neck').bit, 17); eq(catalog.cancerByKey('Head and neck').bit, 17); eq(catalog.cancerByKey(17).key, 'head-and-neck');
    eq(catalog.cancerBitsOf(['lung', 'sarcoma', 'nonsense']), (1 << 0) | (1 << 19));
  });
  const targetsDoc = { generated: 'now', targets: [
    { key: 'EGFR', gene: 'EGFR', pdbId: '1m17', protein: 'EGFR kinase', cancers: ['lung', 'head and neck'], class: 'kinase', ligand: { ccd: 'AQ4', name: 'Erlotinib', heavyAtoms: 29 } },
    { key: 'ABL1', gene: 'ABL1', pdbId: '2HYY', protein: 'ABL1 kinase', cancers: ['leukemia'], class: 'kinase', ligand: { ccd: 'STI', name: 'Imatinib' } },
  ] };
  const ligandsDoc = { ligands: [
    { key: 'QUERCETIN', name: 'Quercetin', plant: 'onion, apple', latin: 'Allium cepa', class: 'flavonol', heavyAtoms: 22, rotatableBonds: 1, file: 'data/ligands/QUERCETIN.sdf' },
    { key: 'CURCUMIN', name: 'Curcumin', plant: 'turmeric', class: 'curcuminoid', heavyAtoms: 27, rotatableBonds: 8 },
  ] };
  await check('without a registry: ids are catalog order, 1-based; paths, bits and keys derived', () => {
    const c = catalog.assembleCatalog(targetsDoc, ligandsDoc, null);
    eq(c.registry, false);
    eq(c.targets.map((t) => [t.id, t.key, t.pdbId, t.pocket, t.cancerBits, t.cancerKeys]), [[1, 'EGFR', '1M17', 'data/pockets/1M17.bin', 1 | (1 << 17), ['lung', 'head-and-neck']], [2, 'ABL1', '2HYY', 'data/pockets/2HYY.bin', 1 << 9, ['leukemia']]]);
    eq(c.ligands.map((l) => [l.id, l.key, l.topology, l.file, l.atoms, l.nrot]), [[1, 'QUERCETIN', 'data/topologies/QUERCETIN.bin', 'data/ligands/QUERCETIN.sdf', 22, 1], [2, 'CURCUMIN', 'data/topologies/CURCUMIN.bin', 'data/ligands/CURCUMIN.sdf', 27, 8]]);
    eq(c.targetById.get(2).key, 'ABL1'); eq(c.ligandByKey.get('CURCUMIN').id, 2); eq(c.targetByPdb.get('1M17').id, 1);
    eq(catalog.cancersOf(c.targets[0]).map((x) => x.name), ['Lung', 'Head and neck']);
    eq(catalog.cancersOf({ cancerBits: 1 << 9 }).map((x) => x.key), ['leukemia']);
    eq(catalog.targetsForCancer('leukemia', c.targets).map((t) => t.key), ['ABL1']);
  });
  await check('with a registry: ids, hashes, atoms and boxes come from it; catalog entries it lacks are listed', () => {
    const reg = { targets: [{ id: 7, key: 'ABL1', pdbId: '2HYY', pocket: 'data/pockets/2HYY.bin', hash: '0xab', atoms: 796, box: { half: [1018, 600, 626] } }], ligands: [{ id: 3, key: 'CURCUMIN', topology: 'data/topologies/CURCUMIN.bin', hash: '0xcd', atoms: 27, nrot: 8 }, { id: 1, key: 'QUERCETIN', topology: 'data/topologies/QUERCETIN.bin', hash: '0xef', atoms: 22, nrot: 1 }] };
    const c = catalog.assembleCatalog(targetsDoc, ligandsDoc, reg);
    eq(c.registry, true);
    eq(c.targets.map((t) => [t.id, t.key, t.hash, t.atoms, t.protein]), [[7, 'ABL1', '0xab', 796, 'ABL1 kinase']]);
    eq(c.targets[0].box.half, [1018, 600, 626]);
    eq(c.ligands.map((l) => [l.id, l.key, l.hash]), [[1, 'QUERCETIN', '0xef'], [3, 'CURCUMIN', '0xcd']]);
    eq(c.unregistered, { targets: ['EGFR'], ligands: [] });
    eq(c.ligands[1].plant, 'turmeric');
  });
  await check('filters: text over several fields, cancer by key or name, class, plant', () => {
    const c = catalog.assembleCatalog(targetsDoc, ligandsDoc, null);
    eq(catalog.filterTargets(c.targets, { q: 'erlotinib' }).map((t) => t.key), ['EGFR']);
    eq(catalog.filterTargets(c.targets, { q: '2hyy' }).map((t) => t.key), ['ABL1']);
    eq(catalog.filterTargets(c.targets, { q: 'kinase egfr' }).map((t) => t.key), ['EGFR']);
    eq(catalog.filterTargets(c.targets, { cancer: 'Head and neck' }).map((t) => t.key), ['EGFR']);
    eq(catalog.filterTargets(c.targets, { cls: 'kinase' }).length, 2);
    eq(catalog.filterTargets(c.targets, { q: 'nothing here' }).length, 0);
    eq(catalog.filterLigands(c.ligands, { q: 'apple' }).map((l) => l.key), ['QUERCETIN']);
    eq(catalog.filterLigands(c.ligands, { plant: 'turmeric' }).map((l) => l.key), ['CURCUMIN']);
    eq(catalog.filterLigands(c.ligands, { cls: 'flavonol' }).map((l) => l.key), ['QUERCETIN']);
    eq(catalog.classesOf(c.targets), [{ key: 'kinase', count: 2 }]);
    eq(catalog.plantsOf(c.ligands), [{ key: 'apple', count: 1 }, { key: 'onion', count: 1 }, { key: 'turmeric', count: 1 }]);
    eq(catalog.rcsbImage('1m17'), 'https://cdn.rcsb.org/images/structures/1m17_assembly-1.jpeg');
    eq(catalog.pocketUrl('1m17'), '/data/pockets/1M17.bin'); eq(catalog.topologyUrl(c.ligands[1]), '/data/topologies/CURCUMIN.bin'); eq(catalog.ligandUrl('curcumin'), '/data/ligands/CURCUMIN.sdf');
  });
}

if (group('pure: builders, quote and the revert explainer')) {
  await check('not live: builders throw the one sentence, quote answers ok:false with it', async () => {
    eq(lab.labAddress(), LAB.address ? getAddress(LAB.address) : null);
    if (LAB.address) return skip('not-live builders', 'LAB.address is set in js/config.js');
    assert.throws(() => lab.buildSubmitRun(1, 1, POSE_A, { runFee: 1n }), /The lab opens when the contract is live\./);
    assert.throws(() => lab.buildWithdraw(), /The lab opens when the contract is live\./);
    assert.throws(() => lab.buildReview(1, 5, 'x'), /The lab opens when the contract is live\./);
    assert.throws(() => lab.buildAttachAnalysis(1, 'gpt', 'x'), /The lab opens when the contract is live\./);
    eq(await lab.quote(1, 1, POSE_A), { ok: false, reason: 'The lab opens when the contract is live.', code: null, error: null, transient: false });
    eq(await chain.labStatus().then((s) => [s.live, s.reason]), [false, 'The lab opens when the contract is live.']);
    eq(await chain.runsPage(), { runs: [], total: 0, head: null, live: false, source: 'none' });
    eq(await chain.runById(1), null);
    eq(await chain.pools(), new Map());
    eq((await chain.walletStats(W1)).live, false);
    eq((await chain.ledger()).live, false);
  });
  lab.useLab(FAKE_LAB, { deployBlock: 0 });
  await check('buildSubmitRun: selector, ids, int16[] pose, the payment flag, the method JSON and msg.value, decodable back', () => {
    const b = lab.buildSubmitRun(3, 7, POSE_A, { payWithToken: false, methodJson: METHOD_STD, runFee: RUN_FEE });
    eq(b.to, FAKE_LAB); eq(b.value, '0x5af3107a4000');
    eq(b.data.slice(0, 10), selector('submitRun(uint16,uint16,int16[],bool,string)'));
    eq(decodeAbi(['uint16', 'uint16', 'int16[]', 'bool', 'string'], '0x' + b.data.slice(10)), [3n, 7n, [...POSE_A].map(BigInt), false, METHOD_STD]);
    const t = lab.buildSubmitRun('3', '7', [...POSE_B], { payWithToken: true, methodJson: { name: 'Quick', version: 1 }, runFee: RUN_FEE });
    eq(t.value, '0x0', 'the token path sends no ETH');
    eq(decodeAbi(['uint16', 'uint16', 'int16[]', 'bool', 'string'], '0x' + t.data.slice(10)).slice(2), [[...POSE_B].map(BigInt), true, '{"name":"Quick","version":1}']);
    const v1 = lab.buildSubmitRun(3, 7, POSE_A, RUN_FEE);
    eq(v1.value, '0x5af3107a4000'); eq(decodeAbi(['uint16', 'uint16', 'int16[]', 'bool', 'string'], '0x' + v1.data.slice(10)).slice(3), [false, ''], 'the v1 call shape (bare runFee) still builds an ETH run without a method');
    eq(lab.buildSubmitRun(3, 7, POSE_A, { runFee: '0' }).value, '0x0');
    eq(decodeAbi(['uint16', 'uint16', 'int16[]', 'bool', 'string'], '0x' + lab.buildSubmitRun(3, 7, POSE_A, { methodJson: ' { "a" : 1 } ' }).data.slice(10))[4], '{"a":1}', 'method JSON is compacted');
  });
  await check('buildApprove, buildReview, buildAttachAnalysis; utf8Bytes; the byte limits', () => {
    const a = lab.buildApprove(FAKE_TOKEN, undefined, RUN_PRICE);
    eq(a.to, FAKE_TOKEN); eq(a.value, '0x0');
    eq(a.data, selector('approve(address,uint256)') + addrTopic(FAKE_LAB).slice(2) + word(RUN_PRICE).slice(2), 'spender defaults to the lab');
    eq(lab.buildApprove(FAKE_TOKEN, W2, 5n).data.slice(10, 74), addrTopic(W2).slice(2));
    const r = lab.buildReview(12, 4, ' Solid pose. ');
    eq(r.data.slice(0, 10), selector('reviewRun(uint256,uint8,string)')); eq(r.value, '0x0');
    eq(decodeAbi(['uint256', 'uint8', 'string'], '0x' + r.data.slice(10)), [12n, 4n, 'Solid pose.']);
    eq(decodeAbi(['uint256', 'uint8', 'string'], '0x' + lab.buildReview(1, 1).data.slice(10))[2], '');
    const x = lab.buildAttachAnalysis(12, 'claude-fable', 'The note.');
    eq(x.data.slice(0, 10), selector('attachAnalysis(uint256,string,string)'));
    eq(decodeAbi(['uint256', 'string', 'string'], '0x' + x.data.slice(10)), [12n, 'claude-fable', 'The note.']);
    eq(lab.utf8Bytes('abc'), 3); eq(lab.utf8Bytes('é'), 2); eq(lab.utf8Bytes('\u{1F9EA}'), 4);
    eq([lab.NOTE_MAX_BYTES, lab.METHOD_MAX_BYTES, lab.ANALYSIS_MAX_BYTES], [280, 1024, 2048]);
    assert.doesNotThrow(() => lab.buildReview(1, 5, 'x'.repeat(280)));
    assert.throws(() => lab.buildReview(1, 5, 'x'.repeat(281)), /longer than 280 bytes/);
    assert.throws(() => lab.buildReview(1, 5, 'é'.repeat(141)), /longer than 280 bytes/, 'bytes, not characters');
    assert.throws(() => lab.buildAttachAnalysis(1, 'gpt', 'x'.repeat(2049)), /longer than 2,048 bytes/);
    assert.throws(() => lab.buildSubmitRun(1, 1, POSE_A, { methodJson: JSON.stringify({ pad: 'x'.repeat(1030) }) }), /longer than 1,024 bytes/);
  });
  await check('builders refuse bad input with the copy deck sentences', () => {
    assert.throws(() => lab.buildSubmitRun(0, 1, POSE_A, { runFee: 1n }), /Unknown target id\./);
    assert.throws(() => lab.buildSubmitRun(1, 70000, POSE_A, { runFee: 1n }), /Unknown ligand id\./);
    assert.throws(() => lab.buildSubmitRun(1, 1, [1, 2], { runFee: 1n }), /three coordinates per atom/);
    assert.throws(() => lab.buildSubmitRun(1, 1, [1, 2, 40000], { runFee: 1n }), /int16/);
    assert.throws(() => lab.buildSubmitRun(1, 1, [], { runFee: 1n }), /empty|three coordinates/);
    assert.throws(() => lab.buildSubmitRun(1, 1, POSE_A, { methodJson: '{not json' }), /not valid JSON/);
    assert.throws(() => lab.buildSubmitRun(1, 1, POSE_A, { methodJson: '[1,2]' }), /must be a JSON object/);
    assert.throws(() => lab.buildFund(1, 0n), /Amount must be greater than zero\./);
    assert.throws(() => lab.buildFund(1, 'abc'), /Amount must be greater than zero\./);
    assert.throws(() => lab.buildSettle(1, -1), /epoch/);
    assert.throws(() => lab.buildReview(1, 0, 'x'), /Stars must be between 1 and 5\./);
    assert.throws(() => lab.buildReview(1, 6, 'x'), /Stars must be between 1 and 5\./);
    assert.throws(() => lab.buildReview(0, 3, 'x'), /Unknown run id\./);
    assert.throws(() => lab.buildAttachAnalysis(1, '', 'x'), /Choose a provider\./);
    assert.throws(() => lab.buildAttachAnalysis(1, 'gpt', '   '), /no analysis text/);
    assert.throws(() => lab.buildApprove('nope', FAKE_LAB, 1n), /token address is not set/);
  });
  await check('buildFund / buildSettle / buildWithdraw', () => {
    const f = lab.buildFund(5, 10n ** 16n);
    eq(f.data, selector('fund(uint16)') + word(5).slice(2)); eq(f.value, toHex(10n ** 16n));
    const s = lab.buildSettle(5, 12);
    eq(s.data, selector('settle(uint16,uint32)') + word(5).slice(2) + word(12).slice(2)); eq(s.value, '0x0');
    eq(lab.buildWithdraw(), { to: FAKE_LAB, data: selector('withdraw()'), value: '0x0' });
  });
  await check('POSE_REASONS: six codes, labels and sentences', () => {
    eq(lab.POSE_REASONS.map((r) => r.name), ['OK', 'ATOM_COUNT', 'BOX', 'BOND', 'PAIR13', 'CLASH']);
    eq(lab.labelForReason(2), 'box'); eq(lab.labelForReason(5), 'clash'); eq(lab.labelForReason(9), 'unknown check');
    eq(lab.sentenceForReason(4), 'A 1-3 pair is not at its ideal distance.');
  });
  const errData = (sig, types = [], vals = []) => selector(sig) + encodeAbi(types, vals).slice(2);
  await check('decodeRevert: custom errors, alternates, Error(string), Panic, unknown', () => {
    eq(lab.decodeRevert(errData('BadPose(uint8)', ['uint8'], [3])), { selector: selector('BadPose(uint8)'), name: 'BadPose', args: [3n], message: null });
    eq(lab.decodeRevert(errData('WrongFee()')).name, 'WrongFee');
    eq(lab.decodeRevert(errData('WrongFee(uint256,uint256)', ['uint256', 'uint256'], [1, 2])).name, 'WrongFee');
    eq(lab.decodeRevert(errData('PaymentRefused()')).name, 'PaymentRefused');
    eq(lab.decodeRevert(errData('NotAuthor()')).name, 'NotAuthor'); eq(lab.decodeRevert(errData('BadStars()')).name, 'BadStars'); eq(lab.decodeRevert(errData('SelfReview()')).name, 'SelfReview');
    eq(lab.decodeRevert(errData('NoteTooLong()')).name, 'NoteTooLong'); eq(lab.decodeRevert(errData('MethodTooLong()')).name, 'MethodTooLong'); eq(lab.decodeRevert(errData('AnalysisTooLong()')).name, 'AnalysisTooLong');
    eq(lab.decodeRevert(errData('NotEnded()')).name, 'NotEnded');
    eq(lab.decodeRevert(errData('NoRuns()')).name, 'NoRuns');
    eq(lab.decodeRevert(errData('TokenRequired()')).name, 'TokenRequired', 'the v1 gate still decodes');
    eq(lab.decodeRevert(errData('Error(string)', ['string'], ['nope'])).message, 'nope');
    eq(lab.decodeRevert(errData('Panic(uint256)', ['uint256'], [17])).message, 'panic 17');
    eq(lab.decodeRevert('0xdeadbeef'), { selector: '0xdeadbeef', name: null, args: [], message: null });
    eq(lab.decodeRevert('0x'), null); eq(lab.decodeRevert(null), null);
  });
  await check('sentences: plain words, context fills the fee, the countdown, the payment option and the token price', () => {
    const s = (sig, types, vals, ctx) => lab.sentenceFor(lab.decodeRevert(errData(sig, types, vals)), ctx);
    eq(s('BadPose(uint8)', ['uint8'], [2]), 'This pose fails a geometry check, so the chain would reject it. Run again. An atom lies outside the target box.');
    eq(s('WrongFee()'), 'The run fee changed. Reload the lab and try again.');
    eq(s('WrongFee()', [], [], { runFee: 10n ** 14n }), 'The run fee is 0.0001 ETH plus gas. Reload the lab and try again.');
    eq(s('PaymentRefused()'), 'That payment option is switched off right now. Reload the lab and try again.');
    eq(s('PaymentRefused()', [], [], { payWithToken: true, token: null }), 'The $PONCHEM option opens after the launch. Pay in ETH.');
    eq(s('PaymentRefused()', [], [], { payWithToken: true, token: FAKE_TOKEN }), 'Paying in $PONCHEM is switched off right now. Pay in ETH.');
    eq(s('PaymentRefused()', [], [], { payWithToken: false }), 'Paying in ETH is switched off right now. Pay in $PONCHEM.');
    eq(s('PaymentRefused(uint8)', ['uint8'], [1], { token: null }), 'The $PONCHEM option opens after the launch. Pay in ETH.');
    eq(s('TokenNotSet()'), 'The $PONCHEM option opens after the launch. Pay in ETH.');
    eq(s('NotEnded()'), 'The epoch has not ended yet.');
    eq(s('NotEnded()', [], [], { epochEnd: 1_000_000 + 3 * 3600 + 720, now: 1_000_000 }), 'The epoch has not ended yet. It ends in 3h 12m.');
    eq(s('NotEnded()', [], [], () => ({ epochEnd: 1_000_000 + 48, now: 1_000_000 })), 'The epoch has not ended yet. It ends in 48s.');
    eq(s('NoRuns()'), 'Nothing to settle: no run was recorded this epoch.');
    eq(s('NotAuthor()'), 'Only the wallet that recorded this docking test can attach an analysis.');
    eq(s('BadStars()'), 'Stars must be between 1 and 5.'); eq(s('SelfReview()'), 'You cannot review your own docking test.');
    eq(s('NoteTooLong()'), 'The review note is longer than 280 bytes. Shorten it and try again.');
    eq(s('MethodTooLong()'), 'The method JSON is longer than 1,024 bytes. Shorten it and try again.');
    eq(s('AnalysisTooLong()'), 'The analysis is longer than 2,048 bytes. Shorten it and try again.');
    eq(s('TransferFailed()'), 'The transaction failed on chain. Nothing was recorded.');
    eq(s('TransferFailed()', [], [], { payWithToken: true }), 'The $PONCHEM payment did not go through. Check the balance and the allowance, then try again.');
    eq(s('ERC20InsufficientAllowance(address,uint256,uint256)', ['address', 'uint256', 'uint256'], [W1, 0, RUN_PRICE], { runPrice: RUN_PRICE }), 'Approve the lab to spend 100 $PONCHEM first, then run the docking test again.');
    eq(s('ERC20InsufficientBalance(address,uint256,uint256)', ['address', 'uint256', 'uint256'], [W1, 0, RUN_PRICE]), 'The connected wallet does not hold enough $PONCHEM for this docking test.');
    eq(s('TokenRequired()'), 'Recording needs a minimum $PONCHEM balance in the connected wallet.');
    eq(s('NothingOwed()'), 'Nothing to claim from this wallet.');
    eq(s('NoTarget()'), 'Unknown target id.'); eq(s('NoLigand()'), 'Unknown ligand id.'); eq(s('NoRun()'), 'Unknown run id.');
    eq(s('NoValue()'), 'Amount must be greater than zero.'); eq(s('NotOwner()'), 'Only the lab owner can do that.'); eq(s('Reentered()'), 'The contract refused a re-entering call. Try again.');
    eq(s('UnknownTarget()'), 'Unknown target id.', 'an alternate spelling still explains');
    eq(s('Error(string)', ['string'], [`bad ${EM} thing`]), 'The contract refused: bad - thing.');
    eq(lab.sentenceFor(lab.decodeRevert('0xdeadbeef')), null);
    for (const f of lab.LAB_FRAGMENTS.filter((x) => x.startsWith('error '))) {
      const frag = lab.labFragment(f.slice(6, f.indexOf('(')));
      const sentence = lab.sentenceFor(lab.decodeRevert(frag.selector + encodeAbi(frag.inputs, frag.inputs.map((t) => (t === 'address' ? W1 : 0))).slice(2)));
      assert.ok(typeof sentence === 'string' && sentence.length > 8 && !DASH.test(sentence) && !EMOJI.test(sentence), `${frag.name}: ${sentence}`);
    }
    for (const [name, sentence] of Object.entries(lab.ERROR_SENTENCES)) assert.ok(!DASH.test(sentence) && !/0x[0-9a-fA-F]{40}/.test(sentence), name);
  });
  await check('revertDataOf finds the data however it is wrapped; explainRevert and the registration', () => {
    const data = errData('NoRuns()');
    eq(lab.revertDataOf({ data }), data);
    eq(lab.revertDataOf({ message: 'execution reverted', data: { originalError: { data } } }), data);
    eq(lab.revertDataOf({ cause: { error: { data } } }), data);
    eq(lab.revertDataOf({ message: `execution reverted: ${data}` }), data);
    eq(lab.revertDataOf({ message: 'nothing' }), null);
    eq(lab.explainRevert({ data }), 'Nothing to settle: no run was recorded this epoch.');
    eq(lab.explainRevert({ data: '0x' }), null);
    const off = lab.registerRevertExplainer({ runFee: 10n ** 14n, runPrice: RUN_PRICE, payWithToken: true, token: null });
    assert.equal(typeof off, 'function');
    off();
  });
}

if (group('pure: js/gamify.js on synthetic ledgers')) {
  const run = (id, wallet, targetId, scoreMilli, block = id * 10) => ({ id, wallet, targetId, ligandId: 1, scoreMilli, epoch: 0, block, logIndex: 0 });
  await check('LEVELS, XP and BADGES are the SPEC 9.5 tables; icons are 24 px path data', () => {
    eq(gamify.LEVELS.map((l) => [l.name, l.min]), [['Observer', 0], ['Assistant', 50], ['Researcher', 150], ['Senior Researcher', 400], ['Principal Investigator', 900], ['Lab Head', 2000]]);
    eq(gamify.XP, { test: 10, target: 5, best: 15, review: 3, goodReview: 5, epoch: 25, sponsor: 5 });
    eq(gamify.BADGES.map((b) => b.id), ['first-test', 'ten-tests', 'fifty-tests', 'ten-targets', 'strong-binder', 'best-on-target', 'epoch-winner', 'sponsor', 'reviewer', 'well-reviewed']);
    for (const b of gamify.BADGES) {
      assert.ok(/^M[\d.\s,a-zA-Z-]+$/.test(b.path) && b.path.length > 20, `${b.id} path`);
      assert.ok(!DASH.test(b.name) && !DASH.test(b.rule) && !EMOJI.test(b.name) && /\.$/.test(b.rule), `${b.id} copy`);
      for (const n of b.path.match(/-?\d+(\.\d+)?/g)) assert.ok(Number(n) >= -24 && Number(n) <= 24, `${b.id} stays on the 24 px grid: ${n}`);
    }
    for (const r of gamify.XP_RULES) assert.ok(!DASH.test(r.sentence) && /\.$/.test(r.sentence));
    eq([0, 49, 50, 149, 150, 399, 400, 899, 900, 1999, 2000, 99999].map((x) => gamify.levelFor(x).index), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
  await check('XP arithmetic: every rule counted once, first-time rules once per target', () => {
    const ledger = {
      runs: [run(1, W1, 1, -5000), run(2, W2, 1, -7000), run(3, W1, 1, -6000), run(4, W1, 2, -9100), run(5, W1, 1, -7000)],
      settled: [{ targetId: 2, epoch: 0, winner: W1, runId: 4, amount: 1n, block: 100, logIndex: 0 }, { targetId: 1, epoch: 0, winner: W2, runId: 2, amount: 1n, block: 101, logIndex: 0 }],
      funded: [{ targetId: 1, from: W1, amount: 1n, block: 5, logIndex: 0 }, { targetId: 1, from: W1, amount: 2n, block: 6, logIndex: 0 }, { targetId: 3, from: W1, amount: 1n, block: 7, logIndex: 0 }],
      reviews: [
        { runId: 2, reviewer: W1, stars: 5, block: 25, logIndex: 0 },
        { runId: 1, reviewer: W2, stars: 4, block: 26, logIndex: 0 },
        { runId: 1, reviewer: W3, stars: 3, block: 27, logIndex: 0 },
        { runId: 3, reviewer: W2, stars: 2, block: 28, logIndex: 0 },
        { runId: 3, reviewer: W2, stars: 5, block: 29, logIndex: 0 },
      ],
    };
    const p = gamify.computeProfile(W1, ledger);
    // tests 4 (40), targets 2 (10), bests: run 1 first on target 1, run 4 first on target 2; run 3 (-6000) not lower than -7000; run 5 ties, keeps the earlier (30)
    // reviews written 1 (3), good reviews received: run 1 by W2 (4) yes, W3 (3) no, run 3 by W2 latest 5 yes = 2 (10), epochs won 1 (25), sponsored targets 2 (10)
    eq(p.counts, { tests: 4, targets: 2, bests: 2, strongBinders: 1, reviewsWritten: 1, reviewsReceived: 3, goodReviewsReceived: 2, epochsWon: 1, sponsoredTargets: 2, best: -9100 });
    eq(p.xp, 40 + 10 + 30 + 3 + 10 + 25 + 10);
    eq([p.level, p.title, p.levelMin, p.next], [1, 'Assistant', 50, { index: 2, title: 'Researcher', min: 150, remaining: 22 }]);
    eq(Math.round(p.progress * 100), 78);
    eq(p.breakdown.map((b) => [b.id, b.count, b.xp]), [['test', 4, 40], ['target', 2, 10], ['best', 2, 30], ['review', 1, 3], ['goodReview', 2, 10], ['epoch', 1, 25], ['sponsor', 2, 10]]);
    const w2 = gamify.computeProfile(W2.toLowerCase(), ledger);
    eq([w2.xp, w2.counts.reviewsWritten, w2.counts.goodReviewsReceived, w2.counts.epochsWon], [10 + 5 + 15 + 6 + 5 + 25, 2, 1, 1], 'lower case address matches; the replaced review counts once');
    eq(gamify.computeProfile(W3, { runs: [], settled: [], funded: [], reviews: [] }).xp, 0);
    eq(gamify.computeProfile(W3, {}).title, 'Observer');
  });
  await check('every badge rule, earned at the event that made it true', () => {
    const none = gamify.computeProfile(W1, { runs: [], settled: [], funded: [], reviews: [] });
    eq(none.badges.map((b) => b.earned), Array(10).fill(false));
    eq(none.badges.map((b) => b.at), Array(10).fill(null));
    const runs = Array.from({ length: 50 }, (_, i) => run(i + 1, W1, (i % 12) + 1, -5000 - (i === 20 ? 4500 : 0)));
    const ledger = {
      runs,
      settled: [{ targetId: 1, epoch: 0, winner: W1, runId: 1, amount: 1n, block: 900, logIndex: 0 }],
      funded: [{ targetId: 4, from: W1, amount: 1n, block: 3, logIndex: 0 }],
      reviews: [
        ...[W2, W3, FAKE_LAB].map((r, i) => ({ runId: 2, reviewer: r, stars: 4 + (i % 2), block: 700 + i, logIndex: 0 })),
        ...Array.from({ length: 5 }, (_, i) => ({ runId: 60, reviewer: W1, stars: 3, block: 800 + i, logIndex: 0 })).map((v, i) => ({ ...v, runId: 60 + i })),
      ],
    };
    const p = gamify.computeProfile(W1, ledger);
    const by = Object.fromEntries(p.badges.map((b) => [b.id, b]));
    eq(p.badges.map((b) => b.earned), Array(10).fill(true));
    eq(by['first-test'].at, { block: 10, runId: 1, tx: null });
    eq(by['ten-tests'].at.runId, 10); eq(by['fifty-tests'].at.runId, 50);
    eq(by['ten-targets'].at.runId, 10, 'targets 1..12 in order: the tenth distinct target arrives with run 10');
    eq(by['strong-binder'].at.runId, 21);
    eq(by['best-on-target'].at.runId, 1);
    eq(by['epoch-winner'].at, { block: 900, runId: 1, tx: null });
    eq(by['sponsor'].at, { block: 3, runId: null, tx: null });
    eq(by['reviewer'].at.block, 804, 'the fifth review');
    eq(by['well-reviewed'].at.block, 702, 'the third review made the average 4.33 over 3 reviews');
    // not quite: only two reviews, or three averaging under 4
    const two = gamify.computeProfile(W1, { ...ledger, reviews: ledger.reviews.slice(0, 2) });
    eq([two.badges.find((b) => b.id === 'well-reviewed').earned, two.badges.find((b) => b.id === 'reviewer').earned], [false, false]);
    const low = gamify.computeProfile(W1, { ...ledger, reviews: ledger.reviews.slice(0, 3).map((v) => ({ ...v, stars: 3 })) });
    eq(low.badges.find((b) => b.id === 'well-reviewed').earned, false);
    const nine = gamify.computeProfile(W1, { runs: runs.slice(0, 9), settled: [], funded: [], reviews: [] });
    eq(nine.badges.filter((b) => b.earned).map((b) => b.id), ['first-test', 'best-on-target']);
    const weak = gamify.computeProfile(W1, { runs: [run(1, W1, 1, -8999)], settled: [], funded: [], reviews: [] });
    eq(weak.badges.find((b) => b.id === 'strong-binder').earned, false, '-8.999 is not at or below -9');
    eq(gamify.computeProfile(W1, { runs: [run(1, W1, 1, -9000)], settled: [], funded: [], reviews: [] }).badges.find((b) => b.id === 'strong-binder').earned, true);
    const second = gamify.computeProfile(W2, { runs: [run(1, W1, 1, -7000), run(2, W2, 1, -6000), run(3, W2, 1, -7000)], settled: [], funded: [], reviews: [] });
    eq(second.badges.find((b) => b.id === 'best-on-target').earned, false, 'a tie does not take the best; ties keep the earlier run');
  });
  await check('rankWallets: every wallet the ledger names, by xp then tests then best dG, ranks 1-based', () => {
    const ledger = {
      runs: [run(1, W1, 1, -5000), run(2, W2, 2, -8000), run(3, W3, 3, -8000)],
      settled: [],
      funded: [{ targetId: 1, from: FAKE_LAB, amount: 1n, block: 2, logIndex: 0 }],
      reviews: [{ runId: 1, reviewer: W2, stars: 5, block: 20, logIndex: 0 }],
    };
    const rows = gamify.rankWallets(ledger);
    // W1: a test, a target, the best, a five star review received = 35; W2: 30 plus a review written = 33; W3: 30; the sponsor: 5
    eq(rows.map((r) => [r.rank, r.address, r.xp, r.tests, r.best]), [[1, W1, 35, 1, -5000], [2, W2, 33, 1, -8000], [3, W3, 30, 1, -8000], [4, FAKE_LAB, 5, 0, null]]);
    eq(rows[0].badges, 2); eq(rows[3].title, 'Observer'); eq(rows[3].level, 0);
    const tie = gamify.rankWallets({ runs: [run(1, W1, 1, -5000), run(2, W2, 2, -8000)], settled: [], funded: [], reviews: [] });
    eq(tie.map((r) => r.address), [W2, W1], 'equal xp and tests: the lower dG ranks first');
    eq(gamify.rankWallets({}), []);
  });
}

// ---------------------------------------------------------------------------------------------------------
// 2. the fake chain, in process

class FakeChain {
  constructor() {
    this.head = 120;
    this.runs = RUNS.map((r) => ({ ...r }));
    this.funded = FUNDS.map((f) => ({ ...f }));
    this.settled = SETTLED.map((s) => ({ ...s }));
    this.rolled = [{ targetId: 2, epoch: 2, pool: 0n, block: 9 }];
    this.reviews = REVIEWS.map((v) => ({ ...v }));
    this.analyses = ANALYSES.map((a) => ({ ...a }));
    this.pools = new Map([[1, 3n * 10n ** 16n], [2, 5n * 10n ** 15n], [3, 0n]]);
    this.owed = new Map([[W1, 7n * 10n ** 15n]]);
    this.targetCount = 3; this.ligandCount = 2; this.runFee = RUN_FEE; this.runPrice = RUN_PRICE; this.feeBps = 500; this.genesis = 1_700_000_000; this.epochLength = 604800; this.epoch = 4;
    this.token = '0x0000000000000000000000000000000000000000'; this.ethAllowed = true; this.tokenAllowed = false;
    this.maxSpan = Infinity; // eth_getLogs spans above this are refused like a public node does
    this.calls = []; // every method seen
    this.getLogsSpans = [];
    this.views = new Map(lab.LAB_FRAGMENTS.filter((f) => f.startsWith('function ')).map((f) => { const p = lab.labFragment(f.slice(9, f.indexOf('('))); return [p.selector, p]; }));
    this.multicall = selector('aggregate3((address,bool,bytes)[])');
  }
  logs() {
    return [
      ...this.runs.map((r) => runLog(r)),
      ...this.runs.map((r) => paidLog(r)),
      ...this.runs.map((r) => methodLog(r)),
      ...this.reviews.map((v, i) => reviewedLog(v, i)),
      ...this.analyses.map((a, i) => analysisLog(a, i)),
      ...this.funded.map((f, i) => fundedLog(f, i)),
      ...this.settled.map((s, i) => settledLog(s, i)),
      ...this.rolled.map((s, i) => rolledLog(s, i)),
    ];
  }
  best(list) { return list.reduce((b, r) => (!b || r.scoreMilli < b.scoreMilli || (r.scoreMilli === b.scoreMilli && r.id < b.id) ? r : b), null); }
  resolvedReviews() {
    const m = new Map();
    for (const v of this.reviews) m.set(`${v.runId}:${v.reviewer}`, v);
    return [...m.values()];
  }
  view(frag, args) {
    const runOf = (id) => this.runs.find((r) => r.id === Number(id));
    switch (frag.name) {
      case 'targetCount': return [this.targetCount];
      case 'ligandCount': return [this.ligandCount];
      case 'runCount': return [this.runs.length];
      case 'currentEpoch': return [this.epoch];
      case 'epochStart': return [this.genesis + Number(args[0]) * this.epochLength];
      case 'epochLength': return [this.epochLength];
      case 'genesis': return [this.genesis];
      case 'runFee': return [this.runFee];
      case 'runPrice': return [this.runPrice];
      case 'feeBps': return [this.feeBps];
      case 'token': return [this.token];
      case 'ethAllowed': return [this.ethAllowed];
      case 'tokenAllowed': return [this.tokenAllowed];
      case 'run': { const r = runOf(args[0]); if (!r) throw { data: selector('NoRun()') }; return [r.wallet, r.targetId, r.ligandId, r.scoreMilli, r.epoch, r.time, keccak256(chain.poseToHex(r.pose)), methodHashOf(r.method)]; }
      case 'bestOf': { const b = this.best(this.runs.filter((r) => r.targetId === Number(args[0]))); return [b ? b.id : 0]; }
      case 'bestOfEpoch': { const b = this.best(this.runs.filter((r) => r.targetId === Number(args[0]) && r.epoch === Number(args[1]))); return [b ? b.id : 0]; }
      case 'bestPair': { const b = this.best(this.runs.filter((r) => r.targetId === Number(args[0]) && r.ligandId === Number(args[1]))); return [b ? b.id : 0]; }
      case 'pool': { const t = Number(args[0]); if (t < 1 || t > this.targetCount) throw { data: selector('NoTarget()') }; return [this.pools.get(t) || 0n]; }
      case 'owed': return [this.owed.get(getAddress(args[0])) || 0n];
      case 'stats': {
        const who = getAddress(args[0]);
        const mine = this.runs.filter((r) => r.wallet === who); const b = this.best(mine);
        const rv = this.resolvedReviews();
        const received = rv.filter((v) => { const r = runOf(v.runId); return r && r.wallet === who; });
        return [mine.length, b ? b.scoreMilli : 0, this.settled.filter((s) => s.winner === who).reduce((a, s) => a + s.amount, 0n), rv.filter((v) => v.reviewer === who).length, received.length, received.reduce((a, v) => a + v.stars, 0)];
      }
      case 'reviewStats': { const rv = this.resolvedReviews().filter((v) => v.runId === Number(args[0])); return [rv.length, rv.reduce((a, v) => a + v.stars, 0)]; }
      case 'reviewOf': { const v = this.resolvedReviews().find((x) => x.runId === Number(args[0]) && x.reviewer === getAddress(args[1])); return v ? [v.stars, this.genesis + v.block * 12] : [0, 0]; }
      case 'quote': {
        const pose = args[2];
        if (pose.length !== 9) throw { data: selector('BadPose(uint8)') + word(1).slice(2) };
        if (pose.some((v) => v > 1200n || v < -1200n)) throw { data: selector('BadPose(uint8)') + word(2).slice(2) };
        return [-5483];
      }
      default: throw { data: '0x' };
    }
  }
  call(to, data) {
    if (to.toLowerCase() === MULTICALL3.toLowerCase() && data.startsWith(this.multicall)) {
      const [calls] = decodeAbi(['(address,bool,bytes)[]'], '0x' + data.slice(10));
      const rows = calls.map(([target, , callData]) => {
        try { return [true, this.call(target, callData)]; } catch (e) { return [false, e.data || '0x']; }
      });
      return encodeAbi(['(bool,bytes)[]'], [rows]);
    }
    if (to.toLowerCase() !== FAKE_LAB.toLowerCase()) return '0x';
    const frag = this.views.get(data.slice(0, 10));
    if (!frag) throw { data: '0x' };
    const args = decodeAbi(frag.inputs, '0x' + data.slice(10));
    return encodeAbi(frag.outputs, this.view(frag, args));
  }
  handle(req) {
    this.calls.push(req.method);
    const ok = (result) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (code, message, data) => ({ jsonrpc: '2.0', id: req.id, error: data ? { code, message, data } : { code, message } });
    const p = req.params || [];
    switch (req.method) {
      case 'eth_chainId': return ok(CHAIN.hex);
      case 'eth_blockNumber': return ok(toHex(this.head));
      case 'eth_getBlockByNumber': { const n = Number(BigInt(p[0])); return ok(n > this.head ? null : { number: toHex(n), timestamp: toHex(this.genesis + n * 12), hash: keccak256(`b${n}`) }); }
      case 'eth_getLogs': {
        const f = p[0];
        const from = Number(BigInt(f.fromBlock)); const to = f.toBlock === 'latest' ? this.head : Number(BigInt(f.toBlock));
        this.getLogsSpans.push([from, to]);
        if (to - from + 1 > this.maxSpan) return err(-32005, 'query returned more than 10000 results');
        if (f.address && String(f.address).toLowerCase() !== FAKE_LAB.toLowerCase()) return ok([]);
        const topics = f.topics || [];
        const match = (log) => topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(log.topics[i]) : String(t).toLowerCase() === log.topics[i]));
        const hits = this.logs().filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to && match(l); });
        return ok(hits.sort((a, b) => (Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber))) || (Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)))));
      }
      case 'eth_call': {
        try { return ok(this.call(p[0].to, p[0].data)); } catch (e) { return err(3, 'execution reverted', e.data); }
      }
      default: return err(-32601, `method not found: ${req.method}`);
    }
  }
}

let fake = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === FAKE_RPC && fake) {
    const body = JSON.parse(init.body);
    const answer = Array.isArray(body) ? body.map((r) => fake.handle(r)) : fake.handle(body);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

if (group('fake chain: js/chain.js live paths')) {
  fake = new FakeChain();
  configure({ rpc: FAKE_RPC, base: BASE, timeoutMs: 5000 });
  lab.useLab(FAKE_LAB, { deployBlock: 0 });
  chain.setRunsSource('logs');
  chain.invalidate();
  await check('labStatus reads every view in one multicall, the payment fields, and sums the pools; no treasury', async () => {
    const s = await chain.labStatus({ fresh: true });
    eq([s.live, s.reason, s.epoch, s.epochLength, s.genesis, s.runFee, s.runPrice, s.feeBps, s.token, s.ethAllowed, s.tokenAllowed, s.tokenOpen, s.minHold, s.runCount, s.targetCount, s.ligandCount, s.head, s.poolsOk], [true, null, 4, 604800, 1_700_000_000, RUN_FEE, RUN_PRICE, 500, null, true, false, false, 0n, 5, 3, 2, 120, true]);
    eq(s.epochStart, 1_700_000_000 + 4 * 604800); eq(s.epochEnd, s.epochStart + 604800);
    eq(s.poolTotal, 35n * 10n ** 15n);
    assert.ok(!('treasury' in s));
    fake.token = FAKE_TOKEN; fake.tokenAllowed = true;
    const t = await chain.labStatus({ fresh: true });
    eq([t.token, t.tokenAllowed, t.tokenOpen], [FAKE_TOKEN, true, true]);
    fake.token = '0x0000000000000000000000000000000000000000'; fake.tokenAllowed = false;
    chain.invalidate();
  });
  await check('runsPage through eth_getLogs: filters, paging, times and method hashes from run(id), pose, payment and reviews kept', async () => {
    const p = await chain.runsPage({ limit: 2 });
    eq(p.source, 'logs'); eq(p.total, 5); eq(p.head, 120); eq(p.runs.map((r) => r.id), [5, 4]);
    eq(p.runs[0].time, 1_700_000_500); eq(p.runs[0].tx, txHash(5)); eq(p.runs[0].block, 50);
    eq([p.runs[0].methodHash, p.runs[1].methodHash], [null, methodHashOf(METHOD_STD)], 'an empty method has no hash');
    eq(p.runs[1].payment, { method: 'eth', code: 0, amount: RUN_FEE });
    eq([...(await chain.runs({ target: 1, ligand: 2, order: 'asc' })).map((r) => r.id)], [1, 2]);
    const r2 = (await chain.runs({ wallet: W2, order: 'asc' }))[0];
    eq([r2.id, r2.payment, r2.reviews], [2, { method: 'token', code: 1, amount: RUN_PRICE }, { count: 2, starSum: 9, average: 4.5 }]);
    eq([...(await chain.runs({ target: 2 }))[0].pose], [...POSE_B]);
  });
  await check('runById, reviewsOf (latest per reviewer, newest first), reviewStats, analysesOf (block order), testsOf', async () => {
    const r3 = await chain.runById(3);
    eq([r3.id, r3.method, r3.methodHash, r3.analysisAttached, r3.analysis.provider, r3.analysis.text], [3, METHOD_REPRO, methodHashOf(METHOD_REPRO), true, 'claude-fable', ANALYSES[1].text]);
    eq(r3.reviewList.map((v) => [v.reviewer, v.stars, v.note]), [[W2, 2, REVIEWS[3].note]]);
    eq(await chain.runById(99), null); eq(await chain.runById('x'), null);
    eq((await chain.reviewsOf(2)).map((v) => [v.reviewer, v.stars, v.block]), [[W3, 4, 23], [W1, 5, 21]]);
    eq(await chain.reviewStats(2), { count: 2, starSum: 9, average: 4.5 });
    eq(await chain.reviewStats(1), { count: 0, starSum: 0, average: null });
    eq((await chain.analysesOf(3)).map((a) => a.provider), ['gpt', 'claude-fable']);
    eq(await chain.analysesOf(1), []);
    eq((await chain.testsOf(W1)).map((r) => r.id), [3, 1]);
  });
  await check('the index syncs incrementally: a new run with its payment and method arrives, only the new span is asked for', async () => {
    const idx = chain.localIndex();
    eq(idx.runs.length, 5); eq(idx.funded.length, 3); eq(idx.settled.length, 1); eq(idx.rolled.length, 1); eq(idx.reviews.size, 2); eq(idx.analyses.size, 1);
    fake.getLogsSpans = [];
    fake.runs.push({ id: 6, wallet: W3, targetId: 2, ligandId: 2, scoreMilli: -9500, epoch: 4, time: 1_700_000_600, block: 130, pose: POSE_A, method: METHOD_STD, pay: TOKEN() });
    fake.reviews.push({ runId: 6, reviewer: W1, stars: 5, note: 'Best so far.', block: 131, logIndex: 0 });
    fake.head = 140;
    await idx.sync({ force: true });
    eq(fake.getLogsSpans, [[121, 140]]);
    eq(idx.runs.map((r) => r.id), [1, 2, 3, 4, 5, 6]); eq(idx.runs[5].time, 1_700_000_600); eq(idx.head, 140);
    eq([idx.runs[5].payment.method, idx.runs[5].method, idx.runs[5].methodHash, idx.runs[5].reviews.count], ['token', METHOD_STD, methodHashOf(METHOD_STD), 1]);
    await idx.sync();
    eq(fake.getLogsSpans.length, 1, 'inside the TTL nothing is asked again');
  });
  await check('getLogsChunked halves a span the node refuses and walks the chunks', async () => {
    fake.maxSpan = 30; fake.getLogsSpans = [];
    const logs = await chain.getLogsChunked({ address: FAKE_LAB, topics: [[chain.RUN_SCORED.topic]], fromBlock: 0, toBlock: 140, chunk: 50 });
    eq(logs.length, 6);
    assert.ok(fake.getLogsSpans.length >= 6, show(fake.getLogsSpans));
    assert.ok(fake.getLogsSpans.some(([a, b]) => a === 0 && b === 49), 'the first chunk was asked whole first');
    fake.maxSpan = Infinity;
  });
  await check('allRuns and bests over the whole list (not partial)', async () => {
    chain.invalidate();
    const all = await chain.allRuns();
    eq([all.total, all.partial, all.runs.map((r) => r.id)], [6, false, [1, 2, 3, 4, 5, 6]]);
    const b = await chain.bests();
    eq(b.partial, false); eq(b.byTarget.get(1).id, 2); eq(b.byTarget.get(2).id, 6); eq(b.byLigand.get(2).id, 6); eq(b.byTargetEpoch.get('2:4').id, 6);
  });
  await check('ledger: runs without poses, settled, funded, resolved reviews, analyses; profileOf and walletRanking over it', async () => {
    const l = await chain.ledger();
    eq([l.live, l.head, l.runs.length, l.runs[0].pose, l.settled.length, l.funded.length, l.reviews.length, l.analyses.length], [true, 140, 6, null, 1, 3, 4, 2]);
    eq(l.reviews.map((v) => [v.runId, v.reviewer, v.stars]), [[2, W1, 5], [2, W3, 4], [3, W2, 2], [6, W1, 5]]);
    const p = await chain.profileOf(W1);
    // W1: tests 1 and 3 (20), targets 2 (10), both best at recording (30), reviews written 2 (6), good received 0, epoch won 1 (25), sponsored 1 (5)
    eq([p.xp, p.title, p.counts.tests, p.counts.reviewsWritten, p.counts.epochsWon, p.counts.sponsoredTargets], [96, 'Assistant', 2, 2, 1, 1]);
    const rank = await chain.walletRanking();
    // W2: tests 2 and 5 (20), targets 1 and 3 (10), both best at recording (30), a review written (3), two good reviews received (10), target 2 sponsored (5) = 78
    // W3: tests 4 and 6 (20), targets 1 and 2 (10), run 6 best (15), one review written (3), one good review received (5) = 53
    eq(rank.map((r) => [r.address, r.xp]), [[W1, 96], [W2, 78], [W3, 53]]);
  });
  await check('pools: one multicall, targets beyond targetCount dropped', async () => {
    const p = await chain.pools();
    eq([...p], [[1, 3n * 10n ** 16n], [2, 5n * 10n ** 15n], [3, 0n]]);
  });
  await check('walletStats: stats and owed views with the review counters, sponsorships from Funded logs, won epochs from Settled', async () => {
    const w = await chain.walletStats(W1);
    eq([w.runs, w.best, w.prizes, w.owed], [2, -9289, 7n * 10n ** 15n, 7n * 10n ** 15n]);
    eq(w.sponsored, [{ targetId: 1, amount: 3n * 10n ** 16n, count: 2, last: 13 }]);
    eq([w.reviewsGiven, w.reviewsReceived, w.starsReceived, w.reviewAverage, w.wonEpochs], [2, 1, 2, 2, 1]);
    eq(w.won.map((s) => [s.targetId, s.epoch, s.runId, s.amount]), [[1, 2, 1, 7n * 10n ** 15n]]);
    const w2 = await chain.walletStats(W2);
    eq([w2.runs, w2.best, w2.reviewsGiven, w2.reviewsReceived, w2.starsReceived, w2.reviewAverage, w2.wonEpochs, w2.won], [2, -6446, 1, 2, 9, 4.5, 0, []]);
    const none = await chain.walletStats('0x9999999999999999999999999999999999999999');
    eq([none.runs, none.best, none.reviewAverage], [0, null, null]);
  });
  await check('report() over the real catalog: counts, groups, most reviewed, Markdown without dashes', async () => {
    const rep = await chain.report();
    eq([rep.live, rep.runCount, rep.wallets, rep.head, rep.epoch, rep.reviewCount], [true, 6, 3, 140, 4, 4]);
    assert.ok(rep.targetCount >= 100, `${rep.targetCount} targets in the report`);
    const groups = rep.cancers.filter((c) => c.bestPairs.length);
    assert.ok(groups.length >= 1, 'targets 1..3 of the catalog belong to at least one group');
    eq(rep.mostReviewed.map((p) => p.id), [2, 6, 3], 'by review count, then by average stars');
    const md = chain.renderReportMarkdown(rep);
    assert.ok(!DASH.test(md) && md.includes('## Method') && md.includes('## Most reviewed docking tests'));
    assert.ok(md.includes('6 docking tests, 3 wallets'));
  });
  await check('quote: ok through eth_call, BadPose reverts decoded into the code and the sentence', async () => {
    eq(await lab.quote(1, 2, POSE_A, { from: W1 }), { ok: true, scoreMilli: -5483 });
    const bad = await lab.quote(1, 2, [1, 2, 3]);
    eq([bad.ok, bad.code, bad.error, bad.reason], [false, 1, 'BadPose', 'This pose fails a geometry check, so the chain would reject it. Run again. The pose does not have the ligand atom count.']);
    const box = await lab.quote(1, 2, Int16Array.from([5000, 0, 0, 0, 0, 0, 0, 0, 0]));
    eq([box.code, lab.labelForReason(box.code)], [2, 'box']);
  });
  await check('runs via the API first: a not-live answer from the server falls back to the logs', async () => {
    chain.setRunsSource('api');
    chain.invalidate();
    let p;
    try { p = await chain.runsPage({ limit: 1 }); } catch (e) { throw new Error(`runsPage: ${e.message}`); }
    eq(p.source, 'logs'); eq(p.total, 6);
    eq((await chain.runById(3)).method, METHOD_REPRO, 'runById falls back to the logs too');
    chain.setRunsSource('logs');
  });
  await check('labStatus reports the chain unreachable when the node fails, and recovers', async () => {
    const h = fake.handle.bind(fake);
    try {
      // a connection-shaped failure: the transport throws, js/rpc.js retries and gives up
      fake.handle = () => { throw new Error('socket hang up'); };
      const s = await chain.labStatus({ fresh: true });
      eq([s.live, s.reason], [false, 'Could not reach Robinhood Chain. Reads will retry.']);
      // a node that answers with an error that is not transient (no contract behind the address)
      fake.handle = (req) => ({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } });
      eq((await chain.labStatus({ fresh: true })).reason, 'The lab contract did not answer.');
    } finally {
      fake.handle = h;
    }
    eq((await chain.labStatus({ fresh: true })).live, true);
  });
  await check('onBlock polls and stops', async () => {
    const seen = [];
    const off = chain.onBlock((n) => seen.push(n), { intervalMs: 1000 });
    await new Promise((r) => setTimeout(r, 150));
    off();
    eq(seen, [140]);
  });
}

// ---------------------------------------------------------------------------------------------------------
// the fake model provider: one HTTP server that speaks the OpenAI chat shape and the Anthropic Messages shape

const FAKE_TEXT = `## Interpretation\n\nThe estimate ${EM} a moderate binder ${EM} suggests the compound fits the pocket in the 5${EN}10 uM range \u{1F9EA}.\n\n- The rigid receptor is a limit.\n- Unverified recall: quercetin has been studied against kinases \u{1F600}${EN}\n\n**Next steps** include docking with receptor flexibility.`;

async function startFakeProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
      seen.push({ url: req.url, headers: req.headers, json });
      res.setHeader('content-type', 'application/json');
      if (json.model === 'fail-500') { res.statusCode = 500; return res.end('{"error":{"message":"boom"}}'); }
      if (json.model === 'refuse') { res.statusCode = 200; return res.end(JSON.stringify({ id: 'msg_r', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' } })); }
      if (req.url === '/v1/messages') return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: FAKE_TEXT }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }));
      if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: FAKE_TEXT }, finish_reason: 'stop' }] }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const listen = (port) => new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); ok(server.address().port); }); });
  let port;
  try { port = await listen(FAKE_PROVIDER_PORT); } catch { port = await listen(0); }
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

if (group('fake chain: API handlers in process')) {
  fake = fake || new FakeChain();
  process.env.PONCHEM_RPC_URL = FAKE_RPC;
  process.env.PONCHEM_LAB = FAKE_LAB;
  process.env.PONCHEM_DEPLOY_BLOCK = '0';
  process.env.PONCHEM_SITE_URL = BASE;
  const api = await import('../api/_lab.mjs');
  const llm = await import('../api/_llm.mjs');
  const statusRoute = (await import('../api/status.js')).default;
  const runsRoute = (await import('../api/runs.js')).default;
  const reportRoute = (await import('../api/report.js')).default;
  const analyzeRoute = (await import('../api/analyze.js')).default;
  const mockRes = () => { const h = {}; return { statusCode: 200, headers: h, body: '', setHeader(k, v) { h[k.toLowerCase()] = String(v); }, getHeader(k) { return h[k.toLowerCase()]; }, end(t) { this.body = t === undefined ? '' : String(t); } }; };
  const call = async (route, url, method = 'GET', body) => { const res = mockRes(); const req = { method, url, headers: {} }; if (body !== undefined) { req.headers['content-type'] = 'application/json'; req.body = body; } await route(req, res); let json = null; try { json = JSON.parse(res.body); } catch { /* text */ } return { status: res.statusCode, headers: res.headers, body: res.body, json }; };
  await check('GET /api/status: live fields incl. payment, strings for wei, the cache header, no address, no minHold', async () => {
    const r = await call(statusRoute, '/api/status');
    eq(r.status, 200); eq(r.headers['cache-control'], 'public, s-maxage=10, stale-while-revalidate=60'); eq(r.headers['content-type'], 'application/json; charset=utf-8');
    const j = r.json;
    eq([j.ok, j.live, j.chainId, j.epoch, j.runFee, j.runFeeEth, j.runPrice, j.runPriceTokens, j.feeBps, j.token, j.ethAllowed, j.tokenAllowed, j.tokenOpen, j.runCount, j.targetCount, j.ligandCount, j.poolTotal, j.head], [true, true, 4663, 4, '100000000000000', '0.0001', String(RUN_PRICE), '100', 500, null, true, false, false, 6, 3, 2, '35000000000000000', 140]);
    assert.ok(!('minHold' in j) && !('treasury' in j));
    assert.ok(!/0x[0-9a-fA-F]{40}/.test(r.body), 'the status body carries an address');
  });
  await check('GET /api/runs: paging, filters, pose hex, payment, reviews summary, total and head', async () => {
    const r = await call(runsRoute, '/api/runs?limit=2&offset=1');
    eq(r.status, 200); eq(r.json.live, true); eq(r.json.total, 6); eq(r.json.head, 140); eq(r.json.runs.map((x) => x.id), [5, 4]);
    eq(r.json.runs[0].pose, chain.poseToHex(POSE_A)); eq(r.json.runs[0].time, 1_700_000_500); eq(r.json.runs[0].tx, txHash(5));
    eq([r.json.runs[1].payment, r.json.runs[1].methodHash, r.json.runs[1].reviews, r.json.runs[1].analysisAttached], [{ method: 'eth', code: 0, amount: String(RUN_FEE) }, methodHashOf(METHOD_STD), { count: 0, starSum: 0, average: null }, false]);
    assert.ok(!('method' in r.json.runs[1]) && !('reviewList' in r.json.runs[1]), 'the list carries no method text and no notes');
    eq((await call(runsRoute, `/api/runs?wallet=${W1.toLowerCase()}&order=asc`)).json.runs.map((x) => x.id), [1, 3]);
    const w2 = (await call(runsRoute, '/api/runs?target=1&ligand=2')).json.runs;
    eq(w2.map((x) => x.id), [2, 1]); eq(w2[0].payment, { method: 'token', code: 1, amount: String(RUN_PRICE) }); eq(w2[0].reviews, { count: 2, starSum: 9, average: 4.5 });
    eq((await call(runsRoute, '/api/runs?target=9')).json, { ok: true, live: true, runs: [], total: 0, head: 140, limit: 100, offset: 0, order: 'desc' });
  });
  await check('GET /api/runs?id=N: one run with method, reviews and analysis; 404 no-run', async () => {
    const r = await call(runsRoute, '/api/runs?id=3');
    eq(r.status, 200); eq(r.json.ok, true); eq(r.json.head, 140);
    const run = r.json.run;
    eq([run.id, run.method, run.methodHash, run.analysisAttached, run.analysis.provider, run.analysis.text, run.payment.method], [3, METHOD_REPRO, methodHashOf(METHOD_REPRO), true, 'claude-fable', ANALYSES[1].text, 'eth']);
    eq(run.reviewList.map((v) => [v.reviewer, v.stars, v.note]), [[W2, 2, REVIEWS[3].note]]);
    const back = chain.fromJsonRun(run);
    eq([back.method, back.reviewList.length, back.analysis.provider, [...back.pose]], [METHOD_REPRO, 1, 'claude-fable', [...POSE_B]]);
    const two = (await call(runsRoute, '/api/runs?id=2')).json.run;
    eq(two.reviewList.map((v) => [v.reviewer, v.stars]), [[W3, 4], [W1, 5]]); eq(two.analysis, null); eq(two.method, '');
    const missing = await call(runsRoute, '/api/runs?id=99');
    eq([missing.status, missing.json.ok, missing.json.error, missing.json.message, missing.headers['cache-control']], [404, false, 'no-run', 'Unknown run id.', 'no-store']);
    eq((await call(runsRoute, '/api/runs?id=0')).status, 400);
  });
  await check('GET /api/runs?view=ledger: the whole record without poses, wei as strings', async () => {
    const r = await call(runsRoute, '/api/runs?view=ledger');
    eq(r.status, 200); eq([r.json.ok, r.json.live, r.json.head, r.json.runs.length, r.json.settled.length, r.json.funded.length, r.json.reviews.length, r.json.analyses.length], [true, true, 140, 6, 1, 3, 4, 2]);
    eq(r.json.runs[0].pose, null); eq(r.json.settled[0].amount, String(7n * 10n ** 15n)); eq(r.json.funded[0].amount, String(10n ** 16n));
    eq(r.json.analyses.map((a) => a.provider), ['gpt', 'claude-fable']);
    assert.ok(!r.json.analyses.some((a) => 'text' in a), 'the ledger lists analyses without their text');
    const l = chain.fromJsonLedger(r.json);
    eq(gamify.computeProfile(W1, l).xp, 96);
    eq((await call(runsRoute, '/api/runs?view=nope')).status, 400);
  });
  await check('GET /api/runs: bad input answers 400 with the field, no-store', async () => {
    for (const [q, field] of [['limit=0', 'limit'], ['limit=1001', 'limit'], ['offset=-1', 'offset'], ['wallet=0x12', 'wallet'], ['target=70000', 'target'], ['ligand=x', 'ligand'], ['order=up', 'order'], ['id=x', 'id']]) {
      const r = await call(runsRoute, `/api/runs?${q}`);
      eq([r.status, r.json.ok, r.json.error, r.json.field], [400, false, 'bad-input', field], q);
      eq(r.headers['cache-control'], 'no-store');
    }
  });
  await check('GET /api/report: Markdown with rows, reviews and links; ?format=json the object; POST 405; HEAD no body', async () => {
    const md = await call(reportRoute, '/api/report');
    eq(md.status, 200); eq(md.headers['content-type'], 'text/markdown; charset=utf-8'); eq(md.headers['cache-control'], 'public, s-maxage=10, stale-while-revalidate=60');
    assert.ok(md.body.startsWith('# Ponchem cancer research report'));
    assert.ok(/\| 1 \| .* \| .* \| -9\.500 \| .* \| 1 \(5\.0\) \| .* \| \[Test #6\]\(https:\/\/ponchem\.ai\/run\?id=6\) \|/.test(md.body), `the best pair row is there: ${md.body.split('\n').find((l) => l.startsWith('| 1 |'))}`);
    assert.ok(!DASH.test(md.body));
    const j = await call(reportRoute, '/api/report?format=json');
    eq([j.json.ok, j.json.runCount, j.json.wallets, j.json.head, j.json.mostReviewed.map((p) => p.id)], [true, 6, 3, 140, [2, 6, 3]]);
    eq(typeof j.json.poolTotal, 'string');
    const post = await call(statusRoute, '/api/status', 'POST');
    eq([post.status, post.json.error], [405, 'method']);
    const head = await call(runsRoute, '/api/runs', 'HEAD');
    eq([head.status, head.body], [200, '']);
    const opt = await call(runsRoute, '/api/runs', 'OPTIONS');
    eq(opt.status, 204);
  });
  await check('GET /api/analyze lists the providers, connected false without keys, never a key; POST 409 / 400 / 404', async () => {
    const r = await call(analyzeRoute, '/api/analyze');
    eq(r.status, 200); eq(r.headers['cache-control'], 'no-store');
    eq(r.json.providers.map((p) => [p.id, p.label, p.model, p.connected]), [['claude-fable', 'Claude Fable 5.1', 'claude-fable-5-1', false], ['gpt', 'GPT', 'gpt-5', false], ['kimi', 'Kimi', 'kimi-k2', false], ['jev', 'Jev AI', 'jev', false]]);
    assert.ok(!/key|secret|token/i.test(Object.keys(r.json.providers[0]).join(',')));
    for (const id of ['claude-fable', 'gpt', 'kimi', 'jev']) {
      const p = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 1, provider: id });
      eq([p.status, p.json.ok, p.json.error, p.json.provider, p.headers['cache-control']], [409, false, 'provider not connected', id, 'no-store'], id);
    }
    eq((await call(analyzeRoute, '/api/analyze', 'POST', { runId: 1, provider: 'nope' })).json.field, 'provider');
    eq((await call(analyzeRoute, '/api/analyze', 'POST', { runId: 'x', provider: 'gpt' })).json.field, 'runId');
    eq((await call(analyzeRoute, '/api/analyze', 'POST', 'not json')).status, 400);
    process.env.JEV_API_KEY = 'fake-jev-key'; // a key without a URL is not connected
    eq((await call(analyzeRoute, '/api/analyze', 'POST', { runId: 1, provider: 'jev' })).status, 409);
    delete process.env.JEV_API_KEY;
    eq((await call(analyzeRoute, '/api/analyze', 'PUT')).status, 405);
    eq((await call(analyzeRoute, '/api/analyze', 'OPTIONS')).headers['access-control-allow-methods'], 'GET, POST, HEAD, OPTIONS');
  });
  const provider = await startFakeProvider();
  console.log(`  note  fake provider on 127.0.0.1:${provider.port}${provider.port !== FAKE_PROVIDER_PORT ? ' (8692 was busy)' : ''}`);
  try {
    process.env.JEV_API_URL = `http://127.0.0.1:${provider.port}/v1`;
    process.env.JEV_API_KEY = 'fake-jev-key';
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${provider.port}`;
    process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key';
    await check('POST /api/analyze against a fake OpenAI-shaped provider: the request, the facts in the prompt, the post-processing, the cache', async () => {
      eq((await call(analyzeRoute, '/api/analyze')).json.providers.map((p) => p.connected), [true, false, false, true]);
      const r = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 1, provider: 'jev' });
      eq([r.status, r.json.ok, r.json.provider, r.json.model, r.json.cached, r.headers['cache-control']], [200, true, 'jev', 'jev', false, 'no-store'], r.body);
      assert.ok(typeof r.json.generatedAt === 'string' && !Number.isNaN(Date.parse(r.json.generatedAt)));
      const text = r.json.text;
      assert.ok(!DASH.test(text) && !EMOJI.test(text) && !/^#/m.test(text) && !/\*\*/.test(text) && !/^- /m.test(text), text);
      assert.ok(text.startsWith('Interpretation\n\nThe estimate, a moderate binder, suggests the compound fits the pocket in the 5 to 10 uM range.'), text);
      assert.ok(text.includes('The rigid receptor is a limit.\nUnverified recall: quercetin has been studied against kinases.'), text);
      assert.ok(text.endsWith('Next steps include docking with receptor flexibility.'), text);
      const req = provider.seen[provider.seen.length - 1];
      eq(req.url, '/v1/chat/completions'); eq(req.headers.authorization, 'Bearer fake-jev-key'); eq(req.headers['content-type'], 'application/json');
      eq([req.json.model, req.json.max_tokens, req.json.messages.length, req.json.messages[0].role, req.json.messages[1].role], ['jev', 700, 2, 'system', 'user']);
      assert.ok(/no emoji, no dashes of any kind, no markdown headers/.test(req.json.messages[0].content) && /unverified recall/.test(req.json.messages[0].content) && /clinical efficacy/i.test(req.json.messages[0].content), 'the system line');
      const u = req.json.messages[1].content;
      const cat = await api.catalog();
      const t = cat.targetById.get(1); const l = cat.ligandById.get(2);
      assert.ok(u.startsWith('Facts about docking test #1 on Ponchem, recorded on Robinhood Chain at block 10'), u.slice(0, 120));
      assert.ok(u.includes(`PDB ${t.pdbId}`) && u.includes(`Ligand: ${l.name}`) && u.includes('dG -5.483 kcal/mol (weak binder)') && u.includes('pKd 4.02'), u);
      assert.ok(u.includes('Context on this target: 2 other tests by 2 other wallets, best on this target dG -6.446 kcal/mol (test #2)') && u.includes('This target and ligand pair: 2 tests, best dG -6.446 kcal/mol (test #2)'), u);
      assert.ok(u.includes(`Search method recorded with the test (JSON): ${METHOD_STD}`) && u.includes('No reviews on chain yet.'), u);
      assert.ok(/geometry proof on the server|Five terms recomputed|not recomputed/.test(u), 'the rescoring line is there');
      assert.ok(!u.includes('Clean pose') && !/0x[0-9a-fA-F]{40}/.test(u), 'no review notes and no addresses in the prompt');
      assert.ok(u.includes('label it as unverified recall'));
      const seen = provider.seen.length;
      const again = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 1, provider: 'jev' });
      eq([again.status, again.json.cached, again.json.text === text, provider.seen.length], [200, true, true, seen], 'the second call is served from the cache');
      const two = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 2, provider: 'jev' });
      eq([two.status, two.json.cached, provider.seen.length], [200, false, seen + 1]);
      const req2 = provider.seen[provider.seen.length - 1].json.messages[1].content;
      assert.ok(req2.includes('Reviews on chain: 2, average 4.5 stars.') && req2.includes('The search method was not recorded with the test.'), req2);
      assert.ok(!JSON.stringify([r.body, again.body, two.body]).includes('fake-jev-key'), 'the key never reaches the answer');
    });
    await check('POST /api/analyze against the Anthropic Messages shape: x-api-key, anthropic-version, system, one user message, text blocks', async () => {
      const r = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 3, provider: 'claude-fable' });
      eq([r.status, r.json.ok, r.json.provider, r.json.model], [200, true, 'claude-fable', 'claude-fable-5-1'], r.body);
      const req = provider.seen[provider.seen.length - 1];
      eq(req.url, '/v1/messages'); eq(req.headers['x-api-key'], 'fake-anthropic-key'); eq(req.headers['anthropic-version'], '2023-06-01'); eq(req.headers.authorization, undefined);
      eq([req.json.model, req.json.max_tokens, req.json.messages.length, req.json.messages[0].role, typeof req.json.system], ['claude-fable-5-1', 700, 1, 'user', 'string']);
      assert.ok(!('thinking' in req.json) && !('temperature' in req.json), 'no thinking parameter, no sampling parameter');
      assert.ok(req.json.messages[0].content.includes(`Search method recorded with the test (JSON): ${METHOD_REPRO}`) && req.json.messages[0].content.includes('Reviews on chain: 1, average 2.0 stars.'));
      assert.ok(r.json.text.includes('5 to 10 uM range.'));
      assert.ok(!JSON.stringify(r.body).includes('fake-anthropic-key'));
    });
    await check('provider failures are plain sentences: HTTP 500 gives 502, a refusal gives 502, nothing is cached', async () => {
      process.env.PONCHEM_MODEL_JEV = 'fail-500';
      const r = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 4, provider: 'jev' });
      eq([r.status, r.json.ok, r.json.error, r.json.message], [502, false, 'provider-failed', 'The provider did not answer.']);
      process.env.PONCHEM_MODEL_CLAUDE_FABLE = 'refuse';
      const ref = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 4, provider: 'claude-fable' });
      eq([ref.status, ref.json.error, ref.json.message], [502, 'provider-failed', 'The model declined to write this analysis.']);
      delete process.env.PONCHEM_MODEL_JEV; delete process.env.PONCHEM_MODEL_CLAUDE_FABLE;
      const ok = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 4, provider: 'jev' });
      eq([ok.status, ok.json.cached], [200, false], 'the failed answer was not cached');
      eq((await call(analyzeRoute, '/api/analyze', 'POST', { runId: 99, provider: 'jev' })).status, 404);
      assert.ok(!DASH.test(r.json.message) && !DASH.test(ref.json.message));
    });
    await check('the limiter: ten per minute per instance, then 429; the cache: ten minutes per (runId, provider)', async () => {
      llm.limiter.reset();
      for (let i = 0; i < 10; i++) assert.ok(llm.limiter.take(1_000_000 + i), `take ${i}`);
      eq(llm.limiter.take(1_000_010), false); eq(llm.limiter.size(), 10);
      eq(llm.limiter.take(1_000_000 + 60_000), true, 'a minute later a slot frees');
      llm.limiter.reset();
      for (let i = 0; i < 10; i++) llm.limiter.take();
      const busy = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 5, provider: 'jev' });
      eq([busy.status, busy.json.error, busy.json.message], [429, 'rate-limited', 'The analysis desk is busy. Try again in a minute.']);
      const cachedStill = await call(analyzeRoute, '/api/analyze', 'POST', { runId: 1, provider: 'jev' });
      eq([cachedStill.status, cachedStill.json.cached], [200, true], 'a cached answer does not need a slot');
      llm.limiter.reset();
      const k = llm.cache.key(1, 'JEV');
      eq(k, '1:jev');
      assert.ok(llm.cache.get(k, Date.now()) !== null);
      eq(llm.cache.get(k, Date.now() + 10 * 60_000 + 1), null, 'gone after ten minutes');
      llm.cache.clear();
    });
    await check('postProcess: dashes to commas or periods, ranges to "to", emoji stripped, headers and bullets dropped, whitespace settled', () => {
      eq(llm.postProcess(`a ${EM} b`), 'a, b');
      eq(llm.postProcess(`a${EM}b`), 'a, b');
      eq(llm.postProcess(`a ${EN} b ${EN}\nc`), 'a, b.\nc');
      eq(llm.postProcess(`5${EN}10 nM and 2 ${EM} 3 A`), '5 to 10 nM and 2 to 3 A');
      eq(llm.postProcess(`${EM} leading dash`), 'leading dash');
      eq(llm.postProcess('### Title\n\n1. one\n2) two\n• three\n* four'), 'Title\n\none\ntwo\nthree\nfour');
      eq(llm.postProcess('\u{1F9EA}\u{1F600} plain \u{1F44D}\u{1F3FD} text \u{1F1EB}\u{1F1F7} here'), 'plain text here');
      eq(llm.postProcess('a\r\n\r\n\r\n\r\nb   c\t'), 'a\n\nb c');
      eq(llm.postProcess(null), ''); eq(llm.postProcess(''), '');
    });
  } finally {
    await provider.close();
    for (const k of ['JEV_API_URL', 'JEV_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) delete process.env[k];
  }
  await check('the handlers answer 502 chain-unavailable when the node fails, and 200 again after', async () => {
    api.uncache();
    const h = fake.handle.bind(fake);
    try {
      fake.handle = () => { throw new Error('socket hang up'); };
      const r = await call(statusRoute, '/api/status');
      eq([r.status, r.json.ok, r.json.error, r.json.live], [502, false, 'chain-unavailable', false]);
      eq(r.headers['cache-control'], 'no-store');
      api.uncache();
      const held = await call(runsRoute, '/api/runs?limit=1');
      eq([held.status, held.json.total], [200, 6], 'inside the index TTL the held list is served');
      api.index().lastSync = 0;
      const runs = await call(runsRoute, '/api/runs?limit=1');
      eq([runs.status, runs.json.error], [502, 'chain-unavailable'], 'past the TTL, a list that cannot be brought up to the head is not served');
    } finally {
      fake.handle = h;
    }
    api.uncache();
    eq((await call(statusRoute, '/api/status')).status, 200);
  });
}

// ---------------------------------------------------------------------------------------------------------
// 3. the dev server

fake = null;
lab.useLab(null);
chain.setRunsSource('auto');
chain.invalidate();
configure({ base: BASE, timeoutMs: 8000 });

async function http_(method, p, headers = {}, body) {
  const r = await realFetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}

let serverLive = null;
if (group(`server ${BASE}: routes over HTTP`)) {
  let up = false;
  try { up = (await http_('GET', '/api/status')).status > 0; } catch { up = false; }
  if (!up) {
    skip('every server check', `nothing answers at ${BASE}: start it with PORT=6133 node tools/dev.mjs`);
  } else {
    const st = await http_('GET', '/api/status');
    serverLive = !!(st.json && st.json.live);
    console.log(`  note  the server is ${serverLive ? 'LIVE' : 'not live'}${local ? ` (${chainFile} exists: rpc ${local.rpc || '?'})` : ''}`);
    await check('GET /api/status: 200, JSON, cache header, CORS, the shape with the payment fields', async () => {
      eq(st.status, 200);
      eq(st.headers.get('content-type'), 'application/json; charset=utf-8');
      eq(st.headers.get('cache-control'), 'public, s-maxage=10, stale-while-revalidate=60');
      eq(st.headers.get('access-control-allow-origin'), '*');
      const j = st.json;
      eq(j.ok, true); eq(j.chainId, 4663);
      for (const k of ['live', 'epoch', 'epochStart', 'epochEnd', 'epochLength', 'runFee', 'runPrice', 'runPriceTokens', 'feeBps', 'token', 'ethAllowed', 'tokenAllowed', 'tokenOpen', 'runCount', 'targetCount', 'ligandCount', 'poolTotal', 'generatedAt']) assert.ok(k in j, `missing ${k}`);
      assert.ok(!('minHold' in j) && !('treasury' in j));
      if (!serverLive) eq(j.reason, 'The lab opens when the contract is live.');
      assert.ok(!/0x[0-9a-fA-F]{40}/.test(st.text), 'the status body carries an address');
    });
    await check('GET /api/runs: 200 with the shape, empty when not live; ?id= 404; ?view=ledger', async () => {
      const r = await http_('GET', '/api/runs?limit=3');
      eq(r.status, 200); eq(r.json.ok, true); assert.ok(Array.isArray(r.json.runs)); eq(r.json.limit, 3);
      if (!serverLive) eq([r.json.live, r.json.runs, r.json.total], [false, [], 0]);
      else { eq(r.json.live, true); assert.ok(r.json.total >= r.json.runs.length); for (const x of r.json.runs) { const b = chain.fromJsonRun(x); assert.ok(b && b.pose && b.reviews && 'analysisAttached' in b, 'a run without the v2 fields'); } }
      const one = await http_('GET', '/api/runs?id=999999999');
      eq([one.status, one.json.error], [404, 'no-run']);
      const l = await http_('GET', '/api/runs?view=ledger');
      eq(l.status, 200); eq(l.json.ok, true);
      for (const k of ['runs', 'settled', 'funded', 'reviews', 'analyses']) assert.ok(Array.isArray(l.json[k]), k);
      if (!serverLive) eq([l.json.live, l.json.runs], [false, []]);
    });
    await check('GET /api/runs: 400 on bad input, 405 on POST, 204 on OPTIONS, HEAD without a body', async () => {
      const bad = await http_('GET', '/api/runs?limit=0');
      eq([bad.status, bad.json.error, bad.json.field], [400, 'bad-input', 'limit']);
      eq((await http_('GET', '/api/runs?wallet=nope')).status, 400);
      eq((await http_('POST', '/api/runs')).status, 405);
      eq((await http_('OPTIONS', '/api/runs')).status, 204);
      const head = await http_('HEAD', '/api/status');
      eq([head.status, head.text], [200, '']);
    });
    await check('GET /api/report: text/markdown, the title, the method note, no dashes, no banned words; /api/report.md too', async () => {
      const r = await http_('GET', '/api/report');
      eq(r.status, 200); eq(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
      eq(r.headers.get('cache-control'), 'public, s-maxage=10, stale-while-revalidate=60');
      assert.ok(r.text.startsWith('# Ponchem cancer research report'));
      assert.ok(r.text.includes('## Method') && r.text.includes('Not clinical results.'));
      assert.ok(!DASH.test(r.text) && !BANNED.test(r.text) && !EMOJI.test(r.text));
      assert.ok(!/0x[0-9a-fA-F]{40}/.test(r.text));
      if (!serverLive) assert.ok(r.text.includes('No runs recorded yet.'));
      const j = await http_('GET', '/api/report?format=json');
      eq(j.status, 200); eq(j.json.ok, true); eq(j.json.cancers.length, 20); assert.ok(Array.isArray(j.json.mostReviewed));
      eq((await http_('GET', '/api/report.md')).status, 200);
    });
    await check('GET /api/analyze over HTTP: the providers with connected booleans and no key; POST 400 / 409; no-store', async () => {
      const r = await http_('GET', '/api/analyze');
      eq(r.status, 200); eq(r.headers.get('cache-control'), 'no-store');
      eq(r.json.providers.map((p) => p.id), ['claude-fable', 'gpt', 'kimi', 'jev']);
      for (const p of r.json.providers) { eq(typeof p.connected, 'boolean', p.id); eq(Object.keys(p).sort(), ['connected', 'id', 'label', 'model']); }
      assert.ok(!/sk-|key/i.test(r.text.replace(/"(id|label|model|providers|connected)"/g, '')), 'a key-shaped string in the provider list');
      const bad = await http_('POST', '/api/analyze', { 'content-type': 'application/json' }, '{"runId":"x","provider":"gpt"}');
      eq([bad.status, bad.json.field], [400, 'runId']);
      const off = r.json.providers.find((p) => !p.connected);
      if (off) {
        const p = await http_('POST', '/api/analyze', { 'content-type': 'application/json' }, JSON.stringify({ runId: 1, provider: off.id }));
        eq([p.status, p.json.error, p.headers.get('cache-control')], [409, 'provider not connected', 'no-store']);
      } else skip('409 over HTTP', 'every provider is connected on that server');
      eq((await http_('PUT', '/api/analyze')).status, 405);
    });
  }
}

if (group(`server ${BASE}: js/catalog.js and js/chain.js from Node with configure({ base })`)) {
  let up = false;
  try { up = (await http_('GET', '/data/catalog/targets.json')).status === 200; } catch { up = false; }
  if (!up) {
    skip('the import smoke test', `nothing answers at ${BASE}`);
  } else {
    let cat = null;
    await check('loadCatalog() reads the two catalogs; ids are 1-based; maps and CANCERS present', async () => {
      cat = await catalog.loadCatalog({ fresh: true });
      assert.ok(cat.targets.length >= 100 && cat.ligands.length >= 100, `${cat.targets.length} targets, ${cat.ligands.length} ligands`);
      eq(cat.targets[0].id, 1); eq(cat.ligands[0].id, 1); eq(cat.targets[cat.targets.length - 1].id, cat.targets.length);
      eq(cat.targetById.get(1), cat.targets[0]); eq(cat.ligandByKey.get(cat.ligands[0].key), cat.ligands[0]);
      eq(cat.cancers, catalog.CANCERS);
      assert.ok(cat.targets.every((t) => /^[0-9][A-Z0-9]{3}$/.test(t.pdbId) && t.pocket === `data/pockets/${t.pdbId}.bin`));
      assert.ok(cat.ligands.every((l) => l.atoms > 0 && l.file.endsWith(`${l.key}.sdf`)));
      const groups = new Set(cat.targets.flatMap((t) => t.cancerKeys));
      assert.ok(groups.has('head-and-neck') && groups.has('lung'), [...groups].join(','));
      assert.ok(cat.targets.every((t) => t.cancers.length === t.cancerKeys.length), 'a catalog cancer name is not one of the twenty groups');
      const reg = fs.existsSync(path.join(ROOT, 'data/registry.json'));
      console.log(`          registry ${reg ? 'exists' : 'absent'}; loadCatalog used it: ${cat.registry}; ${cat.targets.length} targets, ${cat.ligands.length} ligands, ${cat.unregistered.targets.length} catalog targets not registered`);
      eq(cat.registry, reg, 'the registry is used exactly when the file exists');
      if (reg) {
        const regDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/registry.json'), 'utf8'));
        eq(cat.targets.map((t) => t.id), regDoc.targets.map((t) => t.id), 'ids are the registry ids');
        assert.ok(cat.targets.every((t) => typeof t.hash === 'string' && t.atoms > 0 && t.protein), 'registry entries carry hash and atoms and the catalog fields');
        const auto = await catalog.loadCatalog({ registry: 'auto', fresh: true });
        eq(auto.registry, !!LAB.address, 'auto reads the registry only when the lab is live');
      }
      eq(await catalog.loadCatalog(), cat, 'the promise is cached');
    });
    await check('fetchLigandSdf reads a ligand file from the server; fetchPocket fails clearly when the file is absent', async () => {
      const key = cat.ligands[0].key;
      const sdf = await catalog.fetchLigandSdf(key);
      assert.ok(sdf.startsWith(key) || /V2000/.test(sdf), sdf.slice(0, 60));
      eq(await catalog.fetchLigandSdf(cat.ligands[0]), sdf, 'by entry, cached');
      const pdb = cat.targets[0].pdbId;
      if (fs.existsSync(path.join(ROOT, `data/pockets/${pdb}.bin`))) {
        const bytes = await catalog.fetchPocket(pdb);
        assert.ok(bytes instanceof Uint8Array && bytes.length > 28 && new TextDecoder().decode(bytes.slice(0, 4)) === pdb);
      } else {
        await assert.rejects(() => catalog.fetchPocket(pdb), /The catalog could not be loaded\. Reload the page\. \(\/data\/pockets\/.* answered 404\)/);
      }
      eq(await catalog.loadRegistry({ fresh: true }).then((r) => r === null || typeof r === 'object'), true);
    });
    await check('js/chain.js against the server: not live unless the server is; runs() answers a list; ledger empty', async () => {
      const s = await chain.labStatus({ fresh: true });
      eq(s.live, false, 'LAB.address is null in js/config.js, so chain.js reads nothing');
      eq(await chain.runs(), []);
      eq((await chain.ledger()).runs, []);
      const rep = await chain.report();
      eq([rep.live, rep.runCount, rep.cancers.length, rep.mostReviewed], [false, 0, 20, []]);
      assert.ok(rep.targetCount === cat.targets.length);
    });
    if (serverLive && local && (local.lab || local.contract || local.address)) {
      const labAddr = local.lab || local.contract || local.address;
      await check('live server and js/chain.js on the local chain agree on the run count', async () => {
        configure({ rpc: local.rpc, base: BASE, timeoutMs: 8000 });
        lab.useLab(labAddr, { deployBlock: local.deployBlock || 0 });
        chain.setRunsSource('logs');
        chain.invalidate();
        const [viaLogs, viaApi] = [await chain.runsPage({ limit: 1000, order: 'asc' }), (await http_('GET', '/api/runs?limit=1000&order=asc')).json];
        eq(viaLogs.total, viaApi.total);
        eq(viaLogs.runs.map((r) => r.id), viaApi.runs.map((r) => r.id));
        const s = await chain.labStatus({ fresh: true });
        eq(s.live, true);
        lab.useLab(null); chain.setRunsSource('auto'); configure({ base: BASE });
      });
    } else if (local) {
      skip('live checks against the local chain', `${chainFile} exists but the server at ${BASE} is not live: start it with PONCHEM_RPC_URL and PONCHEM_LAB`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failures.length} failed, ${skipped.length} skipped`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f.name}`);
  process.exit(1);
}
