# PONCHEM.AI, design spec (v1, 2026-09-22)

status: final

This file is the visual contract for ponchem.ai. It implements SPEC.md section 6 ("Theme: science. Light paper
background, deep ink text, one accent for receptor and one for ligand, data in a monospace, grid-paper texture in the
hero, real structures rendered in 3D") and obeys every rule in SPEC.md section 2. The reference study behind it is
in `reference/design-notes/` (agemica.md, rcsb.md, yasara.md with screenshots). Brand files are in `img/brand/`.
Final strings are in `docs/copy.md`; this file only shows placeholder text where a component needs an example.

Three ideas run through everything:

1. **The instrument is the hero.** A real structure from the Protein Data Bank rotates on the landing page in the
   first second. No stock art, no video, no slogans over black.
2. **Two accents, two molecules.** Receptor blue and ligand orange are not decoration; they are the colour of the
   protein and the colour of the compound everywhere, in the 3D view, in chips, in the mark itself.
3. **Paper and ink.** Light paper page, deep ink text, monospace numbers, grid-paper only where a lab notebook would
   have it. Quiet, printable, honest.

## 1. Palette

All colours are CSS custom properties on `:root`. Contrast ratios are WCAG 2.x relative-luminance ratios computed
in this session (Python) and rounded to two places. Text colours pass 4.5:1 on the surfaces they are specified
for. Non-text UI edges aim for 3:1 where noted.

### 1.1 Surfaces

| token | hex | use |
|---|---|---|
| `--paper` | `#F5F3EC` | page background |
| `--paper-2` | `#EDEAE1` | sunken areas: sidebars, table header rows, code blocks, sheet backdrops |
| `--white` | `#FFFFFF` | cards, inputs, the 3D viewer canvas, RCSB entry image tiles, the print page |
| `--dark` | `#1B2028` | dark surface: footer, toasts, the wallet menu, the OG card is NOT dark (it is paper) |
| `--dark-2` | `#262C36` | raised element on dark (a row hover, a button on the footer) |

### 1.2 Ink

| token | hex | on white | on paper | on paper-2 | use |
|---|---|---|---|---|---|
| `--ink` | `#14181F` | 17.79 | 16.03 | 15.0 | headings, body, primary button fill |
| `--ink-2` | `#3B4250` | 10.09 | 9.09 | 8.5 | secondary text, table body |
| `--ink-3` | `#5F6673` | 5.78 | 5.20 | 4.80 | muted text, captions, placeholders, disabled label text |
| `--line` | `#D9D5CB` | 1.47 | 1.32 | | hairlines, card borders, table rules (decorative, not relied on for meaning) |
| `--line-strong` | `#B8B3A6` | 1.88 | | | dividers that carry structure (section rules, table header underline) |
| `--edge` | `#7C776B` | 4.46 | 4.02 | | input borders, checkbox edges, icon-only button outlines (passes 3:1 for UI components) |

On dark surfaces: text `--paper` (16.03 on `--dark`, 14.73 on `--dark`, 12.64 on `--dark-2`), muted `--muted-on-dark
#A9B1BD` (7.56 on `--dark`, 6.49 on `--dark-2`), lines `rgba(255,255,255,0.14)`.

### 1.3 Accents

Receptor = the protein. Ligand = the compound. They never swap roles.

| token | hex | on white | on paper | white text on it | tint | text on tint | on-dark variant | on `--dark` |
|---|---|---|---|---|---|---|---|---|
| `--receptor` | `#1F5F8B` | 6.84 | 6.16 | 6.84 | `--receptor-tint #E4EEF6` | 5.82 | `--receptor-on-dark #7FB3D5` | 7.25 |
| `--ligand` | `#B5480C` | 5.39 | 4.85 | 5.39 | `--ligand-tint #FCEEE4` | 4.74 | `--ligand-on-dark #F0A060` | 7.71 |

The two accents also read against each other's tint (ligand on receptor tint 4.58) so a chip can mix them in a
pair label like `EGFR · quercetin`.

### 1.4 Status colours

Binding free energy is negative when binding is favourable, so "good" means "more negative". The success colour
is the colour of a good dG.

| token | hex | on white | on paper | tint | text on tint | on-dark | on `--dark` | meaning |
|---|---|---|---|---|---|---|---|---|
| `--good` | `#15794A` | 5.43 | 4.89 | `--good-tint #E6F5EC` | 4.82 | `--good-on-dark #5FD08F` | 8.49 | strong dG, geometry pass, recorded, connected |
| `--warn` | `#8A5A0B` | 5.92 | 5.33 | `--warn-tint #FBF1DC` | 5.28 | `--warn-on-dark #F2C14E` | 9.75 | weak dG, wrong network, pending, fee notices |
| `--bad` | `#B42318` | 6.57 | 5.92 | `--bad-tint #FBE9E7` | 5.61 | `--bad-on-dark #F28B82` | 6.85 | geometry fail, reverted tx, positive dG |

`--ink` on every tint is above 15:1, so a tinted card can carry normal body text.

### 1.5 Energy bands (colour of the dG number)

- dG at or below -9.000 kcal/mol: `--good`, label "strong".
- dG between -9.000 and -6.000: `--ink`, label "moderate".
- dG above -6.000: `--warn`, label "weak".
- dG at or above 0: `--bad`, label "no binding".
The bands are a display convention only and are stated as such in /docs. They never change what is recorded.

### 1.6 3D viewer colours (3Dmol.js)

- Receptor cartoon: `#9DB7CC` (a light receptor blue, non-text, 2.08 on white by design so the ligand pops).
- Pocket residues within 4.5 A of the ligand as thin sticks: carbon `#8A93A3`, hetero atoms CPK.
- Ligand (our pose): carbon `--ligand #B5480C`, N `#3050F8`, O `#E53935`, S `#C9A800`, halogens `#2E8B57` family,
  stick radius 0.22, plus a translucent surface off by default.
- Reference co-crystal ligand (the one in the PDB entry), when the visitor toggles it: carbon `--receptor
  #1F5F8B`, 55 percent opacity, thinner sticks. So "blue ghost = what the crystal had, orange = what you docked".
- Box: dashed wireframe `--ink-3` at 40 percent, hidden by default, toggle in the viewer toolbar.
- Background: `--white` in cards and the lab; transparent in the hero so the grid paper shows through.
- Never the rainbow chain colouring in product UI. The rainbow stays inside the RCSB entry image, which we show
  untouched as provenance.

### 1.7 Focus and selection

- Focus ring: `outline: 2px solid var(--receptor); outline-offset: 2px` on every interactive element (6.16 on paper).
  On dark surfaces `outline-color: var(--receptor-on-dark)`.
- Text selection: background `--receptor-tint`, colour `--ink`.

## 2. Type

Fonts are self-hosted in `/fonts` (SIL OFL 1.1, declared in `/fonts/fonts.css`, loaded from `partials/head.html`
before `css/site.css`). Checked this session: Albert Sans (variable 300 to 700), Anybody (variable 400 to 800,
width 100 percent only), Space Mono (static 400 and 700), each split latin / latin-ext. No Google Fonts at runtime.

| role | family | fallback stack |
|---|---|---|
| display (H1, H2, big stat numbers only when styled `.display`) | `Anybody` 700 | `'Albert Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif` |
| text and UI (body, H3, H4, buttons, nav, tables text) | `Albert Sans` 400 / 500 / 600 | `'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif` |
| data (numbers, PDB ids, component ids, hashes, eyebrows, code) | `Space Mono` 400 / 700 | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

Tokens: `--font-display`, `--font-text`, `--font-mono`. `font-display: swap` is already set in fonts.css; to stop
layout shift give `html` `font-synthesis: none` and size headings with `line-height` in unitless values.

### 2.1 Scale (desktop, phone at 390 in brackets)

| token | size | line-height | tracking | weight, family |
|---|---|---|---|---|
| `--t-hero` | `clamp(40px, 5.6vw, 72px)` (40) | 1.02 | -0.02em | 700 display |
| `--t-h1` | `clamp(32px, 4vw, 48px)` (32) | 1.08 | -0.015em | 700 display |
| `--t-h2` | `clamp(26px, 3vw, 36px)` (26) | 1.12 | -0.01em | 700 display |
| `--t-h3` | 20px (19) | 1.25 | 0 | 600 text |
| `--t-h4` | 17px | 1.3 | 0 | 600 text |
| `--t-lede` | `clamp(18px, 1.6vw, 21px)` (18) | 1.45 | 0 | 400 text, colour `--ink-2` |
| `--t-body` | 17px (16) | 1.55 | 0 | 400 text |
| `--t-small` | 14px | 1.45 | 0 | 400 text |
| `--t-caption` | 13px | 1.4 | 0 | 400 text, colour `--ink-3` |
| `--t-eyebrow` | 12px | 1.2 | 0.12em, uppercase | 400 mono |
| `--t-mono` | 14px | 1.5 | 0 | 400 mono (tables, ids, hashes) |
| `--t-mono-id` | 15px | 1.3 | 0.02em | 700 mono (PDB id, comp id in card headers) |
| `--t-stat` | `clamp(28px, 3.5vw, 44px)` (28) | 1.05 | -0.01em | 700 mono |
| `--t-dg` | `clamp(36px, 4vw, 48px)` (36) | 1.0 | -0.02em | 700 mono (the dG number in results) |

Measure: body text blocks max 68ch (`--measure: 68ch`); ledes 52ch; docs prose 66ch. Headings never exceed 24
words. Numbers with units: number in mono, a thin space, unit in text font 0.8em `--ink-3` (`-8.412 kcal/mol`).
Tabular numbers everywhere: `font-variant-numeric: tabular-nums` on `body`.

### 2.2 Text rules that the CSS enforces

- No em dash or en dash glyphs are used by any style (no `content: "\2014"`); separators are `·` (U+00B7) with a
  space each side.
- Links in prose: `--receptor`, underline 1px offset 3px, hover thicker. Outbound links append the north-east
  arrow icon (14px) after the text. Links inside dark surfaces use `--receptor-on-dark`.
- Long ids, hashes and addresses (the visitor's own only) wrap with `overflow-wrap: anywhere` in mono.

## 3. Spacing, radius, borders, elevation

Spacing scale (4 px base): `--s-1 4px`, `--s-2 8px`, `--s-3 12px`, `--s-4 16px`, `--s-5 20px`, `--s-6 24px`,
`--s-7 32px`, `--s-8 40px`, `--s-9 48px`, `--s-10 64px`, `--s-11 80px`, `--s-12 96px`, `--s-13 128px`.

- Gutter: `--gutter: 16px` under 768, `24px` from 768, `32px` from 1024, `40px` from 1280.
- Container: `--container: 1200px`, centered, `padding-inline: var(--gutter)`. Docs prose container 760px.
  Lab page uses the full width up to 1440px.
- Section padding: `--section-y: clamp(48px, 7vw, 96px)`. Section header to content gap: `--s-7`.
- Card padding: `--s-5` (20) on phone, `--s-6` (24) from 768. Table cell padding `12px 16px`, compact `8px 12px`.
- Stack rhythm inside cards: 8 / 12 / 16.

Radius: `--r-1 4px` (badges, checkboxes), `--r-2 8px` (buttons, inputs, chips), `--r-3 12px` (cards, table
frames), `--r-4 16px` (viewer, sheets, hero card), `--r-pill 999px` (wallet pill, filter pills).

Borders: `1px solid var(--line)` on cards and table frames; `1px solid var(--edge)` on inputs; `2px solid
var(--ink)` on outline buttons; hairline rows `1px solid var(--line)`; section rules `1px solid var(--line-strong)`.

Elevation (only three levels): `--shadow-1: 0 1px 2px rgba(20,24,31,0.06)` (cards on hover), `--shadow-2: 0 8px
24px rgba(20,24,31,0.10)` (menus, toasts, sheets, the viewer), `--shadow-3: 0 24px 64px rgba(20,24,31,0.18)`
(modals). Nothing else casts a shadow. Cards at rest have no shadow, only the border.

### 3.1 Grid-paper texture rule

The grid is the lab notebook page. It appears in exactly four places: the landing hero band, the 404 page, the
report cover block (screen only) and the OG card. Never behind running text elsewhere, never on the lab page (the
viewer needs a quiet surround), never in print.

```css
.grid-paper {
  background-color: var(--paper);
  background-image:
    linear-gradient(to right, rgba(20,24,31,0.10) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(20,24,31,0.10) 1px, transparent 1px),
    linear-gradient(to right, rgba(20,24,31,0.05) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(20,24,31,0.05) 1px, transparent 1px);
  background-size: 120px 120px, 120px 120px, 24px 24px, 24px 24px;
  background-position: -1px -1px;
  -webkit-mask-image: radial-gradient(ellipse 90% 80% at 50% 40%, #000 55%, transparent 100%);
          mask-image: radial-gradient(ellipse 90% 80% at 50% 40%, #000 55%, transparent 100%);
}
@media print { .grid-paper { background-image: none; mask-image: none; -webkit-mask-image: none; } }
```

Major lines every 120 px at 10 percent ink, minor lines every 24 px at 5 percent ink, faded at the edges so text
never sits on a hard grid edge. Text over the grid is `--ink` on `--paper`; the grid lines are below 1.2:1
against paper so they never compete with type.

## 4. Layout and breakpoints

Breakpoints: 360 (floor, everything must work), 480, 768, 1024, 1280, 1440 (max container width for the lab).
`tools/verify.mjs` sweeps 360/390/430/768/1024/1280/1440.

- Under 768: one column everywhere, 16 px gutters, sticky nav 56 px, no horizontal scroll (`overflow-x: clip` on
  `html`), tap targets 44 px minimum (buttons, list rows, pills, table row actions).
- 768 to 1023: two columns for card grids, lab in two columns, tables scroll inside their frame (`overflow-x: auto`
  on the frame, never on the page) with a right-edge fade hint.
- 1024 up: three to four column card grids, lab in three columns, nav links visible.
- Card grid: `grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--s-5)`.

## 5. Components

### 5.1 Nav with wallet button

- Sticky top, height 64 px (56 px under 768), background `rgba(245,243,236,0.86)` with `backdrop-filter: blur(12px)`,
  bottom hairline `--line`. Never hides on scroll (the wallet button must stay reachable).
- Left: the wordmark (inline SVG: mark 28 px + "Ponchem" in Anybody 700 22 px, `--ink`). The mark is inlined so
  the webfont applies; `img/brand/wordmark.svg` is the standalone fallback.
- Center (1024 up): links `Lab · Targets · Ligands · Leaderboard · Report · Docs`, Albert Sans 500 15 px,
  `--ink-2`, current page `--ink` with a 2 px `--ligand` underline 6 px below the baseline.
- Right: the token pill then the wallet control.
  - Token pill (blank state): pill, border `--line-strong`, mono 13 px `--ink-3`, text `Buy $PONCHEM · soon`,
    not a link, `aria-disabled="true"`, cursor default. Live state (after launch): border `--ligand`, text
    `Buy $PONCHEM` in `--ligand`, opens `TOKEN.buyUrl` in a new tab, plus a `Copy CA` icon button beside it.
  - Wallet control states:
    - disconnected: primary receptor button `Connect wallet` (44 px, `--receptor` fill, white text, wallet icon).
    - connecting: same button, spinner icon, text `Confirm in wallet`, disabled.
    - connected: pill `--white` bg, border `--line-strong`, 8 px dot `--good`, mono 14 px `0x12ab…9f3c` (the
      visitor's own address, shortened 4+4 with `…`), chevron. Opens the wallet menu.
    - wrong network: pill with `--warn-tint` bg, `--warn` border and text, alert icon, text `Wrong network`,
      opens the wallet menu whose first action is `Switch to Robinhood Chain`.
- Under 1024: center links move into a menu. Right side shows the wallet control (icon-only 44 px button with the
  wallet icon when disconnected; the dot-and-address pill collapses to dot + `0x12ab…`) and a 44 px menu button
  (two-line icon). The menu opens a full-height sheet from the right (phone: full width) listing the links at 20
  px with 56 px rows, then the token pill, then the X link, then the footer line. Body scroll locks while open.

### 5.2 Hero with a live 3D structure

- Section with `.grid-paper`, padding `--section-y` top, `--s-10` bottom.
- 1280: two columns `7fr 5fr`, gap `--s-9`, items centered vertically.
  - Left: eyebrow (mono) `PONS LAB CADD · ROBINHOOD CHAIN`; H1 `--t-hero`; lede `--t-lede` (max 52ch); CTA row
    (`Open the lab` primary ink 52 px, `How it works` outline 52 px), then a caption line in mono 13 px `--ink-3`
    with the structure currently shown: `In the viewer: 4HJO · EGFR kinase domain with erlotinib · 2.75 A · X-ray`
    plus an RCSB outbound link. The caption text is generated from the catalog entry, never typed.
  - Right: viewer card, `--white`, border `--line`, radius `--r-4`, aspect 1:1, 3Dmol.js canvas with the
    receptor cartoon and the reference ligand in orange, slow auto-rotation (one turn per 40 s), pauses on hover or
    touch, stops entirely under `prefers-reduced-motion`. Under the canvas a 44 px strip: mono id `4HJO` (700),
    the entry title in 14 px `--ink-2` ellipsised, a `Next structure` ghost button that swaps to another library
    entry, and an outbound arrow to rcsb.org.
  - Loading: the card shows the RCSB entry image (`cdn.rcsb.org/images/structures/<id>_assembly-1.jpeg`) at 60
    percent opacity with a mono `loading structure` caption until the mmCIF arrives; if the file fails, the image
    stays and the caption reads `3D view unavailable, showing the RCSB image`.
- 390: eyebrow, H1 (40 px, 4 lines max), lede, CTA row (two full-width buttons stacked, 48 px), viewer card at
  aspect 4:3, caption strip, RCSB link. The grid paper runs behind the whole block.
- The structure shown in the hero is picked from the catalog by the site script (deterministic per day so the OG
  and the page agree); it must have a reference co-crystal ligand so the orange molecule is visible.

### 5.3 Stat strip

- Directly under the hero, a `--white` band with top and bottom hairlines. Four cells: `Targets`, `Ligands`,
  `Runs recorded`, `In prize pools`. Number in `--t-stat` mono 700 `--ink`, unit in text font 0.5em `--ink-3`
  (`ETH`), label in eyebrow mono under it. Values come from the catalog (counts) and the chain (runs, pools).
- Skeleton: a 40 px wide `--paper-2` bar pulsing at 1.6 s while loading; if the RPC fails the number shows `·`
  and the label gains `(chain unreachable)` in `--warn`.
- 390: 2 x 2 grid, cells 96 px tall, number 28 px.

### 5.4 Cards for targets and ligands (with the RCSB entry image)

Target card (in `/targets` grid and in the lab picker):

- `--white`, border `--line`, radius `--r-3`, padding 0, hover: border `--line-strong` + `--shadow-1`, whole card
  is one link.
- Top: the RCSB entry image in a 4:3 tile, `object-fit: contain`, white background, no filter, no crop. Alt text:
  `RCSB entry image for 4HJO`. A small mono badge top-left on the image: `4HJO` (700, `--ink` on `--white` with
  a `--line` border). Top-right: a cancer-group chip (`--receptor-tint` bg, `--receptor` text, 12 px) showing the
  first group, `+2` if more.
- Body (padding `--s-5`): H3 target name (`EGFR kinase domain`, 2 lines max), caption line mono 13 px
  `2.75 A · X-ray · Homo sapiens`, then a row of two small stats: `Best dG` (mono, energy-banded colour) and
  `Pool` (mono, ETH). Empty values show `·`.
- Footer row: `Dock` ghost button (44 px) and a north-east `RCSB` link. On phone both remain, side by side.

Ligand card: same frame. Image tile shows the ligand's 2D depiction if the catalog provides one, else the RCSB
component image (`cdn.rcsb.org/images/ccd/labeled/<X>/<COMP>.svg` when the catalog author verified it) inside a
`--ligand-tint` tile; badge shows the component id (`AQ4`), chip shows the source plant (`Camellia sinensis`) in
`--ligand-tint`/`--ligand`. Body: H3 common name, caption mono `C22 H23 N3 O4 · 393.4 g/mol · 29 heavy atoms · 10
rotatable`, stats `Best dG` and `Best target`.

List row variant (lab pickers, phone): 64 px row, 48 px image thumb, name, caption, chevron. 44 px minimum touch
height is exceeded.

### 5.5 Tables for leaderboards

- Frame: `--white`, border `--line`, radius `--r-3`, `overflow-x: auto` inside the frame under 768 with a fade.
- Header row: `--paper-2`, eyebrow mono 12 px uppercase `--ink-3`, sortable columns show a sort icon; the active
  sort is `--ink` with a filled caret. Sticky header inside the frame.
- Body rows: 48 px, hairlines, hover `--paper`. Numbers right-aligned mono 14 px; ids mono 700; names text 15 px;
  wallets mono shortened (the visitor's own row highlighted with a `--receptor-tint` left bar 3 px and `you`
  chip).
- Rank column: 1 to 3 get a `--ligand` mono numeral, others `--ink-3`.
- dG cells carry the energy band colour and a 4 px band-coloured dot before the number.
- Row action: `View` ghost button 36 px, or the row itself is a link.
- Phone alternative for the top-level leaderboards: cards of rank + pair + dG stacked; the full table remains
  behind a `Show table` toggle for people who want to scroll.
- Pagination: `Load more` outline button under the table, never infinite scroll; page size 25.

### 5.6 Lab layout

Desktop 1280 (`grid-template-columns: 300px minmax(0, 1fr) 340px; gap: var(--s-6)`), page width up to 1440:

- Left rail (300 px, sticky under the nav, own scroll):
  - Target picker: eyebrow `TARGET`, search input (44 px, magnifier icon, placeholder `Search targets or PDB id`),
    filter pills by cancer group (horizontal scroll row), then list rows (5.4 list variant). Selected row has a
    `--receptor-tint` background and a 3 px `--receptor` left bar.
  - Ligand picker: same pattern with `LIGAND`, placeholder `Search compounds or plants`, filter pills by plant
    family or scaffold, selected row uses `--ligand-tint` and a `--ligand` bar.
  - Screen mode switch under the pickers: segmented control `Pair · Target vs many · Ligand vs many` (44 px).
    In a "many" mode the second picker becomes a multi-select with checkboxes and a `Select top 20` link.
- Center:
  - Viewer card (aspect 16:10, `--white`, radius `--r-4`, `--shadow-2`): 3Dmol.js canvas; toolbar on the top edge
    inside the card (44 px, icon buttons: `Reset view`, `Toggle reference ligand`, `Toggle box`, `Toggle pocket
    sticks`, `Toggle surface`, `Fullscreen`), all with tooltips; bottom-left legend: two 10 px squares, `receptor`
    and `ligand`; bottom-right the pair chips `4HJO · EGFR` (receptor tint) and `AQ4 · erlotinib` (ligand tint).
    Before a run the pose shown is the reference ligand (blue ghost). During a run the best-so-far pose updates
    every 500 ms. After a run the final pose is orange.
  - Run controls card (under the viewer): depth segmented control `Quick · Standard · Deep` with the time estimate
    under each (`about 10 s`, `about 30 s`, `about 90 s`; the numbers come from the engine spec constants),
    a seed field (mono, 44 px, `Seed` label, default random, `Randomise` icon button), then the primary button
    `Run docking` (52 px, full width of the card, ink fill). While running: the button becomes `Stop` (outline).
  - Progress (inside the run controls card while running): 6 px bar `--paper-2` track, `--ligand` fill, mono
    caption `Pose search · 42% · best so far -7.9 kcal/mol`, and a `Deterministic · seed 18422` mono note.
- Right rail (340 px, sticky): the results panel (5.7). Before any run it shows the empty state (5.9).

Tablet 768 to 1023: two columns `280px minmax(0,1fr)`; the results panel goes under the run controls in the
right column. Viewer aspect 4:3.

Phone (under 768): one column in this order:

1. Pair bar (sticky under the nav, 56 px, `--white`, hairline): two chips side by side, `Target: EGFR` (receptor
   tint) and `Ligand: quercetin` (ligand tint), each a 44 px button that opens a bottom sheet picker (search,
   filter pills, list rows, `Done`). Sheet height 85 vh, drag handle, `--shadow-2`. Empty chip reads `Choose
   target` / `Choose ligand` with a dashed `--edge` border.
2. Viewer card, aspect 1:1, toolbar reduced to `Reset`, `Reference`, `Fullscreen` (44 px each), legend kept.
3. Run controls: depth segmented (full width, 48 px), seed row, `Run docking` (52 px). Progress under it.
4. Results panel (5.7) as a card.
5. When results exist, a sticky bottom bar (64 px, `--white`, top hairline, `--shadow-2` upward) holds
   `Record on chain` (48 px, full width) and the fee line; it hides while the sheet is open.

### 5.7 Results panel

Card `--white`, border `--line`, radius `--r-3`, padding `--s-6`.

- Header: eyebrow `RESULT`, then the source tag: `browser estimate` (mono chip `--paper-2`) before recording,
  `chain score` (mono chip `--good-tint`/`--good`, check icon) after. The rule: once recorded, the number shown is
  the chain's number; the browser number is shown below it in `--ink-3` only if it differed (`browser said
  -8.410`).
- The number: `-8.412` in `--t-dg` mono 700 with the energy band colour, unit `kcal/mol` in text font 16 px
  `--ink-3` on the same baseline, band label under it in 13 px (`strong binder`, `moderate`, `weak`, `no binding`).
- Rows (label left 14 px `--ink-3`, value right mono 15 px `--ink`, hairlines, 40 px each):
  `Estimated pKd · 6.17`, `Estimated Kd · 0.68 uM` (auto unit: pM, nM, uM, mM, M; always one of these, never
  scientific notation in UI), `Ligand efficiency · 0.29 kcal/mol per heavy atom`, `Heavy atoms · 29`, `Rotatable
  bonds · 10`, `Depth · Standard`, `Seed · 18422`. A small info icon on pKd, Kd and ligand efficiency opens a
  tooltip with the one-line glossary definition from docs/copy.md.
- Geometry checks: eyebrow `GEOMETRY`, then four rows with a 20 px check (`--good`) or cross (`--bad`) icon:
  `Bond lengths within tolerance`, `1-3 distances within tolerance`, `No internal clashes`, `All atoms inside the
  box`. These are computed with the same integer rules the chain uses; a failing pose cannot be recorded, the
  button explains why.
- Action: `Record on chain` primary ink 48 px full width; under it the fee line mono 13 px `--ink-3`: `Run fee
  0.00002 ETH + gas · joins the EGFR pool` (the fee is read from the contract, never typed). States: disconnected
  wallet → button reads `Connect wallet to record` (receptor style); wrong network → `Switch to Robinhood Chain`
  (warn style); geometry fail → disabled with the reason above it; pending → spinner `Waiting for the chain`;
  done → `Recorded` (good tint, check) plus `View transaction` outbound link to the explorer.
- Screening mode: the panel becomes a ranked list (rows: rank, ligand or target, dG banded, `Record` 36 px ghost)
  with `Record best` at the top; each recorded row gets the chain chip.

### 5.8 Report page and print styles

Screen: report cover block (`.grid-paper`, screen only) with eyebrow `CANCER RESEARCH REPORT`, H1, mono line
`Compiled from Robinhood Chain · block 1,234,567 · 2026-09-22 14:02 UTC`, actions `Download Markdown`, `Print`.
Then one section per cancer group (`lung`, `colorectal`, ...) in SPEC.md order, each a card with: H2 group, a
2-up of the best pair (target card compact + ligand card compact), a table of the top ten pairs (target, ligand,
dG, pKd, LE, runs, wallets), then a mono footnote with the counts. A sticky right-side contents list at 1280
(hidden under 1024, replaced by a `Jump to` select at the top on phone).

Print (`@media print`):

- `@page { size: A4; margin: 18mm 16mm }`. Body 11 pt Albert Sans, headings Anybody, data Space Mono 9.5 pt.
- Hide nav, footer, buttons, the contents list, toasts, the token pill, the 3D canvases (print the RCSB entry
  image in their place at 60 mm wide). No grid paper, white background, black text (`--ink` prints as near black).
- Every card `break-inside: avoid`; each cancer group starts on a new page (`break-before: page`) except the first.
- Tables: full borders 0.5 pt, header repeated (`thead { display: table-header-group }`), zebra off.
- Links: colour black, underline; outbound links print their URL after the text (`a[href^="http"]::after { content:
  " (" attr(href) ")" }`) at 8.5 pt. Transaction links print the full hash.
- Running header via a fixed element at top: `Ponchem · Cancer research report · <date>`; footer `2026 Pons Lab
  CADD (Computer-aided Drug Design) · compiled from Robinhood Chain`.

### 5.9 Empty states

One pattern: the mono mark (`img/brand/mark-mono.svg`) at 48 px in `--ink-3` at 60 percent, an H4, one sentence
in `--ink-2`, one action. Centered in the panel, max 36ch. Strings live in docs/copy.md ("Empty states").
Used in: results panel before a run, leaderboard with no runs, wallet page with no runs / no prizes / no
sponsorships, report group with no runs, search with no matches, pickers filtered to nothing.

### 5.10 Toasts

- Position: bottom-center on phone (16 px from the bottom, full width minus gutters), bottom-right on desktop (24
  px from edges, 360 px wide). Stack up to 3, newest at the bottom.
- Surface `--dark`, text `--paper`, radius `--r-3`, `--shadow-2`, padding 12 px 16 px, 20 px status icon left
  (`--good-on-dark` check, `--warn-on-dark` alert, `--bad-on-dark` cross, `--receptor-on-dark` info), message 14
  px, optional action link right (`View tx` with the north-east arrow, `--receptor-on-dark`), 44 px close
  button.
- Timing: success and info 4 s, warnings 6 s, errors stay until closed. Hover or focus pauses the timer. Enter
  from 8 px below with opacity, 160 ms; no motion under reduced-motion.
- `role="status"` for success and info, `role="alert"` for errors. Only one toast per event (no duplicate for the
  same tx hash).

### 5.11 Wallet menu

Opens from the connected pill; anchored popover on desktop (280 px, `--white`, border `--line`, radius `--r-3`,
`--shadow-2`), bottom sheet on phone. Contents: the full address in mono 13 px with a `Copy address` icon button
(this is the visitor's own address, allowed), the network row with a `--good` dot `Robinhood Chain` (or the wrong
network state), the balance row `0.0412 ETH`, a hairline, links `My runs`, `My prizes`, `My sponsorships` (all
to /wallet with a hash), a hairline, `Disconnect` in `--bad`. Rows 44 px. Escape and outside click close it.

### 5.12 Wrong network state

- Global: a band under the nav, `--warn-tint` bg, `--warn` text 14 px, alert icon, text `Your wallet is on another
  network. Ponchem records runs on Robinhood Chain.` and a 36 px button `Switch network` (warn outline). The band
  stays until the network is right; no close button.
- Local: the wallet pill in its wrong-network state (5.1), the Record button in its switch state (5.7), and the
  sponsor and settle buttons on the target page read `Switch to Robinhood Chain`.
- If the wallet rejects the switch or does not know the chain, a toast explains and the /docs wallet section gives
  the manual parameters (chain id 4663, currency ETH, the RPC URL, the explorer URL; these are not contract
  addresses and are fine to show).

### 5.13 Buttons, inputs and small parts

- Buttons: 44 px default, 36 px compact (tables), 52 px hero and Run. Radius `--r-2`. Text 15 px Albert Sans 600,
  icons 20 px. Variants: `primary` (ink fill, paper text), `receptor` (receptor fill, white text), `outline` (2 px
  ink border, ink text), `ghost` (no border, ink-2 text, hover `--paper-2`), `warn-outline`, `danger` (bad fill,
  white text, only Disconnect and destructive confirmations). Disabled: 45 percent opacity plus `cursor:
  not-allowed`, still readable, never removed from the tab order without a reason shown nearby. Loading: leading
  16 px arc spinner, label swapped for the pending string.
- Inputs: 44 px, `--white`, border `--edge`, radius `--r-2`, padding 0 12 px, text 16 px (prevents iOS zoom),
  focus ring per 1.7. Label above in 14 px 500. Help text 13 px `--ink-3`. Error: border `--bad`, message in `--bad`
  with the alert icon.
- Segmented control: 44 px, `--paper-2` track, selected segment `--white` with a `--line-strong` border and
  `--shadow-1`, text 14 px 600.
- Chips: 28 px, radius pill, 12 px mono or 13 px text, tint background with accent text; removable chips get a
  20 px cross on the right (whole chip 44 px tall in touch contexts via padding).
- Badges: energy band badges (`strong`, `moderate`, `weak`), status badges (`recorded`, `pending`, `settled`),
  4 px radius, 11 px mono uppercase.
- Tooltips: `--dark` surface, `--paper` text 13 px, max 32ch, 4 px radius, arrow, appear on hover 200 ms and on
  focus immediately, dismiss on Escape. On touch the info icon toggles it.
- Tabs (target and ligand pages, docs): text 15 px 500, 44 px, active `--ink` with a 2 px `--ligand` underline,
  inactive `--ink-2`; scrollable row on phone.
- Skeletons: `--paper-2` blocks with a 1.6 s pulse; never spinners for page content, spinners only inside buttons.
- Progress bar: 6 px, track `--paper-2`, fill `--ligand`; `role="progressbar"` with `aria-valuenow`.
- Code blocks (docs, API): `--paper-2`, mono 13 px, radius `--r-2`, copy button top right.

### 5.14 Footer

`--dark` surface, `--paper` text, padding `--section-y`. 1280: four columns: brand (mono mark in `--paper`, one
sentence), `Lab` links, `Data` links (RCSB Protein Data Bank outbound, Robinhood Chain explorer outbound, `/docs`
API), `Community` (X `@PonchemAI` outbound, `ponsfamily.com` outbound). Bottom row after a `rgba(255,255,255,0.14)`
rule: left `2026 Pons Lab CADD (Computer-aided Drug Design)` 14 px, right `Structures from the RCSB Protein Data
Bank` 13 px `--muted-on-dark`. 390: columns stack, bottom row stacks left-aligned. The footer line is exact and
appears on every page including 404.

### 5.15 Icons

Inline SVG only, 24 px grid, `stroke="currentColor"`, `stroke-width="1.75"`, round caps and joins, no fills except
the status dots. One set, named: `wallet`, `flask`, `ligand` (hexagon with a bond, the mark's ring), `receptor`
(the mark's pocket arc), `chain` (two links), `arrow-ne`, `arrow-right`, `chevron-down`, `chevron-right`,
`check`, `cross`, `alert`, `info`, `copy`, `external` (same as arrow-ne, kept for clarity), `play`, `stop`,
`spinner` (270 degree arc, rotates), `download`, `print`, `search`, `filter`, `sort`, `menu`, `close`, `reset`,
`box` (dashed cube), `surface`, `fullscreen`, `x-logo` (two crossing strokes in a 24 px square, not the emoji, not
the raster). Icons never appear alone without an accessible name (`aria-label` on icon-only buttons).

## 6. Motion

- Easing `--ease: cubic-bezier(0.2, 0.8, 0.2, 1)`; durations 120 ms (hover, focus), 160 ms (toasts, menus), 240
  ms (sheets), 320 ms (page section reveal). Nothing longer except the hero rotation.
- Hero and lab auto-rotation: one turn per 40 s, pauses on hover, touch and when the tab is hidden (the render
  loop stops on `visibilitychange`).
- Section reveal: opacity 0 to 1 and 8 px rise on first intersection, once, only on the landing page.
- No scroll-jacking, no parallax, no smooth-scroll hijack, no headline scramble, no marquee, no auto-playing video.
- `prefers-reduced-motion: reduce`: all transitions 0 ms, hero rotation off, skeleton pulse off, toasts appear
  without motion. Progress bar still animates its width (it conveys state).
- Loading a structure: the viewer fades in the model over 240 ms once the file is parsed.

## 7. Dark mode

Decision: one light theme, done well. Rationale: the 3D views, the RCSB entry images (white background by
convention) and the print report all live on white; a full dark theme would need a second viewer palette and
re-tinted images for little gain. The dark surface tokens (`--dark`, `--dark-2`, the `-on-dark` accents) exist
for the footer, toasts, tooltips and the wallet sheet so those components are already correct on dark. If a dark
theme is added later, it is the same token names redefined under `:root[data-theme="dark"]`, and the viewer keeps
a white canvas inside a dark page. `color-scheme: light` is declared on `:root` so form controls match.

## 8. Page wireframes (1280 and 390)

Every page: nav (5.1), the wrong-network band when needed, `<main>` with `id="main"` and a skip link, footer
(5.14). Titles per docs/copy.md ("Meta"), format `Ponchem · Page`.

### `/` landing

1280: hero (5.2) → stat strip (5.3) → "Three things" value props: three `--white` cards in a row with a 32 px
icon in a tint circle (receptor, ligand, chain), H3, two lines → "How it works": eyebrow, H2, four numbered steps
in a row (mono `01` in `--ligand`, H4, two lines), a hairline connector behind them → "The science": two columns,
left H2 + prose (max 60ch), right a `--paper-2` card with a small dG legend (the energy bands with their colours)
and a mono table of the five scoring terms → "On chain": dark band (`--dark`), H2 in `--paper`, four check rows
with what the chain checks, a `View the contract source` link (a link to the repo path, no address) → "Featured
targets": H2 + a 4-up of target cards + `All targets` link → "$PONCHEM": `--white` card with the blank-state
copy, the inert pill and the disabled `Copy CA` button → CTA band on `.grid-paper`: H2, `Open the lab` primary,
`Sponsor a target` outline → footer.

390: same order, everything single column; value props stacked; the four steps stacked with a left vertical
connector; the science card under the prose; featured targets as a horizontal scroll row of 260 px cards with
`scroll-snap`; the token card full width; CTA buttons stacked.

### `/lab`

See 5.6. Page H1 is visually hidden (the pair chips are the title). At 1280 the three columns start directly
under the nav with a 24 px top gap. The URL carries `?target=<id>&ligand=<id>&depth=&seed=` so a run can be
shared; the results panel gets a `Share this run` ghost button (copies the URL, toast `Link copied`).

### `/targets`

1280: H1 `Targets`, lede, toolbar row (search input 320 px, cancer-group filter pills scrolling, sort select
`Best dG · Pool · Runs · Name`), count line mono `98 targets`, card grid 4 columns, `Load more`. 390: H1, lede,
search full width, pills row, sort select full width, 1 column cards.

### `/target` (?id=)

1280: header block in two columns: left the RCSB entry image tile (5.4) 360 px wide with the `RCSB` outbound
link and `Open in Mol* on rcsb.org` link; right the id ladder in the RCSB grammar with air: mono id 700 `4HJO`,
H1 title from the entry, then label:value rows `Target · EGFR kinase domain`, `Cancer groups · lung, colorectal`,
`Organism · Homo sapiens`, `Method · X-ray diffraction`, `Resolution · 2.75 A`, `Reference ligand · AQ4
(erlotinib)`, `Released · 2012-11-14`, `DOI · ...` (outbound), `Pocket · box center and size in A, pocket atom
count, pocket hash short form`. Then the actions row: `Dock this target` primary, `Sponsor pool` receptor,
`Settle epoch` outline (enabled only when the epoch has ended and there is a run). Then a prize pool card: pool
size mono 700, epoch countdown mono (`ends in 3d 04h`), best score this epoch with the wallet (shortened) and
`you` if it is the visitor, `Sponsor` amount field (ETH, 44 px) + button. Then tabs: `Leaderboard` (table of
best runs on this target), `3D` (viewer with the reference ligand), `Runs` (all runs, paged), `About` (the
pocket definition text from docs). 390: image tile full width 4:3, ladder, actions stacked, pool card, tabs
scrollable.

### `/ligands`

Same as `/targets` with ligand cards, filters by plant and scaffold, sort `Best dG · Runs · Name · Heavy atoms`.

### `/ligand` (?id=)

1280: header two columns: left the 2D depiction tile on `--ligand-tint` and, when the catalog has it, the RCSB
component page outbound link; right: mono id `AQ4`, H1 common name, ladder `Source · Camellia sinensis (tea
leaf)`, `Formula · C22 H23 N3 O4`, `Weight · 393.4 g/mol`, `Heavy atoms · 29`, `Rotatable bonds · 10`, `Donors /
acceptors · 1 / 5`, `PubChem CID · ...` (outbound), `Topology hash · short form`. Actions: `Dock this ligand`
primary, `Screen against all targets` outline. Tabs: `Best targets` (table), `Runs`, `About` (how the topology
was derived, from docs). 390: stacked.

### `/leaderboard`

1280: H1, lede, a segmented control `By target · By cancer group · By ligand · Wallets · Pools`, then the table
(5.5) for the chosen view with the top three rows carrying a small energy-band bar chart cell (a 60 px inline
bar whose length is proportional to |dG| within the table, `--good`), a `Download CSV` ghost button. 390: the
segmented control becomes a select; the cards variant with `Show table`.

### `/report`

See 5.8.

### `/wallet`

1280: if disconnected: a centered card with the mark, H2 `Connect a wallet to see your lab record`, `Connect
wallet` receptor button, and a line saying nothing is stored off chain. If connected: H1 `My lab`, the address in
mono with copy, three stat cells (`Runs`, `Best dG`, `Prizes to claim`), then tabs `Runs` (table: date, target,
ligand, dG, tx link), `Prizes` (rows with `Claim` primary 36 px per settled epoch won, or the empty state),
`Sponsorships` (rows: target, amount, epoch). 390: stacked, tabs scrollable, table as cards.

### `/docs`

1280: two columns `240px 1fr`: sticky left contents (`How it works`, `Scoring explained`, `What the chain checks`,
`What is and is not claimed`, `Wallet and network`, `API`, `Glossary`), right prose at 66ch with H2 anchors,
code blocks for the API, definition list for the glossary (term in 600, definition 17 px). 390: contents becomes a
`Jump to` select at the top; prose full width.

### `/404`

`.grid-paper` full height minus nav and footer; centered: mono `404`, H1 from copy, one line, `Back to the lab`
primary and `Home` outline. Footer present.

## 9. Brand assets (`img/brand/`)

- `mark.svg`: 64 px grid, the pocket (a 300 degree arc, receptor blue, 5 px stroke) holding a hexagonal ring with
  one bond leaving through the pocket mouth (ligand orange, 4.5 px stroke). The arc reads as a "P" counterform
  turned into a binding site; the ring is the aromatic core of most plant polyphenols. Works at 16 px (two shapes,
  no fills) and at 256 px.
- `mark-mono.svg`: same geometry in `currentColor` for the footer, empty states, favicons on dark, print.
- `favicon.svg`: ink rounded square 14 px radius, the mark in the on-dark accents (`#7FB3D5`, `#F0A060`), strokes
  thickened to 6 / 5.5 for 16 px legibility. Use as `<link rel="icon" type="image/svg+xml">`; the site manifest
  may point to PNG renders of it at 192 and 512 (rendered by the plumbing author from this file).
- `wordmark.svg`: mark + `Ponchem` in Anybody 700 34 px with a text fallback stack. Inline it in the nav so the
  webfont applies; when used as an `<img>` the fallback renders in Helvetica or Arial, which is acceptable.
- `og-card.svg`: 1200 x 630, paper, grid, eyebrow `PONS LAB CADD`, `Ponchem` at 140 px, three lines of lede, mark
  at 333 px on the right, footer row `ponchem.ai` and `structures from the RCSB Protein Data Bank`. Social
  crawlers do not accept SVG for `og:image`, so `img/brand/og-card.png` (1200 x 630, rendered from the SVG with
  the self-hosted fonts by headless Chrome this session) is the file `og:image` points at. The SVG is the source
  of truth; re-render the PNG whenever the SVG changes.
- Clear space around the mark: half its height. Minimum size 16 px (favicon variant) or 20 px (mark). Never
  recolour the accents outside the two accent tokens and their on-dark variants; mono is the only other form.
- No emoji anywhere, no dashes in any brand text.

## 10. Token block (paste into `css/site.css`)

```css
:root {
  color-scheme: light;
  --paper: #F5F3EC; --paper-2: #EDEAE1; --white: #FFFFFF; --dark: #1B2028; --dark-2: #262C36;
  --ink: #14181F; --ink-2: #3B4250; --ink-3: #5F6673; --line: #D9D5CB; --line-strong: #B8B3A6; --edge: #7C776B;
  --muted-on-dark: #A9B1BD; --line-on-dark: rgba(255,255,255,0.14);
  --receptor: #1F5F8B; --receptor-tint: #E4EEF6; --receptor-on-dark: #7FB3D5;
  --ligand: #B5480C; --ligand-tint: #FCEEE4; --ligand-on-dark: #F0A060;
  --good: #15794A; --good-tint: #E6F5EC; --good-on-dark: #5FD08F;
  --warn: #8A5A0B; --warn-tint: #FBF1DC; --warn-on-dark: #F2C14E;
  --bad: #B42318; --bad-tint: #FBE9E7; --bad-on-dark: #F28B82;
  --font-display: 'Anybody', 'Albert Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-text: 'Albert Sans', 'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif;
  --font-mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --t-hero: clamp(40px, 5.6vw, 72px); --t-h1: clamp(32px, 4vw, 48px); --t-h2: clamp(26px, 3vw, 36px);
  --t-h3: 20px; --t-h4: 17px; --t-lede: clamp(18px, 1.6vw, 21px); --t-body: 17px; --t-small: 14px;
  --t-caption: 13px; --t-eyebrow: 12px; --t-mono: 14px; --t-mono-id: 15px;
  --t-stat: clamp(28px, 3.5vw, 44px); --t-dg: clamp(36px, 4vw, 48px);
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-7: 32px; --s-8: 40px;
  --s-9: 48px; --s-10: 64px; --s-11: 80px; --s-12: 96px; --s-13: 128px;
  --gutter: 16px; --container: 1200px; --measure: 68ch; --section-y: clamp(48px, 7vw, 96px);
  --r-1: 4px; --r-2: 8px; --r-3: 12px; --r-4: 16px; --r-pill: 999px;
  --shadow-1: 0 1px 2px rgba(20,24,31,0.06); --shadow-2: 0 8px 24px rgba(20,24,31,0.10);
  --shadow-3: 0 24px 64px rgba(20,24,31,0.18);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1); --nav-h: 56px;
}
@media (min-width: 768px) { :root { --gutter: 24px; --nav-h: 64px; --t-body: 17px; --t-h3: 20px; } }
@media (min-width: 1024px) { :root { --gutter: 32px; } }
@media (min-width: 1280px) { :root { --gutter: 40px; } }
@media (max-width: 767px) { :root { --t-body: 16px; --t-h3: 19px; } }
html { overflow-x: clip; font-synthesis: none; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 var(--t-body)/1.55 var(--font-text);
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
```

## 11. Accessibility and verification checklist (for `tools/verify.mjs` and reviewers)

- Text contrast at or above 4.5:1 on its surface (all pairs in section 1 pass); large display text also passes.
- Every icon-only control has `aria-label`; every image has alt text naming the PDB id or compound.
- Skip link, one `h1` per page, landmarks (`header`, `nav`, `main`, `footer`), tab order follows reading order.
- 44 px tap targets on every interactive element under 768; table row actions included.
- No horizontal overflow at 360, 390, 430, 768, 1024, 1280, 1440.
- No dash glyphs (U+2013, U+2014), no emoji code points, no `0x` in visible text unless it is a transaction hash
  or the visitor's own address, on every page including toasts and 404.
- Reduced motion honoured; the 3D loop stops when the tab is hidden.
- Print: the report page prints to A4 with no clipped tables.
