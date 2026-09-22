# Ponchem copy deck (v1, 2026-09-22)

status: final

Every string below is final site copy and obeys SPEC.md section 2: no em or en dashes (the title separator is
`·`), no emoji, English only, nothing described as less than live, no wet-lab or clinical claims, no app contract
address in visible text. Values in curly braces are filled by the page script from the catalog, the chain or the config
(`{target}`, `{ligand}`, `{dG}`, `{fee}`, `{pool}`, `{id}`); the script never types them by hand. The blank token
strings are exact per SPEC.md section 1 and must not be reworded.

Voice: a careful scientist who is glad you came. Short sentences. Plain words in the UI, defined words in /docs.
We say "estimated", "computational", "a lead for further study". We never say "AI found a drug".

---

## 1. Landing (`/`)

### Hero

- Eyebrow: `Pons Lab CADD · Robinhood Chain`
- H1: `Computer-aided drug design, scored on chain.`
- H2 (lede): `Pick a cancer target from the Protein Data Bank. Pick a bioactive plant compound. Dock it in your browser. Robinhood Chain re-checks the pose, re-scores it and keeps the record. The best binders feed a live cancer research report.`
- Primary CTA: `Open the lab`
- Secondary CTA: `How it works`
- Viewer caption template (mono): `In the viewer: {id} · {title} · {resolution} A · {method}`
- Viewer strip: `{id}` · `{title}` · button `Next structure` · link `View on RCSB`
- Viewer loading caption: `Loading structure from the Protein Data Bank`
- Viewer fallback caption: `3D view unavailable. Showing the RCSB entry image.`

### Stat strip

- `Targets` · `Ligands` · `Runs recorded` · `In prize pools` (unit `ETH`)
- Unreachable suffix: `(chain unreachable)`

### Three value props (section eyebrow `WHY PONCHEM`, H2 `Three things you can trust`)

1. H3 `Real structures` · `Every target is an experimental structure from the RCSB Protein Data Bank, with its PDB id, method, resolution and reference ligand shown on the card. Nothing is drawn by hand.`
2. H3 `A scorer you can audit` · `The score is an integer implementation of a Vina-style empirical function. It runs inside the contract. After you record a run, the number on the site is the chain's number.`
3. H3 `A record that pays` · `Each run fee joins the target's prize pool. When the seven day epoch ends, the wallet with the lowest binding free energy on that target takes the pool.`

### How it works (eyebrow `HOW IT WORKS`, H2 `Four steps, one record`)

- `01` H4 `Choose` · `Pick a target and a plant compound, or screen one against many.`
- `02` H4 `Dock` · `A seeded pose search runs in your browser. Ten seconds to ninety, your choice.`
- `03` H4 `Record` · `Connect a wallet. The contract checks the geometry, re-scores the pose and stores it.`
- `04` H4 `Settle` · `When the epoch ends, anyone can settle. The best score takes the pool. The report updates.`

### The science (eyebrow `THE SCIENCE`, H2 `What the number means`)

Prose:

`Binding free energy, written dG, is the energy released when a compound settles into a pocket. More negative is better. Ponchem estimates it with an empirical scoring function of the AutoDock Vina family: five terms over heavy atom pairs, weighted with the values Trott and Olson fitted on about 1,300 PDBbind complexes in 2010. Our engine is an independent implementation of that function, written in integers so a contract can run it. It is not AutoDock Vina.`

`From dG we estimate potency: pKd, and Kd from dG = RT ln Kd at 298.15 K. We also show ligand efficiency, the energy per heavy atom, because a small molecule with a fair score is often a better lead than a large one with a great score.`

`These are computational estimates. They rank candidates for further study. They do not say a compound works in a cell, an animal or a person.`

Side card (eyebrow `SCORE BANDS`):

- `strong` · `dG at or below -9 kcal/mol`
- `moderate` · `between -9 and -6`
- `weak` · `above -6`
- `no binding` · `zero or positive`
- Footnote: `Display bands only. The chain records the exact value in milli kcal/mol.`

Terms table (eyebrow `FIVE TERMS`): `gauss 1` · `gauss 2` · `repulsion` · `hydrophobic` · `hydrogen bond`, with the
weights from SPEC-ENGINE.md printed by the script, and a footnote `Divided by 1 + 0.0585 x rotatable bonds.`

### On chain (eyebrow `ON CHAIN`, H2 `What the contract checks before it believes a pose`)

- `The pose contains exactly the ligand's heavy atoms, in topology order.`
- `Every bonded pair sits at its ideal distance, within tolerance. Every 1-3 pair too.`
- `Atoms three or more bonds apart stay above the clash floor.`
- `Every atom lies inside the target's box, whose pocket bytes are hashed and registered.`
- Closing line: `Then it recomputes the score with the same integer function and stores the run. Events carry the whole pose, so this site rebuilds everything from logs. No database of ours sits between you and the record.`
- Link: `Read the contract source` (repo path, not an address)

### Featured targets (H2 `Targets people are docking this week`, link `All targets`)

### Token (eyebrow `$PONCHEM`, H2 `The lab token launches on ponsfamily.com`)

- Body: `Ponchem is an honorable project of ponsfamily.com, and $PONCHEM launches there. Until then the buy link is inert and no contract address is published here. When the token is live this card shows the buy link and Copy CA. The lab can later ask for a minimum $PONCHEM balance to record a run; if that is switched on, the lab page says so.`
- Inert buy pill (exact): `Buy $PONCHEM · soon`
- Disabled Copy CA (exact): `CA posts here at launch`
- Live buy pill (exact, after launch): `Buy $PONCHEM`
- Live copy button: `Copy CA` · toast (exact): `$PONCHEM CA copied`
- Requirement line (only when set): `Recording a run needs at least {minHold} $PONCHEM in the connected wallet.`

### CTA band

- H2: `Dock something today.`
- Line: `Every recorded run adds to a cancer research report anyone can read and check.`
- Buttons: `Open the lab` · `Sponsor a target`

---

## 2. Lab (`/lab`)

- Visually hidden H1: `Lab`
- Picker eyebrows: `TARGET` · `LIGAND`
- Search placeholders: `Search targets or PDB id` · `Search compounds or plants`
- Filter pill rows: cancer groups; plant families
- Screen modes: `Pair` · `Target vs many` · `Ligand vs many` · link `Select top 20`
- Pair bar chips (phone): `Target: {target}` · `Ligand: {ligand}` · empty `Choose target` · `Choose ligand`
- Sheet: title `Choose a target` / `Choose a ligand` · button `Done`
- Viewer toolbar labels: `Reset view` · `Reference ligand` · `Box` · `Pocket` · `Surface` · `Fullscreen`
- Viewer legend: `receptor` · `ligand` · `reference`
- Depth: `Quick` (`about 10 s`) · `Standard` (`about 30 s`) · `Deep` (`about 90 s`)
- Seed: label `Seed` · button `Randomise` · note `Same seed, same pose, on any machine.`
- Run button: `Run docking` · running: `Stop` · after: `Run again`
- Progress caption: `Pose search · {percent}% · best so far {dG} kcal/mol`
- Progress stages: `Preparing pocket` · `Pose search` · `Refining` · `Final integer score`
- Results eyebrow: `RESULT` · chips `browser estimate` · `chain score`
- Browser vs chain note: `Browser said {dG}.`
- Band labels: `strong binder` · `moderate binder` · `weak binder` · `no binding`
- Rows: `Estimated pKd` · `Estimated Kd` · `Ligand efficiency` · `Heavy atoms` · `Rotatable bonds` · `Depth` · `Seed`
- Kd units: `pM` · `nM` · `uM` · `mM` · `M`
- Ligand efficiency unit: `kcal/mol per heavy atom`
- Geometry eyebrow: `GEOMETRY` · rows `Bond lengths within tolerance` · `1-3 distances within tolerance` · `No internal clashes` · `All atoms inside the box`
- Geometry fail note: `This pose fails a geometry check, so the chain would reject it. Run again.`
- Record button: `Record on chain` · disconnected `Connect wallet to record` · wrong network `Switch to Robinhood Chain` · pending `Waiting for the chain` · done `Recorded`
- Fee line: `Run fee {fee} ETH + gas · joins the {target} pool`
- Min hold block: `You need at least {minHold} $PONCHEM to record. Your wallet holds {balance}.`
- After record: `Chain score {dG} kcal/mol` · link `View transaction`
- Share: `Share this run` · toast `Link copied`
- Screening panel: `Record best` · row button `Record` · header `Ranked by binding free energy`

---

## 3. Targets and target pages

- `/targets` H1: `Targets` · lede: `Cancer targets from the RCSB Protein Data Bank. Each entry keeps its PDB id, method, resolution and reference ligand. Pick one to see its pocket, its pool and its best binders.`
- Count: `{n} targets` · sort: `Best dG` · `Pool` · `Runs` · `Name` · button `Load more`
- Card stats: `Best dG` · `Pool` · buttons `Dock` · `RCSB`
- `/target` ladder labels: `Target` · `Cancer groups` · `Organism` · `Method` · `Resolution` · `Reference ligand` · `Released` · `DOI` · `Pocket`
- Pocket value template: `box {sx} x {sy} x {sz} A · {n} pocket atoms · hash {short}`
- Actions: `Dock this target` · `Sponsor pool` · `Settle epoch`
- Pool card: eyebrow `PRIZE POOL` · `Epoch ends in {time}` · `Epoch ended, ready to settle` · `Best this epoch` · `No runs this epoch yet. The pool rolls over.` · field label `Amount (ETH)` · button `Sponsor` · note `Sponsorships join the pool. The lab fee is {feeBps} percent of a settled prize.`
- Tabs: `Leaderboard` · `3D` · `Runs` · `About`
- Links: `View on RCSB` · `Open in Mol* on rcsb.org`

## 4. Ligands and ligand pages

- `/ligands` H1: `Ligands` · lede: `Bioactive plant compounds with their 3D topology on chain. Each one lists its source plant, formula, heavy atoms and rotatable bonds. Pick one to see where it binds best.`
- Sort: `Best dG` · `Runs` · `Name` · `Heavy atoms`
- Card stats: `Best dG` · `Best target`
- `/ligand` ladder labels: `Source` · `Formula` · `Weight` · `Heavy atoms` · `Rotatable bonds` · `Donors / acceptors` · `PubChem CID` · `Topology hash`
- Actions: `Dock this ligand` · `Screen against all targets`
- Tabs: `Best targets` · `Runs` · `About`

## 5. Leaderboard (`/leaderboard`)

- H1: `Leaderboard` · lede: `Best binders by target, by cancer group and by ligand. Every row is a run the chain scored.`
- Views: `By target` · `By cancer group` · `By ligand` · `Wallets` · `Pools`
- Columns: `Rank` · `Target` · `Ligand` · `dG (kcal/mol)` · `pKd` · `LE` · `Wallet` · `Recorded` · `Runs` · `Pool (ETH)` · `Distinct wallets`
- Own row chip: `you` · button `Download CSV` · `Show table` · `Show cards`

## 6. Report (`/report`)

- Eyebrow: `CANCER RESEARCH REPORT`
- H1: `Best computational binders by cancer group`
- Compiled line: `Compiled from Robinhood Chain · block {block} · {date} UTC`
- Lede: `This report is built from every run recorded on chain. For each of the top-threat cancer groups it lists the best target and ligand pairs by binding free energy, with potency estimates, run counts and the number of distinct wallets behind them. It is a screening summary, a place to start reading, not a clinical finding.`
- Actions: `Download Markdown` · `Print`
- Group section: H2 `{group}` · eyebrow `BEST PAIR` · table caption `Top ten pairs by binding free energy` · footnote `{runs} runs · {wallets} wallets · {targets} targets in this group`
- Jump select label: `Jump to`
- Print header: `Ponchem · Cancer research report · {date}` · print footer: `2026 Pons Lab CADD (Computer-aided Drug Design) · compiled from Robinhood Chain`
- Markdown export header line: `Ponchem cancer research report, compiled from Robinhood Chain at block {block} on {date}. Estimates from computational screening with a Vina-style scoring function. Not clinical results.`

## 7. Wallet (`/wallet`)

- Disconnected H2: `Connect a wallet to see your lab record` · line: `Your runs, prizes and sponsorships live on chain. Nothing is stored anywhere else.` · button `Connect wallet`
- Connected H1: `My lab` · stats `Runs` · `Best dG` · `Prizes to claim`
- Tabs: `Runs` · `Prizes` · `Sponsorships`
- Prize row: `{target} · epoch {n} · {amount} ETH` · button `Claim` · claimed `Claimed`
- Copy address button: `Copy address` · toast `Address copied`

## 8. Docs (`/docs`)

Contents: `How it works` · `Scoring explained` · `What the chain checks` · `What is and is not claimed` · `Wallet and network` · `API` · `Glossary`

### How it works

`Ponchem is a computer-aided drug design lab that keeps its record on Robinhood Chain. The library holds about one hundred cancer targets and about one hundred bioactive plant compounds. Each target is an experimental structure from the RCSB Protein Data Bank. Its binding pocket is defined at build time from the reference ligand in the crystal: a box padded by 2 A on each side, at least 6 A of half size, and every receptor heavy atom within reach of that box. The pocket bytes and the box are hashed and the hash is registered on chain.`

`Each ligand is a heavy atom topology derived from its chemical component or PubChem record: atoms, bonds, ideal bond lengths, 1-3 distances and rotatable bonds. Hydrogens are not represented. That topology is registered on chain too.`

`When you dock, a seeded stochastic pose search runs in a Web Worker in your browser. It moves, turns and twists the ligand inside the box and keeps the best poses. Quick, Standard and Deep only change how long it searches. The same seed gives the same pose on any machine. The final pose is always evaluated by the integer scorer, the same function the contract runs.`

`Recording sends the pose to the contract with the run fee. The contract checks the geometry, recomputes the score and emits an event with the whole pose. From then on the site shows the chain's number.`

### Scoring explained

`The score is an empirical estimate of binding free energy in kcal/mol. It sums five terms over every ligand atom and receptor atom pair within 8 A, using the surface distance d, which is the centre distance minus both atom radii.`

- `gauss 1: a narrow bell around d = 0, rewards close contact.`
- `gauss 2: a wide bell around d = 3 A, rewards being near the surface.`
- `repulsion: d squared when d is negative, punishes overlap.`
- `hydrophobic: 1 when two hydrophobic atoms touch, fading to 0 at 1.5 A.`
- `hydrogen bond: 1 when a donor and an acceptor are close, fading to 0 at d = 0.`

`The weights are the ones Trott and Olson fitted on about 1,300 PDBbind complexes (AutoDock Vina, J Comput Chem 2010). The sum is divided by 1 + 0.0585 times the number of rotatable bonds, which costs flexible molecules a little. Ponchem's engine is an independent implementation of this family of functions, which we call Vina-style. It shares the functional form and the published weights. It is not the AutoDock Vina program, and it makes no claim to reproduce its numbers on any given complex.`

`On chain everything is fixed point: coordinates in hundredths of an angstrom, distances from an integer square root table, the bell terms from lookup tables, energies in micro kcal/mol and reported in milli kcal/mol. The JavaScript scorer and the Python reference are bit exact copies of the contract's arithmetic, proven by a shared test vector file.`

`Potency: pKd = -dG / (RT ln 10) at 298.15 K, and Kd = 10 to the power of -pKd. Ligand efficiency is -dG divided by the heavy atom count. All three are derived from the same estimate and carry its uncertainty.`

### What the chain checks

`A pose is a list of heavy atom positions in hundredths of an angstrom, relative to the box centre. The contract accepts it only if:`

- `it has exactly the ligand's heavy atoms in topology order;`
- `every bonded pair is at its ideal distance within the tolerance in the engine spec;`
- `every 1-3 pair is at its ideal distance within tolerance;`
- `every pair separated by three or more bonds is at least the clash floor apart;`
- `every atom is inside the target's box.`

`A pose can only score well by fitting the pocket, because the receptor atoms it is scored against are the registered pocket bytes. Mirror images are not distinguished by these checks; that is a known limit and is stated here. The contract then recomputes the score with the integer function and stores the run with the pose in the event.`

### What is and is not claimed

`Claimed: the structures are real experimental entries from the RCSB Protein Data Bank; the pose search runs in your browser; the score is an integer Vina-style estimate the contract recomputes; the record is on Robinhood Chain and this site rebuilds from it; the prize pools pay the best score of each epoch.`

`Not claimed: that a strong score means a compound is active in cells, animals or people; that any compound here treats or cures a cancer; any wet-lab, clinical or regulatory result; that the engine reproduces AutoDock Vina; that a score is more than a lead for further study. AI modeling here means computer-aided drug design with a learned empirical scoring function. No model on this site claims to have found a drug.`

### Wallet and network

`Ponchem runs on Robinhood Chain, chain id 4663, gas paid in ETH. Connect with any injected wallet. If the wallet is on another network the site asks it to switch, and if the wallet does not know the chain, add it with these parameters: name Robinhood Chain, chain id 4663, currency ETH, RPC {rpcUrl}, explorer {explorerUrl}. Recording a run costs the run fee shown in the lab plus gas. Claiming a prize and sponsoring a pool cost gas only, plus the amount you send.`

### API

`The site exposes read-only JSON endpoints under /api for the runs index and the report, and a same-origin JSON-RPC proxy for chain reads. Endpoints and fields are listed below. The catalog files under /data are static and may be fetched directly.`

### Glossary

- `Binding free energy (dG)` · `The energy change when a ligand binds a receptor, in kcal/mol. Negative means binding is favourable. More negative means stronger.`
- `Gibbs energy` · `The thermodynamic quantity dG stands for. At constant temperature and pressure, a process is favourable when its Gibbs energy change is negative.`
- `Kd` · `Dissociation constant. The concentration at which half the receptor sites are occupied. Smaller means tighter binding. Estimated here from dG = RT ln Kd at 298.15 K.`
- `pKd` · `Minus the base ten logarithm of Kd in molar units. Bigger means tighter. A pKd of 6 is one micromolar; 9 is one nanomolar.`
- `Ligand efficiency` · `Binding free energy per heavy atom, as a positive number. It favours small molecules that bind well for their size.`
- `Pose` · `One placement of the ligand: the position of every heavy atom in the pocket.`
- `Pocket` · `The receptor atoms around the reference ligand's box, taken from the crystal structure. Registered on chain as bytes with a hash.`
- `Box` · `The region the ligand may occupy, centred on the reference ligand and padded. Every atom of a recorded pose must be inside it.`
- `Heavy atom` · `Any atom that is not hydrogen. The engine only represents heavy atoms.`
- `Rotatable bond` · `A single bond the search can twist. More of them means more flexibility and a small penalty in the score.`
- `Epoch` · `A seven day window per target, counted from a genesis timestamp. The best score recorded in the window wins its pool when someone settles.`
- `Prize pool` · `The ETH held for one target: run fees plus sponsorships. Paid to the best wallet of the epoch minus the lab fee, or rolled over if no run was recorded.`
- `Run fee` · `The ETH a run costs to record, set at deploy. It joins the target's pool.`
- `Lab fee` · `The share of a settled prize kept by the lab treasury, set in basis points.`
- `Vina-style` · `Of the AutoDock Vina family of empirical scoring functions: the same five terms and published weights, in an independent implementation.`
- `Seed` · `The number that fixes the random choices of a search. Same seed, same pose.`
- `Reference ligand` · `The compound that was in the crystal structure. It defines the box and appears as a blue ghost in the viewer.`

---

## 9. Empty states (H4 then one line then the action)

- Results, before a run: `No pose yet` · `Choose a target and a ligand, then run docking.` · `Run docking`
- Leaderboard, no runs: `No runs recorded yet` · `The first recorded run on this target starts its leaderboard.` · `Open the lab`
- Report group, no runs: `Nothing recorded for this group yet` · `Dock any of its targets and the report fills in.` · `See targets`
- Wallet runs: `No runs from this wallet` · `Your recorded runs will list here with their chain scores.` · `Open the lab`
- Wallet prizes: `Nothing to claim` · `Win an epoch on a target and the prize appears here.` · `See pools`
- Wallet sponsorships: `No sponsorships yet` · `Fund a target's pool to move people toward it.` · `Sponsor a target`
- Search, no matches: `No matches` · `Try a shorter name or a PDB id.` · `Clear search`
- Picker filtered to nothing: `Nothing in this group yet` · `Clear the filter to see the whole library.` · `Clear filter`
- Target pool this epoch: `No runs this epoch yet. The pool rolls over.`

## 10. Toasts

- `Run recorded on chain` (action `View tx`)
- `Chain score {dG} kcal/mol`
- `Transaction sent. Waiting for confirmation.`
- `Transaction reverted. Nothing was recorded.`
- `Link copied`
- `Address copied`
- `$PONCHEM CA copied` (only after launch)
- `Pool sponsored with {amount} ETH` (action `View tx`)
- `Epoch settled. {amount} ETH sent to the best wallet.` (action `View tx`)
- `Prize claimed` (action `View tx`)
- `Wallet connected`
- `Wallet disconnected`
- `Switched to Robinhood Chain`
- `Markdown downloaded`
- `CSV downloaded`
- `Structure loaded from RCSB`
- `Could not load the structure file. Showing the RCSB image.`

## 11. Error strings

- `Could not reach Robinhood Chain. Reads will retry.`
- `The wallet rejected the request.`
- `The wallet could not switch networks. Add Robinhood Chain manually; the docs list the parameters.`
- `This pose fails a geometry check, so the chain would reject it. Run again.`
- `The run fee is {fee} ETH plus gas. The connected wallet does not hold enough ETH.`
- `Recording needs at least {minHold} $PONCHEM in the connected wallet.`
- `The epoch has not ended yet. It ends in {time}.`
- `Nothing to settle: no run was recorded this epoch.`
- `Nothing to claim from this wallet.`
- `The transaction failed on chain. Nothing was recorded.`
- `The catalog could not be loaded. Reload the page.`
- `Your browser does not support Web Workers, which the docking engine needs.`
- `WebGL is not available, so the 3D view is off. Scores and records still work.`
- `Docking was stopped. The last best pose is kept.`
- `Unknown target id.` · `Unknown ligand id.`
- `Amount must be greater than zero.`

## 12. Wallet strings

- `Connect wallet` · `Confirm in wallet` · `Connecting` · `Disconnect`
- `Wrong network` · `Switch network` · `Switch to Robinhood Chain`
- Band: `Your wallet is on another network. Ponchem records runs on Robinhood Chain.`
- Menu: `Network` · `Robinhood Chain` · `Balance` · `My runs` · `My prizes` · `My sponsorships` · `Copy address`
- No wallet found: `No wallet found. Install a wallet extension or open this page in a wallet browser.`
- Connected: `Wallet connected` · shortened address format `{first4}…{last4}`

## 13. 404 (`/404`)

- Mono: `404`
- H1: `Nothing binds here`
- Line: `The page you asked for is not in the library.`
- Buttons: `Back to the lab` · `Home`

## 14. Footer

- Line (exact, every page): `2026 Pons Lab CADD (Computer-aided Drug Design)`
- Right: `Structures from the RCSB Protein Data Bank`
- Brand sentence: `On-chain computer-aided drug design. An honorable project of ponsfamily.com.`
- Columns: `Lab` (`Lab`, `Targets`, `Ligands`, `Leaderboard`, `Report`, `Wallet`) · `Data` (`RCSB Protein Data Bank`, `Robinhood Chain explorer`, `API`) · `Community` (`X @PonchemAI`, `ponsfamily.com`, `Docs`)

## 15. Meta: titles and descriptions

| page | `<title>` | meta description |
|---|---|---|
| `/` | `Ponchem · On-chain drug design` | `Dock bioactive plant compounds into cancer targets from the Protein Data Bank. Robinhood Chain re-scores every pose and keeps the record.` |
| `/lab` | `Ponchem · Lab` | `Pick a cancer target and a plant compound, run a seeded docking search in your browser, and record the pose on Robinhood Chain.` |
| `/targets` | `Ponchem · Targets` | `About one hundred cancer targets from the RCSB Protein Data Bank, each with its PDB id, resolution, reference ligand, pool and best binders.` |
| `/target` | `Ponchem · {target} ({id})` | `{target}, PDB {id}, {resolution} A. Pocket, prize pool, epoch and the best recorded binders on Robinhood Chain.` |
| `/ligands` | `Ponchem · Ligands` | `About one hundred bioactive plant compounds with on-chain topologies, their source plants, and where each one binds best.` |
| `/ligand` | `Ponchem · {ligand}` | `{ligand} from {source}: formula, heavy atoms, rotatable bonds and its best cancer targets by estimated binding free energy.` |
| `/leaderboard` | `Ponchem · Leaderboard` | `Best computational binders by target, cancer group and ligand. Every row is a run scored by the contract on Robinhood Chain.` |
| `/report` | `Ponchem · Cancer research report` | `A live screening report compiled from chain data: the best target and ligand pairs for each top-threat cancer group, with potency estimates.` |
| `/wallet` | `Ponchem · My lab` | `Your recorded runs, best scores, prizes to claim and pool sponsorships on Robinhood Chain.` |
| `/docs` | `Ponchem · Docs` | `How the lab works, how the Vina-style score is computed, what the contract checks, what is and is not claimed, the API and a glossary.` |
| `/404` | `Ponchem · Not found` | `That page is not in the library.` |

Open Graph: `og:site_name` `Ponchem`, `og:title` equals the page title, `og:description` equals the meta
description, `og:image` the rendered card at `/img/brand/og-card.png`, `twitter:card` `summary_large_image`,
`twitter:site` `@PonchemAI`.

---

## 16. v2 addendum (SPEC.md section 9, 2026-09-22)

Every string below is final and obeys section 2. Strings of sections 1 to 15 stay valid unless a line here says it
replaces one. `{n}` is the docking test id, `{ligand}`, `{gene}`, `{pdb}`, `{dG}`, `{pKd}` come from the catalog
and the chain, never typed by hand.

### Wording

- The chain step is a **docking test**; the browser step is `Dock` / `Find a pose`. Where v1 copy says "run"
  in the sense of the chain record, v2 pages say "docking test" (`Docking tests` in stat strips and stats,
  `My docking tests` on the dashboard). "Runs" stays on the target and ligand tabs and in the API field names.

### Landing changes (replace the v1 lines named)

- Value prop 3 (replaces `A record that pays`): H3 `Every docking test is paid, scored and reviewed` · `A docking test costs 100 $PONCHEM or 0.0001 ETH, paid to the lab treasury. The contract proves the geometry, scores the pose and keeps the record. Anyone can review a test on chain, with stars and a note.`
- Step 03 (replaces `Record`): H4 `Test` · `Connect a wallet and pay the test, 100 $PONCHEM or 0.0001 ETH. The contract checks the geometry, re-scores the pose and stores it.`
- Step 04 (replaces `Settle`): H4 `Review and settle` · `Other wallets review the test. When the epoch ends, anyone can settle: the best score takes the sponsored pool. The report updates.`
- Stat strip (five cells): `Targets` · `Ligands` · `Docking tests` · `Reviews` · `In prize pools`
- Token card body (replaces the v1 body): `Ponchem is an honorable project of ponsfamily.com, and $PONCHEM launches there. Until then the buy link is inert and no contract address is published here. When the token is live this card shows the buy link and Copy CA.` then `Every docking test costs 100 $PONCHEM or 0.0001 ETH, paid to the lab treasury. The payer chooses. While $PONCHEM is not launched only the ETH option works, and the token option in the lab reads after the $PONCHEM launch.`
- Price line (only when the chain is live): `On chain now: a docking test costs {price} $PONCHEM or {fee} ETH.` (`$PONCHEM after the launch` in place of the price while the token is unset)
- The v1 requirement line (`Recording a run needs at least {minHold} $PONCHEM ...`) is retired: minHold is gone.

### Direct links (9.4)

- Link text names the destination: `RCSB {pdb}` (structure), `RCSB {ccd}` (chemical component), `PubChem {cid}`.
  Cards keep `Dock` next to the link; the target page keeps `View on RCSB` and `Open in Mol* on rcsb.org` and adds
  `RCSB {pdb}` plus `RCSB {ccd}` on the reference ligand row; tables show the link after the name.
- Every run row links to its test page: column `Test`, cell `#{n}`.

### Test report page (`/run?id=N`)

- Title: `Ponchem · Docking test #{n}` · description: `{ligand} into {gene} ({pdb}): dG {dG} kcal/mol, pKd {pKd}, scored on Robinhood Chain.`
- Static title (before the id is known): `Ponchem · Docking test`
- Eyebrow `Docking test` · H1 `Docking test #{n}` · lede `{ligand} into {gene} ({pdb})` (both linked)
- Meta: wallet (short) · `{date} · {ago}` · `epoch {n}` · link `View transaction`
- Actions: `Post on X` · `Copy link` · `Download report`
- Score card: eyebrow `Chain score` · chip `chain score` · the number with unit `kcal/mol` · band badge and label · rows `Estimated pKd` · `Estimated Kd` · `Ligand efficiency` (unit `kcal/mol per heavy atom`) · `Heavy atoms` · `Rotatable bonds` · `Paid with` (`{amount} ETH` or `{amount} $PONCHEM`) · `Score in milli kcal/mol`
- Viewer strip: legend `receptor` · `pose` · `{pdb} · {title}` · link `RCSB {pdb}`
- Browser check: eyebrow `Browser check` · H2 `The pose re-scored in your browser` · line `The same integer function the contract runs, applied to the pose in the event. The five terms are weighted, in kcal/mol, before the rotor division.` · `Chain and browser agree` · discrepancy `The chain scored {chain} kcal/mol, the browser {browser} kcal/mol.` · `The browser rejects this pose on a geometry check, the chain accepted it. Reload the page; if it stays, the pocket files differ from the chain.` · eyebrows `Geometry proof` · `Five terms` · rows `sum` · `divided by 1 + 0.0585 x {nrot}` · `browser score`
- Browser check states: `The pose of this test is not in the index yet, so the browser cannot re-score it.` · `The docking engine could not be loaded, so the browser cannot re-score this test.` · `The pocket or topology bytes could not be loaded, so the browser cannot re-score this test.`
- Provenance: eyebrow `Provenance` · H2 `Where the structure and the compound come from` · rows `Target` · `Structure` · `Reference ligand` · `Ligand` · `Formula` · `Source` · `Pocket` · `Topology hash` · `Pose hash` · `Transaction` · `Block`
- Method: eyebrow `Docking method` · H2 `The search that prepared this pose` · `Method {name}` · button `Use this method` · `This test did not record a method.` · `The recorded method does not pass the schema, so the lab will not load it.`
- AI analysis: eyebrow `AI analysis` · H2 `What a model makes of this test` · line `The model receives the facts of this test (target, ligand, score, terms, proof, method, the target's other tests) and answers in its own words. The text is the model's and is not verified. Keys never reach the browser.` · eyebrow `Model` · providers `Claude Fable 5.1` · `GPT` · `Kimi` · `Jev AI` · chip `not connected` · button `Analyze` · note `Ten analyses per minute across this server.` · `AI analysis is not connected on this server.` · chip `attached on chain` · button `Attach analysis on chain` · caption `The text is the model's own output and is not verified. Keys never reach the browser.` · error `The analysis could not be generated. Try again in a minute.` · `The analysis is longer than 2048 bytes, the limit the contract stores. Generate a shorter one.`
- Reviews: eyebrow `Reviews` · H2 `What other wallets say` · summary `{avg} of 5` · `from {n} reviews` (`review` for one) · `No reviews yet` · list item: reviewer (short), stars, `{ago}`, link `tx`, the note or `No note.` · `Reviews are read from chain events; the list appears once the data layer indexes them.`
- Write a review: H3 `Write a review` (`Your review` when one exists) · label `Stars` · label `Note` · placeholder `What stands out in this test? Plain text, 280 characters at most.` · help `Plain text. Stored on chain with your address.` · counter `{n}/280` · button `Send review` (`Replace my review`) · caption `Gas only. A second review replaces the first.` · gate `Connect a wallet to write a review.` + `Connect wallet` · `You cannot review your own docking test.` · errors `Pick one to five stars.` · `A review note has at most 280 characters.`
- Not found: H1 `Docking test not found` · `No docking test with this id is recorded on chain.` · `Unknown docking test id.` · buttons `Leaderboard` · `Open the lab`
- X post text (exact form): `Docking test #{n} on Ponchem: {ligand} into {gene} ({pdb}). dG {dG} kcal/mol, pKd {pKd}, scored on Robinhood Chain.` followed, when an analysis is attached, by ` {provider} {model}: {first 500 characters}`
- Markdown report: `# Docking test #{n} on Ponchem` · sections `## Score` · `## Provenance` · `## Method` · `## Reviews` · `## AI analysis ({provider} {model}, unverified model output)` · closing lines `Estimates from computational screening with a Vina-style scoring function. Not clinical results.` and the footer line `, compiled from Robinhood Chain`

### Dashboard (`/dashboard`; `/wallet` forwards here)

- Title `Ponchem · Dashboard` · description `Your lab record on Robinhood Chain: level, XP and badges, your docking tests, best scores, reviews, prizes, sponsorships and how tests are paid.`
- No wallet: H1 `Connect a wallet to open your dashboard` · `Your lab record lives on chain. Nothing is stored anywhere else. Once connected, the dashboard shows:` · list `Your level, XP and badges` · `Your docking tests with their chain scores and reviews` · `Your best score on each target` · `Reviews you received and reviews you wrote` · `Prizes to claim and pools you sponsored` · `How docking tests are paid` · button `Connect wallet`
- Connected: eyebrow `Dashboard` · H1 `Dashboard` · `Copy address` · eyebrow `Level` · `{level name}` · `{xp} XP` · progress bar label `Progress to the next level` · `{n} XP to {next level} ({min} XP)` · `Top level reached.` · stats `Docking tests` · `Best dG` · `Reviews received` · `Prizes to claim` · eyebrow `Badges`
- Section pills and H2s: `My docking tests` · `Best scores` (line `Your best test on each target, lowest binding free energy first.`) · `Reviews received` · `Reviews written` · `Prizes and withdraw` · `Sponsorships` · `Payment`
- Tests table columns: `Test` · `Target` · `Ligand` · `dG (kcal/mol)` · `Band` · `Reviews` · `Actions` (`Post on X` · `Report`)
- Prizes: `Prizes to claim · {amount} ETH` + `Claim` · `Prizes won so far · {amount} ETH` · badge `settled` / `Claimed` · win rows `{target} · epoch {n} · {amount} ETH`
- Payment: `Every docking test costs {price} $PONCHEM or {fee} ETH, paid to the lab treasury. The payer chooses in the lab.` · `While $PONCHEM is not launched only the ETH option works, and the token option reads after the $PONCHEM launch.` · after the launch `Both options are open: {price} $PONCHEM from the connected wallet, or {fee} ETH with the transaction.` · `Prize pools are funded by sponsors only. A settled epoch pays the best wallet on that target, minus the lab fee.` · the blank token controls (`Buy $PONCHEM · soon`, `Copy CA`, `CA posts here at launch`)
- Levels: `Observer` 0 · `Assistant` 50 · `Researcher` 150 · `Senior Researcher` 400 · `Principal Investigator` 900 · `Lab Head` 2000
- Badges (name · rule): `First test` · `Ten tests` · `Fifty tests` · `Ten targets` · `Strong binder` · `Best on a target` · `Epoch winner` · `Sponsor` · `Reviewer` · `Well reviewed` (rules as js/gamify.js prints them)
- /wallet forwarder: H1 `Your lab record moved to the Dashboard` · `Level, XP and badges, docking tests, reviews, prizes and sponsorships now live at /dashboard. This page forwards there in a moment.` · button `Open the dashboard`
- Wallet menu item (js/shell.js): `dashboard` (was `my runs`), to /dashboard. Footer column: `Dashboard` (was `Wallet`).

### Leaderboard and report

- Lede: `Best binders by target, by cancer group and by ligand. Every row is a docking test the chain scored, with a link to its report page.`
- Views: `By target` · `By cancer group` · `By ligand` · `Wallets` · `Most reviewed` · `Pools`
- Wallets columns: `Rank` · `Wallet` · `Level` · `XP` · `Tests` · `dG (kcal/mol)` · footnote `XP and levels follow the rules in the docs: Levels and badges.`
- Most reviewed: H2 `Most reviewed tests` · columns `Rank` · `Test` · `Pair` (`{ligand} into {gene}`) · `dG (kcal/mol)` · `Stars` · `Reviews`
- Report table gains `Reviews` (`{avg} ({count})` with stars) and `Test` (`#{n}`); the best pair cards carry `RCSB {pdb}` / `RCSB {ccd}` / `PubChem {cid}` and `Test #{n}`. The Markdown table gains `Reviews` and `Test` (the page URL).

### Empty states (v2)

- Dashboard tests: `No docking tests from this wallet` · `Your docking tests will list here with their chain scores.` · `Open the lab`
- Dashboard best: `No best scores yet` · `Your best test on each target appears here.` · `Open the lab`
- Reviews received: `No reviews received yet` · `Reviews other wallets write on your tests appear here.` · `See the leaderboard`
- Reviews written: `No reviews written yet` · `Open any docking test and write a review.` · `See the leaderboard`
- Test page reviews: `No reviews yet` · `The first review on this test starts its list.`
- Most reviewed: `No reviews yet` · `The first review on a docking test starts this list.` · `See tests`
- Wallets: `No wallets ranked yet` · `The first docking test starts the wallet ranking.` · `Open the lab`

### Toasts (v2)

- `Link copied` · `Report downloaded` · `Review recorded on chain` (action `View tx`) · `Analysis attached on chain` (action `View tx`)

### Docs (v2 sections)

Contents: `How it works` · `Payment` · `Scoring explained` · `What the chain checks` · `Docking methods` · `Reviews` ·
`Levels and badges` · `AI analysis` · `Post on X` · `What is and is not claimed` · `Wallet and network` · `API` · `Glossary`.
The prose of the new sections is in docs.html verbatim; the anchors are `#payment`, `#methods`, `#reviews`, `#levels`,
`#ai-analysis`, `#post-on-x`. Glossary adds `Docking test`, `Method`, `Test price`, `Review`, `XP`; `Prize pool` and
the old `Run fee` entry are reworded (pools are sponsorships only).

### Meta (v2)

| page | `<title>` | meta description |
|---|---|---|
| `/run` | `Ponchem · Docking test #{n}` (static `Ponchem · Docking test`) | `{ligand} into {gene} ({pdb}): dG {dG} kcal/mol, pKd {pKd}, scored on Robinhood Chain.` |
| `/dashboard` | `Ponchem · Dashboard` | `Your lab record on Robinhood Chain: level, XP and badges, your docking tests, best scores, reviews, prizes, sponsorships and how tests are paid.` |
| `/wallet` | `Ponchem · Dashboard` (noindex, forwards) | `Your lab record moved to the dashboard: level, XP and badges, docking tests, reviews, prizes and sponsorships on Robinhood Chain.` |
