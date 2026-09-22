#!/usr/bin/env bash
#
# register.sh: register every target and ligand of the registry on the deployed PonchemLab, in registry order so
# that the chain's ids equal the registry's. The owner runs it after ./deploy.sh:
#
#   cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && ./register.sh        keystore pontoon-treasury
#   LIMIT=25 ./register.sh                                                              send 25 registrations, then stop
#
# Resumable: it reads targetCount() and ligandCount() from the lab, checks that every id already on chain carries the
# registry's hash, and continues from the first missing one; run it again after a stop or a failure and it picks up
# where it was. In order: reads the lab from deployments.json, starts its own RPC forwarder and checks the node is the
# live chain, runs the tests, checks js/abi.js, unlocks the keystore, checks the nonce and the balance against the
# estimate of what remains (from the data sizes), prints the plan, and broadcasts only after you type register
# (--slow --skip-simulation: one transaction at a time, gas limits from the node, progress "n of N" per receipt). At
# the end it verifies every id and hash on chain against the registry and prints the totals.
#
# Optional:
#   KEYSTORE_PATH=/path/file   use a keystore file anywhere instead of a name
#   PASSWORD_FILE=/path/file   read the keystore password from a file (otherwise forge asks)
#   RPC_URL=http://...         talk to this node (it must still pass the live chain check)
#   REGISTRY=/path/registry.json   the registry (default ../data/registry.json)
#   REGISTRY_ROOT=/path        what the registry's pocket and topology paths are relative to (default ..)
#   LIMIT=n                    send at most n registrations in this run (default: all that remain)
#   START=n                    must equal the chain's position in the sequence targets-then-ligands (a guard, not a choice)
#   SKIP_TESTS=1               do not run forge test first
#   VERIFY_ONLY=1              check the chain against the registry and send nothing
#
# Rehearsal on a local anvil (nothing reaches Robinhood Chain):
#   LOCAL_BROADCAST=1          RPC_URL defaults to http://127.0.0.1:8690 (anvil, chain 4663); the lab comes from
#                              out/rehearsal/deployments.json (written by the deploy rehearsal); the signer is the
#                              mainnet owner impersonated. When ../data/registry.json does not exist yet and REGISTRY
#                              is unset, a stand-in registry is built from the engine vectors
#                              (node ../tools/local-chain.mjs --standin) into out/rehearsal/registry.json.
#                              The gas of every registration is recorded in out/rehearsal/gas.json (forge test
#                              --match-contract GasTest folds it into gas.md).
#                              Pipe the confirmation in:  echo register | LOCAL_BROADCAST=1 ./register.sh
#
set -euo pipefail
set +B

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=script/lib/shell.sh
. "$HERE/script/lib/shell.sh"

cd "$HERE"
need_tools forge cast python3 curl node

if [ -n "${LOCAL_BROADCAST:-}" ]; then
  REH="$HERE/out/rehearsal"
  mkdir -p "$REH"
  DEPLOYMENTS_JSON="${DEPLOYMENTS_JSON:-$REH/deployments.json}"
  export FOUNDRY_BROADCAST="${FOUNDRY_BROADCAST:-$REH/broadcast}"
  if [ -z "${REGISTRY:-}" ]; then
    if [ -f "$ROOT/data/registry.json" ]; then
      REGISTRY="$ROOT/data/registry.json"
    else
      warn "../data/registry.json is not there yet: building the stand-in registry from the engine vectors"
      (cd "$ROOT" && node tools/local-chain.mjs --standin) || die "could not build the stand-in registry"
      REGISTRY="$REH/registry.json"
    fi
  fi
else
  DEPLOYMENTS_JSON="${DEPLOYMENTS_JSON:-$HERE/deployments.json}"
  REGISTRY="${REGISTRY:-$ROOT/data/registry.json}"
fi
REGISTRY_ROOT="${REGISTRY_ROOT:-$ROOT}"
BROADCAST_DIR="${FOUNDRY_BROADCAST:-$HERE/broadcast}"
RUN="$BROADCAST_DIR/Register.s.sol/4663/run-latest.json"
[ -f "$REGISTRY" ] || die "no registry at $REGISTRY (the pipeline writes ../data/registry.json; REGISTRY=path picks another)"

# ------------------------------------------------------------------- the lab
[ -f "$DEPLOYMENTS_JSON" ] || die "no $DEPLOYMENTS_JSON: run ./deploy.sh first"
LAB="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("address") or "")' "$DEPLOYMENTS_JSON")"
[[ "$LAB" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$DEPLOYMENTS_JSON carries no lab address: run ./deploy.sh first"
OWNER="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("owner") or "")' "$DEPLOYMENTS_JSON")"

# ---------------------------------------------------------------------- node
if [ -n "${LOCAL_BROADCAST:-}" ]; then
  RPC="${RPC_URL:-http://127.0.0.1:8690}"
  require_chain_4663
  is_anvil || die "LOCAL_BROADCAST=1 only rehearses on an anvil node; $RPC is not one. Nothing was sent."
  is_rh_relay "$RPC" && die "LOCAL_BROADCAST=1 refuses a node that answers like the live chain. Nothing was sent."
  warn "rehearsal on the local anvil $RPC: nothing reaches Robinhood Chain"
else
  resolve_rpc "$ROOT"
  require_chain_4663
  is_rh_relay "$RPC" || die "$RPC is not the live Robinhood Chain. For a rehearsal use LOCAL_BROADCAST=1."
fi
say "chain 4663 through $RPC, head block $(head_block "$RPC")"
CODE_LEN="$(cast code "$LAB" --rpc-url "$RPC" | wc -c | tr -d ' ')"
[ "$CODE_LEN" -gt 100 ] || die "no code at $LAB on $RPC: is deployments.json for this chain?"
OWNER_RB="$(cast call "$LAB" 'owner()(address)' --rpc-url "$RPC")"
T_DONE="$(cast call "$LAB" 'targetCount()(uint16)' --rpc-url "$RPC" | cut -d' ' -f1)"
L_DONE="$(cast call "$LAB" 'ligandCount()(uint16)' --rpc-url "$RPC" | cut -d' ' -f1)"
say "lab $LAB: owner $OWNER_RB, $T_DONE targets and $L_DONE ligands registered"
say ""

# --------------------------------------------------------------------- tests
bold "building"
forge build >/dev/null 2>&1 || { forge build || true; die "the build failed. Nothing was sent."; }
ok "  built"
if [ -z "${SKIP_TESTS:-}" ] && [ -z "${VERIFY_ONLY:-}" ]; then
  bold "running the contract tests before anything is signed"
  if ! forge test >/dev/null 2>&1; then
    forge test || true
    die "tests failed. Nothing was sent."
  fi
  ok "  all tests pass"
fi
(cd "$ROOT" && node tools/abi.mjs --check >/dev/null) || die "js/abi.js is stale: run  cd \"$ROOT\" && node tools/abi.mjs  first. Nothing was sent."
ok "  js/abi.js matches this build"
say ""

# ------------------------------------------------------------ what remains
bold "the registry"
PLAN="$(python3 - "$REGISTRY" "$REGISTRY_ROOT" "$T_DONE" "$L_DONE" "${LIMIT:-0}" <<'PY'
import json, os, sys
path, root, tdone, ldone, limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
reg = json.load(open(path))
T, L = reg.get("targets", []), reg.get("ligands", [])
def size(p):
    full = p if os.path.isabs(p) else os.path.join(root, p)
    return os.path.getsize(full) if os.path.exists(full) else None
items = []
for t in T: items.append(("target", t.get("pdbId"), size(t.get("pocket", "")), t.get("atoms")))
for l in L: items.append(("ligand", l.get("key"), size(l.get("topology", "")), None))
pos = tdone if tdone < len(T) else len(T) + ldone
end = len(items) if limit == 0 else min(len(items), pos + limit)
gas = 0; missing = 0
for kind, name, b, atoms in items[pos:end]:
    if b is None: missing += 1; continue
    if kind == "target":
        n = atoms or max(0, (b - 28) // 7)
        gas += 21000 + 32000 + 200 * (28 + 9 * n + (b - 28 - 7 * n) + 1) + 16 * b + 220 * n + 140000
    else:
        gas += 21000 + 32000 + 200 * (b + 1) + 16 * b + 150 * (b // 4) + 140000
print(len(T), len(L), pos, end, gas, missing)
PY
)"
set -- $PLAN
N_T="$1"; N_L="$2"; POS="$3"; END="$4"; EST_GAS="$5"; MISSING="$6"
set --
TOTAL=$(( N_T + N_L ))
say "  registry    $REGISTRY"
say "  targets     $N_T (registered $T_DONE)"
say "  ligands     $N_L (registered $L_DONE)"
say "  position    $POS of $TOTAL in the sequence targets-then-ligands"
[ "$MISSING" = "0" ] || die "$MISSING entries in the slice point at files that do not exist under $REGISTRY_ROOT. Nothing was sent."
if [ -n "${START:-}" ] && [ "$START" != "$POS" ]; then
  die "START=$START but the chain is at position $POS; ids must match the registry, so the next registration is fixed. Nothing was sent."
fi
if [ "$POS" -ge "$TOTAL" ] || [ -n "${VERIFY_ONLY:-}" ]; then
  bold "verifying every registered id against the registry"
  LAB="$LAB" REGISTRY="$REGISTRY" REGISTRY_ROOT="$REGISTRY_ROOT" VERIFY_ONLY=1 forge script script/Register.s.sol:Register --rpc-url "$RPC" 2>&1 | script_logs
  [ "$POS" -ge "$TOTAL" ] && ok "the registry is complete on chain: $N_T targets and $N_L ligands"
  exit 0
fi
say "  this run    positions $POS to $((END - 1)) ($((END - POS)) registrations), about $EST_GAS gas"
say ""

# ----------------------------------------------------------------------- key
if [ -n "${LOCAL_BROADCAST:-}" ] && [ -z "${KEYSTORE_PATH:-}" ]; then
  SIGNER="$OWNER_RB"
  SIGNER_ARGS=(--unlocked)
  cast rpc anvil_impersonateAccount "$SIGNER" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$SIGNER" 0x21E19E0C9BAB2400000 --rpc-url "$RPC" >/dev/null
else
  resolve_signer "${1:-pontoon-treasury}"
fi
[ "$(lower "$SIGNER")" = "$(lower "$OWNER_RB")" ] || die "the keystore's address $SIGNER is not the lab's owner $OWNER_RB. Registration is owner-only. Nothing was sent."

NONCE="$(cast nonce "$SIGNER" --rpc-url "$RPC")"
PENDING_NONCE="$(hex_to_dec "$(rpc_result "$RPC" eth_getTransactionCount "[\"$SIGNER\",\"pending\"]")")"
is_uint "$NONCE" || die "the node answered the nonce with something that is not a number"
[ -z "$PENDING_NONCE" ] || [ "$PENDING_NONCE" = "$NONCE" ] ||
  die "the owner has pending transactions (nonce $NONCE, pending $PENDING_NONCE). Let them land first. Nothing was sent."

# --------------------------------------------------------------------- money
RAW_NODE_PRICE="$(rpc_result "$RPC" eth_gasPrice)"
NODE_PRICE="$(hex_to_dec "$RAW_NODE_PRICE")"
is_uint "$NODE_PRICE" || NODE_PRICE=0
BAL="$(cast balance "$SIGNER" --rpc-url "$RPC")"
is_uint "$BAL" || die "the node answered the balance with something that is not a number"
say "signer      $SIGNER  (nonce $NONCE)"
say "balance     $(cast to-unit "$BAL" ether) ETH"
if [ "$NODE_PRICE" != "0" ]; then
  NEED="$(python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]))' "$EST_GAS" "$NODE_PRICE")"
  say "estimate    $EST_GAS gas at $(cast to-unit "$NODE_PRICE" gwei) gwei = $(cast to-unit "$NEED" ether) ETH for this run"
  if [ "$(python3 -c 'import sys; print(1 if int(sys.argv[1]) < int(sys.argv[2]) * 2 else 0)' "$BAL" "$NEED")" = "1" ]; then
    # Not enough for the whole run: send the longest prefix whose estimate the balance covers twice (with 5 percent
    # headroom on the gas price). Run the script again afterwards, or top up, to register the rest.
    FIT="$(python3 - "$REGISTRY" "$REGISTRY_ROOT" "$POS" "$END" "$BAL" "$NODE_PRICE" <<'PY2'
import json, os, sys
path, root, pos, end, bal, price = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
reg = json.load(open(path))
def size(p):
    full = p if os.path.isabs(p) else os.path.join(root, p)
    return os.path.getsize(full)
items = []
for t in reg.get("targets", []):
    b = size(t["pocket"]); n = t.get("atoms") or max(0, (b - 28) // 7)
    items.append(21000 + 32000 + 200 * (28 + 9 * n + (b - 28 - 7 * n) + 1) + 16 * b + 220 * n + 140000)
for l in reg.get("ligands", []):
    b = size(l["topology"]); items.append(21000 + 32000 + 200 * (b + 1) + 16 * b + 150 * (b // 4) + 140000)
p = price * 105 // 100
k = 0; gas = 0
while pos + k < end and 2 * (gas + items[pos + k]) * p <= bal:
    gas += items[pos + k]; k += 1
print(k, gas)
PY2
)"
    set -- $FIT; FIT_N="$1"; FIT_GAS="$2"; set --
    [ "${FIT_N:-0}" -gt 0 ] || die "the balance does not cover even one registration twice over. Top it up. Nothing was sent."
    LIMIT="$FIT_N"; END=$((POS + FIT_N)); EST_GAS="$FIT_GAS"
    NEED="$(python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]))' "$EST_GAS" "$NODE_PRICE")"
    warn "the balance covers $FIT_N registrations this run (positions $POS to $((END - 1)), about $EST_GAS gas, $(cast to-unit "$NEED" ether) ETH)."
    warn "run ./register.sh again afterwards for the rest; it continues where this run stops."
  fi
  ok "            the balance covers twice the estimate"
else
  warn "the node gave no gas price: the balance cannot be checked against the estimate"
fi
say ""

# ----------------------------------------------------------------- broadcast
if [ -n "${LOCAL_BROADCAST:-}" ]; then
  bold "REHEARSAL: the registrations go to the local anvil only."
else
  bold "Broadcasting $((END - POS)) registrations to Robinhood Chain is irreversible (each is its own transaction)."
  [ "${SIGNER_ARGS[0]}" = "--keystore" ] && [ -z "${PASSWORD_FILE:-}" ] && say "forge will ask for the keystore password once more, to sign."
fi
CONFIRM=""
read -r -p "type 'register' to send them: " CONFIRM || true
[ "$CONFIRM" = "register" ] || { say ""; say "nothing was sent."; exit 0; }
say ""

export LAB REGISTRY REGISTRY_ROOT
export LIMIT="${LIMIT:-0}"
[ -n "${START:-}" ] && export START
forge script script/Register.s.sol:Register --rpc-url "$RPC" "${SIGNER_ARGS[@]}" --sender "$SIGNER" \
  --broadcast --skip-simulation --slow || {
  warn "the broadcast stopped part way. Whatever landed is on chain and in order; run ./register.sh again to continue."
  exit 1
}

# -------------------------------------------------------------- what landed
T_NOW="$(cast call "$LAB" 'targetCount()(uint16)' --rpc-url "$RPC" | cut -d' ' -f1)"
L_NOW="$(cast call "$LAB" 'ligandCount()(uint16)' --rpc-url "$RPC" | cut -d' ' -f1)"
say ""
ok "on chain now: $T_NOW of $N_T targets, $L_NOW of $N_L ligands ($((T_NOW + L_NOW)) of $TOTAL)"

if [ -f "$RUN" ]; then
  python3 - "$RUN" "$REGISTRY" "${LOCAL_BROADCAST:+$HERE/out/rehearsal/gas.json}" "$N_T" "$N_L" <<'PY'
import json, os, sys
run, registry, gaspath, nT, nL = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
r = json.load(open(run))
gas = {rc["transactionHash"]: int(rc["gasUsed"], 16) for rc in r.get("receipts", [])}
rows = []; tg = lg = 0; tn = ln = 0
for t in r.get("transactions", []):
    fn = t.get("function") or ""
    h = t.get("hash")
    if h not in gas: continue
    args = t.get("arguments") or []
    name = args[0] if args else "?"
    blob = args[3] if fn.startswith("registerTarget") and len(args) > 3 else (args[2] if fn.startswith("registerLigand") and len(args) > 2 else "")
    size = max(0, (len(blob) - 2) // 2)
    if fn.startswith("registerTarget"):
        tg += gas[h]; tn += 1; rows.append("| target %s | %d | %d |" % (name, size, gas[h]))
    elif fn.startswith("registerLigand"):
        lg += gas[h]; ln += 1; rows.append("| ligand %s | %d | %d |" % (name, size, gas[h]))
print("this run: %d targets (%d gas), %d ligands (%d gas), %d gas in receipts" % (tn, tg, ln, lg, tg + lg))
if gaspath:
    out = json.load(open(gaspath)) if os.path.exists(gaspath) else {}
    out["registry"] = os.path.basename(registry)
    out["targets"] = nT; out["ligands"] = nL
    out["targetGas"] = str(int(out.get("targetGas", "0")) + tg)
    out["ligandGas"] = str(int(out.get("ligandGas", "0")) + lg)
    out["items"] = out.get("items", []) + rows
    out["totalGas"] = str(int(out.get("checkGas", "0")) + int(out.get("deployGas", "0")) + int(out.get("tablesGas", "0")) + int(out["targetGas"]) + int(out["ligandGas"]))
    json.dump(out, open(gaspath, "w"), indent=2)
    print("recorded in", gaspath)
PY
fi

if [ "$((T_NOW + L_NOW))" -ge "$TOTAL" ]; then
  bold "verifying every id and hash on chain against the registry"
  LAB="$LAB" REGISTRY="$REGISTRY" REGISTRY_ROOT="$REGISTRY_ROOT" VERIFY_ONLY=1 forge script script/Register.s.sol:Register --rpc-url "$RPC" 2>&1 | script_logs
  ok "the registry is complete on chain: $N_T targets and $N_L ligands, ids equal to the registry's"
else
  say "run ./register.sh again to continue from position $((T_NOW < N_T ? T_NOW : N_T + L_NOW))"
fi
