# Ponchem browser engine (js/engine)

The docking engine that runs in the visitor's browser: a float pose search in a Web Worker plus the bit-exact
integer scorer that the chain also runs. Framework-free ES modules, no dependencies, no build step. Everything
below implements SPEC.md 8.1 and 9.7 and SPEC-ENGINE.md sections 0 to 7 and 10.

Files (all under `js/engine/`):

| file | role |
|---|---|
| `index.js` | main-thread API (`parseSdf`, `loadPocket`, `loadTopology`, `ensureTables`, `scoreInt`, `dock`, `cancel`, `derived`, the method exports, ...) |
| `worker.js` | module Worker: `start` / `progress` / `result` / `cancel` / `error` messages |
| `core.js` | one run from bytes to Result (prepare, search, refine, integer polish); the method merge rule; shared by the worker and the in-thread fallback |
| `method.js` | the docking method of SPEC 9.7: `METHOD_SCHEMA`, `METHOD_PRESETS`, `validateMethod`, `resolveMethod`, compact JSON, share link (v2) |
| `sdf.js` | V2000 parser, heavy atoms only, SDF order, `M  CHG` charges, explicit H counts |
| `format.js` | pocket and topology byte layouts (big-endian, DataView), pose bytes encode/decode |
| `tables.js` | the frozen `data/tables/tables.bin`, keccak256-verified, spot-checked, loaded once |
| `score.js` | the integer scorer and geometry proof (grid scan or full scan, identical sums) |
| `ligand.js` | rotor rule, torsion tree, coordinate build, gradient projection, state moves, rigid mode |
| `energy.js` | the smooth float objective with analytic gradients |
| `search.js` | BFGS local optimiser and the Monte Carlo chains, with the method's knobs |
| `polish.js` | int16 rounding, geometry proof, nudge on failure, lattice descent on the integer score (switchable) |
| `derived.js` | dG, pKd, Kd, ligand efficiency, energy bands, Kd units |
| `keccak.js` | keccak256 (Ethereum) on BigInt lanes |
| `fmath.js` | deterministic `fexp`, `fsin`, `fcos` (only IEEE +, -, *, /, sqrt inside) |
| `prng.js` | xoshiro128** seeded by splitmix32 from a uint32; uniform directions and rotations without trigonometry |

Gates: `node tools/engine-test.mjs` (add `--chrome` for the Worker path in headless Chrome on port 6134 / CDP 9543,
`--quick` to skip the 20 s reach test and shrink the preset budgets) and
`node tools/engine-bench.mjs [--budgets 10,30,60] [--presets | --method "Wide search"] [--chrome]`.

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
With the method's `flexible: false` the rotor list is empty (the ideal conformer moves as one rigid body, state
length 7); the topology's Nrot still divides the score, because that is the chain's number and not a search choice.

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

Search: C interleaved Monte Carlo chains (`chains` of the method; absent, one chain per about 600 + 60 Nrot steps
of the run, between 4 and 16, so a longer run means more restarts and a flexible ligand keeps enough steps per
chain to fold into the pocket), each started at a random state (`placement`: `box` puts the centroid uniformly
anywhere in the box, `center` inside 35 percent of the half size around the middle; uniform random rotation,
uniform torsions) and locally optimised. Step i belongs to chain i mod C, so the trajectory up to any step count is
independent of the total. One step: one move (translate `moves.translate` A along a random direction, rotate
`moves.rotate` degrees about a random axis, or turn one torsion by up to `moves.torsion` degrees; a rigid ligand
only translates and rotates), BFGS local optimisation with backtracking line search (`local.steps` iterations at
most, 0 keeps the raw move; the first trial step is clipped to 0.4 A / 0.3 rad / 0.5 rad per torsion), Metropolis
at kT = `temperature` kcal/mol on the total float energy, best kept per chain and overall. A pool of the best
distinct minima (RMSD > 1 A apart, at least 12, `candidates` when larger, ranked as described under "Final
stage" below) is kept for the final stage. With the defaults (1.0 A, 20 degrees, 60 degrees, 30 iterations,
kT 1.2) acceptance is high (about 95 percent): after a local optimisation most moves land in a nearby basin of
similar energy, as in Vina.

Determinism: every random number comes from xoshiro128** seeded by the uint32 seed; nothing calls Math.random,
Math.exp, Math.sin, Math.cos or Math.hypot (V8 and JavaScriptCore differ in the last bits of those). `fmath.js`
provides exp, sin and cos from Taylor kernels with fdlibm-style range reduction (1 ulp against Math.* over the
ranges used), and the PRNG produces unit vectors and uniform quaternions by rejection sampling, so only correctly
rounded IEEE operations are ever executed. Consequence: the same seed, method and step count give the same pose
on any machine; the `--chrome` gate checks that a 300-step run in headless Chrome (Worker) reproduces Node's
pose, score and evaluation count exactly, once with the defaults and once with the Wide search preset.

Budget: `budget.steps` runs exactly that many steps (chains from the rule above unless `chains` is given).
`budget.ms` first runs a 300 ms warm-up search that is thrown away (the probe, with the same knobs): its step rate
gives the expected step count, which sets the chain count and the first total; the real search then starts fresh
from the seed, in blocks of about 40 ms that yield to the event loop between blocks (progress and cancel get
through), and the total is re-estimated every 500 ms so the run ends near the budget (allowed because the
trajectory never depends on the total). A reserve of min(6 percent, 100 + 8 n + 4 n Nrot ms) is kept for refine
and polish. The Result records `steps` and `chains` and `method` (the reproducible form, section 2a); the test
proves that a budget run replays exactly from `Result.method`. Budget runs land within 2 to 6 percent of the
asked time on every bench row below.

Final stage: the pool ranks its minima by intermolecular energy plus 20 x (box and clash violation) rather than by
total energy, because the chain scores only the intermolecular part (a legal pose with a better inter beats one
with a better total). The best `candidates` distinct minima (4 by default, 6 in Deep, 1 to 16) get a 300-iteration
BFGS, then each goes through the integer polish; the candidate with the best INTEGER score is reported
(`polish.candidateScores` lists them all).

## 2a. The docking method (SPEC 9.7, `js/engine/method.js`)

A method is a plain JSON object. The chain's scoring function is not part of it; it only steers the search that
prepares the pose. The schema, with the bounds and the defaults, is `METHOD_SCHEMA` (plain data: `fields[]` with
`key`, `type`, `min`/`max` or `values`, `unit`, `default`, `defaultText`, `meaning`, nested `fields` for
`budget`, `moves` and `local`; the docs page renders it as it is):

| key | type | bound | default | steers |
|---|---|---|---|---|
| `name` | text | 1 to 40 characters | `Custom` | the label in the lab and on the test page |
| `version` | integer | 1 | 1 | the schema version |
| `budget` | `{ ms }` or `{ steps }` | ms 1000 to 600000, steps 60 to 5000000 | `{ ms: 30000 }` | wall clock, or an exact step count (reproducible) |
| `chains` | integer | 1 to 32 | absent = from the budget (4 to 16) | restarts that take turns step by step |
| `temperature` | number | 0.1 to 5 kcal/mol | 1.2 | Metropolis kT |
| `moves.translate` | number | 0.05 to 5 A | 1 | the translation move |
| `moves.rotate` | number | 1 to 180 degrees | 20 | the rotation move |
| `moves.torsion` | number | 1 to 180 degrees | 60 | the largest torsion turn (ignored when rigid) |
| `local.steps` | integer | 0 to 300 | 30 | BFGS iterations after each move |
| `placement` | `box` or `center` | | `box` | where chains start |
| `flexible` | boolean | | true | false freezes the torsions at the ideal conformer |
| `candidates` | integer | 1 to 16 | 4 | poses refined and polished at the end |
| `lattice` | boolean | | true | the integer lattice descent in the polish |
| `seed` | integer | 0 to 4294967295 | absent = chosen by the lab | the PRNG seed |

Functions (all re-exported by `index.js`):

- `validateMethod(json)` -> `{ ok, method, errors }`. Takes an object or JSON text. `method` is the resolved
  object with every default filled in (`chains` and `seed` stay absent when not given); `errors` are plain
  sentences that name the key or the bound, all of them at once: `Unknown key: moves.wiggle.`,
  `chains must be a whole number from 1 to 32.`, `temperature must be a number from 0.1 to 5.`,
  `budget must have exactly one of ms or steps.`, `placement must be box or center.`, `flexible must be true or
  false.`, `version must be 1.`, `name must be text of 1 to 40 characters.`, `The method must be a JSON object.`,
  `The method is not valid JSON.`, `The method must be at most 1024 bytes as compact JSON.` Null means absent.
  The name is trimmed; control characters are refused.
- `resolveMethod(partial)` -> the resolved method, or throws (message = the first sentence, `.errors` = all).
- `methodToCompact(method)` -> canonical compact JSON: keys sorted at every level, no whitespace outside strings,
  numbers as JSON prints them (`1.0` becomes `1`). This is the string for `submitRun(..., method)` and its keccak;
  the same method in any key order gives the same string. Every preset fits in 175 to 215 bytes; the 1024-byte
  chain limit is enforced by the validator.
- `methodToQuery(method)` -> base64url (no padding) of the compact JSON, for `?method=`; `methodFromQuery(text)`
  -> a `validateMethod` result (`The method link could not be decoded.` when the text is not base64url or not
  UTF-8; padding and surrounding spaces are tolerated). Non-ASCII names survive the round trip.
- `methodEquals(a, b)`, `presetByName(name)`, `METHOD_DEFAULTS`, `METHOD_VERSION`, `METHOD_MAX_BYTES`,
  `METHOD_NAME_MAX`.
- `resolveDockMethod(params)` (core.js) is the merge rule of `dock()`: a value inside the method beats the same
  value passed as a parameter (`budgetMs`, `steps`, `chains`, `candidates`, `seed`); a parameter fills a key the
  method leaves out (`steps` beats `budgetMs`, as before); then the defaults apply. Legacy parameters are clamped
  into their bounds as before, values inside the method are validated and `dock()` rejects with an Error named
  `MethodError` (`.errors` lists every sentence). `dock()` with no method and no budget still rejects with
  `dock needs budgetMs, steps or a method`.

`Result.method` is the reproducible form: the resolved method with `budget: { steps }` set to the steps actually
run, `chains` set to the count used and `seed` filled. `dock({ method: result.method })` replays the run bit for
bit (the test proves it for a steps run and for a budget.ms run). `Result.methodCompact` is its canonical string,
`Result.methodRequested` the resolved method as it was asked (budget in ms when it was). The lab should put
`methodCompact` on chain: it names the preset, carries the exact step count, the chain count and the seed.

Presets (`METHOD_PRESETS`, in the lab's order; each is a full frozen method object with `version: 1`). Scores are
the integer score in kcal/mol on the 1M17 pocket, seed 1, Node on this Mac with the three ligands benched in three
processes at once while the other builders' gates ran (so the step rates below are about half of section 4):

| preset | budget | chains | kT | moves A / deg / deg | local | placement | flexible | candidates | lattice | QUE quercetin | AQ4 erlotinib | TA1 paclitaxel |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Quick | 10 s | auto | 1.2 | 1 / 20 / 60 | 30 | box | yes | 4 | yes | -9.731 (3519 steps) | -6.660 (2422) | -6.303 (659) |
| Standard | 30 s | auto | 1.2 | 1 / 20 / 60 | 30 | box | yes | 4 | yes | -9.742 (12036) | -7.472 (6652) | -6.120 (1848) |
| Deep | 90 s | auto | 1.2 | 1 / 20 / 60 | 30 | box | yes | 6 | yes | -9.734 (40707) | -7.440 (20537) | -6.864 (10203) |
| Rigid ligand | 30 s | auto | 1.2 | 1 / 20 / 60 | 30 | box | no | 4 | yes | -8.708 (14129) | -5.848 (6949) | +53.350 (3921) |
| Wide search | 30 s | 16 | 1.6 | 2 / 45 / 90 | 15 | box | yes | 4 | yes | -9.740 (19855) | -7.466 (17966) | -8.283 (5872) |
| Fine local | 30 s | 4 | 0.8 | 0.5 / 10 / 30 | 80 | center | yes | 4 | yes | -9.279 (14347) | -6.980 (4505) | -7.366 (1304) |
| Reproducible | 8000 steps | 8 | 1.2 | 1 / 20 / 60 | 30 | box | yes | 4 | yes | -9.739 (22 s) | -7.354 (38 s) | -6.330 (156 s) |

Reading the table: quercetin (22 atoms, 1 rotor) is solved by every flexible preset within 10 s (-9.73 to
-9.75); erlotinib (10 rotors) needs 30 s for -7.4 to -7.5; paclitaxel (62 atoms, 14 rotors, in erlotinib's
20 x 12 x 12.5 A box) is the pathological case and Wide search (short local, big moves, 16 chains) is the preset
that folds it best. Rigid ligand freezes the ideal conformer: quercetin loses 1 kcal/mol, erlotinib 1.6, and the
rigid paclitaxel conformer cannot fit the box at all, so the best legal pose scores +53 (the polish still returns a
pose that passes the proof; the lab shows the chain's number as it is). Fine local (small moves, low kT, four
chains, 80 local iterations, centre start) refines the basin it starts in and is meant for that; it is not a
global search. Reproducible runs exactly 8000 steps, about 12 s for quercetin alone on this Mac and about 45 s for
paclitaxel alone (three times that under the parallel bench). Placement: `box` and `center` were compared at 10 s
on the three ligands with two seeds and land inside the seed-to-seed noise (box better on AQ4 seed 1 and TA1 seed 2,
center better on the other two rows, quercetin identical), so `box`, the form SPEC 9.7 shows, is the default.

## 3. The integer polish (float pose -> the int16 pose the chain accepts)

1. Round every coordinate to the nearest centi-angstrom, run the geometry proof.
2. On failure (a BOX or CLASH after rounding; BOND and PAIR13 cannot happen because torsions keep those distances
   exact), nudge: minimise the float objective again with the box and clash margins widened by 0.03 to 0.15 A, re-round,
   re-check, up to 12 rounds, then up to 40 more rounds with a small seeded random kick to the rigid body and
   torsions. Every round is counted (`polish.nudgeRounds`, `polish.kicks`, `polish.failures`). If nothing passes,
   the Result comes back with `checks.ok = false` and the first failing reason; the lab shows the copy deck's
   geometry fail note and never submits it.
3. Lattice descent on the integer score (skipped when the method says `lattice: false`): whole-pose translations
   by 1 and 2 centi-A along each axis (they keep every intramolecular distance exactly, only the box check can
   fail), then 0.25 degree rigid rotations and torsion nudges re-rounded from the float state, each accepted when
   the proof passes and the integer score improves; up to 40 rounds. Typical gain 1 to 90 milli kcal/mol.

The reported `scoreMilli` is `scoreInt` of the reported `poseCenti`, nothing else (the test re-scores the pose,
with and without the lattice).

Polish statistics observed: in the 27 bench runs below (3 ligands x 3 budgets x Node, Chrome, plus the earlier
tuning runs), the 21 preset runs above and every test run, no candidate ever needed a nudge (the 0.06 A float
margins on the box and the clash floor absorb the int16 rounding). The nudge path is exercised by the test with a
pose pushed half outside the box (BOX after rounding, fixed in 1 round, no kick) and a random folded conformer with
an internal clash (fixed in a few rounds). Lattice descent accepted 1 to 27 of 40 to 970 tried moves per run and
gained 5 to 164 milli kcal/mol (median about 15 for quercetin and erlotinib, about 90 for paclitaxel).

## 4. Numbers on this Mac (Apple M3, Node 26.3, Chrome 153, one thread, seed 1, 1M17 pocket with 796 atoms)

Steps per second (one step = one move plus a BFGS local optimisation of about 60 to 80 energy evaluations), with
the default method:

| ligand | atoms / Nrot | Node steps/s | Node evals/s | Chrome Worker steps/s |
|---|---|---|---|---|
| QUE quercetin | 22 / 1 | 660 to 680 | 44,000 | 520 to 560 |
| AQ4 erlotinib | 29 / 10 | 450 to 505 | 34,000 to 38,000 | 320 to 370 |
| TA1 paclitaxel | 62 / 14 | 185 to 195 | 15,000 | 140 to 145 |

The Chrome rows ran while the Node bench was running on the same machine (about 15 to 25 percent lower rates than
Node alone; the two are the same V8, and a re-run of the Chrome 300-step determinism check alone gives 693 steps/s
for quercetin against Node's 685). Wide search (15 local iterations) runs about 1.4 to 3 times more steps per
second than the default; Fine local (80 iterations) about half.

Integer score reached (kcal/mol, the chain's number for the final int16 pose; Quick = 10 s, Standard = 30 s, 60 s
stands in for Deep = 90 s; v1 engine, placement 35 percent, 6 candidates):

| ligand | 10 s Node | 30 s Node | 60 s Node | 10 s Chrome | 30 s Chrome | 60 s Chrome |
|---|---|---|---|---|---|---|
| QUE quercetin | -9.742 | -9.744 | -9.744 | -9.720 | -9.744 | -9.744 |
| AQ4 erlotinib | -7.029 | -7.446 | -7.442 | -7.029 | -7.446 | -7.442 |
| TA1 paclitaxel | -7.246 | -7.380 | -8.319 | -7.246 | -7.299 | -7.559 |

Where the step counts of a Node run and a Chrome run happen to fall in the same stretch the scores are identical
(erlotinib 10 s: 4580 vs 2908 steps, both -7.029, the best pose was found early; quercetin 30 and 60 s both
-9.744), which is the determinism at work: the trajectory is the same, only the cut differs. Paclitaxel in
erlotinib's box is the pathological case (62 atoms folded into a 20 x 12 x 12.5 A box): scores vary by about
1 kcal/mol with the seed and the step count. The v2 defaults (placement box, 4 candidates) give the same picture:
the presets table in section 2a is the current reference.

Per-evaluation cost (erlotinib, 29 atoms, 796 pocket atoms): float energy with gradient 36 us, coordinate build
0.8 us, integer score 70 us (grid) / 100 us (full scan). Quercetin reaches -9.7 in about 3 s of search.

Reference points: the Python reference's vectors are erlotinib refined -6.446, quercetin docked -9.289 (28 s of
numpy), paclitaxel docked -2.837 (81 s). Vina's published erlotinib on 1M17 is about -7 to -8.5.

## 5. API for the lab builder

```js
import { parseSdf, loadPocket, loadTopology, ensureTables, scoreInt, dock, cancel, derived, formatKd, formatDg, encodePose,
         METHOD_SCHEMA, METHOD_PRESETS, validateMethod, methodToCompact, methodToQuery, methodFromQuery, presetByName }
  from '/js/engine/index.js';

// data from js/catalog.js: fetchLigandSdf(key) -> text, fetchPocket(pdbId) -> Uint8Array, fetchTopology(key) -> Uint8Array
const pocket = loadPocket(pocketBytes);       // { pdbId, n, center [A abs], half [A], atoms, types, hash, halfCenti, grid, ... }
const topology = loadTopology(topologyBytes); // { n, types, bonds, pairs12, pairs13, nrot, hash, ... }
const ligand = parseSdf(sdfText);             // { atoms: [{ el, x, y, z }], bonds: [[i, j, order]], heavyAtoms }

// the method: a preset, a saved method, an imported JSON or a ?method= link, always through validateMethod first
const picked = presetByName('Standard');                    // or validateMethod(editorText).method, or methodFromQuery(q).method
const method = { ...picked, seed: seedFromTheSeedRow };     // the lab fills the seed when the method has none

const result = await dock({
  pocket, topology, ligand,
  method,                  // a method object or its compact JSON; a value inside it beats budgetMs / steps / chains / candidates / seed
  onProgress: ({ stage, done, best, evaluations, steps }) => {
    // stage: 'prepare' | 'search' | 'refine' | 'score' | 'done'  -> copy deck stages
    //   Preparing pocket | Pose search | Refining | Final integer score
    // done 0..1; best: during the search the browser estimate in milli kcal/mol (float affinity), at 'done' the integer score
    // caption: `Pose search · ${Math.round(done * 100)}% · best so far ${formatDg(best / 1000)} kcal/mol`
  },
});
// dock({ pocket, topology, ligand, seed, budgetMs: 30000 }) still works: the legacy parameters become the method's budget and seed
// result.checks.ok === false -> show the geometry fail note, offer Run again, never submit
// result.scoreMilli  -> the integer score (int32 milli kcal/mol); the chain recomputes exactly this number
// result.poseCenti   -> Int16Array(3n), the int16[] pose for submitRun / quote (js/lab.js buildSubmitRun takes it)
// result.poseAbs     -> Float64Array(3n) absolute angstrom for the 3D viewer (centre + pose / 100)
// result.method      -> the reproducible method: budget { steps: result.steps }, chains, seed, every default filled in
// result.methodCompact -> its canonical JSON (sorted keys, no whitespace), the string for submitRun(..., method) and the
//                       `Use this method` link (methodToQuery(result.method)); at most 1024 bytes by construction
// result.methodRequested -> the resolved method as asked (budget in ms when it was); show its name in the run controls
// replay: dock({ pocket, topology, ligand, method: result.method }) gives the same pose, score and evaluation count
// result.elapsedMs, result.evaluations, result.steps, result.chains, result.seed, result.nrot, result.heavyAtoms, result.terms,
// result.polish, result.search, result.timings
const d = derived(result.scoreMilli, result.heavyAtoms);
// d.dG (kcal/mol), d.pKd, d.kd (mol/L), d.le (kcal/mol per heavy atom), d.band ('strong'|'moderate'|'weak'|'none'), d.bandLabel
// formatDg(d.dG) -> '-8.412'; formatKd(d.kd) -> { value, unit: 'nM', text: '155 nM' }
// cancel() -> the pending dock() rejects with an Error named 'CancelledError' (the Stop button)
// an invalid method -> dock() rejects with an Error named 'MethodError'; err.errors lists every sentence for the editor
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
  with `pocket.half` against the ligand extent. With `flexible: false` such a pair can only end in a positive
  score (paclitaxel in 1M17: +53); the lab shows it as the chain would.
- Method JSON from a link, a file or the editor is untrusted text: validate it, render it with el(), never innerHTML.
  The error sentences are safe to show as they are (no dashes, no emoji, they name the key or the bound).
- The method panel's `Reset to preset` is `presetByName(name)`; `Save as my method` stores `methodToCompact(m)`
  under the name; `Export JSON` may pretty-print `JSON.stringify(m, null, 2)`; `Share link` is `methodToQuery(m)`.

## 6. Worker protocol (js/engine/worker.js)

main -> worker: `{ type: 'start', id, pocket: Uint8Array, topology: Uint8Array, ligand, method?, seed, budgetMs | steps, tables?, chains?, candidates? }`
(`index.js` always sends the resolved `method` plus the seed; the legacy keys stay for direct users of the worker),
`{ type: 'cancel', id }`. worker -> main: `{ type: 'ready' }` once at load, `{ type: 'progress', id, stage, done, best, evaluations, steps }`
(at most every 100 ms), `{ type: 'result', id, result }`, `{ type: 'error', id, message, cancelled }`. `index.js` terminates a worker
that does not answer a cancel within 1.5 s and spawns a fresh one next time.

## 7. Known limits

- Mirror images pass the proof (distances only); documented in SPEC-ENGINE.md.
- The float tables interpolate the gauss terms linearly at 0.01 A, so the float energy differs from the integer
  scorer by a few milli kcal/mol; the integer scorer is the only number shown.
- Speed scales with pocket density and ligand size: paclitaxel (62 atoms, 14 rotors) runs about 4x slower per step
  than quercetin. A 10 s Quick run still finds a valid pose for every catalog ligand tried.
- A method with `local.steps: 0` (raw Monte Carlo, no local optimisation) is allowed by the schema and much
  weaker (AQ4 at 200 steps: -3.8 against -7.2 with 30 iterations); it exists so the docs can show what the local
  optimisation buys. `temperature` near 5 accepts almost every move; near 0.1 it is a greedy descent.
- `Reproducible` counts steps, so its wall time depends on the ligand and the machine (about 12 s for quercetin
  and 45 s for paclitaxel alone on this Mac in Node; phones take longer).
- `data/registry.json`, `data/pockets/*.bin` and `data/topologies/*.bin` did not exist while the v1 engine was
  built; the tests use the pocket and topology bytes registered in `data/vectors/*.json` (1M17 with AQ4, QUE, TA1)
  and switch to `data/topologies` for the rotor check as soon as the folder exists (it does now: 152 ligands).

## 8. Bench rows (node tools/engine-bench.mjs --budgets 10,30,60, and --chrome-only for the Worker path; v1 engine)

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

v2 preset rows (`node tools/engine-bench.mjs --presets --ligands QUE|AQ4|TA1`, the three at once, seed 1):

```
node  QUE  Quick          score  -9731   381 steps/s   3519 steps  4 chains   9616 ms
node  QUE  Standard       score  -9742   410 steps/s  12036 steps  16 chains  29740 ms
node  QUE  Deep           score  -9734   455 steps/s  40707 steps  16 chains  89752 ms
node  QUE  Rigid ligand   score  -8708   480 steps/s  14129 steps  16 chains  29795 ms
node  QUE  Wide search    score  -9740   681 steps/s  19855 steps  16 chains  29499 ms
node  QUE  Fine local     score  -9279   490 steps/s  14347 steps  4 chains   29603 ms
node  QUE  Reproducible   score  -9739   358 steps/s   8000 steps  8 chains   22382 ms
node  AQ4  Quick          score  -6660   267 steps/s   2422 steps  4 chains    9504 ms
node  AQ4  Standard       score  -7472   235 steps/s   6652 steps  6 chains   28685 ms
node  AQ4  Deep           score  -7440   233 steps/s  20537 steps  16 chains  88597 ms
node  AQ4  Rigid ligand   score  -5848   236 steps/s   6949 steps  16 chains  29772 ms
node  AQ4  Wide search    score  -7466   639 steps/s  17966 steps  16 chains  28508 ms
node  AQ4  Fine local     score  -6980   160 steps/s   4505 steps  4 chains   28541 ms
node  AQ4  Reproducible   score  -7354   209 steps/s   8000 steps  8 chains   38312 ms
node  TA1  Quick          score  -6303    72 steps/s    659 steps  4 chains   10672 ms
node  TA1  Standard       score  -6120    66 steps/s   1848 steps  4 chains   28699 ms
node  TA1  Deep           score  -6864   119 steps/s  10203 steps  6 chains   86467 ms
node  TA1  Rigid ligand   score  53350   135 steps/s   3921 steps  5 chains   30547 ms
node  TA1  Wide search    score  -8283   210 steps/s   5872 steps  16 chains  28989 ms
node  TA1  Fine local     score  -7366    46 steps/s   1304 steps  4 chains   29501 ms
node  TA1  Reproducible   score  -6330    51 steps/s   8000 steps  8 chains  156204 ms
```

Gate results at the time of writing: `node tools/engine-test.mjs --chrome` 281 checks pass, 0 fail (tables 17,
terms 33, vectors 97, sdf 13, model 11, determinism 7, polish 13, derived 5, reach 3, method 68, chrome 14). The
method section proves: the schema survives JSON and lists the twelve keys with the SPEC bounds; the empty method
resolves to the schema defaults; the seven presets validate, resolve to themselves and fit 1024 bytes; 35 bad
inputs are rejected with the exact sentence; the compact form is canonical under key order and reparse; the query
round trip (also with padding, spaces, non-ASCII names, bad links); the merge rule of dock(); every knob steers
the search (rigid vs flexible, center vs box, kT 5 vs 0.1 acceptance, big vs tiny moves, local 0, lattice off,
candidates and chains 1/1 and 16/32); a steps run and a budget run replay exactly from `Result.method`; every
preset reaches a negative score on QUE x 1M17 within its budget (Quick -9.651 in 9.9 s, Standard -9.746,
Deep -9.740, Rigid ligand -8.708, Wide search -9.740, Fine local -9.279, Reproducible -9.739 at 8000 steps). In
Chrome the Wide search 300-step worker run equals Node's pose, score and evaluation count, and the browser
`dock()` rejects a bad `?method=` with `chains must be a whole number from 1 to 32.`
