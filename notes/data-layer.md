# Data layer notes (js/catalog.js, js/chain.js, js/lab.js, js/gamify.js, api/_lab.mjs, api/_llm.mjs, api/status.js, api/runs.js, api/report.js, api/analyze.js)

Written by the data layer builder, phase 2 (2026-09-22) and extended in v2 (SPEC.md section 9: paid docking tests,
reviews, the test page reads, XP and badges, the method event, the analysis API). Implements SPEC.md 8.4 and the
write helpers named at its end, coded against the contract interface of 8.2 as amended by 9.1, 9.2, 9.7 and 9.8,
through human-readable fragments in js/rpc.js.

## Files

| file | what it is |
|---|---|
| `js/catalog.js` | the library: catalogs + registry merge, CANCERS, data file fetches (SDF, pocket, topology, RCSB structure), search and filters (unchanged in v2) |
| `js/chain.js` | the read side: labStatus, runs, runById, reviewsOf, reviewStats, analysesOf, testsOf, ledger, profileOf, walletRanking, bests, pools, walletStats, report, onBlock; plus the pure pieces the server shares (log decoding, LogIndex, ledgerOf, selectRuns, computeBests, compileReport, renderReportMarkdown) |
| `js/lab.js` | the write side: LAB_FRAGMENTS (the ABI, the alignment table below), ERC20_FRAGMENTS, labAddress, the builders (submitRun, approve, reviewRun, attachAnalysis, fund, settle, withdraw), allowanceOf, tokenBalanceOf, quote, the revert decoder and explainer |
| `js/gamify.js` | XP, levels and badges of SPEC.md 9.5: pure functions over a ledger; LEVELS, BADGES (24 px stroke path data), XP_RULES, computeProfile, rankWallets |
| `api/_lab.mjs` | shared server helpers: env, upstream RPC with the DoH fallback, cache, the LogIndex singleton, the disk catalog, the reads (status, runsQuery incl. one run and the ledger, reportData, analysisFacts, scoreOnServer), HTTP plumbing with POST support |
| `api/_llm.mjs` | the model providers of SPEC.md 9.8 (raw HTTP, no SDK), the analysis prompt, the post-processing, the limiter and the cache |
| `api/status.js` `api/runs.js` `api/report.js` `api/analyze.js` | the routes, one line each over `_lab.mjs` (analyze is GET + POST) |
| `tools/api-test.mjs` | the test (pure, gamify on synthetic ledgers, fake chain in process, fake model provider over HTTP, the dev server over HTTP, the Node import smoke test) |

## The ABI (the contract builder's alignment sheet)

`js/abi.js` from the contract builder did not exist while this was written, so the ABI lives in ONE place:
`LAB_FRAGMENTS` in `js/lab.js` (alias `LAB_ABI`). `js/chain.js` and `api/_lab.mjs` import it from there. When
`js/abi.js` ships, switch the one import in `js/lab.js` (`export const LAB_FRAGMENTS = LAB_ABI`) and nothing else
moves. The v1 rows were reconciled against `contracts/src/PonchemLab.sol` as it landed; the v2 rows are coded from
SPEC.md 9 exactly as it writes them, with the types below chosen where the SPEC names a field without a type.
The contract builder aligns to this table; a change here is a change in `js/lab.js` first.

| kind | fragment | note |
|---|---|---|
| write | `submitRun(uint16 targetId, uint16 ligandId, int16[] pose, bool payWithToken, string method) payable returns (uint256 runId, int32 scoreMilli)` | 9.1 + 9.7. ETH path `msg.value == runFee`; token path `msg.value == 0`, `transferFrom(msg.sender, treasury, runPrice)`. `method` compact JSON, `<= 1024` bytes, may be empty |
| write | `quote(uint16, uint16, int16[]) view returns (int32 scoreMilli)` | unchanged, free, no payment flag |
| write | `reviewRun(uint256 runId, uint8 stars, string note)` | 9.2. stars 1..5, note `<= 280` bytes, `msg.sender != run.wallet`, a second review replaces the first |
| write | `attachAnalysis(uint256 runId, string provider, string text)` | 9.8. only `run.wallet`, text `<= 2048` bytes, replaces an earlier one |
| write | `fund(uint16) payable` `settle(uint16, uint32)` `withdraw()` | unchanged |
| view | `runFee() uint256` `runPrice() uint256` `feeBps() uint16` `token() address` `ethAllowed() bool` `tokenAllowed() bool` | 9.1. `minHold()` is gone. `treasury()` exists but is never read by the site |
| view | `run(uint256) returns (address wallet, uint16 targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, uint64 time, bytes32 poseHash, bytes32 methodHash)` | 9.7: `methodHash = keccak256(bytes(method))`, zero when the method is empty |
| view | `runsFrom(uint256 from, uint256 count) returns ((...same eight fields...)[] page)` | the tuple follows `run()` |
| view | `stats(address) returns (uint64 runs, int32 best, uint256 prizes, uint32 reviewsGiven, uint32 reviewsReceived, uint32 starsReceived)` | 9.2. the three counters are uint32 (the SPEC names them without a type) |
| view | `reviewStats(uint256 runId) returns (uint32 count, uint32 starSum)` `reviewOf(uint256 runId, address wallet) returns (uint8 stars, uint64 time)` | 9.2 |
| view | targetCount, ligandCount, runCount, currentEpoch, epochStart, epochLength, genesis, owner, pendingOwner, tables, target, targetBox, ligand, bestOf, bestOfEpoch, bestPair, pool, poolAt, carry, nextSettle, totalHeld, totalOwed, owed, MAX_FEE_BPS, PAGE_LIMIT | unchanged |
| owner | `setPrices(uint256 runFee, uint256 runPrice)` `setPaymentOptions(bool ethAllowed, bool tokenAllowed)` `setToken(address token)` `setTreasury(address)` `setFeeBps(uint16)` | 9.1. `setRunFee` and `setToken(address, uint256)` are gone |
| owner | setTables, registerTarget(..., bytes32 expectedHash), registerLigand(..., bytes32 expectedHash), transferOwnership, acceptOwnership | unchanged |
| event | `RunScored(uint256 indexed runId, address indexed wallet, uint16 indexed targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, int16[] pose)` | unchanged |
| event | `Paid(uint256 indexed runId, address indexed wallet, uint8 method, uint256 amount)` | 9.1. method 0 eth (amount in wei), 1 token (amount in token base units) |
| event | `Method(uint256 indexed runId, string json)` | 9.7. emitted on every submitRun, empty string when no method |
| event | `Reviewed(uint256 indexed runId, address indexed reviewer, uint8 stars, string note)` | 9.2. the note lives only in the event |
| event | `Analysis(uint256 indexed runId, string provider, string text)` | 9.8 |
| event | `PricesSet(uint256 runFee, uint256 runPrice)` `PaymentOptionsSet(bool ethAllowed, bool tokenAllowed)` `TokenSet(address token)` | proposed names for the new setters (the site does not read them) |
| event | Funded, Settled, Rolled, TargetRegistered, LigandRegistered, TablesSet, FeeBpsSet, TreasurySet, Owed, Withdrawn, OwnershipTransferStarted, OwnershipTransferred | unchanged |
| error | `PaymentRefused()` | 9.1: the chosen option is off (ethAllowed / tokenAllowed false) or the token is not set. Alternates decoded too: `PaymentRefused(uint8 method)`, `EthRefused()`, `TokenRefused()`, `TokenNotSet()` |
| error | `WrongFee()` | ETH path with `msg.value != runFee` (or a token path with value) |
| error | `TransferFailed()` | the ETH forward or the `transferFrom` failed; the ERC-20's own `ERC20InsufficientAllowance` / `ERC20InsufficientBalance` are decoded too |
| error | `NotAuthor()` `BadStars()` `NoteTooLong()` `SelfReview()` `MethodTooLong()` `AnalysisTooLong()` | 9.2 / 9.7 / 9.8, all without arguments (alternates with a uint argument decode too) |
| error | BadPose(uint8), NotEnded, NoRuns, NoTarget, NoLigand, NoRun, NoValue, AlreadySettled, NothingOwed, Reentered, ScoreOverflow, NotOwner, NotPendingOwner, ZeroAddress, FeeTooHigh, BadEpochLength, NoTables, TablesAlreadySet, BadTables, HashMismatch, BadName, TooMany, BadPocket, BadTopology, PayloadTooLarge, StoreFailed | unchanged. `TokenRequired` (v1 minHold) is kept as an alternate so an old deployment still explains itself |

Every error has a plain sentence in `ERROR_SENTENCES` (js/lab.js), no dashes; the test asserts every error in the
fragment list explains. Context fills numbers: `{ runFee, runPrice, epochEnd, now, payWithToken, token }`.

## Where the lab is

`labAddress()` in `js/lab.js`: `useLab(address)` override (set by the API from env, by tests), else the localhost
`?contract=` override of `js/rpc.js`, else `LAB.address` from `js/config.js`. `labDeployBlock()` is
`LAB.deployBlock`, or 0 while an override points somewhere else. Every read and every builder goes through these two.
While `labAddress()` is null: `labStatus()` answers `{ live: false, reason: 'The lab opens when the contract is live.' }`,
`runs()` answers `[]`, `runById()` null, `ledger()` an empty ledger, `pools()` an empty Map, `report()` a report with
`live: false`, the builders throw that sentence and `quote()` answers `{ ok: false, reason }`. No page can crash on a
null address.

## js/catalog.js

```js
const cat = await loadCatalog();            // { targets, ligands, cancers, targetById, ligandById, targetByKey, ligandByKey, targetByPdb, registry, unregistered }
cat.targets[0]                              // catalog entry + { id, cancerBits, cancerKeys, pocket, atoms, name, referenceAtoms } (+ hash, box from the registry)
cat.ligands[0]                              // catalog entry + { id, topology, file, atoms, nrot } (+ hash from the registry)
CANCERS[17]                                 // { bit: 17, key: 'head-and-neck', name: 'Head and neck' }
cancersOf(target)  targetsForCancer('lung', cat.targets)  filterTargets(cat.targets, { q, cancer, cls })  filterLigands(cat.ligands, { q, cls, plant })
await fetchLigandSdf('QUERCETIN')  await fetchPocket('1M17')  await fetchTopology('QUERCETIN')  await fetchStructure('1M17')
rcsbImage('1M17')  rcsbEntryUrl('1M17')  ligandUrl(key)  pocketUrl(pdbId)  topologyUrl(key)
```

Registry rule (`registry: true`, the default): `data/registry.json` is read, and its entries ARE the library (ids,
hashes, atoms, box), merged over the matching catalog entry by key (targets also by PDB id). The pipeline registered
100 targets of the 188 in the catalog and all 152 ligands (2026-09-22); the 88 catalog targets it lacks are listed
under `unregistered`. A 404 on the registry is silent and gives catalog order (1-based). The ids of the registry are
what `contracts/deploy.sh` registers in order, so after the deploy they equal the chain's.

## js/lab.js (the write side)

```js
buildSubmitRun(targetId, ligandId, poseCenti, { payWithToken: false, methodJson: '{"name":"Standard",...}', runFee })   // { to, data, value }: value = runFee on the ETH path, 0 on the token path
buildSubmitRun(targetId, ligandId, poseCenti, runFee)     // the v1 call shape still works (ETH, no method)
buildApprove(token, spender = labAddress(), amount)       // ERC-20 approve for the token path, sent before submitRun
await allowanceOf(token, owner, spender = labAddress())   // bigint     await tokenBalanceOf(token, owner) -> bigint
buildReview(runId, stars, note)                           // stars 1..5, note <= 280 bytes (UTF-8, utf8Bytes())
buildAttachAnalysis(runId, provider, text)                // text <= 2048 bytes
buildFund(targetId, wei)  buildSettle(targetId, epoch)  buildWithdraw()
await quote(targetId, ligandId, poseCenti, { from })      // { ok: true, scoreMilli } | { ok: false, reason, code, error, transient }
registerRevertExplainer(() => ({ runFee, runPrice, epochEnd, payWithToken, token }))   // sentences with the numbers filled in
NOTE_MAX_BYTES 280  METHOD_MAX_BYTES 1024  ANALYSIS_MAX_BYTES 2048  PAYMENT { eth: 0, token: 1 }  paymentName(code)
```

`methodJson` may be a string (parsed, must be a JSON object, re-serialised compactly) or an object; longer than 1024
bytes throws the same sentence the contract's `MethodTooLong` explains. The builders check bytes the way the
contract does (`bytes(x).length`, UTF-8).

## js/chain.js (the read side)

```js
await labStatus()          // { live, reason, epoch, epochStart, epochEnd, epochLength, runFee, runPrice, feeBps, token (null until launch), ethAllowed, tokenAllowed, tokenOpen, minHold (always 0n), runCount, targetCount, ligandCount, poolTotal, poolsOk, head, generatedAt }
await runs({ target, ligand, wallet, limit, offset, order })   // Run[]     runsPage(same) -> { runs, total, head, live, source }
await runById(id)          // one Run with everything, or null: + method (JSON text | null), reviewList (newest first), analysis ({ provider, text, block, tx } | null)
await reviewsOf(runId)  await reviewStats(runId)  await analysesOf(runId)  await testsOf(wallet)
await ledger()             // { head, live, runs (no poses), settled, funded, reviews (latest per reviewer, block order), analyses (provider and block, no text) }
await profileOf(address)   // js/gamify.js computeProfile over ledger()      await walletRanking() -> rankWallets over ledger()
await bests()  await pools()  await walletStats(address)  await report()  onBlock(cb)  invalidate()
```

Run: `{ id, wallet, targetId, ligandId, scoreMilli, epoch, time, block, tx, pose: Int16Array | null, methodHash, payment:
{ method: 'eth' | 'token', code, amount: bigint } | null, reviews: { count, starSum, average }, analysisAttached }`.
`payment` comes from `Paid`, `method` from `Method`, `reviews` from `Reviewed` (the latest review by a wallet on a
run replaces its earlier one), `analysis` from `Analysis` (the latest wins; `analysesOf` lists the history on the
log path), `methodHash` from `run(id)` (filled with the time, one multicall per 500 runs), zero hash reads as null.
The wire shape of `GET /api/runs` is `toJsonRun(run)` (compact: no method text, no notes) and `toJsonRun(run, { full: true })`
for `?id=`; `fromJsonRun` reads both. The ledger's wire shape is `toJsonLedger` / `fromJsonLedger`.

`walletStats(address)`: `{ runs, best, prizes, owed, sponsored: [{ targetId, amount, count, last }], reviewsGiven, reviewsReceived,
starsReceived, reviewAverage, won: Settled[], wonEpochs, live }` (stats and owed views in one multicall, Funded logs
filtered by the wallet's topic, Settled logs read whole and filtered by winner, cached 10 s).

`report()` / `compileReport()`: every best pair and target best carries `runId`, `url` (`https://ponchem.ai/run?id=N`),
`reviews` and `analysisAttached`; the report carries `reviewCount` and `mostReviewed` (top ten by review count, then
average stars, then id). `renderReportMarkdown()`: the group tables gain a `Reviews` column (`2 (4.5)` or `0`) and a
`Link` column (`[Test #N](https://ponchem.ai/run?id=N)`), then `## Most reviewed docking tests`, then `## Method`.
Names are cleaned of pipes and dashes; review notes never reach the report.

Source rule for the browser: runs, runById and ledger read `GET /api/runs` first (`source: 'api'`) and fall back to
`eth_getLogs` from `LAB.deployBlock` (`source: 'logs'`) when the API is unreachable, answers not live, or the page
runs against a local chain (`?rpc=` / `?contract=` overrides). `setRunsSource('logs' | 'api' | 'auto')` forces it.
The log index subscribes to all eight event topics in one `eth_getLogs` filter; logs are ingested in (block, logIndex)
order and a Paid, Method, Reviewed or Analysis log that arrives before its run is attached when the run arrives.

## js/gamify.js (SPEC.md 9.5)

Pure and deterministic over a ledger. XP: 10 per docking test, 5 per distinct target (first time), 15 per test that
became the best on its target when recorded (in run order, strictly lower than the best so far or the first run on
the target; ties keep the earlier run, as the contract does), 3 per review written, 5 per review received with 4 or
5 stars (the latest review by a wallet on a run counts), 25 per epoch won (Settled winner), 5 per target sponsored
(first time). Levels Observer 0, Assistant 50, Researcher 150, Senior Researcher 400, Principal Investigator 900,
Lab Head 2000. Badges (ids): first-test, ten-tests, fifty-tests, ten-targets, strong-binder (a test at or below
-9000 milli), best-on-target, epoch-winner, sponsor, reviewer (5 written), well-reviewed (an own test with 3+ reviews
averaging 4+); each with `name`, a `rule` sentence and `path` (24 px grid, drawn with `stroke="currentColor"`,
stroke-width 1.75, round caps and joins, no fill). `computeProfile(address, ledger)` -> `{ xp, level, title, levelMin,
next: { index, title, min, remaining } | null, progress, badges: [{ id, name, rule, earned, at: { block, runId, tx } | null }],
counts, breakdown }`. `rankWallets(ledger)` ranks every wallet the ledger names by xp, tests, best dG, address.

## The API

| route | answer |
|---|---|
| `GET /api/status` | labStatus() as JSON: wei and token amounts as strings (`runFee`, `runFeeEth`, `runPrice`, `runPriceTokens`), `token`, `ethAllowed`, `tokenAllowed`, `tokenOpen`; no `minHold`, never the treasury or the lab address |
| `GET /api/runs?target=&ligand=&wallet=&limit=&offset=&order=` | `{ ok, live, runs: [compact Run], total, head, limit, offset, order }` |
| `GET /api/runs?id=N` | `{ ok, live, head, run }` with method, reviewList and analysis; 404 `{ error: 'no-run' }` (with `live: false` while the lab is not live) |
| `GET /api/runs?view=ledger` | `{ ok, live, head, runs (no poses), settled, funded, reviews, analyses }` |
| `GET /api/report` `?format=json` `/api/report.md` | the Markdown research report, or the compiled object (+ `mostReviewed`, `reviewCount`, `runId` and `url` on every pair) |
| `GET /api/analyze` | `{ ok, providers: [{ id, label, model, connected }] }` (no-store; never a key) |
| `POST /api/analyze` `{ runId, provider }` | `{ ok, provider, model, text, generatedAt, cached }`; 400 bad input, 404 no run, 409 `{ error: 'provider not connected' }`, 429 busy (10 per minute per instance), 502 `{ error: 'provider-failed', message }` |

`handle(run, { methods })` in `api/_lab.mjs` now takes a method list; POST bodies come from `req.body` (Vercel and
tools/dev.mjs parse JSON) or the stream (64 KB cap); every POST answer is no-store.

### The analysis (SPEC.md 9.8)

Providers (`api/_llm.mjs`, raw fetch, no SDK): `claude-fable` (Anthropic Messages API `POST /v1/messages`, headers
`x-api-key` and `anthropic-version: 2023-06-01`, body `{ model, max_tokens, system, messages: [{ role: 'user', content }] }`,
the text blocks of `content` joined, `stop_reason: 'refusal'` is a plain error; default model `claude-fable-5-1`, no
`thinking` parameter because the model reasons by default), `gpt` (OpenAI chat completions with
`max_completion_tokens`, default `gpt-5`), `kimi` (Moonshot `https://api.moonshot.ai/v1`, default `kimi-k2`), `jev`
(`JEV_API_URL` + `JEV_API_KEY`, OpenAI-compatible, default model `jev`). Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`MOONSHOT_API_KEY`, `JEV_API_KEY`; models `PONCHEM_MODEL_CLAUDE_FABLE`, `PONCHEM_MODEL_GPT`, `PONCHEM_MODEL_KIMI`,
`PONCHEM_MODEL_JEV`; base overrides `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `MOONSHOT_BASE_URL` (the test points
them at a fake). `connected` = the key (and for Jev the URL) exists; read at call time; never logged or echoed.

The prompt (`buildAnalysisPrompt`): facts first (the test id, block and time; the target's gene, protein, PDB id,
method, resolution, cancer groups, reference ligand; the ligand's name, plant, formula, heavy atoms, rotatable bonds,
class, PubChem CID or CCD; dG, band, pKd, Kd, ligand efficiency; the five weighted terms and the geometry proof
recomputed on the server from the recorded pose with the browser's integer scorer, and whether they agree with the
chain's score; the target's other tests, its best and the epoch best; the pair's tests and best; the recorded method
JSON; the review count and average) then the ask (interpret, the limits of a rigid-receptor Vina-style estimate, next
computational and wet-lab steps, recalled literature labelled as unverified recall, under 350 words). The system
line forbids emoji, dashes, markdown headers and bullets and any clinical claim. Review notes are never sent. 25 s
timeout, 700 tokens, post-processing (`postProcess`): em and en dashes become commas or periods (a numeric range
becomes "to"), emoji removed, markdown headers, bullet and bold markers dropped. Cached per (runId, provider) for
ten minutes; ten calls per minute per instance.

The server-side rescoring (`scoreOnServer`) loads `js/engine/format.js`, `score.js` and `tables.js` in Node, reads
`data/tables/tables.bin`, `data/pockets/<PDB>.bin` and `data/topologies/<KEY>.bin` from disk (HTTP from the
deployment's own `/data` as the fallback) and caches the result per run for ten minutes. A missing engine or file
only drops the terms line from the prompt.

## ENV (api/_lab.mjs)

| var | meaning |
|---|---|
| `PONCHEM_RPC_URL` | JSON-RPC URL the routes read through (default `RH_RPC_URL`, else `CHAIN.rpc`). Never echoed. |
| `PONCHEM_LAB` | PonchemLab address; wins over `LAB.address` (a local chain for tests). |
| `PONCHEM_DEPLOY_BLOCK` | first block to scan when `PONCHEM_LAB` is set (default 0; `LAB.deployBlock` otherwise). |
| `PONCHEM_SITE_URL` | where `/data` lives when the catalog files are not on disk (default: this deployment). |
| provider keys and models | see the analysis section above |

Against a local chain: `PORT=6133 PONCHEM_RPC_URL=http://127.0.0.1:8692 PONCHEM_LAB=<address> node tools/dev.mjs`, and
in the browser `/leaderboard?rpc=http://127.0.0.1:8692&contract=<address>` (localhost only). Restart the dev server
after editing `api/_lab.mjs` or `api/_llm.mjs` (route files reload on change, the shared modules do not).

## Tests

`node tools/api-test.mjs` (default base http://127.0.0.1:6133; `--base`, `--only`). 67 checks: pure decoding with
hand-encoded logs for all eight events, the index ingest in any log order (payments, methods, reviews and analyses
attached; latest review per reviewer; latest analysis), the wire shapes, selection and paging, bests and tie rules,
the report compiler (reviews, links, mostReviewed) and its Markdown, the catalog assembler with and without a registry,
the filters, the builders (calldata decoded back, both call shapes of buildSubmitRun, approve, review, analysis, the
byte limits), the reason table, every error selector's sentence, the revert data digger; js/gamify.js on synthetic
ledgers (the tables, XP arithmetic per rule, every badge and its `at`, levels at every boundary, the ranking); then
a fake JSON-RPC node inside the process (the global fetch answers one made-up URL, so no port is used) serving
eth_getLogs with topic filters and a "too many results" refusal, Multicall3 and every lab view in the SPEC 9 shapes:
labStatus with the payment fields, runsPage, runById, reviewsOf, reviewStats, analysesOf, testsOf, the incremental
sync, chunk halving, bests, ledger with profileOf and walletRanking, pools, walletStats with the review counters and
won epochs, report, quote, the API fallback, the unreachable reason, onBlock; the API handlers imported in process
with the env pointed at the fake (status, paging, filters, one run, the ledger, 400s, 405, HEAD, OPTIONS, the report,
analyze GET and 409 / 400 / 404 / 405, then a fake model provider server on 127.0.0.1:8692 (ephemeral when busy)
speaking the OpenAI chat shape and the Anthropic Messages shape: the request headers and body, the facts in the
prompt, the post-processing, the cache, provider failures and refusals, the limiter, 502 then recovery); and over
HTTP against the dev server the not-live shapes, headers, `/api/report.md`, analyze GET and POST, and the Node import
smoke test. Provider keys are removed from the process environment before anything runs, so no real model is called.

## What still needs other builders

- `contracts/src/PonchemLab.sol` at SPEC 9 (the table above) and `contracts/deploy.sh` filling `LAB.address` /
  `deployBlock` / `genesis` in js/config.js. Until then every read is the not-live path.
- `vercel.json` (not owned here): `POST /api/analyze` can take up to 25 s on the provider plus the chain read; add
  `"functions": { "api/analyze.js": { "maxDuration": 60 } }` so the platform does not cut it at the default.
- The dashboard, run and leaderboard pages consume `runById`, `reviewsOf`, `analysesOf`, `ledger`, `profileOf`,
  `walletRanking`, `walletStats` and the `analyze` route as documented above; the lab UI consumes `buildSubmitRun`
  with the options object, `buildApprove`, `allowanceOf`, `tokenBalanceOf` and `labStatus().token / tokenAllowed / runPrice`.
- The stale `anvil --port 8691` process from 2026-09-21 is still running; nothing here needed it.
