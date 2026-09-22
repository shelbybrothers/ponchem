# PONCHEM.AI, build contract (v1, 2026-09-22)

Ponchem is an on-chain computer-aided drug design (CADD) lab from Pons Lab, an honorable project of ponsfamily.com.
People dock bioactive plant compounds into the binding pockets of cancer targets taken from the RCSB Protein Data
Bank, and Robinhood Chain scores every final pose with an integer implementation of a Vina-style empirical scoring
function. The record of every run (who, which target, which ligand, the pose, the binding free energy) lives on
chain, and the site compiles it into a live cancer research report. Nothing on the site is a demo: the pockets,
the ligand topologies, the scorer and the prize pools are on mainnet (Robinhood Chain, id 4663).

Owner intent, verbatim priorities: 100% mainnet use case live (no demo, no larp); science theme; decent, proper,
mobile view; X page x.com/PonchemAI; footer "2026 Pons Lab CADD (Computer-aided Drug Design)"; $PONCHEM buy link and
Copy CA blank until the launch on ponsfamily.com; connect wallet; ~100 ligands and ~100 receptors from RCSB; collect
the best Gibbs energy and potency; goal: help the research report and find the best cancer drug candidates for the
top-threat cancers.

## 1. Identity

- Name **Ponchem**, domain **ponchem.ai**, X **https://x.com/PonchemAI** (handle `ponchem`).
- Footer line on every page: `2026 Pons Lab CADD (Computer-aided Drug Design)`.
- Token **$PONCHEM**: launches later on ponsfamily.com. Until then `TOKEN.ca` and `TOKEN.buyUrl` are null: the Buy
  link is inert and reads `Buy $PONCHEM · soon`, Copy CA is disabled and reads `CA posts here at launch`. No page
  may carry a `0x` address string in visible text while blank.
- Chain: Robinhood Chain 4663 (`0x1237`), ETH gas, official RPC `https://rpc.mainnet.chain.robinhood.com` plus
  `https://robinhood-rpc.publicnode.com` for wallets. Browser reads go through the same-origin proxy `/api/rpc`.
- Explorer for transaction links: `https://robinhoodchain.blockscout.com/tx/<hash>`.

## 2. Copy and UI rules (hard gates)

1. No em dashes or en dashes anywhere in visible copy, titles, meta, toasts, error strings. Rewrite the sentence.
   Title separator is `·` (`Ponchem · Lab`).
2. No emoji anywhere (UI, icons, favicons, social copy). Icons are inline SVG strokes, one visual language.
3. No app contract address in visible UI, ever (visitors confuse it with the coin CA). Addresses live in
   `js/config.js` only. Transaction hashes and the visitor's own wallet are fine. The only address control on the
   site is the coin's Copy CA (blank until launch), and its toast names the coin: `$PONCHEM CA copied`.
4. Never call anything a demo, preview, mock or simulation-of-a-simulation. The docking is a real computation and
   the chain scores it. Say "computational screening", "estimated binding free energy", "a lead for further study".
5. Never claim wet-lab validation, clinical results, cures, FDA anything, or "AI discovered a drug". "AI modeling" is
   allowed as the category name of the field (computer-aided drug design with a learned scoring function), and the
   How-it-works page states exactly what runs: a stochastic pose search in the browser, plus an empirical scoring
   function of the AutoDock Vina family whose five weights were fitted on ~1,300 PDBbind complexes (Trott and Olson,
   J Comput Chem 2010). Ponchem's engine is an independent implementation ("Vina-style"), not AutoDock Vina.
6. English only. Short sentences. Plain words over jargon in UI; jargon lives in /docs with a definition.
7. Mobile first: every page works at 360 px wide, no horizontal scroll, tap targets 44 px, the lab runs on a phone.
8. External assets: only RCSB (files.rcsb.org, data.rcsb.org, cdn.rcsb.org images) and self-hosted libraries. No
   Google Fonts at runtime (fonts self-hosted in /fonts), no analytics, no trackers.

## 3. Product: what a visitor can do

- **Browse the library**: ~100 cancer targets (receptors) and ~100 plant compounds (ligands), each with its RCSB
  provenance (PDB id, reference co-crystal ligand, resolution, method, organism, DOI) and a 3D view.
- **Dock**: pick a target and a ligand (or "screen": one target against many ligands, one ligand against many
  targets), run the engine in the browser (a Web Worker, seeded, deterministic, progress shown, 10 s to 90 s per
  pair depending on the depth chosen), see the pose in 3D on the receptor, see the binding free energy (kcal/mol),
  the estimated potency (pKd and Kd from dG = RT ln Kd at 298.15 K, ligand efficiency), and the geometry checks.
- **Record on chain**: connect a wallet, submit the pose. The contract re-checks the geometry against the ligand's
  topology, recomputes the score with the same integer function, and stores the run. The score shown on the site
  after that is the chain's number. A run costs the run fee (goes into that target's prize pool) plus gas.
- **Prize pools**: anyone can fund a target's pool ("sponsor EGFR"). Every run fee joins the pool. At the end of an
  epoch (7 days) anyone can settle: the wallet holding the best (lowest) score submitted during that epoch on that
  target receives the pool minus the lab fee. No runs, the pool rolls over.
- **Leaderboard and report**: best binders per target, per cancer group, per ligand; most active wallets; pool
  sizes; a cancer research report page compiled from chain data (per top-threat cancer: the best pairs, their dG,
  pKd, ligand efficiency, run counts, distinct wallets), exportable as Markdown and printable.
- **Wallet page**: my runs, my best scores, my prizes to claim, my pool sponsorships.
- **Token utility hook**: the contract can later require a minimum $PONCHEM balance to submit (owner sets token
  and minHold). Off by default. The site shows the requirement when set.

Top-threat cancer groups (for grouping targets and for the report): lung, colorectal, liver, breast, stomach,
pancreatic, prostate, esophageal, cervical, leukemia, lymphoma, brain, melanoma, ovarian, bladder, kidney, myeloma,
head and neck, thyroid, sarcoma. A target may belong to several.

## 4. Engine (the scientific core), summary

The exact numeric definition lives in `SPEC-ENGINE.md` (written by the engine spec author; the Solidity, the JS
and the Python reference all implement THAT document, and a shared test-vector file proves they agree).

- Types: Vina/X-Score heavy-atom types. Hydrogens are not represented. Receptor typing from residue and atom name
  tables (standard amino acids; metals as metal donors; waters and other hetero groups dropped). Ligand typing from
  the SDF bond graph (carbon bonded to N or O is polar carbon, else hydrophobic; N donor if it carries H, N acceptor
  if it has a lone pair available; O acceptor always and donor when it carries H; halogens hydrophobic; S, P).
- Terms: gauss1 (o=0, w=0.5), gauss2 (o=3, w=2), repulsion (d<0: d^2), hydrophobic (1 for d<0.5, linear to 0 at
  1.5), hbond (1 for d<-0.7, linear to 0 at 0), on the surface distance d = r - Ri - Rj, cutoff r <= 8 A, weights
  -0.0356, -0.00516, 0.840, -0.0351, -0.587, then divided by (1 + 0.0585 * Nrot). Result in kcal/mol.
- Fixed point everywhere on chain: coordinates int16 in 0.01 A relative to the box center; distances via an integer
  square-root table on r^2; gauss terms via lookup tables at 0.01 A resolution; energies in micro-kcal/mol
  intermediate, reported in milli-kcal/mol. The JS scorer is a bit-exact replica (Int32/BigInt), the Python
  reference too. The float engine only searches; the final pose is always evaluated by the integer scorer.
- Geometry proof (on chain): the pose must contain exactly the ligand's heavy atoms in topology order; every bonded
  pair's distance must match the ideal within tolerance; every 1-3 pair too; every pair separated by 3+ bonds must
  be at least the clash floor apart; every atom inside the box. So a submitted pose can only score well by really
  fitting the pocket. (Mirror images are not distinguished; documented.)
- Pocket definition (build time, Python): receptor heavy atoms (protein chains and metal ions of the biological
  assembly's relevant chain set) within reach of the box (box = reference ligand bounding box padded by 2 A per side,
  half-size at least 6 A; pocket = atoms within half-size + 8 A of the center on every axis). Pocket bytes and box
  are hashed and the hash is registered on chain with the data.

## 5. Chain

`contracts/src/PonchemLab.sol` (plus small data contracts holding pocket bytes, topologies and the tables, written
once with CREATE). Ownable two-step, no proxy, no upgrade. Owner and treasury 0xb53cB636243AAD194628B88Cfcd770fFBE0cEDd8
(same as ponbio). Fee on prizes `feeBps` 500. Run fee `runFee` set at deploy (proposal: 0.00002 ETH). Epoch 7 days
from a genesis timestamp. Events carry the pose so the site rebuilds everything from logs. Views paged and clamped.

Registration is owner-only and happens in the deploy: the lab, the tables, then each target's pocket and each
ligand's topology, in one resumable `contracts/deploy.sh` (broadcast with `--slow --skip-simulation`, see the
forge-nitro note), with the total gas printed before the first send and a rehearsal mode on anvil. `js/config.js`
gets the GENERATED:DEPLOY block. The user runs the deploy themselves; they paste commands verbatim, so a command
they receive never contains a placeholder.

## 6. Site

Static HTML pages plus vanilla ES modules (no framework, no bundler), shell (head, nav, footer) stamped from
`partials/` by `tools/shell.mjs`, one `css/site.css` with tokens, self-hosted fonts, `3Dmol.js` self-hosted in
`/lib` for the 3D views. Vercel functions in `/api` (JSON-RPC proxy, runs index, report). Dev server
`node tools/dev.mjs` on port **6130**. Deploy with `tools/ship.sh` (git archive, no .git, `vercel deploy --prod`).
Repo `shelbybrothers/ponchem`, own git root (the monorepo ignores `/ponchem/`).

Pages: `/` landing, `/lab` (dock), `/targets`, `/target` (?id=), `/ligands`, `/ligand` (?id=), `/leaderboard`,
`/report`, `/wallet`, `/docs` (how it works, scoring, verification, API, glossary), `/404`.

Theme: science. Light paper background, deep ink text, one accent for "receptor" and one for "ligand", data in a
monospace, grid-paper texture in the hero, real structures rendered in 3D (from RCSB at runtime). Details in
`SPEC-DESIGN.md`.

## 7. Gates (all must pass before a ship)

- `forge test` (unit, fuzz, invariant, gas ceilings: submitRun for the largest ligand on the largest pocket under
  the ceiling written in SPEC-ENGINE.md).
- `node tools/engine-test.mjs`: the JS integer scorer equals the Python reference on every vector, and the Solidity
  scorer equals both (via a forge test that reads the same vectors).
- `node tools/verify.mjs`: every page at 360/390/430/768/1024/1280/1440, no horizontal overflow, copy rules (no
  dashes, no emoji, no 0x in visible text), links resolve, CSP holds, `<title>` per page.
- `node tools/wallet-test.mjs` with the simulated wallet; `node tools/app-test.mjs` against the local chain.

## 8. Interfaces (binding for the phase 2 builders; change only by editing this section first)

### 8.1 Browser engine, `js/engine/index.js` (main thread) and `js/engine/worker.js`

```
parseSdf(text)                     -> { atoms: [{ el, x, y, z }], bonds: [[i, j, order]] }   heavy atoms only, SDF order
loadPocket(bytes: Uint8Array)      -> Pocket   { pdbId, n, center: [x,y,z] (A, absolute), half: [hx,hy,hz] (A), atoms: Int16Array (x,y,z centi), types: Uint8Array, hash }
loadTopology(bytes: Uint8Array)    -> Topology { n, types, bonds, pairs12, pairs13, nrot, hash }
scoreInt(pocket, topology, poseCenti: Int16Array) -> { ok, reason, scoreMilli, terms: { g1, g2, rep, hyd, hb, pairs } }
        the bit-exact integer scorer + geometry checks, same answers as the Python reference and the contract
dock({ pocket, topology, ligand, seed, budgetMs, onProgress }) -> Promise<Result>   runs in a Worker (falls back to the main thread if Workers are unavailable)
        ligand = parseSdf output; seed uint32; budgetMs 5000..120000; onProgress({ done: 0..1, best: scoreMilli|null, evaluations })
        Result { poseCenti: Int16Array, scoreMilli, poseAbs: Float64Array (A, absolute, for the viewer), checks: { ok, reason }, elapsedMs, evaluations, seed }
cancel()
derived(scoreMilli, heavyAtoms) -> { dG (kcal/mol), pKd, kd (M), le (kcal/mol per heavy atom) }   display helpers, float
```
Determinism: same pocket, topology, ligand, seed, budget in "steps" mode gives the same pose. `budgetMs` picks a step
count from a calibration run; the Result records the step count so a run can be replayed with `steps` instead.

### 8.2 Contract, `contracts/src/PonchemLab.sol` (names are binding; types may widen only with a note in the ABI doc)

```
submitRun(uint16 targetId, uint16 ligandId, int16[] pose) payable -> (uint256 runId, int32 scoreMilli)   msg.value == runFee
quote(uint16 targetId, uint16 ligandId, int16[] pose) view -> (int32 scoreMilli)                        same checks, reverts with the same reasons; for eth_call before sending
fund(uint16 targetId) payable
settle(uint16 targetId, uint32 epoch)                    after the epoch ended; pays the epoch's best wallet (pool minus fee), or rolls the pool if no run
withdraw()                                               pull payments for refused transfers (owed)
views: targetCount() ligandCount() runCount() currentEpoch() epochStart(uint32) epochLength() genesis() runFee() feeBps() token() minHold()
       target(uint16) -> (string pdbId, string name, uint32 cancerBits, address data, bytes32 hash, uint16 atoms)
       ligand(uint16) -> (string key, string name, address data, bytes32 hash, uint8 atoms, uint8 nrot)
       run(uint256)   -> (address wallet, uint16 targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, uint64 time, bytes32 poseHash)
       bestOf(uint16 targetId) -> uint256 runId (0 = none; runs are 1-based)   bestOfEpoch(uint16, uint32) -> uint256   bestPair(uint16, uint16) -> uint256
       pool(uint16) -> uint256   owed(address) -> uint256   stats(address) -> (uint64 runs, int32 best, uint256 prizes)
events: TargetRegistered(uint16 indexed id, string pdbId, string name, address data, bytes32 hash)
        LigandRegistered(uint16 indexed id, string key, string name, address data, bytes32 hash)
        RunScored(uint256 indexed runId, address indexed wallet, uint16 indexed targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, int16[] pose)
        Funded(uint16 indexed targetId, address indexed from, uint256 amount, uint256 pool)
        Settled(uint16 indexed targetId, uint32 indexed epoch, address winner, uint256 runId, uint256 amount)
        Rolled(uint16 indexed targetId, uint32 indexed epoch, uint256 pool)
owner: registerTarget(...), registerLigand(...), setRunFee, setFeeBps (<= 1000), setTreasury, setToken(address, uint256 minHold), Ownable2Step
```
Revert reasons are custom errors with plain names (BadPose(reason code), WrongFee, NotEnded, NoRuns, TokenRequired).
ids are 1-based for targets and ligands too (0 = none). `RunScored.pose` is the full pose so the site rebuilds every
run from logs; storage keeps the hash only.

### 8.3 Data files (built by the pipeline, shipped with the site)

```
data/catalog/targets.json, data/catalog/ligands.json      the curated catalogs (phase 1)
data/registry.json     { targets: [{ id, key, pdbId, ..., pocket: "data/pockets/<PDB>.bin", hash, atoms, box }], ligands: [{ id, key, ..., topology: "data/topologies/<KEY>.bin", hash, atoms, nrot }] }
data/pockets/<PDB>.bin, data/topologies/<KEY>.bin, data/tables/*.bin     bytes exactly as registered on chain
data/ligands/<KEY>.sdf                                     heavy-atom SDF, atom order = topology order
```
The site reads registry ids from `data/registry.json`; after the deploy the ids must equal the chain's (the deploy
script registers in registry order and verifies).

### 8.4 Data layer, `js/chain.js` and `js/catalog.js` (read side, used by every page and by the lab)

```
js/catalog.js
  loadCatalog()            -> { targets: [...catalog entries + id], ligands: [...], cancers: CANCERS, targetById, ligandById, targetByKey, ligandByKey }
                              ids come from data/registry.json when it exists, else catalog order (1-based); registry entries carry pocket/topology paths, hashes, atoms, box
  fetchLigandSdf(key)      -> text            data/ligands/<KEY>.sdf
  fetchPocket(pdbId)       -> Uint8Array      data/pockets/<PDB>.bin
  fetchTopology(key)       -> Uint8Array      data/topologies/<KEY>.bin
  fetchStructure(pdbId)    -> text            https://files.rcsb.org/download/<PDB>.pdb (for the 3D viewer only)
  rcsbImage(pdbId)         -> url             https://cdn.rcsb.org/images/structures/<pdb lower>_assembly-1.jpeg
  CANCERS                  -> [{ bit, key, name }] in this order (bit = index): lung, colorectal, liver, breast, stomach, pancreatic, prostate,
                              esophageal, cervical, leukemia, lymphoma, brain, melanoma, ovarian, bladder, kidney, myeloma, head-and-neck, thyroid, sarcoma
js/chain.js   (all reads go through /api/rpc via js/rpc.js multicall; nothing here signs)
  labStatus()              -> { live, epoch, epochStart, epochEnd, epochLength, runFee (wei), feeBps, token, minHold, runCount, targetCount, ligandCount, poolTotal (wei) }
  runs({ target, ligand, wallet, limit, offset }) -> Run[]   Run { id, wallet, targetId, ligandId, scoreMilli, epoch, time, block, tx, pose: Int16Array|null }
                              served by GET /api/runs (server-side log index, cached ~10 s) with a browser fallback to eth_getLogs from LAB.deployBlock
  bests()                  -> { byTarget: Map<id, Run>, byPair: Map<'t:l', Run>, byLigand: Map<id, Run>, byTargetEpoch: Map<'t:e', Run> }
  pools()                  -> Map<targetId, wei>
  walletStats(address)     -> { runs, best (scoreMilli|null), prizes (wei), owed (wei), sponsored: [{ targetId, amount }] }
  report()                 -> { generatedAt, runCount, wallets, cancers: [{ key, name, targets: [{ id, key, pdbId, best: Run|null, runs, wallets, pool }], bestPairs: Run[] }] }
  onBlock(cb)              -> unsubscribe   polls eth_blockNumber every 4 s while the tab is visible
api/runs.js     GET /api/runs?target=&ligand=&wallet=&limit=&offset=   JSON { runs: Run[], total, head }   (cache-control: public, s-maxage=10, stale-while-revalidate=60)
api/report.js   GET /api/report.md   the research report as Markdown (text/markdown), same data as report()
api/status.js   GET /api/status      JSON labStatus()
```
The lab (write side) builds calldata with `js/lab.js`: `buildSubmitRun(targetId, ligandId, poseCenti, runFee)`, `buildFund(targetId, wei)`,
`buildSettle(targetId, epoch)`, `buildWithdraw()`, and `quote(targetId, ligandId, poseCenti)` (eth_call) and registers the revert explainer.

### 8.5 Precedence

Where SPEC-ENGINE.md differs from the summary in section 4 (polar carbon next to any heteroatom, one 2.20 A clash floor, box
half = max(6 A, max|x - c| + 2 A), worst-case gas gate 6.0M), SPEC-ENGINE.md wins. Copy that explains the scorer must follow it.
Deploy defaults: runFee 0.0001 ETH, feeBps 500, epoch 7 days, genesis = the deploy block's timestamp.

## 9. v2 addendum (owner request 2026-09-22, binding for phase 3; overrides earlier sections where they differ)

### 9.1 Paid docking tests, paid to the treasury
- A **docking test** is the on-chain step: the pose found in the browser is submitted, the contract proves the
  geometry, scores it and records it. The browser search is "prepare a pose"; the chain's scoring is "the test".
  UI wording: `Run docking test` for the chain step; the browser step is `Dock` / `Find a pose`.
- Every docking test costs **100 $PONCHEM** or **0.0001 ETH**. The payer chooses. Both go to the treasury
  `0xb53cB636243AAD194628B88Cfcd770fFBE0cEDd8` (config only, never visible). While $PONCHEM is not launched
  (`token()` is zero) only the ETH option works and the token option reads `after the $PONCHEM launch`.
- Contract: `submitRun(uint16 targetId, uint16 ligandId, int16[] pose, bool payWithToken) payable`.
  ETH path: `msg.value == runFee` (0.0001 ether), forwarded to the treasury (refused transfer credits `owed[treasury]`).
  Token path: `msg.value == 0`, `token != 0`, `tokenAllowed`, `IERC20(token).transferFrom(msg.sender, treasury, runPrice)`
  with strict return-value checks (`runPrice` default 100e18, owner-settable). Owner: `setToken(address)`,
  `setPrices(uint256 runFee, uint256 runPrice)`, `setPaymentOptions(bool ethAllowed, bool tokenAllowed)`,
  `setTreasury`. `quote(...)` stays free and does not take the flag. New event `Paid(uint256 indexed runId, address
  indexed wallet, uint8 method (0 eth, 1 token), uint256 amount)` next to the unchanged `RunScored`.
- Run fees no longer feed prize pools. Pools are funded only by `fund(targetId)` (sponsors); `settle` unchanged.
  The `minHold` token gate from 8.2 is dropped (payment is the utility).

### 9.2 Reviews (social review, stored on chain)
- `reviewRun(uint256 runId, uint8 stars, string note)`: run exists, `msg.sender != run.wallet`, stars 1..5,
  `bytes(note).length <= 280`, free (gas only). A wallet's second review of the same run replaces the first
  (sums adjusted). Storage: `reviewStats(runId) -> (uint32 count, uint32 starSum)`, `reviewOf(runId, wallet) ->
  (uint8 stars, uint64 time)`. Event `Reviewed(uint256 indexed runId, address indexed reviewer, uint8 stars, string note)`
  (the note lives in the event; the site reads reviews from logs). `stats(address)` gains `reviewsGiven`,
  `reviewsReceived`, `starsReceived`.
- Site: every test report page shows the average stars, the count, the review list (newest first, reviewer short
  address, stars as SVG, note as text via el()), and `Write a review` for a connected wallet that is not the author
  (stars picker + note field, 280 chars, plain text). Notes are untrusted text: never innerHTML.

### 9.3 Test report page `/run?id=N` (one per recorded docking test)
Header: `Docking test #N` · ligand into target (PDB id) · wallet (short) · time · transaction link. Score block:
dG (band), pKd, Kd, ligand efficiency, the five terms and the geometry proof recomputed in the browser from the
pose in the event (must equal the chain's score; show `Chain and browser agree` or the discrepancy). 3D viewer
with the pose on the receptor. Provenance with the direct links of 9.4. Reviews (9.2). Actions: `Post on X`
(an X intent link `https://x.com/intent/post?text=<encoded>&url=https://ponchem.ai/run?id=N`; the text is
`Docking test #N on Ponchem: <ligand> into <gene> (<PDB>). dG <x> kcal/mol, pKd <y>, scored on Robinhood Chain.`
no emoji, no dashes, no address), `Copy link`, `Download report` (Markdown, client-side, same content plus the
review summary). The research report page (/report) links every best pair to its test page.

### 9.4 Direct RCSB links everywhere
- Target: `https://www.rcsb.org/structure/<PDB>` on cards (an icon link), on the target page (`View on RCSB`),
  in the lab picker row, on test pages and in the report tables. Reference ligand: `https://www.rcsb.org/ligand/<CCD>`.
- Ligand with a CCD id: `https://www.rcsb.org/ligand/<CCD>`; without one: `https://pubchem.ncbi.nlm.nih.gov/compound/<CID>`
  labelled `PubChem` (the site says which source the 3D came from). Also on cards, pages, the lab picker and tests.
- Links open in a new tab with `rel="noopener"`; the link text names the destination (`RCSB 4WKQ`, `RCSB AQ4`, `PubChem 5280343`).

### 9.5 Dashboard and gamification (`/dashboard`; `/wallet` redirects to it)
- Profile: address, level and title, XP with a progress bar to the next level, badges (inline SVG, never emoji).
- XP (computed client-side from chain data, deterministic, documented in /docs): 10 per docking test, 5 per distinct
  target tested (first time), 15 per test that becomes the best on its target at the time of recording (from
  `bestOf` history in the run order), 3 per review written, 5 per review received with 4 or 5 stars, 25 per epoch
  won (Settled events), 5 per target sponsored (first time). Levels: Observer 0, Assistant 50, Researcher 150,
  Senior Researcher 400, Principal Investigator 900, Lab Head 2000.
- Badges: First test, Ten tests, Fifty tests, Ten targets, Strong binder (a test at or below -9 kcal/mol), Best on a
  target, Epoch winner, Sponsor, Reviewer (5 reviews written), Well reviewed (an own test with 3+ reviews averaging
  4+). Each badge is a 24 px stroke icon in one visual language.
- Sections: My docking tests (table: id, target, ligand, dG, band, reviews, actions Post on X / Report), Best
  scores, Reviews received, Reviews written, Prizes and withdraw, Sponsorships, Payment (how tests are paid, the
  $PONCHEM blank state). Leaderboard `Wallets` tab shows level, XP, tests, best dG; a `Most reviewed tests` list.
- Empty state for a visitor without a wallet: what the dashboard will show, with Connect.

### 9.6 Copy updates
The landing's third value prop becomes about paid tests and review (`Every docking test is paid, scored and
reviewed`), the token section explains the 100 $PONCHEM price and the ETH option, /docs gains sections for
payment, reviews, levels and the X post. All strings obey section 2.

### 9.7 Docking methods: presets and user-defined JSON (owner request 2026-09-22)
- The chain's scoring function is fixed (the test). The **search** that prepares the pose is configurable through a
  **method**: a JSON object the engine validates against a published schema with bounds and defaults:
  ```
  { "name": "Standard", "version": 1,
    "budget": { "ms": 30000 } | { "steps": 12000 },      one of the two; steps is the reproducible form
    "chains": 8,                                        restarts, 1..32 (default: from the budget)
    "temperature": 1.2,                                 Metropolis kT in kcal/mol, 0.1..5
    "moves": { "translate": 1.0, "rotate": 20, "torsion": 60 },   A, degrees, degrees; each 0.05..5 / 1..180 / 1..180
    "local": { "steps": 30 },                           local optimisation steps per move, 0..300
    "placement": "box" | "center",                      random anywhere in the box, or near the box centre
    "flexible": true,                                   false = rigid ligand (torsions frozen at the ideal conformer)
    "candidates": 4,                                    poses kept for the integer polish, 1..16
    "lattice": true,                                    integer lattice moves in the polish
    "seed": 7 }                                          optional; the lab fills it when absent
  ```
  Unknown keys are rejected with the key named; out-of-range values are rejected with the bound named. The engine
  exports `METHOD_SCHEMA`, `METHOD_PRESETS` and `validateMethod(json) -> { ok, method, errors[] }`, and
  `dock({ ..., method })` uses it. `Result.method` echoes the resolved method (every default filled in), so a run is
  reproducible from `Result.method` + the seed.
- **Presets** (engine-owned, shown in the lab): Quick (10 s), Standard (30 s), Deep (90 s), Rigid ligand,
  Wide search (more chains, larger moves, shorter local), Fine local (fewer chains, small moves, long local),
  Reproducible (steps instead of ms). Owners of the lab UI may add none.
- **Lab UI**: a Method panel with the preset picker, a JSON editor (monospace textarea, live validation, the error
  list in plain words, `Reset to preset`), `Save as my method` (localStorage `ponchem.methods`, named), `Export JSON`,
  `Import JSON` (file input; validated), `Share link` (`?method=<base64url of the JSON>`; validated on load). The run
  controls show the active method's name.
- **On chain**: `submitRun(..., bool payWithToken, string method)` takes the method JSON (compact, `<= 1024 bytes`,
  may be empty) and emits `Method(uint256 indexed runId, string json)`; storage keeps `keccak256(json)` in the run
  (`run(id)` gains `bytes32 methodHash`). The test page shows the method (pretty-printed, as text) with
  `Use this method` (opens the lab with `?method=`), and the Markdown report includes it. Method JSON is untrusted
  text: rendered with el(), never innerHTML, and validated before it is loaded into the lab.
- /docs gains `Docking methods`: the schema, the bounds, what each field does, and the presets table.

### 9.8 AI analysis of a docking test (owner request 2026-09-22)
- Every test report page offers `AI analysis`: a model picker and an `Analyze` button. Providers offered: **Claude
  Fable 5.1** (Anthropic Messages API, model `claude-fable-5-1`), **GPT** (OpenAI chat completions), **Kimi**
  (Moonshot, OpenAI-compatible), **Jev AI** (the owner's own model behind an OpenAI-compatible endpoint). The
  analysis text is always the model's real output. A provider whose key is not configured on the server is shown
  as `not connected` and cannot be selected; no placeholder, sample or canned text is ever displayed as an analysis.
- Server route `POST /api/analyze` `{ runId, provider }`: loads the test from the chain (target, ligand, score, terms,
  proof, method, the target's other tests and the epoch best), builds one structured prompt (facts first, then the
  ask: interpret the score for this target and ligand in plain words, name the limits of a rigid-receptor
  Vina-style estimate, suggest the next computational and wet-lab steps, flag literature the model recalls and
  label it as unverified recall), calls the provider with the key from the environment (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `MOONSHOT_API_KEY`, `JEV_API_KEY` + `JEV_API_URL`; models via `PONCHEM_MODEL_<PROVIDER>` with
  sensible defaults), post-processes the text (em and en dashes become commas or periods, emoji removed), caches
  per (runId, provider) in memory for the instance, and answers `{ provider, model, text, generatedAt }`.
  `GET /api/analyze` lists providers with `connected: true|false` (derived from which keys exist; never the keys).
  Rate limit: 10 analyses per minute per instance; errors are plain sentences.
- The author of a test may `Attach analysis on chain` (`attachAnalysis(uint256 runId, string provider, string text)`,
  text `<= 2048 bytes`, only `run.wallet`, replaces an earlier one; event `Analysis(uint256 indexed runId, string
  provider, string text)`). The test page shows the attached analysis to everyone (from logs) with its provider and
  model; an unattached analysis is shown only to the person who generated it in that session.
- The X post and the Markdown report include the first 500 characters of an attached analysis, labelled with the
  model. All copy rules of section 2 apply to the UI; the model output is displayed as text via el().
- Docs: a section `AI analysis` stating what is sent to the model, that the text is the model's and unverified,
  and that keys never reach the browser.

### 9.9 Documentation (owner request 2026-09-22: "decent docs")
Site docs become a hub at `/docs` with one page per section (`/docs/<slug>` served as `docs/<slug>.html` with
cleanUrls; `/docs` is the overview with the section list). Desktop: a left sidebar with the section list and the
current page's headings; phone: a section picker at the top and a sticky "On this page" disclosure. Every page:
breadcrumb, prev and next links, anchored h2/h3, a last-updated line, and the copy rules of section 2.
Sections, in order:
1. `overview`: what Ponchem is, the loop (choose, dock, test, review, sponsor, settle, report), what is and is not claimed.
2. `quick-start`: your first docking test in five steps with real screenshots (rendered with headless Chrome from
   the running site, stored under img/docs/, phone and desktop), what you need (a wallet on Robinhood Chain, ETH for
   the fee and gas, or $PONCHEM after the launch).
3. `library`: how targets were chosen (human, X-ray, resolution, co-crystal reference ligand, the 20 cancer
   groups, the class balance), every provenance field explained, the RCSB links; how ligands were chosen, the three
   coordinate sources, atom order, heavy atoms only, charges; the exact counts.
4. `engine`: the browser search (chains, Monte Carlo moves, local optimisation, torsions, placement, the integer
   polish), determinism and replay, performance numbers measured on this project (from notes/engine.md), what the
   worker does when the tab is hidden.
5. `scoring`: atom types and radii table, the five terms with their formulas and plots as inline SVG, the weights
   and the rotor penalty, surface distance, cutoff, fixed point and the tables, one worked example with real
   numbers from a vector file, the display quantities (dG, pKd, Kd, ligand efficiency) and the bands, and why a
   number can differ from AutoDock Vina's.
6. `verification`: what the contract proves before it scores (the five checks with their reason codes), the box,
   the grid, gas per test, events and what they carry, how to reproduce a chain score yourself with the Python
   reference CLI and with the JS scorer (exact commands, no placeholders: use a real test id from the live chain
   once one exists, else the vector files).
7. `methods`: the method JSON schema as a table (field, type, bounds, default, meaning), the presets table with
   their values, three example methods, sharing by link and file, how a method is recorded with a test.
8. `tests-and-payment`: what a docking test is, the price (100 $PONCHEM or 0.0001 ETH), the option while the token
   is not launched, where the payment goes (the lab treasury, no address shown), approve then pay for the token
   path, epochs, sponsor pools, settle, withdraw, and the token launch note.
9. `reviews-and-reports`: the test page, writing a review (one per wallet per test, replaceable), stars and notes on
   chain, the research report (columns explained), Post on X, Markdown export.
10. `dashboard`: XP table, levels table, badges table with their icons, how ranks are computed, what is public.
11. `ai-analysis`: providers, what is sent to the model, what is never sent, that the text is the model's and
    unverified, attaching an analysis on chain, keys never reach the browser.
12. `api`: every endpoint with request and response examples (status, runs with every query parameter, report and
    report.md, analyze GET and POST, the RPC proxy and its allow list), the data files (registry.json fields, the
    pocket and topology binary layouts, tables, vectors) with byte tables, CORS and caching.
13. `reproduce`: an end-to-end recipe: fetch a test's pose from the chain, rebuild pocket and topology from RCSB
    with the pipeline, score with the reference, compare; the repository layout and the gates.
14. `glossary`: every term used on the site, one paragraph each, alphabetical.
15. `faq`: at least fifteen real questions (why was my pose rejected, why is my score less negative than Vina's,
    mirror images, what happens to my fee, can I dock my own compound (not yet: the registry is curated), can I add a
    target (the reserve list), is this medical advice (no), what the AI analysis is, how epochs work, how to
    reproduce a score, why the receptor is rigid, why waters are dropped, what the reference ligand is, phone use,
    why Robinhood Chain).
16. `changelog`: dated entries starting with the launch; the current deploy status line is filled by the site
    from labStatus() (live or not yet).
Repo docs (for developers): README.md (what, layout, run, test, ship, deploy in order, with the exact commands),
docs/DEVELOPING.md (dev server, gates, the local chain, the rehearsal, ports), docs/API.md (the same endpoint
reference as the site page), contracts/README.md (contract surface, storage, events, deploy and register scripts,
gas table). Markdown files follow the copy rules too except that em dashes in quoted API responses are not copy.

### 9.10 Late requests (owner, 2026-09-22 11:30)
- Pose search must animate: the engine posts the current best pose (poseAbs) in onProgress at most every 250 ms; the lab
  shows it live in the viewer (ligand moves in the pocket) and the progress bar fills smoothly; the status line keeps
  the best score. When the tab is hidden the search continues; the viewer catches up on return.
- Footer line under the credit on every page: `Preliminary project from` + link `https://www.rcsb.org/` (rel noopener).
- Researcher name: `setName(string name)` on the contract (<= 32 bytes, printable ASCII, empty clears), `nameOf(address)`,
  event `Named(address indexed wallet, string name)`. Dashboard: a name field with Save (one transaction). Shown as
  `docked by <name> (0x1234…abcd)` (or the short address alone when unnamed) on the test page, the X post text
  (`Docking test #N by <name> on Ponchem: ...`), the leaderboard wallets tab and best tables, and the report rows.
- Budget: the owner has limited credit left; from here integration is done by the orchestrator with at most one or two
  small agents; no adversarial fleet.
