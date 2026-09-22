# Ponchem browser engine (js/engine)

The docking engine that runs in the visitor's browser: a float pose search in a Web Worker plus the bit-exact
integer scorer that the chain also runs. Framework-free ES modules, no dependencies, no build step. Everything
below implements SPEC.md 8.1 and SPEC-ENGINE.md sections 0 to 7 and 10.

Files (all under `js/engine/`):

| file | role |
|---|---|
| `index.js` | main-thread API (`parseSdf`, `loadPocket`, `loadTopology`, `ensureTables`, `scoreInt`, `dock`, `cancel`, `derived`, ...) |
| `worker.js` | module Worker: `start` / `progress` / `result` / `cancel` / `error` messages |
| `core.js` | one run from bytes to Result (prepare, search, refine, integer polish); shared by the worker and the in-thread fallback |
| `sdf.js` | V2000 parser, heavy atoms only, SDF order, `M  CHG` charges, explicit H counts |
| `format.js` | pocket and topology byte layouts (big-endian, DataView), pose bytes encode/decode |
| `tables.js` | the frozen `data/tables/tables.bin`, keccak256-verified, spot-checked, loaded once |
| `score.js` | the integer scorer and geometry proof (grid scan or full scan, identical sums) |
| `ligand.js` | rotor rule, torsion tree, coordinate build, gradient projection, state moves |
| `energy.js` | the smooth float objective with analytic gradients |
| `search.js` | BFGS local optimiser and the Monte Carlo chains |
| `polish.js` | int16 rounding, geometry proof, nudge on failure, lattice descent on the integer score |
| `derived.js` | dG, pKd, Kd, ligand efficiency, energy bands, Kd units |
| `keccak.js` | keccak256 (Ethereum) on BigInt lanes |
| `fmath.js` | deterministic `fexp`, `fsin`, `fcos` (only IEEE +, -, *, /, sqrt inside) |
| `prng.js` | xoshiro128** seeded by splitmix32 from a uint32; uniform directions and rotations without trigonometry |

Gates: `node tools/engine-test.mjs` (add `--chrome` for the Worker path in headless Chrome, `--quick` to skip the 20 s
reach test) and `node tools/engine-bench.mjs [--budgets 10,30,60] [--chrome]`.

## 1. The integer path (what the chain does, replicated bit for bit)

`scoreInt(pocket, topology, poseCenti)` runs the contract's `evaluate` in the contract's order: atom count, box,
bonds, 1-3 pairs, clash floor (every pair whose `near` bit is clear must be at r2 >= 48400), then the five term
sums over every ligand x pocket pair with r2 <= 640000 through the 27-cell grid of the pocket bytes. Numbers carry
coordinates, r2, the exact floor square root (table plus correction loop), d, the table values and the five sums
(all below 2^53); BigInt carries the five products, E_pico and the final division, which truncates toward zero.
Grid scan and full scan give the same sums (the test proves it on every vector). Cost on this Mac: erlotinib on
1M17 (29 x 796) 0.07 ms grid, 0.10 ms full scan.

Two things the spec text gets slightly wrong, where the reference and the vectors win:
- `DON_MASK` is `0x81A8` (bits 3, 5, 7, 8, 15: N_D, N_DA, O_D, O_DA, Met_D), not `0x8128`; terms.json row 23 (an
  O_D donor against O_A) only passes with `0x81A8`.
- Nothing else: all 15 pose vectors, the 32 term rows, the four table hashes and every spot value pass.

## 2. The float search

The ligand is the ideal conformer (SDF coordinates) with rigid fragments joined by rotatable bonds. The rotor rule
is the spec's (order 1, not a ring bond, both ends of heavy degree >= 2, no triple bond at either end, not an amide
C(=O)-N) and it agrees with the Python reference on all 152 catalog ligands and the 5 fixtures. The catalog's
`rotatableBonds` field (an RDKit count) differs from the rule on 14 ligands (paclitaxel 10 vs 14, brusatol 3 vs 5,
homoharringtonine 9 vs 11, ...); the scorer always uses the topology's Nrot, the search uses the rule's bonds.

Pose state: translation t (angstrom, box frame), unit quaternion q, one angle per rotor. Torsion k rotates the side
of its bond that does not contain the root atom (the root is the atom that minimises the total moving-set size, so
every moving set is a subtree: nested or disjoint), then X = R(q)(Y - c0) + t with c0 the ideal centroid. Any
sequence of such rotations keeps every bond and 1-3 distance exact, which is what the geometry proof checks; the
test builds random states and the largest deviation from the topology's ideal centi-angstrom values is the 0.5
centi rounding of the ideals themselves.

Objective (kcal/mol, float): the five Vina terms over ligand x pocket pairs within 8 A, tabulated per pair class
(none, hydrophobic, hydrogen bond) at 0.01 A of surface distance FROM THE FROZEN INTEGER TABLES (gauss1, gauss2 in
micro units, divided by 1e6) plus the exact piecewise terms, linearly interpolated; the same terms over ligand pairs
at graph distance >= 4; a clash penalty 50 c^2 + 5 c for every pair at graph distance >= 3 closer than 2.26 A
(the on-chain floor 2.20 plus rounding margin); a box penalty 20 o^2 + 2 o per coordinate beyond half - 0.06 A.
The affinity shown during the run is inter / (1 + 0.0585 Nrot). Gradients are analytic: Cartesian forces from the
table slopes, projected onto (dt, domega, dtheta) as force sum, torque about t, and per rotor the torque of the
moving set about the bond axis.

Search: C interleaved Monte Carlo chains (one chain per about 600 + 60 Nrot steps of the run, between 4 and 16,
so a longer run means more restarts and a flexible ligand keeps enough steps per chain to fold into the pocket),
each started at a random state (centre uniform inside 35 percent of the box, uniform random rotation, uniform
torsions) and locally optimised. Step i belongs to chain i mod C, so the trajectory up to any step count is
independent of the total. One step: one move (translate 1.0 A along a random
direction, rotate 20 degrees about a random axis, or turn one torsion by up to 60 degrees), BFGS local optimisation
with backtracking line search (30 iterations at most; the first trial step is clipped to 0.4 A / 0.3 rad / 0.5 rad
per torsion), Metropolis at kT = 1.2 kcal/mol on the total float energy, best kept per chain and overall. A pool
of the 12 best distinct minima (RMSD > 1 A apart, ranked as described under "Final stage" below) is kept for the
final stage. Acceptance is high (about 95 percent): after a local optimisation most moves land in a nearby basin
of similar energy, as in Vina.

Determinism: every random number comes from xoshiro128** seeded by the uint32 seed; nothing calls Math.random,
Math.exp, Math.sin, Math.cos or Math.hypot (V8 and JavaScriptCore differ in the last bits of those). `fmath.js`
provides exp, sin and cos from Taylor kernels with fdlibm-style range reduction (1 ulp against Math.* over the
ranges used), and the PRNG produces unit vectors and uniform quaternions by rejection sampling, so only correctly
rounded IEEE operations are ever executed. Consequence: the same seed and step count give the same pose on any
machine; the `--chrome` gate checks that a 300-step run in headless Chrome (Worker) reproduces Node's pose,
score and evaluation count exactly.

Budget: `steps` runs exactly that many steps (chains from the rule above unless `chains` is given). `budgetMs`
first runs a 300 ms warm-up search that is thrown away (the probe): its step rate gives the expected step count,
which sets the chain count and the first total; the real search then starts fresh from the seed, in blocks of
about 40 ms that yield to the event loop between blocks (progress and cancel get through), and the total is
re-estimated every 500 ms so the run ends near the budget (allowed because the trajectory never depends on the
total). A reserve of min(6 percent, 100 + 8 n + 4 n Nrot ms) is kept for refine and polish. The Result records
`steps` and `chains`; the test proves that a budget run replays exactly with `{ seed, steps, chains }`. Budget
runs land within 2 to 6 percent of the asked time on every bench row below.

Final stage: the pool ranks its minima by intermolecular energy plus 20 x (box and clash violation) rather than by
total energy, because the chain scores only the intermolecular part (a legal pose with a better inter beats one
with a better total). The best 6 distinct minima (RMSD > 1 A apart) get a 300-iteration BFGS, then each goes through
the integer polish; the candidate with the best INTEGER score is reported (`polish.candidateScores` lists all six).

## 3. The integer polish (float pose -> the int16 pose the chain accepts)

1. Round every coordinate to the nearest centi-angstrom, run the geometry proof.
2. On failure (a BOX or CLASH after rounding; BOND and PAIR13 cannot happen because torsions keep those distances
   exact), nudge: minimise the float objective again with the box and clash margins widened by 0.03 to 0.15 A, re-round,
   re-check, up to 12 rounds, then up to 40 more rounds with a small seeded random kick to the rigid body and
   torsions. Every round is counted (`polish.nudgeRounds`, `polish.kicks`, `polish.failures`). If nothing passes,
   the Result comes back with `checks.ok = false` and the first failing reason; the lab shows the copy deck's
   geometry fail note and never submits it.
3. Lattice descent on the integer score: whole-pose translations by 1 and 2 centi-A along each axis (they keep every
   intramolecular distance exactly, only the box check can fail), then 0.25 degree rigid rotations and torsion
   nudges re-rounded from the float state, each accepted when the proof passes and the integer score improves; up
   to 40 rounds. Typical gain 1 to 90 milli kcal/mol.

The reported `scoreMilli` is `scoreInt` of the reported `poseCenti`, nothing else (the test re-scores the pose).

Polish statistics observed: in the 27 bench runs below (3 ligands x 3 budgets x Node, Chrome, plus the earlier
tuning runs) and every test run, no candidate ever needed a nudge (0 of 162 polished candidates: the 0.06 A float
margins on the box and the clash floor absorb the int16 rounding). The nudge path is exercised by the test with a
pose pushed half outside the box (BOX after rounding, fixed in 1 round, no kick) and a random folded conformer with
an internal clash (fixed in a few rounds). Lattice descent accepted 1 to 27 of 40 to 970 tried moves per run and
gained 5 to 164 milli kcal/mol (median about 15 for quercetin and erlotinib, about 90 for paclitaxel).

## 4. Numbers on this Mac (Apple M3, Node 26.3, Chrome 153, one thread, seed 1, 1M17 pocket with 796 atoms)

Steps per second (one step = one move plus a BFGS local optimisation of about 60 to 80 energy evaluations):

| ligand | atoms / Nrot | Node steps/s | Node evals/s | Chrome Worker steps/s |
|---|---|---|---|---|
| QUE quercetin | 22 / 1 | 660 to 680 | 44,000 | 520 to 560 |
| AQ4 erlotinib | 29 / 10 | 450 to 505 | 34,000 to 38,000 | 320 to 370 |
| TA1 paclitaxel | 62 / 14 | 185 to 195 | 15,000 | 140 to 145 |

The Chrome rows ran while the Node bench was running on the same machine (about 15 to 25 percent lower rates than
Node alone; the two are the same V8, and a re-run of the Chrome 300-step determinism check alone gives 693 steps/s
for quercetin against Node's 685).

Integer score reached (kcal/mol, the chain's number for the final int16 pose; Quick = 10 s, Standard = 30 s, 60 s
stands in for Deep = 90 s):

| ligand | 10 s Node | 30 s Node | 60 s Node | 10 s Chrome | 30 s Chrome | 60 s Chrome |
|---|---|---|---|---|---|---|
| QUE quercetin | -9.742 | -9.744 | -9.744 | -9.720 | -9.744 | -9.744 |
| AQ4 erlotinib | -7.029 | -7.446 | -7.442 | -7.029 | -7.446 | -7.442 |
| TA1 paclitaxel | -7.246 | -7.380 | -8.319 | -7.246 | -7.299 | -7.559 |

Where the step counts of a Node run and a Chrome run happen to fall in the same stretch the scores are identical
(erlotinib 10 s: 4580 vs 2908 steps, both -7.029, the best pose was found early; quercetin 30 and 60 s both
-9.744), which is the determinism at work: the trajectory is the same, only the cut differs. Paclitaxel in
erlotinib's box is the pathological case (62 atoms folded into a 20 x 12 x 12.5 A box): scores vary by about
1 kcal/mol with the seed and the step count.

Per-evaluation cost (erlotinib, 29 atoms, 796 pocket atoms): float energy with gradient 36 us, coordinate build
0.8 us, integer score 70 us (grid) / 100 us (full scan). Quercetin reaches -9.7 in about 3 s of search.

Reference points: the Python reference's vectors are erlotinib refined -6.446, quercetin docked -9.289 (28 s of
numpy), paclitaxel docked -2.837 (81 s). Vina's published erlotinib on 1M17 is about -7 to -8.5.

## 5. API for the lab builder

```js
import { parseSdf, loadPocket, loadTopology, ensureTables, scoreInt, dock, cancel, derived, formatKd, formatDg, encodePose }
  from '/js/engine/index.js';

// data from js/catalog.js: fetchLigandSdf(key) -> text, fetchPocket(pdbId) -> Uint8Array, fetchTopology(key) -> Uint8Array
const pocket = loadPocket(pocketBytes);       // { pdbId, n, center [A abs], half [A], atoms, types, hash, halfCenti, grid, ... }
const topology = loadTopology(topologyBytes); // { n, types, bonds, pairs12, pairs13, nrot, hash, ... }
const ligand = parseSdf(sdfText);             // { atoms: [{ el, x, y, z }], bonds: [[i, j, order]], heavyAtoms }

const result = await dock({
  pocket, topology, ligand,
  seed: 1,                 // uint32; "Randomise" picks one; show it in the Seed row
  budgetMs: 30000,         // Quick 10000, Standard 30000, Deep 90000 (or steps: N to replay a run)
  onProgress: ({ stage, done, best, evaluations, steps }) => {
    // stage: 'prepare' | 'search' | 'refine' | 'score' | 'done'  -> copy deck stages
    //   Preparing pocket | Pose search | Refining | Final integer score
    // done 0..1; best: during the search the browser estimate in milli kcal/mol (float affinity), at 'done' the integer score
    // caption: `Pose search · ${Math.round(done * 100)}% · best so far ${formatDg(best / 1000)} kcal/mol`
  },
});
// result.checks.ok === false -> show the geometry fail note, offer Run again, never submit
// result.scoreMilli  -> the integer score (int32 milli kcal/mol); the chain recomputes exactly this number
// result.poseCenti   -> Int16Array(3n), the int16[] pose for submitRun / quote (js/lab.js buildSubmitRun takes it)
// result.poseAbs     -> Float64Array(3n) absolute angstrom for the 3D viewer (centre + pose / 100)
// result.steps, result.chains -> replay with dock({ ..., seed: result.seed, steps: result.steps, chains: result.chains })
// result.elapsedMs, result.evaluations, result.nrot, result.heavyAtoms, result.terms, result.polish, result.search, result.timings
const d = derived(result.scoreMilli, result.heavyAtoms);
// d.dG (kcal/mol), d.pKd, d.kd (mol/L), d.le (kcal/mol per heavy atom), d.band ('strong'|'moderate'|'weak'|'none'), d.bandLabel
// formatDg(d.dG) -> '-8.412'; formatKd(d.kd) -> { value, unit: 'nM', text: '155 nM' }
// cancel() -> the pending dock() rejects with an Error named 'CancelledError' (the Stop button)
// scoreInt(pocket, topology, poseCenti) needs the tables: await ensureTables() once (dock() does it itself)
```

Rules that follow from the engine:
- Show the float estimate only as "browser estimate" during the run; the RESULT card shows `result.scoreMilli`.
- A second `dock()` while one runs rejects with `engine busy`; call `cancel()` first.
- The Worker fetches `data/tables/tables.bin` itself (same origin, `connect-src 'self'`), verifies its keccak256
  and refuses a corrupted file. Pass `tables: Uint8Array` to `dock()` to skip the fetch.
- Workers unavailable or failing to load (4 s ready timeout): the same run happens on the main thread, yielding
  every ~40 ms; `lastRunMode()` says which path ran.
- The ligand SDF must have exactly the topology's heavy atoms in the same order (data/ligands/<KEY>.sdf do);
  `dock` throws otherwise.
- Pairs whose ideal conformer cannot fit the box still run (the search folds the ligand); the site may hide them
  with `pocket.half` against the ligand extent.

## 6. Worker protocol (js/engine/worker.js)

main -> worker: `{ type: 'start', id, pocket: Uint8Array, topology: Uint8Array, ligand, seed, budgetMs | steps, tables?, chains?, candidates? }`,
`{ type: 'cancel', id }`. worker -> main: `{ type: 'ready' }` once at load, `{ type: 'progress', id, stage, done, best, evaluations, steps }`
(at most every 100 ms), `{ type: 'result', id, result }`, `{ type: 'error', id, message, cancelled }`. `index.js` terminates a worker
that does not answer a cancel within 1.5 s and spawns a fresh one next time.

## 7. Known limits

- Mirror images pass the proof (distances only); documented in SPEC-ENGINE.md.
- The float tables interpolate the gauss terms linearly at 0.01 A, so the float energy differs from the integer
  scorer by a few milli kcal/mol; the integer scorer is the only number shown.
- Speed scales with pocket density and ligand size: paclitaxel (62 atoms, 14 rotors) runs about 4x slower per step
  than quercetin. A 10 s Quick run still finds a valid pose for every catalog ligand tried.
- `data/registry.json`, `data/pockets/*.bin` and `data/topologies/*.bin` did not exist while this was built; the
  tests use the pocket and topology bytes registered in `data/vectors/*.json` (1M17 with AQ4, QUE, TA1) and switch
  to `data/topologies` for the rotor check as soon as the folder exists.

## 8. Bench rows (node tools/engine-bench.mjs --budgets 10,30,60, and --chrome-only for the Worker path)

```
node           AQ4  10 s  score  -7029    504 steps/s  4580 steps   9479 ms
node           AQ4  30 s  score  -7446    452 steps/s  12763 steps  28603 ms
node           AQ4  60 s  score  -7442    465 steps/s  27039 steps  58571 ms
node           QUE  10 s  score  -9742    679 steps/s  6337 steps   9661 ms
node           QUE  30 s  score  -9744    661 steps/s  19396 steps  29661 ms
node           QUE  60 s  score  -9744    673 steps/s  39961 steps  59682 ms
node           TA1  10 s  score  -7246    193 steps/s  1750 steps   9719 ms
node           TA1  30 s  score  -7380    194 steps/s  5406 steps   28430 ms
node           TA1  60 s  score  -8319    185 steps/s  10391 steps  56685 ms
chrome-worker  AQ4  10 s  score  -7029    321 steps/s  2908 steps   9481 ms
chrome-worker  AQ4  30 s  score  -7446    372 steps/s  10480 steps  28611 ms
chrome-worker  AQ4  60 s  score  -7442    365 steps/s  21256 steps  58611 ms
chrome-worker  QUE  10 s  score  -9720    520 steps/s  4852 steps   9692 ms
chrome-worker  QUE  30 s  score  -9744    557 steps/s  16318 steps  29671 ms
chrome-worker  QUE  60 s  score  -9744    342 steps/s  20270 steps  59605 ms
chrome-worker  TA1  10 s  score  -7246    144 steps/s  1306 steps   9750 ms
chrome-worker  TA1  30 s  score  -7299    140 steps/s  3892 steps   28622 ms
chrome-worker  TA1  60 s  score  -7559    145 steps/s  8120 steps   56846 ms
```

Gate results at the time of writing: `node tools/engine-test.mjs --chrome` 208 checks pass, 0 fail (tables 17,
terms 33, vectors 97, sdf 13, model 11, determinism 7, polish 13, derived 5, reach 3, chrome 9).
