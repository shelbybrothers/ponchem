# Pages builder notes (css/site.css, the pages, js/pages/*)

status: v2 built and gated (2026-09-22, SPEC.md section 9: test pages, dashboard, direct links, docs); v1 notes kept below

## Files I own

`index.html targets.html target.html ligands.html ligand.html leaderboard.html report.html wallet.html docs.html 404.html
run.html dashboard.html`, `css/site.css`, `js/pages/{common,home,targets,target,ligands,ligand,leaderboard,report,wallet,
dashboard,run,docs,xp}.js`, `partials/*`, `og.png`, `sitemap.xml`, `tools/verify.mjs` (extended), `tools/pages-test.mjs`,
the `/wallet` redirect entry in `vercel.json`, the `dashboard` menu item in `js/shell.js` and its expectation in
`tools/wallet-test.mjs`, this file. `js/pages/lab.js` and `js/lab-ui/*` are the lab builder's.

`js/pages/common.js` is the helpers every page module shares (safe dynamic imports of the other builders' modules,
the catalog fallback, energy bands, tables, empty states, icons, and since v2 the stars, reviews, run-by-id, X intent,
test Markdown, analysis route and gamification adapters). `js/pages/xp.js` is the reference implementation of the
XP, level and badge rules of SPEC 9.5; `common.js gamify()` prefers `js/gamify.js` when it exports the shipped shape.

## v2 (SPEC 9) in short

- `/run?id=N` (run.html, js/pages/run.js): header (`Docking test #N`, ligand into target, wallet, time, tx), the chain's
  score with pKd, Kd, LE, the browser check (engine `scoreInt` on the event pose: `Chain and browser agree` or the two
  numbers, the four geometry rows, the five weighted terms), the pose on the receptor (`mountStructure` with `pose` and
  `box`, through `js/viewer.js showPose` or the own 3Dmol path), provenance with the 9.4 links, the method block
  (pretty JSON as text, `Use this method` -> `/lab?method=<base64url>` only when `validateMethod` passes), AI analysis
  (GET /api/analyze providers with `not connected`, POST, `Attach analysis on chain` for the author via
  `buildAttachAnalysis` + `sendTx`, the attached one from the run), reviews (average, count, list newest first, notes as
  text) and `Write a review` (stars picker, 280 counter, `buildReview` + `sendTx`), `Post on X`, `Copy link`, `Download
  report` (Markdown built in the browser). Not found: `Docking test not found` with the chain note (the not-live sentence
  when there is no contract). Head tags are set per test (title, description, canonical, og:url).
- `/dashboard` (dashboard.html, js/pages/dashboard.js): no-wallet card listing what the dashboard shows + Connect;
  connected: address + Copy, level and title, XP with the progress bar to the next level, the ten badges (earned lit),
  four stats, then the sections My docking tests (Test, Target, Ligand, dG, Band, Reviews, Post on X / Report), Best
  scores, Reviews received, Reviews written, Prizes and withdraw (Claim -> buildWithdraw), Sponsorships, Payment
  (prices from labStatus: runFee, runPrice, tokenOpen; the blank token controls). Data: `walletStats` + `ledger()`
  (through `gamifyData()`), profile through `gamify().profileOf`.
- `/wallet` is a forwarding page (meta refresh 3 s + link); `vercel.json` redirects it permanently to `/dashboard`.
  The wallet menu's `my runs` item became `dashboard` -> `/dashboard` (js/shell.js, asserted by tools/wallet-test.mjs).
  The footer column says `Dashboard`. sitemap lists `/dashboard`.
- Leaderboard: view `Wallets` shows Rank, Wallet, Level, XP, Tests, dG from `gamify().rank(ledger)`; view `Most reviewed`
  lists tests by review count; every run table has a `Test` column (`#N` -> /run) and a `Reviews` column when the
  ledger has reviews; the phone cards link `test #N`.
- Report: the top-ten tables gain `Reviews` and `Test`, the names carry `RCSB 4WKQ` / `RCSB AQ4` / `PubChem 5280343`;
  the best pair cards get the same links and `Test #N`; the browser-built Markdown gains the two columns.
- Landing: value prop 3 `Every docking test is paid, scored and reviewed`, steps 03 `Test` and 04 `Review and settle`,
  the token card explains 100 $PONCHEM or 0.0001 ETH and the `after the $PONCHEM launch` state, the stat strip has
  five cells (`Docking tests`, `Reviews`); the minHold line is gone.
- Docs: sections Payment (#payment), Docking methods (#methods, the schema table rendered from
  `js/engine/method.js METHOD_SCHEMA` and the presets from `METHOD_PRESETS`, static fallback in the HTML), Reviews
  (#reviews), Levels and badges (#levels, XP table, levels, the ten badge tiles from gamify), AI analysis (#ai-analysis),
  Post on X (#post-on-x); glossary adds Docking test, Method, Test price, Review, XP; API lists GET and POST /api/analyze.
- 9.4 links everywhere: `rcsbStructureLink(pdb)` -> `RCSB 4WKQ`, `rcsbLigandLink(ccd)` -> `RCSB AQ4`,
  `pubchemLink(cid)` -> `PubChem 5280343`, `ligandSourceLink(l)` picks the CCD page else PubChem. Cards, the target
  page (reference ligand row too), the ligand page, the test page, the report tables. All open in a new tab with
  `rel="noopener noreferrer"`.

## The data layer v2 as consumed (js/chain.js, js/lab.js, js/gamify.js as shipped 2026-09-22)

```
runById(id) -> Run (full: pose, method (JSON text | null), payment { method 'eth'|'token', code, amount }, reviews { count, starSum, average },
                     reviewList: Review[] newest first, analysis { provider, text, block, tx } | null) | null
reviewsOf(id) -> Review[]   analysesOf(id) -> Analysis[] (block order)   ledger() -> { runs asc (no pose), settled, funded, reviews, analyses }
profileOf(address) / walletRanking()  (chain.js over gamify.js)          walletStats(a) gains reviewsGiven, reviewsReceived, starsReceived, won, wonEpochs
labStatus() gains runPrice, ethAllowed, tokenAllowed, tokenOpen
js/lab.js: buildReview(runId, stars, note), buildAttachAnalysis(runId, provider, text), buildSubmitRun(t, l, pose, { payWithToken, methodJson, runFee })
js/gamify.js: computeProfile(address, ledger) -> { address, xp, level (index), title, next { title, min, remaining }, progress, badges [{ id, name, rule, earned }], counts }
              rankWallets(ledger) -> [{ rank, address, xp, title, tests, best, ... }]   LEVELS { index, name, min }   BADGES { id, name, rule, path }   XP_RULES { id, xp, sentence }
api/analyze.js: GET { ok, providers: [{ id, label, model, connected }] }   POST { runId, provider } -> { ok, provider, model, text, generatedAt }
```

`common.js` normalises all of it: `runById` (falls back to the run list), `reviewsOf(id, run)` (uses `run.reviewList`),
`analysisOf(id, run)`, `methodOf(run)`, `gamifyData()` (the ledger, else allRuns + settledAll), `gamify()` (one Profile shape:
`{ wallet, xp, level: { name, min, next, progress, toNext }, tests, best, badges: [id] }`; `js/pages/xp.js` when the
shared module is absent; the two agree on the SPEC 9.5 rules, checked on a hand ledger). The Payment shape difference
(`code` 0/1 or `method` string) is handled in run.js `paidRow`.

## Gates (v2)

- `node tools/shell.mjs --check` pass (13 pages).
- `node tools/verify.mjs --files` pass: `run` and `dashboard` in SPEC_PAGES; the words gate also refuses `sample` and
  `placeholder` (input `placeholder=""` attributes are not visible text and are dropped first); regex literals in js and
  mjs are dropped before the dashes and emoji gates (api/_llm.mjs strips dashes and emoji from model output with them);
  the content gate carries the v2 strings of every page; the browser X-link gate reads `BRAND.x`
  (https://x.com/PonchemAI) and the logo gate accepts the PNG mark the partials use.
- `node tools/verify.mjs http://127.0.0.1:6131` (CHROME_PORT=9540): every route including `/run?id=1`, `/dashboard`,
  `/wallet` at 360/390/430/768/1024/1280/1440.
- `node tools/pages-test.mjs --base http://127.0.0.1:6131` (CHROME_PORT=9540): 395 checks; `/run?id=1` shows the
  not-found state with the not-live reason, `/run` without an id shows `Unknown docking test id.`, `/dashboard` shows the
  no-wallet state with one h1, `/wallet` forwards to `/dashboard`, `/docs` has the ten anchors, ten badge tiles, six
  levels, 14 schema rows and 7 presets, the target and ligand pages carry links that name their destination.
- Not exercised without a deployed contract: the found state of `/run` (score, browser check, pose viewer, reviews
  form, analysis picker), the connected dashboard, the Wallets and Most reviewed views with data. They are written
  against the shipped module signatures above. `node tools/pages-test.mjs --rpc URL --contract 0x..` drives the pages
  against a local chain when one exists.

## Tokens, class names, viewer and data contracts (v1, unchanged)

Tokens (all on `:root` in css/site.css, the block from SPEC-DESIGN.md section 10, verbatim): colours `--paper --paper-2
--white --dark --dark-2 --ink --ink-2 --ink-3 --line --line-strong --edge --muted-on-dark --line-on-dark --receptor
--receptor-tint --receptor-on-dark --ligand --ligand-tint --ligand-on-dark --good --good-tint --good-on-dark --warn
--warn-tint --warn-on-dark --bad --bad-tint --bad-on-dark`; fonts `--font-display --font-text --font-mono`; type
`--t-hero .. --t-dg`; spacing `--s-1 .. --s-13`, `--gutter --container --measure --section-y`; radius `--r-1 .. --r-pill`;
shadows `--shadow-1..3`; motion `--ease`; `--nav-h`; viewer colours `--v-receptor --v-pocket-c --v-ligand-c --v-ref-c`.

Class names (prefix `pc-`; the lab may use every one): layout `.pc-skip .pc-main .pc-container(--wide|--prose)
.pc-section(--tight) .pc-section-head .pc-band--dark|--white|--paper2 .grid-paper .pc-grid .pc-cards(--scroll) .pc-two
.pc-row .pc-stack .pc-visually-hidden`; type `.pc-eyebrow .pc-h1..h4 .pc-lede .pc-mono .pc-id .pc-muted .pc-small
.pc-caption .pc-unit .pc-link(--out)`; buttons `.pc-btn` + `--primary --receptor --outline --ghost --warn --danger --lg
--sm --block --icon`, `[aria-busy]`; inputs `.pc-field .pc-label .pc-input .pc-select .pc-help .pc-error .pc-search
.pc-seg .pc-pills .pc-pill .pc-chip(--receptor|--ligand|--good|--warn|--bad|--mono) .pc-badge(--strong|--moderate|--weak|
--none|--recorded|--pending|--settled)`; cards `.pc-card(--link|--pad|--paper2) .pc-card-media(--ligand) .pc-card-badge
.pc-card-chip .pc-card-body .pc-card-title .pc-card-caption .pc-card-stats .pc-ministat .pc-card-foot .pc-listrow`;
tables `.pc-table-frame .pc-table(--stack|--compact) .pc-td-num .pc-td-id .pc-td-mono .pc-td-name .pc-td-links .pc-rank
.pc-dg(--strong|--moderate|--weak|--none|--plain) .pc-bar .pc-tr-you .pc-you`; data `.pc-ladder .pc-stats(--5) .pc-stat
.pc-skel .pc-empty .pc-alert(--warn|--bad|--good|--info) .pc-netband .pc-tabs .pc-tab .pc-tabpanel .pc-progress .pc-code
.pc-dl .pc-toc .pc-tooltip`; viewer `.pc-viewer-card .pc-viewer .pc-viewer-img .pc-viewer-caption .pc-viewer-strip
.pc-viewer-legend .pc-viewer-toolbar`; v2 `.pc-run-head .pc-run-meta .pc-run-grid .pc-score .pc-score-num .pc-rows
.pc-run-sections .pc-run-section .pc-agree(--ok|--bad) .pc-geo .pc-geo-row[data-ok] .pc-method .pc-analysis(--attached)
.pc-providers .pc-provider[data-connected] .pc-stars .pc-star[data-lit] .pc-stars-picker .pc-star-btn .pc-review-cell
.pc-review-summary .pc-review-list .pc-review .pc-review-head .pc-review-note .pc-review-form .pc-review-gate .pc-textarea
.pc-counter .pc-connect-card--wide .pc-dash-list .pc-profile .pc-level-card .pc-level-name .pc-level-xp .pc-xp-bar
.pc-wallet-stats--4 .pc-badges(--docs) .pc-badge-tile[data-earned] .pc-badge-icon .pc-badge-name .pc-badge-rule
.pc-dash-nav .pc-dash-sections .pc-dash-section .pc-payment .pc-empty--page .pc-run-link`.

The viewer contract: `mountStructure(host, { pdbId, refCcd, chain, image, transparent, spin, frameAll, pose: { sdfText,
poseAbs }, box: { center, half } })` uses `js/viewer.js createViewer / showStructure({ highlightPocket }) / showPose` when
it exists, else the own 3Dmol path (`sdfWithPoseLocal` swaps the SDF coordinates), else the RCSB image; `mountLigand` as
before. The catalog contract (`js/catalog.js loadCatalog()` with registry ids, else the files) and the chain reads (v1
`labStatus / runs / bests / pools / walletStats / report / onBlock`, v2 above) are all behind `chain(name, ...)` with
`{ ok, value, reason }`, so an absent function degrades to the copy deck state.

## What runs on each page (v1 pages, unchanged unless noted)

- `/` home.js: hero structure, five-cell stat strip (reviews from `ledger().reviews`), weights, featured targets, the
  token card with the price line when live.
- `/targets`, `/ligands`: search, pills, sort, paging; cards with `RCSB 4WKQ` / `RCSB AQ4` / `PubChem CID` links.
- `/target?id=`: provenance ladder (reference ligand row links `RCSB <ccd>`), `View on RCSB` + `RCSB <pdb>` + Mol*,
  pool card, tabs Leaderboard / 3D / Runs / About (the tables link every run to `/run`).
- `/ligand?id=`: `RCSB <ccd>` / `PubChem <cid>` links, 3D of the SDF, best targets and runs (linked to `/run`).
- `/leaderboard`, `/report`, `/docs`, `/dashboard`, `/run`, `/wallet`: see v2 above. 404.html loads docs.js (shell only).

## Depends on other builders

- js/viewer.js (lab builder): `showPose` for the pose on the receptor; the pages fall back to their own 3Dmol path.
- js/catalog.js, js/chain.js, js/lab.js, js/gamify.js, api/* (data layer): every chain number, the ledger, the profile
  rules, the analysis route. Without them the pages show the not-live and empty states from the copy deck.
- js/engine/index.js (`scoreInt`, `loadPocket`, `loadTopology`, `ensureTables`) for the browser check; js/engine/method.js
  (`validateMethod`, `METHOD_SCHEMA`, `METHOD_PRESETS`) for the method block and the docs table.
- partials/head.html links the manifest; its PNG icons under img/brand/ are the plumbing author's.
- vercel.json (plumbing): the `/api/report.md` rewrite and now the `/wallet` -> `/dashboard` redirect (mine).
