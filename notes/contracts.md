# Contracts: notes for the owner and the integration phase

Status 2026-09-22: built, tested (52 forge tests: vectors, units, fuzz, invariants, gas, regressions), rehearsed
end to end on a local anvil (deploy, the whole registry of 100 targets and 152 ligands, a docking test, a review, a
sponsorship, a settlement). Nothing is deployed on Robinhood Chain. The owner deploys with the two commands in
"The owner's commands".

## READ FIRST

1. SPEC.md section 9 (the v2 addendum) landed while this was built. The contract implements it: docking tests are
   paid to the treasury in ETH (`runFee`, 0.0001 ETH) or in $PONCHEM (`runPrice`, 100e18, `transferFrom` with strict
   return checks), pools are fed only by sponsors (`fund`), reviews live on chain, `minHold` is gone. The 8.2
   three-argument `submitRun(uint16,uint16,int16[])` is kept as the ETH path (what `fragment(LAB_ABI, 'submitRun')`
   returns), and `submitRun(uint16,uint16,int16[],bool payWithToken)` is the full form. `stats(address)` returns six
   values: the three of 8.2 first, then `reviewsGiven, reviewsReceived, starsReceived`.
2. Gas: the two ceilings SPEC-ENGINE.md 6.1 proposed (2.5M for AQ4 on 1M17, 6M for the 64 x 2000 case) are NOT
   met. Measured: 3,122,974 and 9,168,773 (submitRun, storage cold). The gates in `test/Gas.t.sol` are the measured
   numbers plus 15 percent (3.6M and 10.5M), which is what that section says to do once the Solidity exists. The
   section below explains where the gas goes and what was tried. Both are far under the chain's 32M per transaction;
   a typical docking test costs about 3.1M gas.
3. Two contracts, not one: `PonchemCheck` (the registration checks, the scan-form builder, `pairTerms`) is deployed
   first and its address goes into the lab's constructor. The lab's runtime would not fit under EIP-170 with it
   inside. Both are verified on Sourcify by `deploy.sh`.
4. The lab stores each pocket in **scan form** (a lossless 9-byte-per-atom transform of the spec blob, header and
   offsets unchanged; `contracts/README.md`). `target(id).hash` is the keccak256 of the spec blob the pipeline wrote;
   `target(id).data` is the scan-form contract. Anyone can rebuild the blob from it and check the hash.
5. `foundry.toml` is part of the design: the Yul optimizer sequence has no FullInliner step, and `optimizer_runs` is
   10,000. `test/Regressions.t.sol` pins both. Do not "clean up" the optimizer settings.

## Design decisions

- Data as code (SSTORE2): pocket scan form, topology bytes and the 13,010-byte tables blob each live in a data
  contract created with CREATE (`DataStore.sol`: `63 <size> 80 60 0E 60 00 39 60 00 F3` then `00 || payload`). A run
  EXTCODECOPYs the three into memory; no storage is read for data.
- Registration checks everything the scan trusts: header, id (4 upper-case alphanumerics equal to the header),
  atom count 1..2000, box half sizes, grid dimensions against the box, blob length, monotone offsets ending at n,
  every type code below 16, every atom in the cell whose range holds it; topology: version, counts, length, type
  codes, ordered in-range bond and 1-3 lists, near masks with the self bit and nothing beyond N. The hash the
  pipeline recorded is checked before anything else (`HashMismatch`).
- The evaluation (`PonchemEngine.sol`) follows SPEC-ENGINE.md section 6 in order: ATOM_COUNT, BOX, BOND, PAIR13,
  CLASH, then the 27-cell grid scan with the pocket's own cell offsets (three z-neighbours are one contiguous
  range). Pose words are validated as sign-extended int16 (a dirty word is a plain revert). The five sums are
  packed in one word (48 bits each), the energy is int256, the division is `sdiv` (truncation toward zero). The
  pose hash is the keccak256 of the canonical 6N pose bytes of SPEC-ENGINE.md 4.7 (not of the ABI words).
- Runs are 1-based, stored in two slots (wallet, target, ligand, score, time in one; the pose hash in the other);
  `run(id).epoch` is computed from the time. Bests update on strictly lower scores; ties keep the earlier run.
- Payments: last in the function, through a call with a 100,000 gas allowance and no return data copied; refused
  transfers are credited in `owed` (`withdraw()` pulls, full gas, reverts if refused again). A gas-burning or
  reverting treasury cannot block docking tests (regression test). The token path copies one word of return data
  and accepts an empty return (USDT style) or `true`; false, a revert, a short word or an address without code
  revert `TokenPaymentFailed`.
- Ownership: two-step, written in the contract (no OpenZeppelin). Setters: `setPrices`, `setPaymentOptions`,
  `setToken`, `setFeeBps` (<= 1000), `setTreasury`, `transferOwnership` / `acceptOwnership`.
- Reviews: one per (run, wallet), a second one replaces the first (count unchanged, sums adjusted), 1..5 stars,
  note of at most 280 bytes in the event only. Not the author.

## The pool and epoch rule (also in contracts/README.md)

`poolAt[target][epoch]` accrues what `fund` sends during that epoch. `settle(target, e)` needs `e < currentEpoch()`
and `e >= nextSettle[target]`, and settles every epoch from `nextSettle` to `e` in order in one call: an epoch with
a run pays its pool plus the carry, minus the fee at today's `feeBps`, to the wallet of `bestOfEpoch`; an epoch
without a run rolls its pool into the carry (`Rolled` carries the running total). Then `nextSettle = e + 1`. Money
that arrives after an epoch ended belongs to the epoch it arrives in. Nothing to settle at all (no run, no money in
the whole range) reverts `NoRuns` and leaves the cursor. A target registered later starts at its registration
epoch. `pool(target)` is the current epoch's stake: carry, plus the pools of earlier unsettled run-less epochs, plus
the current epoch's own accrual. Invariant (tested): `balance >= totalHeld + totalOwed`.

## Gas

Execution gas, storage cold before the call (`forge test --match-contract GasTest -vv` writes `contracts/gas.md`):

| case | quote | submitRun |
|---|---|---|
| AQ4 erlotinib (29 atoms) x 1M17 (796 pocket atoms), vector real_02 | 2,875,885 | 3,122,974 |
| QUE quercetin (22) x 1M17 | 2,394,963 | 2,541,783 |
| TA1 paclitaxel (62) x 1M17 | 4,347,187 | 4,541,173 |
| TA1 x synthetic 2000-atom pocket at protein density (0.044 atoms per A^3, box 14 x 8 x 8 A) | 8,917,106 | 9,168,773 |

Rehearsal receipts on anvil (real transactions, `out/rehearsal/gas.json`, folded into gas.md): PonchemCheck
1,286,769; PonchemLab 4,615,500; setTables 2,848,553; the registry of 100 targets 251,573,214 (about 2.5M each,
2.0M to 3.7M by pocket size) and 152 ligands 54,719,616 (about 360k each); everything together 315,043,652 gas.
`deploy.sh` estimated 277M from the file sizes before sending (12 percent under). A docking test of the real_02
pose on that chain: 3,150,956 gas in the receipt; fund 79,422; settle 104,463; reviewRun about 95,000.

Why the run ceilings are missed, from an opcode-level profile of the compiled loop on anvil
(`debug_traceTransaction`, gas per instruction): the spec's model was 80 gas per examined pocket atom and 250 per
pair inside the cutoff. The compiled loop costs about 65 per rejected visit, 130 more per visit that passes the
axis test (59 percent of the 11,018 visits for AQ4, the pocket is dense where the ligand sits) and about 430 per
pair inside the cutoff (1,868 pairs). Most of it is stack traffic and jumps, not arithmetic: MUL and MLOAD together
are 7 percent of the run. What was tried, in order, and what it gave for AQ4 (quote): the straightforward Yul with
the default optimizer 4.14M (the inliner flattened everything and the stack-limit evader spilled the loop to
memory); no inliner 3.89M; four live variables in the visit loop 3.52M; one packed word per pocket atom with a
single-AND rejection of any axis gap over 8 A 3.20M; PUSH32 constants (optimizer runs) 2.98M; the scan-form
records built at registration (no run-time unpack), branch-free pair terms through a per-run table over d, and a
four-way unrolled loop 2.88M. A run-time finer grid (4 A and 2 A cells) was measured and dropped: it removes only
the cheap rejected visits and its bucketing costs more than it saves. Ideas not taken, for later: sorting atoms
within a cell by x at registration (the range scan could then stop early), a hand-written EVM loop (the compiler's
stack scheduling is the remaining cost: about 45 DUP/SWAP/PUSH per visit), or accepting the cost (a docking test at
3.1M gas is a few cents at the chain's gas price).

Registration cost was cut ten times late in the build: the check's per-atom loop and the scan-form builder were
Solidity with bounds checks and checked arithmetic on every byte (about 5.1M for a 796-atom pocket, 7.8M per target
on average in the first rehearsal); in Yul they cost 484k for that pocket and 2.5M per target on average.

## The owner's commands

Both scripts start their own RPC forwarder (`tools/rpc-local.mjs`, DNS-over-HTTPS to the real node), check that
the node is the live chain, run the tests, check `js/abi.js`, unlock the keystore `pontoon-treasury`, check the
nonce and the balance, print the plan and wait for the word. Nothing is sent before it.

Deploy (three transactions: PonchemCheck, PonchemLab, setTables; then Sourcify, deployments.json and the
GENERATED:DEPLOY block of js/config.js with address, deployBlock from the receipt and genesis):

    cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && ./deploy.sh

Register the whole registry (252 transactions, one per entry, in registry order; resumable, run it again after any
stop and it continues; at the end every id and hash is verified against data/registry.json):

    cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && ./register.sh

To send it in slices of 40 instead:

    cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && LIMIT=40 ./register.sh

To check the chain against the registry without sending anything:

    cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && VERIFY_ONLY=1 ./register.sh

The whole thing is about 315M gas (measured on the rehearsal); `deploy.sh` prints the estimate at the node's gas
price before asking for the word, and refuses if the balance does not cover twice the deploy. The registry must be
final before `register.sh`: ids are positions in `data/registry.json`, and the site reads the same file.

Rehearsal (anvil on 8690, nothing reaches the chain; outputs in contracts/out/rehearsal/):

    anvil --port 8690 --chain-id 4663 --silent
    cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && echo deploy | LOCAL_BROADCAST=1 LOCAL_RESET=1 ./deploy.sh
    cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && echo register | LOCAL_BROADCAST=1 ./register.sh

A throwaway chain for the site and the tests, with the registry registered and runs seeded:

    cd "/Users/medikamedika/USELESS JOURNEY/ponchem" && node tools/local-chain.mjs

## What remains for the integration phase

- `js/lab.js` and `js/chain.js` (data layer builder): `LAB_ABI` from `js/abi.js` (114 fragments); `submitRun` three
  arguments for ETH; `Paid` and `Reviewed` events exist next to `RunScored`; `stats` has six outputs; `pool(id)` is
  the current stake; `poolAt`, `carry`, `nextSettle` are public for the pool card; `reviewStats`, `reviewOf`,
  `reviewRun` for section 9.2; `runFee`, `runPrice`, `token`, `ethAllowed`, `tokenAllowed` for the payment card.
- The site's gas hint for a docking test: about 3.1M for a 29-atom ligand on an 800-atom pocket, up to 9M for the
  largest ligands in the largest pockets; the wallet's estimate is the authority.
- `api/runs.js` rebuilds runs from `RunScored` (pose included) from `LAB.deployBlock`; `Paid` gives the method.
- Sourcify verification of both contracts runs inside `deploy.sh`; if it reports "not yet", the retry command is
  printed.
- Chain reads of `target(id).data` return the scan-form contract, not the spec blob: the site keeps reading pockets
  from `data/pockets/` (same hash).
- The stale `node tools/rpc-local.mjs` that squatted on port 8690 (an orphan from an earlier session, 21 hours old,
  relaying to the live chain) was stopped to free the assigned anvil port; two other orphaned anvils (8595, 52447)
  and the fork on 8691 were left alone.
