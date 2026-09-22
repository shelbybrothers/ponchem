# contracts/

The Foundry project for the Ponchem lab on Robinhood Chain (chain id 4663, an Arbitrum Nitro chain).

```
cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts"
forge build
forge test
```

## What is here

- `src/PonchemLab.sol`: the lab. Registration of targets (pockets) and ligands (topologies), docking tests
  (`submitRun`, `quote`), payments to the treasury in ETH or in the lab token, reviews, prize pools per target and
  epoch, settlement, pull payments, two-step ownership. Inherits the scorer.
- `src/PonchemEngine.sol`: the integer Vina-style scorer and the geometry proof of `SPEC-ENGINE.md` section 6, in
  Yul. Reads the pocket scan form, the topology and the tables from data contracts into memory once per call.
- `src/PonchemCheck.sol`: the registration-time checks (pocket blob against section 5, topology blob against 4.6),
  the scan-form builder, and `pairTerms` for audits. Deployed next to the lab (it would not fit inside it under the
  24,576-byte code limit) and called with STATICCALL; it holds no state.
- `src/PonchemConstants.sol`: the frozen numbers shared by both. `src/DataStore.sol`: bytes stored as code.
- `test/`: `Vectors.t.sol` (every file of `../data/vectors`), `Lab.t.sol` (units), `Fuzz.t.sol`, `Invariant.t.sol`,
  `Gas.t.sol` (ceilings and the writer of `gas.md`), `Regressions.t.sol`. `Base.t.sol` is the fixture.
- `script/Mainnet.sol` (the constants), `script/Deploy.s.sol` (check + lab + tables), `script/Register.s.sol`
  (the registry, resumable), `script/lib/shell.sh` (helpers for the shell scripts).
- `deploy.sh` and `register.sh`: what the owner runs. Both have a rehearsal mode on anvil (`LOCAL_BROADCAST=1`).
- `deployments.json`: written by `deploy.sh`. `gas.md`: written by `forge test --match-contract GasTest`.

## Data on chain

Every blob is stored as code in its own data contract (a STOP byte, then the payload; `DataStore.sol`). A run
copies the pocket, the topology and the tables into memory with EXTCODECOPY and touches no storage for them.

- Tables: `data/tables/tables.bin` as is (13,010 bytes), once, `setTables`.
- Ligand: the topology blob as is. `ligand(id).hash` is its keccak256.
- Target: `target(id).hash` is the keccak256 of the pocket blob the pipeline wrote (`data/pockets/<PDB>.bin`), and
  `registerTarget` checks the blob and that hash. What the data contract holds is the blob's **scan form**: the
  same 28-byte header, then one 9-byte record per atom in the blob's order,
  `R = (x + 32768) | (y + 32768) << 18 | (z + 32768) << 36 | tw << 54` with `tw = radius << 8 | flags` of the atom's
  type (flags: bit0 hydrophobic, bit1 donor, bit2 acceptor), then the blob's cell offset table unchanged. It is a
  lossless transform: x, y, z and the type come back from each record, so anyone can rebuild the registered bytes
  from the chain and check the hash. The scorer reads it directly, which is what lets one subtraction test the
  three axis gaps of a pair at once (`PonchemEngine.sol` explains).

## The pool and epoch rule

- Pools are per target and per epoch. `fund(targetId)` adds to `poolAt[targetId][currentEpoch()]`. Docking test
  payments do not feed pools (they go to the treasury, SPEC.md section 9).
- Epochs are `epochLength` seconds from `genesis` (the deploy block's timestamp), numbered from 0. A target
  registered later starts settling at its registration epoch (`nextSettle`).
- `settle(targetId, e)` needs `e < currentEpoch()` (ended) and `e >= nextSettle[targetId]` (not settled yet). It
  settles every epoch from `nextSettle` up to `e`, in order, in one call: an epoch with a run pays
  `poolAt[e] + carry` minus the lab fee (`feeBps` at settlement time) to the wallet of `bestOfEpoch[targetId][e]`
  and the fee to the treasury, and clears the carry; an epoch without a run adds its pool to the carry and emits
  `Rolled`. Then `nextSettle = e + 1`. Money that arrives after an epoch ended belongs to the epoch it arrives in,
  never to the ended one, so a settlement can never be raced by a late sponsorship.
- If no epoch in the range has a run and none of them received money, the call reverts with `NoRuns` (nothing to
  settle) and the cursor does not move.
- `pool(targetId)` is what the current epoch's best wallet would take before the fee if nothing more came in: the
  carry, plus the pools of unsettled earlier epochs that have no run, plus the current epoch's own pool.
- Payments go out last, through a call with a 100,000 gas allowance and no return data copied; a receiver that
  refuses is credited in `owed` and calls `withdraw()`.

## Deploy notes (from ponbio, proven on this chain)

- forge does not add Nitro's L1 data gas on chain 4663 and has died with "intrinsic gas too low": both scripts
  broadcast with `--slow --skip-simulation` so every gas limit comes from the node.
- Inside the EVM `block.number` is the PARENT chain's block: the deploy block comes from the transaction receipt.
- On this machine the RPC hostname resolves to a hijacked address: `resolve_rpc` in `script/lib/shell.sh` uses a
  relay on 127.0.0.1:8670 when one answers like the live chain, else starts `tools/rpc-local.mjs` itself.
- `deploy.sh` rewrites the `GENERATED:DEPLOY` block of `../js/config.js` (`LAB = { address, deployBlock, genesis }`).
- The optimizer settings in `foundry.toml` are part of the design: no Yul inliner, 1,000,000 runs. With the default
  sequence the scorer's Yul functions were flattened into one body and its loop spilled to memory (a run cost 4.1M
  gas instead of 3.1M). `test/Regressions.t.sol` pins them.
