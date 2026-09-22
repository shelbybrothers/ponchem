# Pages builder notes (css/site.css, the nine pages, js/pages/*)

status: built and gated (2026-09-22); the class-name section was written first so the lab builder could reuse it

## Files I own

`index.html targets.html target.html ligands.html ligand.html leaderboard.html report.html wallet.html docs.html 404.html`,
`css/site.css`, `js/pages/{common,home,targets,target,ligands,ligand,leaderboard,report,wallet,docs}.js`, `partials/*`,
`og.png`, `sitemap.xml`, `tools/verify.mjs` (extended), `tools/pages-test.mjs`, this file.

`js/pages/common.js` is one extra module beyond the task list: the helpers every page module shares (safe dynamic
imports of the other builders' modules, the catalog fallback, energy bands, tables, empty states, icons). Nobody
else writes into `js/pages/`.

## Tokens (all on `:root` in css/site.css, the block from SPEC-DESIGN.md section 10, verbatim)

Colours `--paper --paper-2 --white --dark --dark-2 --ink --ink-2 --ink-3 --line --line-strong --edge --muted-on-dark
--line-on-dark --receptor --receptor-tint --receptor-on-dark --ligand --ligand-tint --ligand-on-dark --good --good-tint
--good-on-dark --warn --warn-tint --warn-on-dark --bad --bad-tint --bad-on-dark`.
Fonts `--font-display --font-text --font-mono`. Type `--t-hero --t-h1 --t-h2 --t-h3 --t-h4 --t-lede --t-body --t-small
--t-caption --t-eyebrow --t-mono --t-mono-id --t-stat --t-dg`. Spacing `--s-1 .. --s-13`, `--gutter --container --measure
--section-y`. Radius `--r-1 --r-2 --r-3 --r-4 --r-pill`. Shadows `--shadow-1 --shadow-2 --shadow-3`. Motion `--ease`.
Nav height `--nav-h` (56 under 768, 64 from 768). Viewer colours as CSS custom properties too: `--v-receptor #9DB7CC`,
`--v-pocket-c #8A93A3`, `--v-ligand-c` = `--ligand`, `--v-ref-c` = `--receptor`.

## Class names (prefix `pc-`; the lab page may use every one of them)

Layout: `.pc-skip` (skip link) · `.pc-main` · `.pc-container` (1200) · `.pc-container--wide` (1440, the lab) ·
`.pc-container--prose` (760) · `.pc-section` · `.pc-section--tight` · `.pc-section-head` (eyebrow + h2 + optional link) ·
`.pc-band--dark` · `.pc-band--white` · `.grid-paper` (hero, 404, report cover only) · `.pc-grid` with `--cols: N` ·
`.pc-cards` (auto-fill 260 grid) · `.pc-cards--scroll` (phone: horizontal snap row) · `.pc-two` (two columns from 1024) ·
`.pc-row` (flex wrap gap 12) · `.pc-stack` (grid gap 12) · `.pc-visually-hidden`.

Type: `.pc-eyebrow` · `.pc-h1` · `.pc-h2` · `.pc-h3` · `.pc-h4` · `.pc-lede` · `.pc-mono` · `.pc-id` (mono 700 15 px) ·
`.pc-muted` (ink-3) · `.pc-small` · `.pc-caption` · `.pc-unit` (unit after a number) · `.pc-link` (prose link) ·
`.pc-link--out` (outbound arrow after the text).

Buttons: `.pc-btn` + `.pc-btn--primary | --receptor | --outline | --ghost | --warn | --danger`, sizes `.pc-btn--lg` (52)
`.pc-btn--sm` (36), `.pc-btn--block`, `.pc-btn--icon` (44 square, needs aria-label). `[aria-busy="true"]` shows the arc
spinner. Disabled: the `disabled` attribute or `aria-disabled="true"`.

Inputs: `.pc-field` (label + control + help) · `.pc-label` · `.pc-input` · `.pc-select` · `.pc-help` · `.pc-error` ·
`.pc-search` (input with the magnifier) · `.pc-seg` (segmented control) > `.pc-seg-btn[aria-pressed]` · `.pc-pills`
(scrolling pill row) > `.pc-pill[aria-pressed]` · `.pc-chip` + `.pc-chip--receptor | --ligand | --good | --warn | --bad`
· `.pc-badge` + `.pc-badge--strong | --moderate | --weak | --none | --recorded | --pending | --settled`.

Cards: `.pc-card` (white, line border, r-3) · `.pc-card--link` (hover) · `.pc-card--pad` · `.pc-card-media`
(4:3 image tile) · `.pc-card-media--ligand` (ligand tint) · `.pc-card-badge` (mono id on the image) ·
`.pc-card-chip` (top right) · `.pc-card-body` · `.pc-card-title` · `.pc-card-caption` · `.pc-card-stats` >
`.pc-ministat` (label + value) · `.pc-card-foot`. List row variant: `.pc-listrow` (64 px, thumb, name, caption, chevron),
`.pc-listrow[aria-selected="true"]`, `.pc-listrow--ligand`.

Tables: `.pc-table-frame` (white frame, scrolls inside under 768 with a fade) > `table.pc-table` · `.pc-td-num` (right,
mono) · `.pc-td-id` (mono 700) · `.pc-rank` (top three in ligand colour) · `.pc-dg` + `.pc-dg--strong | --moderate |
--weak | --none` (banded colour with the 4 px dot) · `.pc-bar` (inline 60 px energy bar) · `tr.pc-tr-you` + `.pc-you`
chip · `.pc-table--stack` (under 640 every row becomes a card; each `td` carries `data-label`).

Data: `.pc-ladder` (dl of label:value rows) · `.pc-stats` (stat strip) > `.pc-stat` > `.pc-stat-num` `.pc-stat-unit`
`.pc-stat-label` · `.pc-skel` (pulsing skeleton block) · `.pc-empty` (mark, h4, line, action) · `.pc-alert` +
`.pc-alert--warn | --bad | --good | --info` · `.pc-netband` (wrong network band under the nav) · `.pc-tabs` >
`.pc-tab[aria-selected]` + `.pc-tabpanel[hidden]` · `.pc-progress` (6 px bar, `role="progressbar"`) · `.pc-code` (code
block) · `.pc-dl` (glossary definition list) · `.pc-toc` (sticky contents) · `.pc-tooltip` (dark tooltip).

Viewer (shared with the lab): `.pc-viewer-card` (white, r-4, border) · `.pc-viewer` (the canvas host, `position:
relative`, aspect from `--aspect`, default 1) · `.pc-viewer-img` (the RCSB entry image shown while loading or as the
fallback, 60 percent opacity) · `.pc-viewer-caption` (mono 13 px overlay bottom left) · `.pc-viewer-strip` (44 px row
under the canvas: id, title, buttons) · `.pc-viewer-legend` (two squares) · `.pc-viewer-toolbar` (44 px icon buttons).

Shell (from the plumbing, styled here): `.pc-nav .pc-nav-inner .pc-logo .pc-logo-mark .pc-wordmark .pc-nav-toggle
.pc-nav-links .pc-nav-link .pc-buy .pc-soon .pc-ca .pc-wallet .pc-wallet-button .pc-wallet-menu .pc-menu-label
.pc-menu-addr .pc-menu-note .pc-menu-item .pc-menu-icon .pc-warn-text .pc-toasts .pc-toast[data-kind] .pc-footer ...`.
js/shell.js paints the wallet button and the menu items in lower case (`connect wallet`, `my runs`); the CSS
capitalises their first letter with `::first-letter`, so the visible strings match the copy deck.

## The viewer contract (js/viewer.js as the lab builder shipped it)

`js/pages/common.js` `mountStructure(host, { pdbId, refCcd, chain, image, transparent, spin, frameAll })` and
`mountLigand(host, { ligand, sdfText, spin })` use, in this order:

1. `js/viewer.js`: `createViewer(slot, { style: 'hero' | 'card' })` then `showStructure(pdbText, { id, chain, ligandCcd })`
   or `showLigand(sdfText)`, then `spin(true)`; `dispose()` on teardown. The hero passes `frameAll` (whole structure
   framed with `viewer.zoomTo()`) and recolours the reference ligand orange (SPEC-DESIGN 5.2) with `setReference(false)`
   plus a stick style on `{ resn, hetflag }`; the target page keeps the pocket framing and the blue ghost.
   lib/3Dmol-min.js is injected lazily by `ensure3Dmol()` (a `<script src>` element, allowed by script-src 'self'),
   so the landing page does not pay 538 KB unless it really renders a structure.
2. If js/viewer.js is absent or throws: common.js's own small 3Dmol path (cartoon #9DB7CC, ligand sticks in the
   ligand accent, spin paused on hover, hidden tab and reduced motion).
3. If WebGL or the structure file is unavailable: the RCSB entry image (targets) with the copy deck's fallback
   caption, or the CCD depiction / formula tile (ligands).

## The data contract (as shipped by the data layer builder, SPEC.md 8.4)

`js/catalog.js loadCatalog()` (ids follow data/registry.json once the lab is live, else catalog order),
`js/chain.js labStatus() / runs() / bests() / pools() / walletStats() / report() / onBlock()`, `js/lab.js buildFund /
buildSettle / buildWithdraw / registerRevertExplainer`, `js/engine/score.js W_G1..W_HB` (the five weights, micro-kcal
BigInt; printed as kcal/mol on / and /docs; a local constant equal to SPEC-ENGINE 3.5 is the fallback).

Every import is dynamic with a catch (`common.js chain(name, ...)` returns `{ ok, value, reason }`): an absent module
or a thrown read leaves the page on its static content and the copy deck's state. `chainNote(result)` shows the
module's own sentence (`The lab opens when the contract is live.` from js/lab.js NOT_LIVE, or `Could not reach
Robinhood Chain. Reads will retry.`); the stat strip adds `(chain unreachable)` only for a failed read.
While js/catalog.js is absent, common.js reads data/catalog/*.json itself (same Catalog shape).

## What runs on each page

- `/` home.js: hero structure (deterministic per day among X-ray targets with a reference ligand and resolution
  <= 3.0 A, `Next structure` cycles; caption template from the deck), stat strip (catalog counts + labStatus), five
  weights, featured targets (best of the current epoch from bests().byTargetEpoch, else the first six), token card
  (blank state, minHold line when labStatus.token and minHold are set), section reveal on first intersection.
- `/targets` targets.js: search (key, gene, protein, PDB id, title, reference ligand, cancers), cancer pills with
  counts, class pills, sort Best dG / Pool / Runs / Name, pages of 24 with Load more, `?cancer=` preselects a group.
- `/target?id=` target.js: id or key; provenance ladder (Organism and Released rows appear only when the catalog
  carries them; Pocket row from the registry box, atoms and hash), actions, pool card (countdown, best this epoch,
  Sponsor form -> buildFund + sendTx, Settle -> buildSettle when the previous epoch holds a run and the pool is
  funded or the current epoch has ended with a run), tabs Leaderboard (best per ligand and wallet) / 3D (mounted on
  first open) / Runs / About, refresh on every block.
- `/ligands` ligands.js, `/ligand?id=` ligand.js: same pattern; the 3D view is the ligand's SDF; Best targets is
  the best run per target.
- `/leaderboard` leaderboard.js: By target / By cancer group (pills) / By ligand / Wallets / Pools (Sponsor per row,
  Settle when possible), cards under 640 px with `Show table`, `Download CSV`, epoch countdown, `#view` in the URL.
- `/report` report.js: chain.report() rendered per cancer group (best pair 2-up, top ten table, counts footnote),
  sticky contents at 1280 / `Jump to` select below, Print (print CSS in site.css), `Download Markdown` links
  /api/report.md and builds the Markdown in the browser when that route is not served (the dev server only routes
  names without a dot; vercel.json needs the rewrite the API author describes in api/report.js).
- `/wallet` wallet.js: disconnected card (Connect wallet opens the shell's wallet menu), connected: address + Copy
  address, stats from walletStats, tabs Runs / Prizes (Claim -> buildWithdraw + sendTx) / Sponsorships.
- `/docs` docs.js: network parameters from CHAIN, live fees line from labStatus, weights, contents highlighting.
  404.html loads docs.js too (it only boots the shell there).

## Gates

- `node tools/shell.mjs --check` pass (11 pages).
- `node tools/verify.mjs --files` pass: added the `content` gate (per page key headings and strings of the copy deck in
  the static HTML) and `/api/<name>[.ext]` link resolution against `api/<name>.js`.
- `node tools/verify.mjs http://127.0.0.1:6131` pass at 360/390/430/768/1024/1280/1440 (77 page loads): added one
  visible h1 per page, the page's key heading rendered, the nav collapsed under 900 px, and a tolerance (noted, not
  failed) for a 404 of a file another builder has not shipped yet while it is absent on disk (manifest icons,
  js modules, data/registry.json).
- `node tools/pages-test.mjs` pass (300 checks): each page and target?id=1, ligand?id=1 at 390 and 1280, ready
  states, copy deck strings, tap targets, screenshots in .tmp/shots/. `--rpc URL --contract 0x..` drives the pages
  against a local chain through the localhost overrides of js/rpc.js (not run: no anvil deployment was available
  to this builder; the not-live state is what was exercised).

## Depends on other builders

- js/viewer.js (lab builder): the shared 3D views; the pages fall back to their own 3Dmol path or the RCSB image.
- js/catalog.js, js/chain.js, js/lab.js, api/* (data layer): every chain number; without them the pages show the
  not-live and empty states from the copy deck.
- js/engine/score.js (engine builder): the printed weights; a local constant otherwise.
- partials/head.html links the manifest; its PNG icons under img/brand/ are the plumbing author's (Chrome fetches
  icon-192.png on every load; a 404 there is tolerated by the gates only while the file is absent).
- vercel.json (plumbing): needs `{ "source": "/api/report.md", "destination": "/api/report" }` for the Download
  Markdown link to be served by the API in production; the page builds the file in the browser until then.
## Page status

All ten pages built and gated (see Gates). Open items: the chain-live path (sponsor, settle, claim toasts, live
tables) was written against the shipped module signatures but not exercised against a deployed contract.
