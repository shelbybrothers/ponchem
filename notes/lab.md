# Lab builder notes (v2, 2026-09-22)

The docking app at `/lab` and the shared 3D viewer. Files owned: `lab.html`, `css/lab.css`, `js/pages/lab.js`,
`js/lab-ui/*`, `js/viewer.js`, `tools/lab-test.mjs`, this note. Ports used while building: dev server 6132,
Chrome CDP 9541. No anvil.

v2 (SPEC.md section 9) added: the docking test wording and the payment choice (9.1), the direct RCSB and PubChem
links in the picker rows (9.4) and the Method panel (9.7). Section 6 below lists what changed; sections 1 and 2
describe the whole thing as it is now.

## 1. The viewer, `js/viewer.js`

Unchanged in v2. Wraps `window.$3Dmol` from `/lib/3Dmol-min.js` (2.5.5). The page loads the classic script once
with a static `<script src="/lib/3Dmol-min.js" defer></script>` in its head (CSP `script-src 'self'` allows it;
nothing is injected). Structure and ligand text is fetched by the caller (`js/catalog.js fetchStructure /
fetchLigandSdf`).

```
ready()                      -> Promise<$3Dmol>   resolves once the script has run (rejects after 20 s)
supported()                  -> bool              WebGL probe, cached
FALLBACK_CAPTION             '3D view unavailable. Showing the RCSB entry image.'
WEBGL_OFF                    'WebGL is not available, so the 3D view is off. Scores and records still work.'
createViewer(el, { style: 'card' | 'paper' | 'hero', background, quality }) -> handle
  showStructure(pdbText, { id, chain, ligandCcd, highlightPocket: { center, half } })
                                -> { atoms, reference, pocketResidues }
  showLigand(sdfText)           the ligand alone (ligand page)
  showPose(sdfText, poseAbs)    the SDF with its coordinates replaced by the pose (absolute angstrom, 3 per heavy
                                atom, topology order), orange sticks over the structure
  clearPose()
  setBox(center, half)          translucent box: a wireframe at 40 percent plus a 6 percent fill
  setBoxVisible(on) setReference(on) setPocket(on) setSurface(on) -> Promise<bool>     the toolbar toggles
  resetView()  spin(on)  resize()  dispose()  toPng()  state()
sdfWithPose(sdfText, poseAbs) -> text   (exported helper)
```

- Colours per SPEC-DESIGN 1.6: cartoon `#9DB7CC`, pocket sticks carbon `#8A93A3` with CPK hetero atoms, our
  ligand carbons `#B5480C` (N `#3050F8`, O `#E53935`, S `#C9A800`, halogens `#2E8B57`), the reference co-crystal
  ligand as its own model (so it can be 55 percent translucent) in `#1F5F8B`, the box in `--ink-3`.
- Pocket residues: within 4.5 A of the reference ligand (`within` + `byres`), or, when the entry has no
  reference, the residues with an atom inside the box. The camera frames those residues; `resetView()` returns
  to that framing.
- No surface by default (phones). `setSurface(true)` adds a VDW surface of the pocket residues (3Dmol builds it in
  a `blob:` worker, allowed by `worker-src`).
- `style: 'card'` (white) is the default and what the lab uses; `'paper'` and `'hero'` exist for the other pages.
- The spin is driven by our own `setInterval` (one turn per 40 s), paused while the pointer is over the canvas,
  while the tab is hidden and under `prefers-reduced-motion`. No rAF anywhere in the lab.
- `data-structure`, `data-pose`, `data-box`, `data-reference`, `data-surface` mirror the state on the element so
  tests can read it without touching the viewer.

## 2. The lab flow, `js/pages/lab.js` and `js/lab-ui/*`

Modules: `strings.js` (every visible string: docs/copy.md plus the v2 strings of section 4), `icons.js` (inline
SVG strokes), `pickers.js` (target and ligand pickers, multi-select in the screening modes, the direct links),
`sheet.js` (phone bottom sheet that moves a picker or the method panel in and out), `derive.js` (bands, Kd units,
term energies, geometry rows), `results.js` (results panel, screening table), `record.js` (the docking test flow
with the payment choice), `run.js` (engine inputs, dock with a method, screening queue), `method.js` (the Method
panel and the wrapper around `js/engine/method.js`).

Flow:

1. `initShell()`, then dynamic imports of `js/catalog.js`, `js/engine/index.js`, `js/engine/method.js`,
   `js/chain.js`, `js/lab.js` (each may be missing; the page degrades: no catalog gives the copy deck's catalog
   error, no engine disables Find a pose with an explanation, no method module shows the engine-unavailable line
   in the Method panel and lets the depth control drive the run, no chain or lab module gives the not-live state).
2. `loadCatalog()`; pickers built from `targets` and `ligands` with their registry ids; cancer pills from
   `CANCERS`, ligand pills from the ligand `class`. Every row is a focusable `div[role=option]` (Enter and Space
   select) so it can carry a real link: `RCSB <PDB>` (`https://www.rcsb.org/structure/<PDB>`) on a target row,
   `RCSB <CCD>` (`/ligand/<CCD>`) or `PubChem <CID>` (`https://pubchem.ncbi.nlm.nih.gov/compound/<CID>` from the
   catalog's `pubchemCid`) on a ligand row; the link opens a new tab with `rel="noopener"`, its text (visually
   hidden, `aria-label` and `title` too) names the destination, and it stops its click so the tap that selects the
   row stays the row's (SPEC 9.4). The viewer strip link reads `RCSB <PDB>` too.
3. URL `?target=<id|key|pdbId>&ligand=<id|key|ccd>&depth=quick|standard|deep&seed=<uint32>&mode=pair|target-many|ligand-many&method=<base64url JSON>`
   is read at start and rewritten with `history.replaceState` on every change (ids are registry ids).
   `?method=` wins over `?depth=`; an invalid method toasts `The method in this link is not valid. Standard is
   selected instead.` and is dropped from the URL. `depth=` is written only while the active method is one of the
   three depth presets; otherwise `method=` carries the editor's JSON (the engine's `methodToQuery`, canonical
   compact JSON, sorted keys). `Share this run` and the panel's `Share link` copy that URL.
4. Choosing a target fetches the structure (`fetchStructure`) into the viewer with the box from the registry
   entry (`box.center`, `box.half`) and the reference CCD. Failure or no WebGL shows the RCSB entry image with the
   copy deck caption.
5. The browser step is `Dock` / `Find a pose` (SPEC 9.1): the run card carries the eyebrow `DOCK`, the line `Find a
   pose in your browser, then run the docking test on chain.`, the depth control, the seed row, the method chip
   (`Method: <name>`) and the button `Find a pose` (`Stop` while running, `Run again` after). `run.js` fetches SDF,
   pocket bytes and topology bytes (cached), `ensureTables()`, then `engine.dock({ pocket, topology, ligand, seed,
   method, budgetMs | steps, chains?, candidates? })`: the resolved method of the panel (seed filled in) plus the
   same values as plain v1 parameters, so an engine without method support still runs the method's search size.
   Progress arrives as worker messages; the bar and the caption `Pose search · {percent}% · best so far {dG}
   kcal/mol` are painted in the callback with a 200 ms throttle (Date.now, no rAF). Stop calls `engine.cancel()`.
6. The final pose is re-evaluated on the main thread with `engine.scoreInt` (the same integer function): the big
   number is that `scoreMilli`, never the float energy. The panel shows dG with its band, pKd, Kd (auto unit),
   ligand efficiency, heavy atoms, rotatable bonds, `Method` (the active method's name), seed, steps, elapsed, the
   five weighted terms and the four geometry rows. The pose goes into the viewer. The run keeps `methodJson`: the
   engine's `Result.methodCompact` (the canonical string of the reproducible method: budget as the steps run, the
   chains used, the seed), or our compact of the resolved method with the seed when the engine has none.
7. The docking test (`record.js`, SPEC 9.1): `labStatus()` decides live or not. When live the action slot shows the
   two payment cards (`role="radiogroup"`, two `role="radio"` buttons): `Pay {fee} ETH` and `Pay {price} $PONCHEM`,
   the token card disabled with the note `after the $PONCHEM launch` while `status.token` is null or
   `status.tokenAllowed` is not true (the ETH card is disabled with `not offered right now` while `ethAllowed` is
   false), then the button and the fee line `Docking test fee {price} $PONCHEM or {fee} ETH + gas · paid to the lab
   treasury` (`runPrice` and `runFee` from the status; while a status carries no `runPrice` the SPEC default 100e18
   is shown). Button states: not live, no run, geometry fail, `Connect wallet to run the test`, `Switch to Robinhood
   Chain`, `Run docking test`, `Approving $PONCHEM`, `Waiting for the chain`, `Recorded`. `record()`: `lab.quote()`
   first and the chain's dry run line; on the token path `lab.tokenBalanceOf(token, owner)` (a short balance stops
   with `Your wallet holds {balance} $PONCHEM. A docking test costs {price}.`; an unreadable balance is skipped, the
   chain decides), `lab.allowanceOf(token, owner, spender)` and, when short, `lab.buildApprove(token, spender,
   runPrice)` + `sendTx` + receipt (`Approval sent. Waiting for confirmation.` then `$PONCHEM approved for the
   docking test`); then `lab.buildSubmitRun(targetId, ligandId, pose, { payWithToken, methodJson, runFee })` (runFee
   0 on the token path) + `sendTx`, the pending state with the explorer link, the receipt, `RunScored` decoded
   (SPEC 8.2 signature) and the chain's score as the final number with `Browser said {dG}.`, the `chain score`
   chip, `Docking test #N` (a link to `/run?id=N`, the test page of SPEC 9.3), `View docking test` and `View
   transaction`. Toast `Docking test recorded on chain`. The plain ERC-20 calls (`balanceOf`, `allowance`,
   `approve` through js/rpc.js) are the fallback when js/lab.js lacks the helpers. The screening rows and `Test
   best` use the same recorder, so the same payment choice.
8. Screening: `Target vs many` (ligand picker multi-select, `Select top 20`) or `Ligand vs many`. The queue runs
   pairs one after another in the worker with the same seed and method; the panel becomes the ranked table
   (sortable by dG, `Run test` per row, `Test best` on top, a row click shows that pose). The action slot shows the
   payment cards and the fee line (the button is hidden there).
9. The Method panel (`method.js`, SPEC 9.7): on desktop a card under the run controls, opened by the method chip
   (`Change` / `Hide`); on a phone the chip opens the sheet (`Docking method`, Done). Contents: the preset select
   (optgroups `Presets`, engine order, and `My methods`, plus a hidden `Edited method` entry), the JSON editor
   (monospace textarea, validated on every input: `This is not valid JSON: {detail}` / `A method is a JSON object
   with curly braces.` / the engine's own sentences that name the key or the bound / `The method JSON is {bytes}
   bytes. The chain accepts at most 1024.`), the status line `Valid method · {bytes} bytes`, `Reset to preset`,
   `Save as my method` (localStorage `ponchem.methods`, an array of `{ name, method, savedAt }` keyed by the JSON's
   `name`; `Remove` for a saved one), `Export JSON` (a Blob download `ponchem-method-<slug>.json`), `Import JSON`
   (file input, validated, the file text stays in the editor with its errors when invalid), `Share link`. The
   depth control mirrors the Quick / Standard / Deep presets: a depth click selects that preset, a non-depth preset
   or an edit leaves the depth unpressed. An invalid method disables Find a pose with `Fix the method JSON before
   finding a pose.` The chip and the results row show the method's name (the JSON's `name`, or `Edited method`).
   `js/engine/method.js` is wrapped by `createMethodApi()` so its shape may move: presets may be an array of method
   objects, `{ key, name, method }` entries or a map; `validateMethod` may answer errors as strings or objects;
   `methodToCompact`, `methodToQuery`, `methodFromQuery`, `methodEquals` are used when present with plain fallbacks.
10. Phone (under 768): pair bar with two chips that open the picker sheet (85 vh, Done, Escape, backdrop), the
   viewer 240 px tall, results as a stacked card (its action shows the payment cards and the fee line), a fixed
   bottom bar with Find a pose (or Run docking test plus the fee line and the not-live line once a result exists),
   hidden while a sheet is open; the method chip opens the method sheet.

## 3. What depends on other builders

- `js/catalog.js`: `loadCatalog` (ids, `box`, `cancerKeys`, `cancersOf`), `fetchStructure`, `fetchLigandSdf`,
  `fetchPocket`, `fetchTopology`, `rcsbImage`, `CANCERS`; the ligand fields `ccd` and `pubchemCid` for the links.
- `js/engine/index.js` (v2): `parseSdf`, `loadPocket`, `loadTopology`, `ensureTables`, `scoreInt`, `dock({ ...,
  method })`, `cancel`, `derived`; `Result.steps`, `Result.methodCompact`. `js/engine/method.js`: `METHOD_PRESETS`
  (seven full method objects), `validateMethod`, `methodToCompact`, `methodToQuery`, `methodFromQuery`,
  `methodEquals`. The v2 index imports the method module, so the module's absence takes the engine down with it
  (the page then shows both the engine line on the run button and the unavailable line in the panel).
- `js/chain.js labStatus()` (v2): `runFee`, `runPrice`, `token`, `tokenAllowed`, `ethAllowed`. `js/lab.js` (v2):
  `quote`, `buildSubmitRun(targetId, ligandId, pose, { payWithToken, methodJson, runFee })`, `buildApprove(token,
  spender, amount)`, `allowanceOf(token, owner, spender)`, `tokenBalanceOf(token, owner)`, `labAddress`,
  `registerRevertExplainer` (context `{ runFee, runPrice, epochEnd, token, payWithToken }`), `NOT_LIVE`.
- `css/site.css`: tokens, the shell, toasts, the wallet menu. `css/lab.css` carries fallback values for every
  token so the lab renders alone.
- `/run?id=N` (the test page of SPEC 9.3) is linked after a recorded test; `/docs#methods` from the panel note.
- `data/registry.json`, `data/pockets/*.bin`, `data/topologies/*.bin`: present (100 targets, 152 ligands).
- `js/abi.js`: not present; `js/lab.js` carries the fragments (the one place the ABI lives).

## 4. Strings the copy deck does not have (candidates for docs/copy.md)

v1 (kept): `The docking engine could not be loaded. Reload the page.` · `Recording opens when the lab contract
is live on Robinhood Chain.` (fallback; `js/lab.js NOT_LIVE` is what shows) · `Chain dry run {dG} kcal/mol` ·
`Chain dry run {dG} kcal/mol, browser said {browser}.` · `The chain refused this pose: {reason}` · `{i} of {n} ·
{name}`.

v2 (SPEC 9.1): run card `DOCK` · `Find a pose in your browser, then run the docking test on chain.` · button
`Find a pose` · empty state `Choose a target and a ligand, then find a pose.` · `Tick the compounds or targets to
screen, then find the poses.` · `Run docking test` · `Connect wallet to run the test` · `Approving $PONCHEM` ·
`Docking test fee {price} $PONCHEM or {fee} ETH + gas · paid to the lab treasury` · `Pay {fee} ETH` · `Pay {price}
$PONCHEM` · `after the $PONCHEM launch` · `not offered right now` · `Your wallet holds {balance} $PONCHEM. A docking
test costs {price}.` · `Approval sent. Waiting for confirmation.` · `$PONCHEM approved for the docking test` ·
`Docking test recorded on chain` · `Docking test #{id}` · `View docking test` · `Test best` · `Run test`.

v2 (SPEC 9.4): `RCSB {id}` · `PubChem {id}`.

v2 (SPEC 9.7): `METHOD` · `Docking method` · `Method: {name}` · `Change` · `Hide` · `Preset` · `Presets` · `My
methods` · `Method JSON` · `The search that prepares the pose. The chain scoring function is fixed. Fields and
bounds are in the docs.` · `Docking methods in the docs` · `Valid method · {bytes} bytes` · `Reset to preset` ·
`Save as my method` · `Remove` · `Export JSON` · `Import JSON` · `Share link` · `This is not valid JSON: {detail}` ·
`A method is a JSON object with curly braces.` · `The method JSON is {bytes} bytes. The chain accepts at most
1024.` · `Give the method a name in its JSON before saving.` · `Method saved as {name}` · `Method removed` ·
`Method loaded: {name}` · `That file is not a valid method.` · `Method JSON downloaded` · `The method in this link
is not valid. Standard is selected instead.` · `Fix the method JSON before finding a pose.` · `Edited method` ·
results row `Method`.

Dropped in v2: the min hold block and `Recording needs at least {minHold} $PONCHEM in the connected wallet.`
(SPEC 9.1 dropped `minHold`; payment is the utility). `Run fee {fee} ETH + gas · joins the {target} pool` is gone
too (run fees no longer feed pools).

## 5. Gates and what could not be exercised

- `node tools/shell.mjs`: every page carries the current shell. `node tools/verify.mjs --files`: the lab's files
  pass every gate (dashes, emoji, words, address, scripts, links, head, content, shell, csp); the failures the run
  reports at the time of writing are in other builders' files (dashboard.html `pc-dash-preview` class name for the
  words gate, js/pages/common.js and api/_llm.mjs dash regexes for the dashes and emoji gates).
- `node tools/lab-test.mjs`: 36 checks in headless Chrome, all against the real modules on disk (the method stub
  inside the test is served only while js/engine/method.js is absent): A 1280 real modules (the row links, a Quick
  run, the not-live state, the Method panel); B 390 and 360 (sheets for the pickers and the method panel); C, C2,
  C3 the simulated wallet with a stubbed live chain and a stubbed js/lab.js served through DevTools request
  interception (the fee line, the payment cards, `buildSubmitRun` with `{ payWithToken, methodJson, runFee }`, the
  compact method JSON with the seed, msg.value == runFee on the ETH path, the Approve step reaching the wallet on
  the token path when the allowance is short, msg.value 0 with payWithToken when it is enough); D the engine
  missing; E screening; F js/engine/method.js missing (the unavailable line); G the Method panel (presets, the
  depth mirror, invalid JSON and the plain error list, two Reproducible runs of 300 and 500 steps, the share link
  round trip, export and import, save and remove). Screenshots in `.tmp/shots-lab/`.
- Not exercised against a real contract: `quote()`, `submitRun` and the ERC-20 approve on chain, the receipt
  decode of a real `RunScored` (the stub wallet answers a made up hash and no receipt ever arrives, so the pending
  and approving states are the last states the tests see), the `Paid` and `Method` events. `node tools/app-test.mjs`
  against a local chain is the place for those once the v2 contract is deployed on anvil.
- The manifest icons `/img/brand/icon-192.png` and friends answer 404 (site.webmanifest names them); the test
  allows those 404s, `tools/verify.mjs` will not.

## 6. What changed in v2 (for the reviewers of the other modules)

- `pickers.js` rows are `div[role=option][tabindex=0]` instead of buttons, with a `.lab-row-link` anchor (RCSB or
  PubChem) or an empty spacer; the grid is `48px 1fr 36px 24px`.
- `record.js`: payment cards, the approve step, `buildSubmitRun` with the options object, no min hold. The recorder
  exposes `payment()` and `setPayment()`.
- `run.js`: `dock()` and `queue()` take `method` and `methodName`; `engineParamsOf(method, depthKey)` maps a method
  to the plain v1 parameters; the run keeps `method` and `methodJson`; the view carries `methodName`.
- `results.js`: the `Method` row, `Docking test #N` and `View docking test` links, `Run test` and `Test best`.
- `sheet.js`: focuses the first visible control (never a hidden file input); `content()` tells what is open.
- `js/pages/lab.js`: the method panel wiring, the `?method=` URL, the payment context for the revert explainer.
- `lab.html`: the run card head, the method chip, the method card; `css/lab.css`: the new parts.
