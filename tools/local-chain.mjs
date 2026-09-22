#!/usr/bin/env node
/*
 * local-chain.mjs: a throwaway Robinhood Chain for the pages, the API and the tests.
 *
 *   node tools/local-chain.mjs              anvil on 127.0.0.1:8690 (chain id 4663), PonchemCheck, PonchemLab and the
 *                                           tables deployed, every target and ligand of data/registry.json registered
 *                                           (or the stand-in registry built from the engine vectors when the pipeline
 *                                           has not written it yet), runs seeded from the real vectors, one pool funded,
 *                                           one review; stays up until Ctrl-C (it owns the anvil it started)
 *   node tools/local-chain.mjs --once       the same, then exit after seeding (use with --reuse against an anvil you
 *                                           manage, or the chain goes away with this process)
 *   node tools/local-chain.mjs --reuse      keep an anvil that already listens on the port (seeds only when the lab is
 *                                           not there yet, from .data/local-chain.json)
 *   node tools/local-chain.mjs --standin    only build the stand-in registry into contracts/out/rehearsal and exit
 *   PORT=8690  REGISTRY=path  STATE=.data/local-chain.json
 *
 * It prints the lab address and the RPC URL, and writes .data/local-chain.json { rpc, lab, check, tables, deployBlock,
 * genesis, owner, accounts, targets, ligands, runs } for the other tools. Nothing here touches the live chain.
 *
 * Open the site against it (the overrides only work on localhost, js/rpc.js overrides()):
 *   http://127.0.0.1:6130/lab?rpc=http://127.0.0.1:8690&contract=<lab>
 *
 * Accounts are anvil's defaults: #0 deploys and owns, #1 to #5 record runs and sponsor. Transactions are sent
 * unlocked through anvil (eth_sendTransaction), so no key lives in this file.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, rpc, encodeCall, encodeAbi, fragment, toHex, keccak256, bytesToHex, hexToBytes } from '../js/rpc.js';
import { LAB_ABI } from '../js/abi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8690);
const URL_ = `http://127.0.0.1:${PORT}`;
const ONCE = process.argv.includes('--once');
const REUSE = process.argv.includes('--reuse');
const STANDIN_ONLY = process.argv.includes('--standin');
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const REH = path.join(ROOT, 'contracts/out/rehearsal');
const CANCERS = ['lung', 'colorectal', 'liver', 'breast', 'stomach', 'pancreatic', 'prostate', 'esophageal', 'cervical', 'leukemia', 'lymphoma', 'brain', 'melanoma', 'ovarian', 'bladder', 'kidney', 'myeloma', 'head-and-neck', 'thyroid', 'sarcoma'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------------------------- the stand-in registry

function readVector(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vectors', file), 'utf8'));
}

/** Builds contracts/out/rehearsal/registry.json (+ pockets/, topologies/) from the engine vectors. */
function buildStandin() {
  const pockets = [
    ['real_02_1M17_AQ4_refined.json', 'EGFR', '1M17', 'EGFR kinase domain with erlotinib (engine vector)', ['lung']],
    ['syn_01_methanol_one_pocket_atom.json', 'SYN1', 'SYN1', 'synthetic pocket 1: one carbon', []],
    ['syn_02_ethanolamine_four_pocket_atoms.json', 'SYN2', 'SYN2', 'synthetic pocket 2: four atoms', []],
    ['syn_03_propane_hydrophobic_wall.json', 'SYN3', 'SYN3', 'synthetic pocket 3: hydrophobic wall', []],
    ['syn_04_pyridine_donor_and_stack.json', 'SYN4', 'SYN4', 'synthetic pocket 4: donor and stack', []],
    ['syn_05_propanediol_anti.json', 'SYN5', 'SYN5', 'synthetic pocket 5: propanediol', []],
  ];
  const ligands = [
    ['real_02_1M17_AQ4_refined.json', 'ERLOTINIB', 'Erlotinib (AQ4, engine vector)'],
    ['real_03_1M17_QUE_docked.json', 'QUERCETIN', 'Quercetin (QUE, engine vector)'],
    ['real_04_1M17_TA1_docked.json', 'PACLITAXEL', 'Paclitaxel (TA1, engine vector)'],
    ['syn_01_methanol_one_pocket_atom.json', 'METHANOL', 'methanol (synthetic)'],
    ['syn_02_ethanolamine_four_pocket_atoms.json', 'ETHANOLAMINE', 'ethanolamine (synthetic)'],
    ['syn_03_propane_hydrophobic_wall.json', 'PROPANE', 'propane (synthetic)'],
    ['syn_04_pyridine_donor_and_stack.json', 'PYRIDINE', 'pyridine (synthetic)'],
    ['syn_05_propanediol_anti.json', 'PROPANEDIOL', 'propanediol (synthetic)'],
  ];
  fs.mkdirSync(path.join(REH, 'pockets'), { recursive: true });
  fs.mkdirSync(path.join(REH, 'topologies'), { recursive: true });
  const registry = { generated: new Date().toISOString(), source: 'stand-in built by tools/local-chain.mjs --standin from data/vectors', targets: [], ligands: [] };
  pockets.forEach(([file, key, pdbId, name, cancers], i) => {
    const v = readVector(file);
    const bytes = hexToBytes(v.pocket_hex);
    if (keccak256(bytes) !== v.pocket_keccak) throw new Error(`pocket hash mismatch in ${file}`);
    const rel = `contracts/out/rehearsal/pockets/${pdbId}.bin`;
    fs.writeFileSync(path.join(ROOT, rel), bytes);
    registry.targets.push({ id: i + 1, key, pdbId, name, gene: key, cancers, pocket: rel, hash: v.pocket_keccak, atoms: v.pocket_atoms, box: { half: v.half, grid: v.grid } });
  });
  ligands.forEach(([file, key, name], i) => {
    const v = readVector(file);
    const bytes = hexToBytes(v.topology_hex);
    if (keccak256(bytes) !== v.topology_keccak) throw new Error(`topology hash mismatch in ${file}`);
    const rel = `contracts/out/rehearsal/topologies/${key}.bin`;
    fs.writeFileSync(path.join(ROOT, rel), bytes);
    registry.ligands.push({ id: i + 1, key, name, topology: rel, hash: v.topology_keccak, atoms: v.ligand_atoms, nrot: v.nrot });
  });
  const out = path.join(REH, 'registry.json');
  fs.writeFileSync(out, JSON.stringify(registry, null, 2) + '\n');
  console.log(`stand-in registry: ${registry.targets.length} targets, ${registry.ligands.length} ligands -> ${out}`);
  return out;
}

if (STANDIN_ONLY) {
  buildStandin();
  process.exit(0);
}

// --------------------------------------------------------------------------------------------- the chain

configure({ rpc: URL_ });

async function up() {
  try { return (await rpc('eth_chainId', [], { retries: 0, timeoutMs: 1500 })) === '0x1237'; } catch { return false; }
}

let anvil = null;
if (await up()) {
  if (!REUSE) {
    console.error(`something already answers on ${URL_}. Stop it, pick another PORT, or pass --reuse.`);
    process.exit(1);
  }
} else {
  anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', '4663', '--silent'], { stdio: 'ignore' });
  anvil.on('exit', (c) => { if (c) console.error(`anvil exited with ${c}`); });
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(150);
  if (!(await up())) { console.error('anvil did not start'); process.exit(1); }
}
const stop = () => { if (anvil) anvil.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const accounts = await rpc('eth_accounts');
const [owner, alice, bob, carol, dave, erin] = accounts;
const F = (n) => fragment(LAB_ABI, n);

async function wait(hash) {
  for (let i = 0; i < 200; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) { if (r.status !== '0x1') throw new Error(`transaction reverted: ${hash}`); return r; }
    await sleep(50);
  }
  throw new Error(`no receipt for ${hash}`);
}
async function send(from, to, data, value = 0n) {
  return wait(await rpc('eth_sendTransaction', [{ from, to, data, value: toHex(value), gas: toHex(30_000_000n) }]));
}
async function create(from, data) {
  return wait(await rpc('eth_sendTransaction', [{ from, data, gas: toHex(30_000_000n) }]));
}
async function call(to, name, args = []) {
  const frag = F(name);
  const out = await rpc('eth_call', [{ to, data: encodeCall(frag, args) }, 'latest']);
  return out;
}
const asInt = (hex) => BigInt(hex);

const multicallHex = path.join(ROOT, 'tools/fixtures/multicall3.hex');
if (fs.existsSync(multicallHex)) await rpc('anvil_setCode', [MULTICALL3, fs.readFileSync(multicallHex, 'utf8').trim()]);

const statePath = path.resolve(ROOT, process.env.STATE || '.data/local-chain.json');
let state = null;
if (REUSE && fs.existsSync(statePath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (prev.rpc === URL_ && (await rpc('eth_getCode', [prev.lab, 'latest'])) !== '0x') state = prev;
  } catch { /* deploy again */ }
}

if (!state) {
  execFileSync('forge', ['build'], { cwd: path.join(ROOT, 'contracts'), stdio: ['ignore', 'ignore', 'inherit'] });
  const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `contracts/out/${n}.sol/${n}.json`), 'utf8'));
  const checkRc = await create(owner, art('PonchemCheck').bytecode.object);
  const check = checkRc.contractAddress;
  const RUN_FEE = 100_000_000_000_000n; // 0.0001 ETH
  const RUN_PRICE = 100n * 10n ** 18n;
  const ctor = encodeAbi(['address', 'address', 'address', 'uint16', 'uint256', 'uint256', 'uint64'], [check, owner, owner, 500, RUN_FEE, RUN_PRICE, 7n * 86400n]);
  const labRc = await create(owner, art('PonchemLab').bytecode.object + ctor.slice(2));
  const lab = labRc.contractAddress;
  const deployBlock = Number(labRc.blockNumber);
  const tables = fs.readFileSync(path.join(ROOT, 'data/tables/tables.bin'));
  await send(owner, lab, encodeCall(F('setTables'), [bytesToHex(tables)]));
  const genesis = Number(asInt(await call(lab, 'genesis')));
  console.log(`PonchemCheck  ${check}`);
  console.log(`PonchemLab    ${lab}  (block ${deployBlock}, genesis ${genesis})`);

  // ---- the registry: the pipeline's, else the stand-in
  let registryPath = process.env.REGISTRY ? path.resolve(ROOT, process.env.REGISTRY) : path.join(ROOT, 'data/registry.json');
  if (!fs.existsSync(registryPath)) {
    console.log('data/registry.json is not there yet: using the stand-in registry from the engine vectors');
    registryPath = buildStandin();
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const cut = (s) => { const b = Buffer.from(String(s || ''), 'utf8'); return b.length > 96 ? b.subarray(0, 96).toString('utf8').replace(/�/g, '') : String(s || ''); };
  const bitsOf = (t) => {
    if (typeof t.cancerBits === 'number') return t.cancerBits;
    let bits = 0;
    for (const c of t.cancers || []) {
      const i = CANCERS.indexOf(c === 'head and neck' ? 'head-and-neck' : c);
      if (i >= 0) bits |= 1 << i;
    }
    return bits;
  };
  const targetByHash = new Map();
  const ligandByHash = new Map();
  let tid = 0;
  for (const t of registry.targets) {
    const blob = fs.readFileSync(path.resolve(ROOT, t.pocket));
    const hash = keccak256(blob);
    if (hash !== t.hash) throw new Error(`registry hash mismatch for target ${t.pdbId}`);
    await send(owner, lab, encodeCall(F('registerTarget'), [t.pdbId, cut(t.name || t.protein || t.gene || t.key), bitsOf(t), bytesToHex(blob), hash]));
    tid += 1;
    targetByHash.set(hash, tid);
    if (tid % 20 === 0 || tid === registry.targets.length) console.log(`  targets ${tid} of ${registry.targets.length}`);
  }
  let lid = 0;
  for (const l of registry.ligands) {
    const blob = fs.readFileSync(path.resolve(ROOT, l.topology));
    const hash = keccak256(blob);
    if (hash !== l.hash) throw new Error(`registry hash mismatch for ligand ${l.key}`);
    await send(owner, lab, encodeCall(F('registerLigand'), [l.key, cut(l.name || l.key), bytesToHex(blob), hash]));
    lid += 1;
    ligandByHash.set(hash, lid);
    if (lid % 20 === 0 || lid === registry.ligands.length) console.log(`  ligands ${lid} of ${registry.ligands.length}`);
  }

  // ---- runs from the real vectors: the registry's entries when the hashes match, else extra entries
  const extras = [];
  async function targetFor(v) {
    if (targetByHash.has(v.pocket_keccak)) return targetByHash.get(v.pocket_keccak);
    await send(owner, lab, encodeCall(F('registerTarget'), [v.provenance.pdb_id, `${v.provenance.pdb_id} pocket (engine vector)`, 1, v.pocket_hex, v.pocket_keccak]));
    tid += 1;
    targetByHash.set(v.pocket_keccak, tid);
    extras.push(`target ${tid} ${v.provenance.pdb_id}`);
    return tid;
  }
  async function ligandFor(v) {
    if (ligandByHash.has(v.topology_keccak)) return ligandByHash.get(v.topology_keccak);
    const ccd = v.provenance.ligand_ccd || v.name.split('_')[3] || 'LIG';
    await send(owner, lab, encodeCall(F('registerLigand'), [`V-${ccd}`, `${v.provenance.ligand_name || ccd} (engine vector)`, v.topology_hex, v.topology_keccak]));
    lid += 1;
    ligandByHash.set(v.topology_keccak, lid);
    extras.push(`ligand ${lid} V-${ccd}`);
    return lid;
  }
  const seeds = [
    ['real_02_1M17_AQ4_refined.json', alice],
    ['real_01_1M17_AQ4_crystal_fit.json', bob],
    ['real_03_1M17_QUE_docked.json', carol],
    ['real_04_1M17_TA1_docked.json', dave],
    ['real_02_1M17_AQ4_refined.json', erin],
  ];
  const runFee = asInt(await call(lab, 'runFee'));
  const runs = [];
  for (const [file, from] of seeds) {
    const v = readVector(file);
    const t = await targetFor(v);
    const l = await ligandFor(v);
    const rc = await send(from, lab, encodeCall(F('submitRun'), [t, l, v.pose_flat]), runFee);
    const id = runs.length + 1;
    runs.push({ id, target: t, ligand: l, wallet: from, expected: v.expect_score_milli, tx: rc.transactionHash });
    console.log(`  run ${id}: ${v.name} by ${from.slice(0, 10)} (expected ${v.expect_score_milli} milli)`);
  }
  if (extras.length) console.log(`  extra entries for the vectors: ${extras.join(', ')}`);
  const funded = runs[0].target;
  await send(erin, lab, encodeCall(F('fund'), [funded]), 50_000_000_000_000_000n); // 0.05 ETH
  console.log(`  pool: 0.05 ETH on target ${funded}`);
  await send(carol, lab, encodeCall(F('reviewRun'), [2n, 5, 'clean pose in the hinge region']));
  console.log('  review: carol gave run 2 five stars');

  state = {
    rpc: URL_, lab, check, tables: '0x' + (await call(lab, 'tables')).slice(26), deployBlock, genesis, owner,
    accounts: { alice, bob, carol, dave, erin },
    registry: path.relative(ROOT, registryPath), targets: tid, ligands: lid, runs, fundedTarget: funded,
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

const q = `rpc=${encodeURIComponent(URL_)}&contract=${state.lab}`;
console.log(`local chain   ${URL_}  (chain id 4663${anvil ? '' : ', reused'})`);
console.log(`lab           ${state.lab}   deployBlock ${state.deployBlock}   genesis ${state.genesis}`);
console.log(`check         ${state.check}`);
console.log(`registered    ${state.targets} targets, ${state.ligands} ligands; ${state.runs.length} runs`);
console.log(`site          http://127.0.0.1:6130/lab?${q}`);
console.log(`state         ${path.relative(ROOT, statePath)}`);
if (ONCE) { if (anvil) console.log('(--once without --reuse: the anvil this process started stops with it)'); stop(); }
if (anvil) { console.log('running until Ctrl-C'); await new Promise(() => {}); }
