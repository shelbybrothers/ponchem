#!/usr/bin/env node
/*
 * tools/engine-test.mjs: gate for the browser docking engine (SPEC.md 7 and 8.1, SPEC-ENGINE.md).
 *
 *   node tools/engine-test.mjs             everything below in Node (about 45 s: the reach test docks quercetin for 20 s)
 *   node tools/engine-test.mjs --quick     skips the 20 s reach test
 *   node tools/engine-test.mjs --chrome    also drives headless Chrome through the Worker path (port 6134, CDP 9543):
 *                                          the vectors in the browser, and a fixed-step quercetin run whose pose must
 *                                          equal Node's (cross-engine determinism)
 *
 * Sections: tables (bytes, keccak256, spot values) · terms (32 per-pair rows) · vectors (every data/vectors case,
 * grid and full scan, sums, e_pico, score or rejection reason, pose bytes round trip) · sdf (all catalog ligands
 * parse, heavy atom counts, rotor rule against data/topologies when present else the Python reference, catalog
 * rotatableBonds reported) · model (torsion builds keep bonds and 1-3 distances, analytic gradient vs finite
 * differences) · determinism (same seed twice, different seeds) · polish (the reported score is scoreInt of the pose)
 * · derived · reach (quercetin into 1M17 reaches <= -7.5 kcal/mol within a 20 s budget) · method (SPEC 9.7: schema
 * round trip, every preset validates, bounds and unknown keys rejected with the right sentence, compact form canonical,
 * query round trip, every knob steers the search, rigid vs flexible and center vs box differ, steps replay identical,
 * every preset reaches a negative score on QUE x 1M17 within its budget; --quick shrinks the preset budgets) · chrome
 * (optional; adds a Wide search worker run that must equal Node's).
 * Exit code 1 when any check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const CHROME = args.includes('--chrome');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));
const PY = path.join(ROOT, '.venv/bin/python');

const { parseSdf } = await import('../js/engine/sdf.js');
const { loadPocket, loadTopology, encodePose, decodePose } = await import('../js/engine/format.js');
const { ensureTables, getTables, parseTables, tablesFromJson, TABLES_KECCAK, GAUSS1_KECCAK, GAUSS2_KECCAK, SQRT_KECCAK } = await import('../js/engine/tables.js');
const { scoreInt, pairTerms, isqrt, checkGeometry, CODES, DON_MASK, HYD_MASK, ACC_MASK, RADIUS_CENTI } = await import('../js/engine/score.js');
const { keccak256, hexToBytes, bytesToHex } = await import('../js/engine/keccak.js');
const { rotatableBonds, makeLigandModel } = await import('../js/engine/ligand.js');
const { makeEnergyModel } = await import('../js/engine/energy.js');
const { makeRng } = await import('../js/engine/prng.js');
const { fexp, fsin, fcos } = await import('../js/engine/fmath.js');
const { dock, derived, formatKd, band, bandLabel, lastRunMode, methodToQuery: toQuery, METHOD_PRESETS: PRESETS } = await import('../js/engine/index.js');

let pass = 0, fail = 0, sectionPass = 0, sectionFail = 0, sectionName = '';
const failures = [];
function section(name) {
  if (sectionName) console.log(`  ${sectionName}: ${sectionPass} pass, ${sectionFail} fail`);
  sectionName = name; sectionPass = 0; sectionFail = 0;
  console.log(`\n${name}`);
}
function check(ok, label, extra = '') {
  if (ok) { pass++; sectionPass++; }
  else { fail++; sectionFail++; failures.push(`${sectionName}: ${label} ${extra}`); console.log(`  FAIL ${label} ${extra}`); }
  return ok;
}
function endSections() {
  if (sectionName) console.log(`  ${sectionName}: ${sectionPass} pass, ${sectionFail} fail`);
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------------------------------------- tables
section('tables');
{
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'data/tables/tables.bin')));
  check(bytes.length === 13010, 'tables.bin is 13010 bytes', String(bytes.length));
  check(keccak256(bytes) === TABLES_KECCAK, 'tables.bin keccak256 equals the frozen hash');
  check(keccak256(bytes.subarray(0, 4004)) === GAUSS1_KECCAK, 'gauss1 slice keccak256');
  check(keccak256(bytes.subarray(4004, 8008)) === GAUSS2_KECCAK, 'gauss2 slice keccak256');
  check(keccak256(bytes.subarray(8008)) === SQRT_KECCAK, 'sqrt slice keccak256');
  for (const f of ['gauss1.bin', 'gauss2.bin', 'sqrt.bin']) {
    const b = new Uint8Array(fs.readFileSync(path.join(ROOT, 'data/tables', f)));
    const off = f === 'gauss1.bin' ? 0 : f === 'gauss2.bin' ? 4004 : 8008;
    check(same(b, bytes.subarray(off, off + b.length)), `${f} equals its slice of tables.bin`);
  }
  const t = await ensureTables({ bytes });
  const desc = readJson('data/tables/tables.json');
  check(desc.tables.keccak256 === TABLES_KECCAK && desc.gauss1.keccak256 === GAUSS1_KECCAK && desc.gauss2.keccak256 === GAUSS2_KECCAK && desc.sqrt.keccak256 === SQRT_KECCAK, 'data/tables/tables.json hashes agree');
  const fromJson = tablesFromJson(desc);
  check(same(fromJson.g1, t.g1) && same(fromJson.g2, t.g2) && same(fromJson.sq, t.sq), 'tables.json arrays encode to the same bytes');
  const vt = readJson('data/vectors/tables.json');
  check(vt.tables_keccak === TABLES_KECCAK && vt.gauss1_keccak === GAUSS1_KECCAK && vt.gauss2_keccak === GAUSS2_KECCAK && vt.sqrt_keccak === SQRT_KECCAK, 'data/vectors/tables.json hashes agree');
  let spot = true;
  vt.spot_d.forEach((d, i) => { if (t.g1[d + 440] !== vt.spot_g1[i] || t.g2[d + 440] !== vt.spot_g2[i]) spot = false; });
  check(spot, `gauss spot values (${vt.spot_d.length} d values)`);
  let sq = true;
  vt.spot_r2.forEach((r2, i) => { if (isqrt(r2) !== vt.spot_isqrt[i]) sq = false; });
  check(sq, `isqrt spot values (${vt.spot_r2.length})`);
  let exact = true;
  for (let r2 = 0; r2 <= 640000; r2 += 7) { const r = isqrt(r2); if (r * r > r2 || (r + 1) * (r + 1) <= r2) { exact = false; break; } }
  for (let r2 = 0; r2 < 20000; r2++) { const r = isqrt(r2); if (r * r > r2 || (r + 1) * (r + 1) <= r2) { exact = false; break; } }
  check(exact, 'isqrt is the exact floor square root on a sweep of r2');
  let corrupt = bytes.slice(); corrupt[100] ^= 1;
  let threw = false; try { parseTables(corrupt); } catch (e) { threw = true; }
  check(threw, 'a corrupted tables.bin is refused');
  check(HYD_MASK === 0x7801 && DON_MASK === 0x81a8 && ACC_MASK === 0x0170, 'type masks match the reference (DON_MASK 0x81A8)');
  check(same(RADIUS_CENTI, [190, 190, 180, 180, 180, 180, 170, 170, 170, 200, 210, 150, 180, 200, 220, 120]), 'radius table');
}

// ----------------------------------------------------------------------------------------------------------- terms
section('terms');
{
  const T = readJson('data/vectors/terms.json');
  check(T.hyd_mask === HYD_MASK && T.don_mask === DON_MASK && T.acc_mask === ACC_MASK, 'terms.json masks equal the engine masks');
  let ok = 0;
  for (let i = 0; i < T.count; i++) {
    const x = pairTerms(T.type_a[i], T.type_b[i], T.r2[i]);
    const good = T.skipped[i] ? x === null
      : x !== null && x.r === T.r_centi[i] && x.d === T.d_centi[i] && x.g1 === T.g1[i] && x.g2 === T.g2[i] && x.rep === T.rep[i] && x.hyd === T.hyd[i] && x.hb === T.hb[i] && x.ePico === BigInt(T.e_pico[i]);
    if (good) ok++;
    check(good, `term row ${i} (types ${T.type_a[i]},${T.type_b[i]} r2 ${T.r2[i]})`, good ? '' : JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  console.log(`  ${ok}/${T.count} term rows exact`);
}

// --------------------------------------------------------------------------------------------------------- vectors
section('vectors');
const VEC = {};
{
  const idx = readJson('data/vectors/index.json');
  let n = 0;
  for (const f of idx.files) {
    if (f.kind === 'tables' || f.kind === 'terms') continue;
    const v = readJson(`data/vectors/${f.file}`);
    VEC[f.name] = v;
    const pocketBytes = hexToBytes(v.pocket_hex), topoBytes = hexToBytes(v.topology_hex), poseBytes = hexToBytes(v.pose_hex);
    const pocket = loadPocket(pocketBytes), topo = loadTopology(topoBytes);
    check(pocket.hash === v.pocket_keccak && topo.hash === v.topology_keccak, `${f.name}: pocket and topology keccak256`);
    check(pocket.n === v.pocket_atoms && same(pocket.halfCenti, v.half) && same(pocket.grid, v.grid) && topo.n === v.ligand_atoms && topo.nrot === v.nrot, `${f.name}: header fields`);
    const pose = decodePose(poseBytes);
    check(same(Array.from(pose), v.pose_flat) && same(encodePose(pose), poseBytes), `${f.name}: pose bytes round trip`);
    const r = scoreInt(pocket, topo, pose);
    const rf = scoreInt(pocket, topo, pose, { grid: false });
    check(r.code === v.expect_code && r.reason === v.expect_error && f.expect_code === v.expect_code, `${f.name}: result code ${CODES[v.expect_code]}`, `got ${r.reason}`);
    if (v.expect_code === 0) {
      check(r.scoreMilli === v.expect_score_milli && r.terms.g1 === v.expect_sum_g1 && r.terms.g2 === v.expect_sum_g2 && r.terms.rep === v.expect_sum_rep && r.terms.hyd === v.expect_sum_hyd && r.terms.hb === v.expect_sum_hb && r.terms.pairs === v.expect_pairs_in_cutoff && r.terms.ePico === BigInt(v.expect_e_pico),
        `${f.name}: grid scan score ${v.expect_score_milli} and the five sums`, `got ${r.scoreMilli} ${JSON.stringify(r.terms, (k, x) => (typeof x === 'bigint' ? String(x) : x))}`);
      check(rf.scoreMilli === r.scoreMilli && rf.terms.g1 === r.terms.g1 && rf.terms.g2 === r.terms.g2 && rf.terms.rep === r.terms.rep && rf.terms.hyd === r.terms.hyd && rf.terms.hb === r.terms.hb && rf.terms.pairs === r.terms.pairs, `${f.name}: full scan equals grid scan`);
      const dsp = derived(r.scoreMilli, topo.n);
      check(Math.abs(dsp.dG - v.display.dG_kcal) < 1e-9 && Math.abs(dsp.pKd - v.display.pKd) < 1e-9 && Math.abs(dsp.le - v.display.ligand_efficiency) < 1e-9 && Math.abs(dsp.kd / v.display.Kd_M - 1) < 1e-9, `${f.name}: derived numbers equal the vector's display block`);
    } else {
      check(r.scoreMilli === null && r.terms === null, `${f.name}: rejected pose carries no score`);
      if (v.expect_detail && v.expect_detail.i !== undefined) check(r.detail && r.detail.i === v.expect_detail.i && r.detail.j === v.expect_detail.j, `${f.name}: failing pair ${v.expect_detail.i}-${v.expect_detail.j}`, JSON.stringify(r.detail));
    }
    n++;
  }
  console.log(`  ${n} vector cases`);
}

// ------------------------------------------------------------------------------------------------------------- sdf
section('sdf');
{
  const cat = readJson('data/catalog/ligands.json');
  const ligs = cat.ligands || cat;
  let parsed = 0, countOk = 0;
  const parsedByKey = {};
  for (const l of ligs) {
    let p = null;
    try { p = parseSdf(read(l.file)); parsed++; } catch (e) { check(false, `${l.key}: parse`, e.message); continue; }
    parsedByKey[l.key] = p;
    if (p.heavyAtoms === l.heavyAtoms) countOk++;
    else check(false, `${l.key}: heavy atom count`, `sdf ${p.heavyAtoms} catalog ${l.heavyAtoms}`);
    if (p.atoms.some((a) => /^[HDT]$/i.test(a.el))) check(false, `${l.key}: hydrogen kept`);
    if (p.bonds.some(([i, j]) => i >= j || j >= p.heavyAtoms)) check(false, `${l.key}: bond indices`);
  }
  check(parsed === ligs.length, `all ${ligs.length} catalog ligands parse`, `${parsed}`);
  check(countOk === ligs.length, `heavy atom counts equal the catalog for all ${ligs.length}`, `${countOk}`);
  for (const f of ['AQ4', 'QUE', 'TA1', 'CUR', 'STL']) {
    const p = parseSdf(read(`tools/engine/fixtures/${f}_ideal.sdf`));
    check(p.explicitHydrogens && p.atoms.every((a) => !/^[HDT]$/i.test(a.el)), `${f}_ideal.sdf: explicit hydrogens stripped (${p.heavyAtoms} heavy atoms)`);
    parsedByKey[`fixture:${f}`] = p;
  }
  const que = parseSdf(read('tools/engine/fixtures/QUE_ideal.sdf'));
  check(que.heavyAtoms === 22 && que.atoms.filter((a) => a.hcount > 0).length === 10 && que.bonds.length === 24, 'QUE ideal: 22 heavy atoms, 10 carry hydrogens, 24 bonds');
  const ex = parseSdf(read('data/vectors/synthetic_ethanolamine.sdf'));
  const exRot = rotatableBonds(ex.heavyAtoms, ex.bonds, ex.atoms.map((a) => a.el.toUpperCase()));
  check(ex.heavyAtoms === 4 && exRot.length === 1, 'synthetic ethanolamine: 4 heavy atoms, Nrot 1');
  // rotor rule: against topology bytes when the pipeline has produced them, else against the Python reference
  const topoDir = path.join(ROOT, 'data/topologies');
  const rotorRef = {};
  let refSource = '';
  if (fs.existsSync(topoDir) && fs.readdirSync(topoDir).some((f) => f.endsWith('.bin'))) {
    refSource = 'data/topologies';
    for (const l of ligs) {
      const f = path.join(topoDir, `${l.key}.bin`);
      if (!fs.existsSync(f)) continue;
      const t = loadTopology(new Uint8Array(fs.readFileSync(f)));
      rotorRef[l.key] = { nrot: t.nrot, n: t.n, bonds: t.bonds.map(([i, j]) => [i, j]) };
    }
  } else if (fs.existsSync(PY)) {
    refSource = 'Python reference (tools/engine/ref/topology.py, one process over every catalog SDF)';
    const script = `
import sys, os, json, glob
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools/engine'))})
from ref.topology import build_topology
out = {}
for f in sorted(glob.glob(${JSON.stringify(path.join(ROOT, 'data/ligands/*.sdf'))})):
    key = os.path.basename(f)[:-4]
    try:
        blob, info = build_topology(open(f).read())
        out[key] = {"nrot": info["nrot"], "n": info["n_atoms"], "rot": info["rotatable_bonds"], "bonds": [b[:2] for b in info["bonds"]]}
    except Exception as e:
        out[key] = {"error": str(e)}
print(json.dumps(out))
`;
    const r = spawnSync(PY, ['-c', script], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) {
      const obj = JSON.parse(r.stdout);
      for (const [k, v] of Object.entries(obj)) if (!v.error) rotorRef[k] = { nrot: v.nrot, n: v.n, rot: v.rot, bonds: v.bonds };
    } else {
      check(false, 'python reference topology run', (r.stderr || '').slice(0, 300));
    }
  }
  if (Object.keys(rotorRef).length) {
    let agree = 0, total = 0, catAgree = 0;
    const catDiff = [];
    for (const l of ligs) {
      const ref = rotorRef[l.key], p = parsedByKey[l.key];
      if (!ref || !p) continue;
      total++;
      const els = p.atoms.map((a) => a.el.toUpperCase());
      const rot = rotatableBonds(p.heavyAtoms, p.bonds, els);
      const pairs = rot.map((k) => [p.bonds[k][0], p.bonds[k][1]]);
      const bondsSame = same(p.bonds.map(([i, j]) => `${i}-${j}`), ref.bonds.map(([i, j]) => `${i}-${j}`));
      const ok = rot.length === ref.nrot && ref.n === p.heavyAtoms && bondsSame && (!ref.rot || same(pairs.map((x) => x.join('-')), ref.rot.map((x) => x.join('-'))));
      if (ok) agree++;
      else check(false, `${l.key}: rotor rule`, `js ${rot.length} ref ${ref.nrot} bondsSame ${bondsSame}`);
      if (l.rotatableBonds === ref.nrot) catAgree++; else catDiff.push(`${l.key} catalog ${l.rotatableBonds} rule ${ref.nrot}`);
    }
    check(agree === total, `rotor rule agrees with ${refSource} on ${total} ligands`, `${agree}/${total}`);
    console.log(`  catalog rotatableBonds (RDKit count) equals the rule's Nrot for ${catAgree}/${total}; differs (expected, informational): ${catDiff.length ? catDiff.join('; ') : 'none'}`);
  } else {
    check(false, 'rotor rule reference available (data/topologies or the Python venv)');
  }
  // fixtures vs the topology bytes registered in the vectors
  for (const [key, vec] of [['AQ4', 'real_01_1M17_AQ4_crystal_fit'], ['QUE', 'real_03_1M17_QUE_docked'], ['TA1', 'real_04_1M17_TA1_docked']]) {
    const p = parsedByKey[`fixture:${key}`];
    const t = loadTopology(hexToBytes(VEC[vec].topology_hex));
    const rot = rotatableBonds(p.heavyAtoms, p.bonds, p.atoms.map((a) => a.el.toUpperCase()));
    check(rot.length === t.nrot && p.heavyAtoms === t.n, `${key} fixture: Nrot ${t.nrot} and ${t.n} atoms match its vector topology`, `js ${rot.length}`);
  }
}

// ----------------------------------------------------------------------------------------------------------- model
section('model');
{
  const cases = [['AQ4', 'real_01_1M17_AQ4_crystal_fit'], ['QUE', 'real_03_1M17_QUE_docked'], ['TA1', 'real_04_1M17_TA1_docked']];
  for (const [key, vec] of cases) {
    const v = VEC[vec];
    const pocket = loadPocket(hexToBytes(v.pocket_hex)), topo = loadTopology(hexToBytes(v.topology_hex));
    const sdf = parseSdf(read(`tools/engine/fixtures/${key}_ideal.sdf`));
    const lig = makeLigandModel(sdf, topo);
    const rng = makeRng(11);
    const st = new Float64Array(lig.stateLength);
    const X = new Float64Array(3 * lig.n);
    let maxDev = 0, boxFail = 0;
    for (let trial = 0; trial < 20; trial++) {
      lig.randomState(rng, pocket.half, st);
      lig.build(st, X);
      for (const [i, j, ideal] of topo.bonds.concat(topo.pairs13)) {
        const dx = X[3 * i] - X[3 * j], dy = X[3 * i + 1] - X[3 * j + 1], dz = X[3 * i + 2] - X[3 * j + 2];
        maxDev = Math.max(maxDev, Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100 - ideal));
      }
      const pose = new Int16Array(3 * lig.n);
      for (let i = 0; i < 3 * lig.n; i++) pose[i] = Math.round(X[i] * 100);
      const g = checkGeometry(topo, pose, pocket.halfCenti);
      if (g.reason === 'BOND' || g.reason === 'PAIR13') boxFail++;
    }
    check(maxDev < 1.0, `${key}: random torsions and rigid moves keep bonds and 1-3 distances (max dev ${maxDev.toFixed(3)} centi)`);
    check(boxFail === 0, `${key}: rounded random poses never fail BOND or PAIR13`, `${boxFail} did`);
    // gradient vs finite differences
    const en = makeEnergyModel(pocket, topo, lig, getTables());
    lig.randomState(rng, pocket.half, st, 0.3);
    const gX = new Float64Array(3 * lig.n), g = new Float64Array(lig.dim), st2 = new Float64Array(lig.stateLength), delta = new Float64Array(lig.dim);
    lig.build(st, X); en.evaluate(X, gX); lig.project(X, st, gX, g);
    let maxRel = 0;
    const h = 1e-6;
    for (let k = 0; k < lig.dim; k++) {
      delta.fill(0); delta[k] = h; lig.step(st, delta, st2); lig.build(st2, X); const ep = en.evaluate(X, null);
      delta[k] = -h; lig.step(st, delta, st2); lig.build(st2, X); const em = en.evaluate(X, null);
      const num = (ep - em) / (2 * h);
      maxRel = Math.max(maxRel, Math.abs(num - g[k]) / Math.max(1e-3, Math.abs(num)));
    }
    check(maxRel < 2e-2, `${key}: analytic gradient matches finite differences over ${lig.dim} parameters (max rel ${maxRel.toExponential(2)})`);
  }
  // deterministic math kernels
  let mx = 0;
  for (let i = 0; i < 20000; i++) { const x = (i / 20000 - 0.5) * 60; mx = Math.max(mx, Math.abs(fexp(x) / Math.exp(x) - 1), Math.abs(fsin(x) - Math.sin(x)), Math.abs(fcos(x) - Math.cos(x))); }
  check(mx < 1e-14, `fexp, fsin, fcos agree with Math.* to ${mx.toExponential(1)}`);
  const r1 = makeRng(123), r2 = makeRng(123), r3 = makeRng(124);
  const a = Array.from({ length: 50 }, () => r1.u32()), b = Array.from({ length: 50 }, () => r2.u32()), c = Array.from({ length: 50 }, () => r3.u32());
  check(same(a, b) && !same(a, c), 'PRNG: same seed same stream, different seed different stream');
}

// ---------------------------------------------------------------------------------------------------- determinism
section('determinism');
const QUE_CASE = { v: VEC.real_03_1M17_QUE_docked, sdf: parseSdf(read('tools/engine/fixtures/QUE_ideal.sdf')) };
const AQ4_CASE = { v: VEC.real_02_1M17_AQ4_refined, sdf: parseSdf(read('tools/engine/fixtures/AQ4_ideal.sdf')) };
async function runFixed(c, seed, steps) {
  return dock({ pocket: hexToBytes(c.v.pocket_hex), topology: hexToBytes(c.v.topology_hex), ligand: c.sdf, seed, steps });
}
let NODE_FIXED = null;
{
  const a = await runFixed(QUE_CASE, 7, 300);
  const b = await runFixed(QUE_CASE, 7, 300);
  const c = await runFixed(QUE_CASE, 8, 300);
  check(a.steps === 300 && b.steps === 300, 'steps mode runs exactly the asked steps', `${a.steps} ${b.steps}`);
  check(same(Array.from(a.poseCenti), Array.from(b.poseCenti)) && a.scoreMilli === b.scoreMilli && a.evaluations === b.evaluations, 'QUE seed 7 twice: same pose, score and evaluation count', `${a.scoreMilli} ${b.scoreMilli}`);
  check(!same(Array.from(a.poseCenti), Array.from(c.poseCenti)), 'QUE seed 8 differs from seed 7', `${a.scoreMilli} vs ${c.scoreMilli}`);
  check(lastRunMode() === 'thread', 'Node runs on the in-thread fallback (no Worker global)');
  NODE_FIXED = a;
  const d = await runFixed(AQ4_CASE, 21, 200);
  const e = await runFixed(AQ4_CASE, 21, 200);
  check(same(Array.from(d.poseCenti), Array.from(e.poseCenti)) && d.scoreMilli === e.scoreMilli, 'AQ4 (10 rotors) seed 21 twice: same pose and score', `${d.scoreMilli} ${e.scoreMilli}`);
  console.log(`  QUE seed 7/300 steps: ${a.scoreMilli} milli, ${a.evaluations} evaluations; seed 8: ${c.scoreMilli}; AQ4 seed 21/200 steps: ${d.scoreMilli}`);
  // replay: a budget run replays exactly with its step count
  const f = await dock({ pocket: hexToBytes(QUE_CASE.v.pocket_hex), topology: hexToBytes(QUE_CASE.v.topology_hex), ligand: QUE_CASE.sdf, seed: 9, budgetMs: 1500 });
  const g = await dock({ pocket: hexToBytes(QUE_CASE.v.pocket_hex), topology: hexToBytes(QUE_CASE.v.topology_hex), ligand: QUE_CASE.sdf, seed: 9, steps: f.steps, chains: f.chains });
  check(same(Array.from(f.poseCenti), Array.from(g.poseCenti)) && f.scoreMilli === g.scoreMilli, `a budget run (${f.steps} steps, ${f.chains} chains) replays exactly with steps and chains`, `${f.scoreMilli} vs ${g.scoreMilli}`);
  // cancel
  const p = dock({ pocket: hexToBytes(QUE_CASE.v.pocket_hex), topology: hexToBytes(QUE_CASE.v.topology_hex), ligand: QUE_CASE.sdf, seed: 1, budgetMs: 20000 });
  const { cancel } = await import('../js/engine/index.js');
  setTimeout(() => cancel(), 400);
  let cancelled = false;
  try { await p; } catch (err) { cancelled = err.name === 'CancelledError'; }
  check(cancelled, 'cancel() rejects the pending run with CancelledError');
}

// ---------------------------------------------------------------------------------------------------------- polish
section('polish');
{
  for (const [name, c, seed] of [['QUE', QUE_CASE, 7], ['AQ4', AQ4_CASE, 21]]) {
    const r = await runFixed(c, seed, name === 'QUE' ? 300 : 200);
    const pocket = loadPocket(hexToBytes(c.v.pocket_hex)), topo = loadTopology(hexToBytes(c.v.topology_hex));
    const s = scoreInt(pocket, topo, r.poseCenti);
    check(r.checks.ok && s.ok && s.scoreMilli === r.scoreMilli, `${name}: the reported score is scoreInt of the reported int16 pose`, `${s.reason} ${s.scoreMilli} vs ${r.scoreMilli}`);
    check(r.terms && s.terms.g1 === r.terms.g1 && s.terms.pairs === r.terms.pairs, `${name}: the reported terms are the scorer's`);
    let absOk = true;
    for (let i = 0; i < 3 * topo.n; i++) if (Math.abs(r.poseAbs[i] - (pocket.center[i % 3] + r.poseCenti[i] / 100)) > 1e-9) absOk = false;
    check(absOk, `${name}: poseAbs = centre + pose / 100`);
    check(r.nrot === topo.nrot && r.heavyAtoms === topo.n && r.pocketHash === pocket.hash && r.topologyHash === topo.hash, `${name}: Result carries nrot, atoms and hashes`);
    console.log(`  ${name}: polish ${JSON.stringify({ nudged: r.polish.nudged, nudgeRounds: r.polish.nudgeRounds, lattice: `${r.polish.latticeAccepted}/${r.polish.latticeTried}`, gain: r.polish.latticeGain, candidates: r.polish.candidateScores })}`);
  }
  // force the nudge path: the ideal conformer pushed against the box wall (BOX after rounding) and a folded
  // conformer with an internal clash must both come back legal through polish()
  {
    const { polish } = await import('../js/engine/polish.js');
    const { makeWork } = await import('../js/engine/search.js');
    const c = AQ4_CASE;
    const pocket = loadPocket(hexToBytes(c.v.pocket_hex)), topo = loadTopology(hexToBytes(c.v.topology_hex));
    const lig = makeLigandModel(c.sdf, topo);
    const en = makeEnergyModel(pocket, topo, lig, getTables());
    const work = makeWork(lig, lig.n);
    const st = new Float64Array(lig.stateLength);
    lig.identityState(st);
    st[0] = pocket.half[0] - 0.5;   // half the ligand outside the box on +x
    const X = new Float64Array(3 * lig.n);
    lig.build(st, X);
    const pose0 = new Int16Array(3 * lig.n);
    for (let i = 0; i < 3 * lig.n; i++) pose0[i] = Math.round(X[i] * 100);
    check(checkGeometry(topo, pose0, pocket.halfCenti).reason === 'BOX', 'nudge fixture: the start pose fails BOX');
    const out = polish({ pocket, topology: topo, lig, en, state: st, work, rng: makeRng(5) });
    check(out.ok && out.stats.nudged && out.stats.nudgeRounds > 0, `polish nudges a BOX failure back to a legal pose (rounds ${out.stats.nudgeRounds}, kicks ${out.stats.kicks}, failures ${out.stats.failures.join(',')})`, out.reason);
    check(out.ok && scoreInt(pocket, topo, out.poseCenti).scoreMilli === out.scoreMilli, 'nudged pose re-scores to the reported number');
    check(Math.abs(en.floor - 2.26) < 1e-12 && Math.abs(en.half[0] - (pocket.half[0] - 0.06)) < 1e-12, 'polish restores the float margins afterwards');
    // internal clash: torsions set so that two far atoms overlap, if such a state exists among a few random tries
    let clashSt = null;
    const rng = makeRng(77);
    for (let tries = 0; tries < 400 && !clashSt; tries++) {
      lig.randomState(rng, pocket.half, st, 0.1);
      lig.build(st, X);
      for (let i = 0; i < 3 * lig.n; i++) pose0[i] = Math.round(X[i] * 100);
      if (checkGeometry(topo, pose0, pocket.halfCenti).reason === 'CLASH') clashSt = Float64Array.from(st);
    }
    if (clashSt) {
      const out2 = polish({ pocket, topology: topo, lig, en, state: clashSt, work, rng: makeRng(6) });
      check(out2.ok && out2.stats.nudged, `polish nudges a CLASH failure back to a legal pose (rounds ${out2.stats.nudgeRounds}, kicks ${out2.stats.kicks})`, out2.reason);
    } else {
      console.log('  no random CLASH state found in 400 tries (skipped the CLASH nudge check)');
    }
  }
}

// --------------------------------------------------------------------------------------------------------- derived
section('derived');
{
  const d = derived(-9289, 22);
  check(Math.abs(d.dG + 9.289) < 1e-12 && Math.abs(d.pKd - 6.808969162091436) < 1e-9 && Math.abs(d.kd - 1.5524972440741927e-07) / 1.55e-7 < 1e-9 && Math.abs(d.le - 0.42222727272727273) < 1e-12, 'derived(-9289, 22) equals the reference display block');
  check(band(-9) === 'strong' && band(-9.0001) === 'strong' && band(-8.999) === 'moderate' && band(-6) === 'moderate' && band(-5.999) === 'weak' && band(-0.001) === 'weak' && band(0) === 'none' && band(3) === 'none', 'energy bands at the edges');
  check(bandLabel(-10) === 'strong binder' && bandLabel(-7) === 'moderate binder' && bandLabel(-2) === 'weak binder' && bandLabel(1) === 'no binding', 'band labels are the copy deck strings');
  check(formatKd(1.55e-7).text === '155 nM' && formatKd(2.5e-10).text === '250 pM' && formatKd(3.2e-6).text === '3.2 uM' && formatKd(0.004).text === '4 mM' && formatKd(2).text === '2 M', 'Kd formatting units pM nM uM mM M');
  check(derived(0, 10).band === 'none' && derived(7157, 5).bandLabel === 'no binding', 'positive scores are no binding');
}

// ----------------------------------------------------------------------------------------------------------- reach
section('reach');
if (QUICK) {
  console.log('  skipped (--quick)');
} else {
  const t0 = performance.now();
  let lastProgress = null;
  const r = await dock({ pocket: hexToBytes(QUE_CASE.v.pocket_hex), topology: hexToBytes(QUE_CASE.v.topology_hex), ligand: QUE_CASE.sdf, seed: 1, budgetMs: 20000,
    onProgress: (p) => { lastProgress = p; } });
  const ms = performance.now() - t0;
  check(r.checks.ok && r.scoreMilli <= -7500, `quercetin into 1M17 reaches <= -7.5 kcal/mol within a 20 s budget (got ${r.scoreMilli} milli, ${r.steps} steps, ${r.search.stepsPerSecond} steps/s, ${Math.round(ms)} ms)`);
  check(ms < 24000, 'the 20 s budget run finished within 24 s', `${Math.round(ms)} ms`);
  check(lastProgress && lastProgress.stage === 'done' && lastProgress.done === 1 && lastProgress.best === r.scoreMilli, 'final progress event carries the integer score');
  console.log(`  score ${r.scoreMilli}, float affinity ${r.float.affinity.toFixed(3)}, ${r.evaluations} evaluations, timings ${JSON.stringify(r.timings)}`);
}


// ---------------------------------------------------------------------------------------------------------- method
section('method');
{
  const { METHOD_SCHEMA, METHOD_PRESETS, METHOD_DEFAULTS, validateMethod, resolveMethod, methodToCompact, methodToQuery, methodFromQuery, methodEquals, presetByName, resolveDockMethod } = await import('../js/engine/index.js');
  const { base64urlDecode } = await import('../js/engine/method.js');
  // schema: plain data that survives JSON, every field carries key, type, default and a one-sentence meaning
  const roundTrip = JSON.parse(JSON.stringify(METHOD_SCHEMA));
  check(JSON.stringify(roundTrip) === JSON.stringify(METHOD_SCHEMA) && roundTrip.version === 1 && roundTrip.maxBytes === 1024, 'METHOD_SCHEMA survives a JSON round trip');
  const flat = [];
  for (const f of METHOD_SCHEMA.fields) { flat.push(f); for (const g of f.fields || []) flat.push({ ...g, key: `${f.key}.${g.key}` }); }
  check(flat.every((f) => typeof f.key === 'string' && typeof f.type === 'string' && typeof f.meaning === 'string' && f.meaning.length > 10 && f.meaning.endsWith('.')), `every schema field has key, type and a meaning sentence (${flat.length} rows)`);
  check(flat.every((f) => !/[–—]/.test(f.meaning) && !/\p{Extended_Pictographic}/u.test(f.meaning)), 'schema sentences carry no dashes and no emoji');
  check(METHOD_SCHEMA.fields.map((f) => f.key).join(',') === 'name,version,budget,chains,temperature,moves,local,placement,flexible,candidates,lattice,seed', 'schema lists the twelve keys of SPEC 9.7 in order');
  const bounds = Object.fromEntries(flat.filter((f) => f.min !== undefined).map((f) => [f.key, [f.min, f.max]]));
  check(same(bounds['budget.ms'], [1000, 600000]) && same(bounds['budget.steps'], [60, 5000000]) && same(bounds.chains, [1, 32]) && same(bounds.temperature, [0.1, 5]) && same(bounds['moves.translate'], [0.05, 5]) && same(bounds['moves.rotate'], [1, 180]) && same(bounds['moves.torsion'], [1, 180]) && same(bounds['local.steps'], [0, 300]) && same(bounds.candidates, [1, 16]) && same(bounds.seed, [0, 4294967295]), 'schema bounds equal SPEC 9.7');
  // defaults: an empty method resolves to every default of the schema
  const empty = validateMethod({});
  check(empty.ok && empty.errors.length === 0, 'an empty object validates');
  const defaultsFromSchema = {};
  for (const f of METHOD_SCHEMA.fields) if (f.default !== null && f.default !== undefined) defaultsFromSchema[f.key] = f.default;
  check(methodToCompact(empty.method) === methodToCompact(defaultsFromSchema) && methodToCompact(empty.method) === methodToCompact(METHOD_DEFAULTS), 'the resolved empty method equals the schema defaults and METHOD_DEFAULTS');
  check(empty.method.chains === undefined && empty.method.seed === undefined, 'chains and seed stay absent when not given (from the budget, chosen by the lab)');
  check(validateMethod(undefined).ok && validateMethod('{}').ok && validateMethod('{"temperature": 2}').method.temperature === 2, 'validateMethod accepts JSON text');
  // presets
  check(METHOD_PRESETS.length === 7 && METHOD_PRESETS.map((p) => p.name).join('|') === 'Quick|Standard|Deep|Rigid ligand|Wide search|Fine local|Reproducible', 'the seven presets of SPEC 9.7 in order');
  for (const p of METHOD_PRESETS) {
    const r = validateMethod(p);
    check(r.ok && methodToCompact(r.method) === methodToCompact(p) && r.method.version === 1 && Buffer.byteLength(methodToCompact(p)) <= 1024, `preset ${p.name} validates, is fully resolved and fits 1024 bytes (${Buffer.byteLength(methodToCompact(p))})`, r.errors.join(' '));
    check(presetByName(p.name) === p && Object.isFrozen(p), `presetByName finds ${p.name} and the preset is frozen`);
  }
  check(METHOD_PRESETS[0].budget.ms === 10000 && METHOD_PRESETS[1].budget.ms === 30000 && METHOD_PRESETS[2].budget.ms === 90000, 'Quick 10 s, Standard 30 s, Deep 90 s');
  check(METHOD_PRESETS[3].flexible === false && METHOD_PRESETS[1].chains === undefined && METHOD_PRESETS[4].chains === 16 && METHOD_PRESETS[4].moves.translate > 1 && METHOD_PRESETS[4].local.steps < 30, 'Rigid ligand is rigid; Wide search has more chains, larger moves, shorter local');
  check(METHOD_PRESETS[5].chains === 4 && METHOD_PRESETS[5].moves.translate < 1 && METHOD_PRESETS[5].local.steps > 30 && METHOD_PRESETS[6].budget.steps > 0 && METHOD_PRESETS[6].budget.ms === undefined, 'Fine local has fewer chains, small moves, long local; Reproducible counts steps');
  check(methodEquals(METHOD_PRESETS[1], { name: 'Standard' }) && !methodEquals(METHOD_PRESETS[1], METHOD_PRESETS[0]), 'Standard equals the defaults with its name; presets differ from each other');
  // bounds and unknown keys are rejected with the right sentence
  const rejects = [
    [{ chains: 0 }, 'chains must be a whole number from 1 to 32.'],
    [{ chains: 33 }, 'chains must be a whole number from 1 to 32.'],
    [{ chains: 2.5 }, 'chains must be a whole number from 1 to 32.'],
    [{ temperature: 0.05 }, 'temperature must be a number from 0.1 to 5.'],
    [{ temperature: 5.1 }, 'temperature must be a number from 0.1 to 5.'],
    [{ temperature: '1' }, 'temperature must be a number from 0.1 to 5.'],
    [{ moves: { translate: 0.01 } }, 'moves.translate must be a number from 0.05 to 5.'],
    [{ moves: { rotate: 181 } }, 'moves.rotate must be a number from 1 to 180.'],
    [{ moves: { torsion: 0 } }, 'moves.torsion must be a number from 1 to 180.'],
    [{ moves: 3 }, 'moves must be an object with translate, rotate and torsion.'],
    [{ local: { steps: 301 } }, 'local.steps must be a whole number from 0 to 300.'],
    [{ local: { steps: -1 } }, 'local.steps must be a whole number from 0 to 300.'],
    [{ candidates: 17 }, 'candidates must be a whole number from 1 to 16.'],
    [{ candidates: 0 }, 'candidates must be a whole number from 1 to 16.'],
    [{ budget: { ms: 999 } }, 'budget.ms must be a whole number from 1000 to 600000.'],
    [{ budget: { ms: 600001 } }, 'budget.ms must be a whole number from 1000 to 600000.'],
    [{ budget: { steps: 59 } }, 'budget.steps must be a whole number from 60 to 5000000.'],
    [{ budget: { ms: 2000, steps: 100 } }, 'budget must have exactly one of ms or steps.'],
    [{ budget: {} }, 'budget must have exactly one of ms or steps.'],
    [{ budget: 5000 }, 'budget must be an object with ms or steps.'],
    [{ seed: -1 }, 'seed must be a whole number from 0 to 4294967295.'],
    [{ seed: 4294967296 }, 'seed must be a whole number from 0 to 4294967295.'],
    [{ placement: 'left' }, 'placement must be box or center.'],
    [{ flexible: 'yes' }, 'flexible must be true or false.'],
    [{ lattice: 1 }, 'lattice must be true or false.'],
    [{ version: 2 }, 'version must be 1.'],
    [{ name: '' }, 'name must be text of 1 to 40 characters.'],
    [{ name: 'x'.repeat(41) }, 'name must be text of 1 to 40 characters.'],
    [{ foo: 1 }, 'Unknown key: foo.'],
    [{ moves: { wiggle: 1 } }, 'Unknown key: moves.wiggle.'],
    [{ budget: { ms: 2000, hours: 1 } }, 'Unknown key: budget.hours.'],
    [{ local: { iters: 1 } }, 'Unknown key: local.iters.'],
    [[], 'The method must be a JSON object.'],
    [null, 'The method must be a JSON object.'],
    ['{bad', 'The method is not valid JSON.'],
  ];
  let rejected = 0;
  for (const [input, sentence] of rejects) {
    const r = validateMethod(input);
    if (!r.ok && r.method === null && r.errors.includes(sentence)) rejected++;
    else check(false, `rejects ${JSON.stringify(input)}`, `got ${JSON.stringify(r.errors)}`);
  }
  check(rejected === rejects.length, `${rejects.length} out-of-range, wrong-type and unknown-key inputs are rejected with the right sentence`);
  const multi = validateMethod({ chains: 0, foo: 1, moves: { rotate: 500 } });
  check(multi.errors.length === 3 && multi.errors[0] === 'Unknown key: foo.' && multi.errors.every((e) => !/[–—]/.test(e)), 'every error is reported at once, plain sentences without dashes');
  let threw = null; try { resolveMethod({ chains: 0 }); } catch (e) { threw = e; }
  check(threw && threw.message === 'chains must be a whole number from 1 to 32.' && threw.errors.length === 1, 'resolveMethod throws the first sentence');
  check(validateMethod({ name: '  Mine  ' }).method.name === 'Mine' && validateMethod({ chains: null, seed: null }).ok, 'name is trimmed; null means absent');
  // compact form: canonical, sorted keys, no whitespace, stable under reparse and key order
  const w = METHOD_PRESETS[4];
  const shuffled = { version: 1, placement: w.placement, moves: { torsion: w.moves.torsion, translate: w.moves.translate, rotate: w.moves.rotate }, name: w.name, budget: { ms: w.budget.ms }, chains: w.chains, temperature: w.temperature, local: { steps: w.local.steps }, flexible: w.flexible, candidates: w.candidates, lattice: w.lattice };
  const compact = methodToCompact(w);
  check(compact === methodToCompact(shuffled) && compact === methodToCompact(JSON.parse(compact)) && !/\s/.test(compact.replace(/"[^"]*"/g, '""')), 'compact JSON is canonical under key order and reparse, and has no whitespace outside strings');
  const keys = Object.keys(JSON.parse(compact));
  check(same(keys, keys.slice().sort()) && same(Object.keys(JSON.parse(compact).moves), ['rotate', 'torsion', 'translate']), 'compact JSON keys are sorted at every level');
  check(methodToCompact({ moves: { translate: 1.0 }, temperature: 1.20 }) === '{"moves":{"translate":1},"temperature":1.2}', 'numbers print in their shortest form');
  check(compact === '{"budget":{"ms":30000},"candidates":4,"chains":16,"flexible":true,"lattice":true,"local":{"steps":15},"moves":{"rotate":45,"torsion":90,"translate":2},"name":"Wide search","placement":"box","temperature":1.6,"version":1}', 'Wide search compact string is the expected one', compact);
  // query round trip
  const q = methodToQuery(w);
  check(/^[A-Za-z0-9_-]+$/.test(q), 'the share link value is base64url without padding');
  const back = methodFromQuery(q);
  check(back.ok && methodToCompact(back.method) === compact, 'methodFromQuery(methodToQuery(m)) resolves to the same method');
  check(methodFromQuery(q + '==').ok && methodFromQuery(' ' + q + ' ').ok, 'padding and surrounding spaces are tolerated');
  const bad = methodFromQuery('%%%'), bad2 = methodFromQuery(''), bad3 = methodFromQuery(methodToQuery({ chains: 99 }));
  check(!bad.ok && bad.errors[0] === 'The method link could not be decoded.' && !bad2.ok && !bad3.ok && bad3.errors[0] === 'chains must be a whole number from 1 to 32.', 'a bad link gives one sentence; a valid link with a bad method gives the method error');
  check(same(Array.from(base64urlDecode('AAECA_-w')), [0, 1, 2, 3, 255, 176]), 'base64url decodes - and _');
  const unicode = validateMethod({ name: 'Méthode été' });
  check(unicode.ok && methodFromQuery(methodToQuery(unicode.method)).method.name === 'Méthode été', 'non-ASCII names survive the query round trip');
  // resolveDockMethod: the merge rule of dock()
  const rd = resolveDockMethod({ budgetMs: 5000, seed: 3, method: { budget: { steps: 100 }, seed: 9 } });
  check(rd.method.budget.steps === 100 && rd.seed === 9, 'a budget and a seed inside the method beat the parameters');
  const rd2 = resolveDockMethod({ budgetMs: 5000, steps: 500, seed: 3, chains: 2, candidates: 3, method: { name: 'X' } });
  check(rd2.method.budget.steps === 500 && rd2.seed === 3 && rd2.method.chains === 2 && rd2.method.candidates === 3 && rd2.method.name === 'X', 'parameters fill the keys the method leaves out (steps beats budgetMs as before)');
  const rd3 = resolveDockMethod({ budgetMs: 200, steps: null, method: null });
  check(rd3.method.budget.ms === 1000 && rd3.seed === 1, 'a legacy budgetMs is clamped into the schema bound; the seed defaults to 1');
  threw = null; try { resolveDockMethod({ method: '{"chains": 0}' }); } catch (e) { threw = e; }
  check(threw && threw.name === 'MethodError' && threw.errors[0] === 'chains must be a whole number from 1 to 32.', 'resolveDockMethod throws a MethodError for a bad method');
  let rejectedByDock = null;
  try { await dock({ pocket: hexToBytes(AQ4_CASE.v.pocket_hex), topology: hexToBytes(AQ4_CASE.v.topology_hex), ligand: AQ4_CASE.sdf, method: { budget: { steps: 100 }, foo: 1 } }); } catch (e) { rejectedByDock = e; }
  check(rejectedByDock && rejectedByDock.name === 'MethodError' && rejectedByDock.errors[0] === 'Unknown key: foo.', 'dock() rejects an invalid method with a MethodError');
  // the knobs steer the search (AQ4, 200 steps, seed 5)
  const A = { pocket: hexToBytes(AQ4_CASE.v.pocket_hex), topology: hexToBytes(AQ4_CASE.v.topology_hex), ligand: AQ4_CASE.sdf };
  const run = (method, extra = {}) => dock({ ...A, seed: 5, method: { budget: { steps: 200 }, ...method }, ...extra });
  const poseOf = (r) => Array.from(r.poseCenti);
  const base = await run({});
  check(base.steps === 200 && base.checks.ok && base.method && base.method.budget.steps === 200 && base.method.seed === 5 && base.method.chains === base.chains, 'Result.method carries the steps run, the chain count and the seed');
  check(methodToCompact(base.methodRequested) === methodToCompact(resolveMethod({ budget: { steps: 200 }, seed: 5 })) && base.methodCompact === methodToCompact(base.method), 'Result.methodRequested is the resolved input; methodCompact is the canonical string of Result.method');
  check(['name', 'version', 'budget', 'chains', 'temperature', 'moves', 'local', 'placement', 'flexible', 'candidates', 'lattice', 'seed'].every((k) => base.method[k] !== undefined), 'Result.method has every key filled in');
  const legacy = await dock({ ...A, seed: 5, steps: 200 });
  check(same(poseOf(legacy), poseOf(base)) && legacy.scoreMilli === base.scoreMilli && legacy.evaluations === base.evaluations, 'dock({ steps }) equals dock({ method: { budget: { steps } } })');
  const replay = await dock({ ...A, method: base.method });
  check(same(poseOf(replay), poseOf(base)) && replay.scoreMilli === base.scoreMilli && replay.evaluations === base.evaluations, 'dock({ method: result.method }) replays the run exactly');
  const rigid = await run({ flexible: false });
  check(rigid.nrotSearch === 0 && rigid.nrot === 10 && rigid.checks.ok && !same(poseOf(rigid), poseOf(base)), `rigid ligand: no search rotors, Nrot still 10 in the score, pose differs (${rigid.scoreMilli} vs ${base.scoreMilli})`);
  const rigid2 = await run({ flexible: false });
  check(same(poseOf(rigid2), poseOf(rigid)) && rigid2.scoreMilli === rigid.scoreMilli, 'rigid ligand run is deterministic');
  const center = await run({ placement: 'center' });
  check(center.checks.ok && !same(poseOf(center), poseOf(base)), `placement center differs from box (${center.scoreMilli} vs ${base.scoreMilli})`);
  const hot = await run({ temperature: 5 });
  const cold = await run({ temperature: 0.1 });
  check(hot.search.accepted > cold.search.accepted && !same(poseOf(hot), poseOf(base)), `temperature steers acceptance (kT 5: ${hot.search.accepted}, kT 0.1: ${cold.search.accepted}, kT 1.2: ${base.search.accepted} of 200)`);
  const big = await run({ moves: { translate: 5, rotate: 180, torsion: 180 } });
  const tiny = await run({ moves: { translate: 0.05, rotate: 1, torsion: 1 } });
  check(!same(poseOf(big), poseOf(base)) && !same(poseOf(tiny), poseOf(base)) && tiny.search.accepted > big.search.accepted, `move sizes steer the search (accepted big ${big.search.accepted}, tiny ${tiny.search.accepted})`);
  const noLocal = await run({ local: { steps: 0 } });
  check(noLocal.evaluations < base.evaluations / 4 && !same(poseOf(noLocal), poseOf(base)), `local.steps 0 skips the local optimisation (${noLocal.evaluations} vs ${base.evaluations} evaluations)`);
  const noLattice = await run({ lattice: false });
  check(noLattice.polish.latticeTried === 0 && noLattice.polish.latticeAccepted === 0 && base.polish.latticeTried > 0 && noLattice.checks.ok && scoreInt(loadPocket(A.pocket), loadTopology(A.topology), noLattice.poseCenti).scoreMilli === noLattice.scoreMilli, 'lattice false skips the lattice descent and still reports scoreInt of the pose');
  const one = await run({ candidates: 1, chains: 1 });
  const many = await run({ candidates: 16, chains: 32 });
  check(one.polish.candidates === 1 && one.chains === 1 && many.chains === 32 && many.polish.candidates > 4 && many.polish.candidates <= 16, `candidates and chains are honoured (1/1 and ${many.polish.candidates}/32)`);
  const ms = await dock({ ...A, seed: 5, budgetMs: 1500, method: { placement: 'center' } });
  const msReplay = await dock({ ...A, method: ms.method });
  check(ms.methodRequested.budget.ms === 1500 && ms.method.budget.steps === ms.steps && same(poseOf(msReplay), poseOf(ms)) && msReplay.scoreMilli === ms.scoreMilli, `a budget.ms run (${ms.steps} steps) replays exactly from Result.method`);
  // every preset reaches a negative score on QUE x 1M17 within its budget or steps
  const Q = { pocket: hexToBytes(QUE_CASE.v.pocket_hex), topology: hexToBytes(QUE_CASE.v.topology_hex), ligand: QUE_CASE.sdf };
  const presetRows = [];
  for (const p of METHOD_PRESETS) {
    let method = p;
    if (QUICK) method = { ...p, budget: p.budget.ms != null ? { ms: Math.min(p.budget.ms, 2000) } : { steps: Math.min(p.budget.steps, 400) } };
    const t0 = performance.now();
    const r = await dock({ ...Q, seed: 1, method });
    const elapsed = performance.now() - t0;
    const limit = method.budget.ms != null ? method.budget.ms * 1.25 + 1500 : Infinity;
    check(r.checks.ok && r.scoreMilli < 0 && elapsed <= limit && r.method.name === p.name && r.steps === (method.budget.steps ?? r.steps), `preset ${p.name}${QUICK ? ' (reduced budget)' : ''}: negative score within its budget (${r.scoreMilli} milli, ${r.steps} steps, ${Math.round(elapsed)} ms)`);
    presetRows.push(`${p.name}: ${r.scoreMilli} milli, ${r.steps} steps, ${r.chains} chains, ${Math.round(elapsed)} ms`);
  }
  console.log(`  presets on QUE x 1M17 seed 1${QUICK ? ' (reduced budgets)' : ''}: ${presetRows.join('; ')}`);
}

// ---------------------------------------------------------------------------------------------------------- chrome
if (CHROME) {
  section('chrome');
  const { serveSite, chromeSession, ENGINE_PORT, ENGINE_CDP } = await import('./engine-bench.mjs');
  const site = await serveSite(ENGINE_PORT);
  let session = null;
  try {
    session = await chromeSession({ base: site.base, cdpPort: ENGINE_CDP });
    console.log(`  ${session.version} via ${site.base}`);
    const vec = await session.run('mode=vectors', 60000);
    if (check(!!vec.result, 'vectors page produced a result', JSON.stringify(vec.error))) {
      const bad = vec.result.vectors.filter((x) => x.code !== x.expect_code || (x.expect_code === 0 && x.scoreMilli !== x.expect));
      check(bad.length === 0 && vec.result.vectors.length === 15, `all 15 vectors score the same in Chrome`, JSON.stringify(bad));
    }
    check(vec.violations.length === 0 && vec.errors.length === 0, 'no CSP violations or console errors on the vectors page', `${vec.violations.join(' | ')} ${vec.errors.join(' | ')}`);
    const q = `mode=dock&vector=real_03_1M17_QUE_docked.json&sdf=tools/engine/fixtures/QUE_ideal.sdf&seed=7&steps=300`;
    const out = await session.run(q, 120000);
    if (check(!!out.result, 'worker dock produced a result', JSON.stringify(out.error) + ' ' + out.errors.join(' | '))) {
      const r = out.result.result;
      check(out.result.runMode === 'worker', 'the run used the Web Worker', out.result.runMode);
      check(r.steps === 300 && r.checks.ok, 'worker run: 300 steps, geometry ok', `${r.steps} ${r.checks.reason}`);
      check(NODE_FIXED && same(r.poseCenti, Array.from(NODE_FIXED.poseCenti)) && r.scoreMilli === NODE_FIXED.scoreMilli && r.evaluations === NODE_FIXED.evaluations,
        `Chrome pose equals the Node pose for the same seed and steps (cross-engine determinism)`, `chrome ${r.scoreMilli}/${r.evaluations} node ${NODE_FIXED && NODE_FIXED.scoreMilli}/${NODE_FIXED && NODE_FIXED.evaluations}`);
      check(out.result.samples.some((s) => s.stage === 'search') && out.result.samples.at(-1).stage === 'done', 'progress messages arrived through the worker');
      check(out.violations.length === 0 && out.errors.length === 0, 'no CSP violations or console errors during the worker run', `${out.violations.join(' | ')} ${out.errors.join(' | ')}`);
      console.log(`  chrome: score ${r.scoreMilli}, ${r.search.stepsPerSecond} steps/s, ${r.elapsedMs} ms, mode ${out.result.runMode}`);
    }
    // a method through the worker: Wide search at 300 steps must equal the same run in Node
    const wide = { ...PRESETS.find((p) => p.name === 'Wide search'), budget: { steps: 300 }, seed: 7 };
    const nodeWide = await dock({ pocket: hexToBytes(QUE_CASE.v.pocket_hex), topology: hexToBytes(QUE_CASE.v.topology_hex), ligand: QUE_CASE.sdf, method: wide });
    const qm = `mode=dock&vector=real_03_1M17_QUE_docked.json&sdf=tools/engine/fixtures/QUE_ideal.sdf&method=${toQuery(wide)}`;
    const outM = await session.run(qm, 120000);
    if (check(!!outM.result, 'worker dock with a method produced a result', JSON.stringify(outM.error) + ' ' + outM.errors.join(' | '))) {
      const r = outM.result.result;
      check(outM.result.runMode === 'worker' && r.steps === 300 && r.chains === 16 && r.method && r.method.name === 'Wide search' && r.method.seed === 7, 'worker honours the method (300 steps, 16 chains, name, seed)', `${r.steps} ${r.chains} ${r.method && r.method.name}`);
      check(same(r.poseCenti, Array.from(nodeWide.poseCenti)) && r.scoreMilli === nodeWide.scoreMilli && r.evaluations === nodeWide.evaluations && r.methodCompact === nodeWide.methodCompact, `Chrome Wide search pose equals Node's (${r.scoreMilli})`, `chrome ${r.scoreMilli}/${r.evaluations} node ${nodeWide.scoreMilli}/${nodeWide.evaluations}`);
      check(outM.violations.length === 0 && outM.errors.length === 0, 'no CSP violations or console errors during the method run', `${outM.violations.join(' | ')} ${outM.errors.join(' | ')}`);
    }
    const badQ = await session.run('mode=dock&vector=real_03_1M17_QUE_docked.json&sdf=tools/engine/fixtures/QUE_ideal.sdf&method=' + toQuery({ chains: 0, budget: { steps: 100 } }), 30000);
    check(!badQ.result && badQ.error && badQ.error.name === 'MethodError' && badQ.error.message === 'chains must be a whole number from 1 to 32.', 'the browser dock() rejects a bad method with the sentence', JSON.stringify(badQ.error));
  } finally {
    if (session) await session.close();
    await site.close();
  }
}

endSections();
console.log(`\n${pass} checks pass, ${fail} fail`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
