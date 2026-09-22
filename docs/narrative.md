# Ponchem narrative (v1, 2026-09-22)

status: final

The owner asked for the concept to be brainstormed and the narrative polished until it stands on its own. This is
that narrative: the argument for the project, the loop it runs, and the words we use in public. It obeys SPEC.md
section 2: no dashes, no emoji, nothing described as less than live, no over-claims. Everything here can be quoted on the site or on X.

---

## The one-paragraph version

Ponchem is an on-chain computer-aided drug design lab. It takes about one hundred cancer targets from the RCSB
Protein Data Bank, real experimental structures with their pockets defined from the crystal, and about one hundred
bioactive plant compounds with their topologies fixed on chain. Anyone can dock a compound into a target in the
browser. Robinhood Chain checks the geometry of the pose, recomputes the binding free energy with an integer
scoring function, and stores the run. Every recorded run feeds a live cancer research report and a prize pool per
target. The record is public, the scorer is public, and the best lead of each week is paid.

## Why on-chain CADD

Computer-aided drug design has a reproducibility problem that is not about the science. The methods are
published. The structures are public. The scoring functions are in the literature with their weights. What is
missing is a record: who docked what, with which pose, scored by which exact function, and when. Results sit in
notebooks and spreadsheets. A number in a paper cannot be re-run by a reader. A screening campaign in one lab is
invisible to the next.

A contract fixes the parts of this that a contract can fix.

- The scoring function is code that anyone can read and that runs the same way for everyone. It is an integer
  implementation of a Vina-style empirical function, so there is no floating point drift and no vendor build. The
  number on the chain is the number, and the JavaScript and Python copies are proven bit exact against it.
- The pose is the record. The contract does not accept a score; it accepts atom positions, checks that they are a
  legal instance of the ligand's topology, and scores them itself. You cannot submit a good number without a pose
  that earns it.
- The inputs are pinned. Each pocket and each ligand topology is registered with a hash. The structure came from
  a specific PDB entry at a specific resolution; the ligand came from a specific chemical component or PubChem
  record. Provenance is a field on the card, not a footnote.
- The record is permanent and open. Events carry the whole pose, so the site rebuilds everything from logs and so
  can anyone else. There is no database of ours between the reader and the run.

Put together: a screening campaign that anyone can join, whose results anyone can verify, that nobody can
quietly edit. That is what "on-chain" buys here. It buys nothing about biology, and we do not say it does.

## Why plant compounds

Plant secondary metabolites are the historical source of a large share of small-molecule medicines, and
polyphenols, alkaloids, terpenoids and flavonoids keep showing up as hits in screening. They are also public:
their structures are in the chemical component dictionary and PubChem, they have names people know (quercetin,
curcumin, berberine, resveratrol), and many have a folk-medicine story that a reader from anywhere can connect to.

For a public lab that is the right library. A visitor can pick a compound from a plant they grew up with and
dock it into a kinase from a cancer that touched their family. The result is an estimate, and we say so every
time. But the question is real, the structures are real, and the record is real.

Plant compounds also stress the scoring function honestly. They are often flexible, often polar, often larger
than fragment-sized. The rotatable bond penalty and the hydrogen bond term matter. Ligand efficiency matters. A
library of drug-like plant molecules gives the leaderboard texture that a library of hand-picked inhibitors would
not.

## Why the record matters

A single docking score is nearly worthless. A thousand scores from the same function on the same pockets, with
the poses attached, from many hands and many seeds, start to mean something. The best pose per pair, the spread of
scores per target, which ligands keep surfacing across a cancer group: those are the signals a medicinal chemist
looks for before spending a bench week. Ponchem produces exactly that dataset and publishes it as a report that
updates with every block.

The report is careful. It groups targets by the top-threat cancers (lung, colorectal, liver, breast, stomach,
pancreatic, prostate, esophageal, cervical, leukemia, lymphoma, brain, melanoma, ovarian, bladder, kidney, myeloma,
head and neck, thyroid, sarcoma). For each it lists the best pairs by binding free energy with pKd, Kd and ligand
efficiency, plus how many runs and how many distinct wallets stand behind them. It is exportable as Markdown and
printable. It says on its first line that it is a computational screening summary and not a clinical finding.

## The loop

1. **Dock.** A visitor picks a target and a ligand, or screens one against many. A seeded pose search runs in a
   Web Worker in the browser. The final pose is scored by the integer function.
2. **Record.** The visitor connects a wallet and submits the pose with the run fee. The contract checks the
   geometry against the topology, recomputes the score, emits the event. From then on the site shows the chain's
   number.
3. **Sponsor.** Anyone can fund a target's prize pool. A sponsor who cares about one cancer can move the crowd
   toward it. Every run fee joins the pool too.
4. **Settle.** Epochs are seven days per target. When one ends, anyone can settle: the wallet with the lowest
   score in that window takes the pool minus the lab fee. No runs, the pool rolls over.
5. **Report.** The report and the leaderboards rebuild from chain events. The best pairs per cancer group are
   public, with their poses, forever.

The loop is an incentive to search well, not to search often. The prize goes to the best score, so the winning
move is a deep run on a pocket other people have not explored, with a ligand that fits it. That is the behaviour
a screening campaign wants.

## What we say and what we do not

We say: computational screening; estimated binding free energy; a lead for further study; AI modeling as the
name of the field (computer-aided drug design with a learned empirical scoring function); Vina-style, meaning an
independent implementation of the AutoDock Vina family of functions with the published weights.

We do not say: cure, treats, clinically, validated, FDA, discovered a drug, AI found. We never describe the lab
as anything less than live, because it is: the pockets, the topologies, the scorer and the pools are on Robinhood
Chain mainnet.

## Three positioning statements

1. **Ponchem is the public lab notebook for docking.** Real structures from the Protein Data Bank, a scoring
   function that runs inside a contract, and a record nobody can edit.
2. **Ponchem turns a screening campaign into a game with real stakes.** Dock a plant compound into a cancer
   target. If your pose is the best of the week, the pool is yours. The report keeps the pose either way.
3. **Ponchem is computer-aided drug design with receipts.** Every number on the site is the chain's number, and
   the pose behind it is one click away.

## X bio (160 characters max)

`On-chain computer-aided drug design. Dock plant compounds into cancer targets from the PDB. Robinhood Chain scores every pose. Pons Lab CADD. ponchem.ai`

(158 characters.)

## Five X post drafts (under 280 characters, no emoji, no dashes)

1. `Ponchem is live. Pick a cancer target from the Protein Data Bank, pick a bioactive plant compound, dock it in your browser. Robinhood Chain checks the pose, re-scores it and keeps the record. Computer-aided drug design with receipts. ponchem.ai`

2. `Why on chain? A docking score in a paper cannot be re-run by the reader. On Ponchem the scoring function is contract code, the pose is the record, and the inputs are hashed. Anyone can verify any run. That is what the chain buys. Nothing more, nothing less.`

3. `Every Ponchem target keeps its provenance: PDB id, method, resolution, reference ligand, DOI. Every ligand keeps its plant, formula and topology. Provenance is a field on the card, not a footnote. Browse the library at ponchem.ai/targets`

4. `Each target on Ponchem has a prize pool. Run fees and sponsorships fill it. Every seven days the wallet with the best binding free energy on that target takes the pool. Sponsor the cancer you care about and move the crowd toward it.`

5. `The Ponchem report rebuilds from chain events with every block: the best target and ligand pairs per cancer group, with pKd, Kd and ligand efficiency, plus how many wallets stand behind them. A screening summary, open to anyone, printable. ponchem.ai/report`

## Notes for whoever writes about Ponchem next

- Lead with the instrument, not the mission. Show a structure in the first sentence.
- Keep the two accents straight: blue is the receptor, orange is the ligand, everywhere.
- The token is a footnote until it launches on ponsfamily.com. Until then: `Buy $PONCHEM · soon` and
  `CA posts here at launch`, nothing else.
- Numbers get units. Estimates get the word estimate. Leads get the phrase "for further study".
