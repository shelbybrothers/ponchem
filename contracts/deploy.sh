#!/usr/bin/env bash
#
# deploy.sh: put PonchemCheck, PonchemLab and the scoring tables on Robinhood Chain (4663). The owner runs it in
# their own terminal:
#
#   cd "/Users/medikamedika/USELESS JOURNEY/ponchem/contracts" && ./deploy.sh        keystore pontoon-treasury
#   ./deploy.sh another-keystore                                                      a keystore in ~/.foundry/keystores
#
# In order: refuses if a contract is already recorded, starts its own RPC forwarder (tools/rpc-local.mjs, because the
# chain's RPC hostname is DNS-hijacked on this machine) and checks the node is the live chain, runs the tests, checks
# js/abi.js is current, unlocks the keystore, checks the deployer's nonce (no pending transactions) and balance against
# the estimate, prints the plan INCLUDING the gas estimate of the whole registry (lab + tables + every target + every
# ligand), and broadcasts only after you type deploy. The broadcast skips forge's own simulation (--skip-simulation) so
# every gas limit comes from the node: forge does not add Nitro's L1 data gas on this chain id and has died with
# "intrinsic gas too low" before. Then it reads the lab back with cast call (owner, treasury, feeBps, runFee, tables set,
# targetCount 0, and that the code on chain is byte for byte this build), submits the sources to Sourcify, writes
# deployments.json and the GENERATED:DEPLOY block of ../js/config.js (address, deployBlock from the receipt, genesis
# from the block timestamp). Answer anything but "deploy" and nothing is sent. Registration is the next step:
# ./register.sh.
#
# The deploy block is taken from the transaction receipt through the RPC. On Nitro, block.number inside the EVM is the
# PARENT chain's block, so a script cannot report it.
#
# Optional:
#   KEYSTORE_PATH=/path/file   use a keystore file anywhere instead of a name
#   PASSWORD_FILE=/path/file   read the keystore password from a file (otherwise forge asks)
#   RPC_URL=http://...         talk to this node (it must still pass the live chain check)
#   OWNER=0x.. TREASURY=0x..   default: script/Mainnet.sol (0xb53cB636243AAD194628B88Cfcd770fFBE0cEDd8 for both)
#   FEE_BPS=500 RUN_FEE=100000000000000 RUN_PRICE=100000000000000000000 EPOCH=604800   the other constants
#   REGISTRY=/path/registry.json   the registry to estimate (default ../data/registry.json; the plan says so when missing)
#   SKIP_VERIFY=1              do not submit source to Sourcify
#   SKIP_TESTS=1               do not run forge test first (the rehearsal has run it)
#   REDEPLOY=1                 deploy even though a contract or an unfinished broadcast is recorded
#   READBACK_ONLY=1            finish a broadcast that went through but was not read back (sends nothing)
#
# Rehearsal on a local anvil (nothing reaches Robinhood Chain):
#   LOCAL_BROADCAST=1          RPC_URL defaults to http://127.0.0.1:8690 and must be anvil on chain 4663. The deployer
#                              is the mainnet owner address itself, impersonated on anvil (--unlocked). Outputs go to
#                              out/rehearsal/ (deployments.json, a copy of js/config.js, the broadcast record); the
#                              project's own files are never written.
#                              Pipe the confirmation in:  echo deploy | LOCAL_BROADCAST=1 ./deploy.sh
#   LOCAL_RESET=1              with LOCAL_BROADCAST=1: forget earlier rehearsals (a new anvil does not have their contract)
#
set -euo pipefail
# No brace expansion anywhere in this script: it builds JSON-RPC params by hand, and a JSON object is a comma inside
# braces, which the bash 3.2 of macOS would expand into two words.
set +B

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=script/lib/shell.sh
. "$HERE/script/lib/shell.sh"

cd "$HERE"
need_tools forge cast python3 curl node

REAL_CONFIG_JS="$ROOT/js/config.js"
REAL_DEPLOYMENTS_JSON="$HERE/deployments.json"
if [ -n "${LOCAL_BROADCAST:-}" ]; then
  REH="$HERE/out/rehearsal"
  mkdir -p "$REH"
  CONFIG_JS="${CONFIG_JS:-$REH/config.js}"
  DEPLOYMENTS_JSON="${DEPLOYMENTS_JSON:-$REH/deployments.json}"
  export FOUNDRY_BROADCAST="${FOUNDRY_BROADCAST:-$REH/broadcast}"
  for f in CONFIG_JS DEPLOYMENTS_JSON; do
    real="REAL_$f"
    if [ "$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]) == os.path.realpath(sys.argv[2]))' "${!f}" "${!real}")" = "True" ]; then
      die "LOCAL_BROADCAST=1 never writes the project's own $f. Leave it unset (out/rehearsal/ is used)."
    fi
  done
  if [ -n "${LOCAL_RESET:-}" ]; then rm -f "$CONFIG_JS" "$DEPLOYMENTS_JSON" "${DEPLOYMENTS_JSON%.json}.pending.json" "$REH/gas.json"; rm -rf "$FOUNDRY_BROADCAST"; fi
  [ -f "$CONFIG_JS" ] || cp "$REAL_CONFIG_JS" "$CONFIG_JS"
else
  CONFIG_JS="${CONFIG_JS:-$REAL_CONFIG_JS}"
  DEPLOYMENTS_JSON="${DEPLOYMENTS_JSON:-$REAL_DEPLOYMENTS_JSON}"
fi
BROADCAST_DIR="${FOUNDRY_BROADCAST:-$HERE/broadcast}"
PENDING_JSON="${DEPLOYMENTS_JSON%.json}.pending.json"
RUN="$BROADCAST_DIR/Deploy.s.sol/4663/run-latest.json"
REGISTRY="${REGISTRY:-$ROOT/data/registry.json}"

# ------------------------------------------------------------ already deployed?
LIVE="$(python3 - "$DEPLOYMENTS_JSON" "$CONFIG_JS" <<'PY'
import json, os, re, sys
dep, cfg = sys.argv[1], sys.argv[2]
found = ""
if os.path.exists(cfg):
    block = re.search(r"GENERATED:DEPLOY:BEGIN(.*?)GENERATED:DEPLOY:END", open(cfg).read(), re.S)
    if block:
        m = re.search(r"(?<![A-Za-z])address:\s*['\"](0x[0-9a-fA-F]{40})['\"]", block.group(1))
        found = m.group(1) if m else ""
if not found and os.path.exists(dep):
    try:
        found = json.load(open(dep)).get("address") or ""
    except Exception:
        pass
print(found)
PY
)"
if [ -z "${READBACK_ONLY:-}" ] && [ -z "${REDEPLOY:-}" ]; then
  if [ -n "$LIVE" ]; then
    bold "PonchemLab already looks deployed: $LIVE"
    say "js/config.js or deployments.json points at it. Register with ./register.sh. To deploy a new one anyway: REDEPLOY=1 ./deploy.sh"
    exit 0
  fi
  if [ -f "$PENDING_JSON" ] || [ -f "$RUN" ]; then
    bold "an earlier broadcast started and was never read back"
    [ -f "$PENDING_JSON" ] && say "  marker    $PENDING_JSON"
    [ -f "$RUN" ] && say "  broadcast $RUN"
    say "Check the deployer's transactions on https://robinhoodchain.blockscout.com first. Then either:"
    say "  finish it:     READBACK_ONLY=1 ./deploy.sh   (reads the recorded broadcast back, sends nothing)"
    say "  start over:    REDEPLOY=1 ./deploy.sh        (a second contract; the first stays on chain)"
    exit 1
  fi
fi

# ---------------------------------------------------------------------- node
if [ -n "${LOCAL_BROADCAST:-}" ]; then
  RPC="${RPC_URL:-http://127.0.0.1:8690}"
  require_chain_4663
  is_anvil || die "LOCAL_BROADCAST=1 only rehearses on an anvil node; $RPC is not one. Nothing was sent."
  is_rh_relay "$RPC" && die "LOCAL_BROADCAST=1 refuses a node that answers like the live chain. Nothing was sent."
  warn "rehearsal on the local anvil $RPC: outputs go to $HERE/out/rehearsal, nothing reaches Robinhood Chain"
else
  resolve_rpc "$ROOT"
  require_chain_4663
  is_rh_relay "$RPC" || die "$RPC is not the live Robinhood Chain (anvil, a fork, or a node behind block $RH_MIN_HEAD). For a rehearsal use LOCAL_BROADCAST=1."
fi
HEAD="$(head_block "$RPC")"
[ -n "$HEAD" ] || die "$RPC did not answer eth_blockNumber with a block number"
say "chain 4663 through $RPC, head block $HEAD"
say ""

# ------------------------------------------------------------ what is planned
MAINNET_OWNER="$(sed -n 's/.*constant OWNER = \(0x[0-9a-fA-F]\{40\}\);.*/\1/p' script/Mainnet.sol)"
MAINNET_TREASURY="$(sed -n 's/.*constant TREASURY = \(0x[0-9a-fA-F]\{40\}\);.*/\1/p' script/Mainnet.sol)"
MAINNET_FEE="$(sed -n 's/.*constant FEE_BPS = \([0-9]\{1,4\}\);.*/\1/p' script/Mainnet.sol)"
OWNER="${OWNER:-$MAINNET_OWNER}"
TREASURY="${TREASURY:-$MAINNET_TREASURY}"
FEE_BPS="${FEE_BPS:-$MAINNET_FEE}"
RUN_FEE="${RUN_FEE:-100000000000000}"
RUN_PRICE="${RUN_PRICE:-100000000000000000000}"
EPOCH="${EPOCH:-604800}"
for v in OWNER TREASURY; do
  [[ "${!v}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$v is not an address: ${!v:-empty} (check script/Mainnet.sol)"
  [ "$(lower "${!v}")" != "0x0000000000000000000000000000000000000000" ] || die "$v is the zero address"
done
[[ "$FEE_BPS" =~ ^[0-9]{1,4}$ ]] && [ "$FEE_BPS" -le 1000 ] || die "FEE_BPS must be 0 to 1000, not '$FEE_BPS'"
is_uint "$RUN_FEE" || die "RUN_FEE must be a wei amount"
is_uint "$RUN_PRICE" || die "RUN_PRICE must be an integer amount"
is_uint "$EPOCH" && [ "$EPOCH" -ge 3600 ] && [ "$EPOCH" -le 31536000 ] || die "EPOCH must be 3600 to 31536000 seconds"
export OWNER TREASURY FEE_BPS RUN_FEE RUN_PRICE EPOCH

# tx_field RUN NAME FIELD: a field of the recorded CREATE transaction of contract NAME
tx_field() {
  python3 -c 'import json, sys; run = json.load(open(sys.argv[1])); print(next((t.get(sys.argv[3]) or "" for t in run.get("transactions", []) if t.get("contractName") == sys.argv[2] and t.get("transactionType") == "CREATE"), ""))' "$1" "$2" "$3"
}

readback() {
  say ""
  bold "reading the contracts back"
  local record_addr status rb
  TXH="$(tx_field "$RUN" PonchemLab hash)"
  record_addr="$(tx_field "$RUN" PonchemLab contractAddress)"
  CHECK_ADDR="$(tx_field "$RUN" PonchemCheck contractAddress)"
  [[ "$TXH" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "no PonchemLab creation transaction in $RUN"
  [[ "$CHECK_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "no PonchemCheck creation transaction in $RUN"

  # The receipt, through the RPC, is the authority for the address AND the block.
  local receipt=""
  for _ in $(seq 1 30); do
    receipt="$(rpc_result "$RPC" eth_getTransactionReceipt "[\"$TXH\"]")"
    [ -n "$receipt" ] && [ "$receipt" != "null" ] && break
    sleep 2
  done
  [ -n "$receipt" ] && [ "$receipt" != "null" ] || die "the node has no receipt for $TXH yet. Later: READBACK_ONLY=1 ./deploy.sh"
  status="$(printf '%s' "$receipt" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("status") or "")')"
  [ "$status" = "0x1" ] || die "the creation transaction $TXH did not succeed (status '$status')"
  LAB="$(printf '%s' "$receipt" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("contractAddress") or "")')"
  [[ "$LAB" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "the receipt of $TXH carries no contract address"
  [ "$(lower "$LAB")" = "$(lower "$record_addr")" ] || die "the receipt says $LAB but forge recorded $record_addr"
  LAB="$(cast to-check-sum-address "$LAB")"
  CHECK_ADDR="$(cast to-check-sum-address "$CHECK_ADDR")"
  BLOCK_HEX="$(printf '%s' "$receipt" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("blockNumber") or "")')"
  BLOCK="$(hex_to_dec "$BLOCK_HEX")"
  is_uint "$BLOCK" && [ "$BLOCK" -gt 0 ] || die "the receipt of $TXH carries no block number"
  DEPLOYER_RB="$(printf '%s' "$receipt" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("from") or "")')"
  [[ "$DEPLOYER_RB" =~ ^0x[0-9a-fA-F]{40}$ ]] && DEPLOYER_RB="$(cast to-check-sum-address "$DEPLOYER_RB")"
  GAS_USED="$(hex_to_dec "$(printf '%s' "$receipt" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("gasUsed") or "")')")"

  OWNER_RB="$(cast call "$LAB" 'owner()(address)' --rpc-url "$RPC")"
  TREASURY_RB="$(cast call "$LAB" 'treasury()(address)' --rpc-url "$RPC")"
  FEE_RB="$(cast call "$LAB" 'feeBps()(uint16)' --rpc-url "$RPC" | cut -d' ' -f1)"
  RUNFEE_RB="$(cast call "$LAB" 'runFee()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)"
  RUNPRICE_RB="$(cast call "$LAB" 'runPrice()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)"
  EPOCH_RB="$(cast call "$LAB" 'epochLength()(uint64)' --rpc-url "$RPC" | cut -d' ' -f1)"
  GENESIS_RB="$(cast call "$LAB" 'genesis()(uint64)' --rpc-url "$RPC" | cut -d' ' -f1)"
  TABLES_RB="$(cast call "$LAB" 'tables()(address)' --rpc-url "$RPC")"
  CHECK_RB="$(cast call "$LAB" 'check()(address)' --rpc-url "$RPC")"
  COUNT_RB="$(cast call "$LAB" 'targetCount()(uint16)' --rpc-url "$RPC" | cut -d' ' -f1)"
  PENDING_OWNER_RB="$(cast call "$LAB" 'pendingOwner()(address)' --rpc-url "$RPC")"
  say "  PonchemLab     $LAB"
  say "  PonchemCheck   $CHECK_ADDR"
  say "  tables         $TABLES_RB"
  say "  deploy block   $BLOCK  (from the receipt, $GAS_USED gas)"
  say "  transaction    $TXH"
  say "  owner          $OWNER_RB"
  say "  treasury       $TREASURY_RB"
  say "  feeBps         $FEE_RB"
  say "  runFee         $RUNFEE_RB wei"
  say "  runPrice       $RUNPRICE_RB"
  say "  epochLength    $EPOCH_RB s"
  say "  genesis        $GENESIS_RB"
  say "  targetCount    $COUNT_RB"
  [ "$(lower "$OWNER_RB")" = "$(lower "$OWNER")" ] || die "owner() read back as $OWNER_RB, the plan said $OWNER"
  [ "$(lower "$TREASURY_RB")" = "$(lower "$TREASURY")" ] || die "treasury() read back as $TREASURY_RB, the plan said $TREASURY"
  [ "$FEE_RB" = "$FEE_BPS" ] || die "feeBps() read back as $FEE_RB, the plan said $FEE_BPS"
  [ "$RUNFEE_RB" = "$RUN_FEE" ] || die "runFee() read back as $RUNFEE_RB, the plan said $RUN_FEE"
  [ "$EPOCH_RB" = "$EPOCH" ] || die "epochLength() read back as $EPOCH_RB, the plan said $EPOCH"
  [ "$(lower "$CHECK_RB")" = "$(lower "$CHECK_ADDR")" ] || die "check() read back as $CHECK_RB, the record says $CHECK_ADDR"
  [ "$(lower "$TABLES_RB")" != "0x0000000000000000000000000000000000000000" ] || die "tables() is zero: setTables did not land"
  [ "$COUNT_RB" = "0" ] || die "targetCount() is $COUNT_RB on a contract that was just created"
  [ "$(lower "$PENDING_OWNER_RB")" = "0x0000000000000000000000000000000000000000" ] || die "pendingOwner() is set on a fresh contract"
  is_uint "$GENESIS_RB" && [ "$GENESIS_RB" -gt 1700000000 ] || die "genesis() read back as '$GENESIS_RB'"

  # The executable runtime (before the compiler's metadata) must match this build byte for byte. The lab has
  # immutables (check, genesis, epochLength), so those slots are masked out of the comparison.
  rb="$(python3 - "$HERE/out/PonchemLab.sol/PonchemLab.json" "$(cast code "$LAB" --rpc-url "$RPC")" <<'PY'
import json, sys
art = json.load(open(sys.argv[1]))
local = bytearray.fromhex(art["deployedBytecode"]["object"][2:])
chain = bytearray.fromhex(sys.argv[2][2:] if sys.argv[2].startswith("0x") else sys.argv[2])
for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
    for r in refs:
        for b in range(r["start"], r["start"] + r["length"]):
            if b < len(local): local[b] = 0
            if b < len(chain): chain[b] = 0
def split(raw):
    if len(raw) < 2: return raw, b""
    n = int.from_bytes(raw[-2:], "big") + 2
    return (raw[:-n], raw[-n:]) if n <= len(raw) else (raw, b"")
lc, lm = split(bytes(local)); cc, cm = split(bytes(chain))
if not cc or cc != lc: print("different")
else: print("same %d %s" % (len(cc) + len(cm), "meta-same" if cm == lm else "meta-differs"))
PY
)"
  [[ "$rb" == same* ]] || die "the executable code at $LAB is not this build's. Do not point the site at it. Facts so far: address $LAB, block $BLOCK, transaction $TXH"
  ok "  runtime        $(printf '%s' "$rb" | cut -d' ' -f2) bytes, executable code identical to this build ($(printf '%s' "$rb" | cut -d' ' -f3))"

  python3 - "$DEPLOYMENTS_JSON" "$LAB" "$CHECK_ADDR" "$TABLES_RB" "$BLOCK" "$GENESIS_RB" "$TXH" "$DEPLOYER_RB" "$OWNER_RB" "$TREASURY_RB" "$FEE_RB" "$RUNFEE_RB" "$RUNPRICE_RB" "$EPOCH_RB" "${LOCAL_BROADCAST:+anvil $RPC}" <<'PY'
import datetime, json, sys
(path, address, check, tables, block, genesis, txh, deployer, owner, treasury, fee, runfee, runprice, epoch, where) = sys.argv[1:16]
out = {
    "chainId": 4663,
    "contract": "PonchemLab",
    "address": address,
    "check": check,
    "tables": tables,
    "deployBlock": int(block),
    "genesis": int(genesis),
    "tx": txh,
    "deployer": deployer,
    "owner": owner,
    "treasury": treasury,
    "feeBps": int(fee),
    "runFee": runfee,
    "runPrice": runprice,
    "epochLength": int(epoch),
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
if where:
    out["rehearsal"] = where
json.dump(out, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("  wrote", path)
PY
  python3 - "$CONFIG_JS" "$LAB" "$BLOCK" "$GENESIS_RB" <<'PY'
import re, sys
path, address, block, genesis = sys.argv[1:5]
assert re.fullmatch(r"0x[0-9a-fA-F]{40}", address)
src = open(path).read()
m = re.search(r"// GENERATED:DEPLOY:BEGIN[^\n]*\n[\s\S]*?// GENERATED:DEPLOY:END", src)
if not m:
    sys.exit("GENERATED:DEPLOY markers not found in " + path)
new = ("// GENERATED:DEPLOY:BEGIN (contracts/deploy.sh rewrites this block)\n"
       "export const LAB = Object.freeze({\n"
       f"  address: '{address}',\n"
       f"  deployBlock: {int(block)},\n"
       f"  genesis: {int(genesis)},\n"
       "});\n"
       "// GENERATED:DEPLOY:END")
open(path, "w").write(src[: m.start()] + new + src[m.end():])
print("  wrote the DEPLOY block in", path)
PY
  node --input-type=module -e "
    const m = await import('file://' + process.argv[1]);
    const ok = m.LAB && m.LAB.address === process.argv[2] && m.LAB.deployBlock === Number(process.argv[3])
      && m.LAB.genesis === Number(process.argv[4]) && m.CHAIN && m.CHAIN.id === 4663 && m.labLive();
    if (!ok) process.exit(1);
    console.log('  config imports cleanly: LAB.address', m.LAB.address, 'deployBlock', m.LAB.deployBlock, 'genesis', m.LAB.genesis);
  " "$CONFIG_JS" "$LAB" "$BLOCK" "$GENESIS_RB" || die "$CONFIG_JS did not import with the new DEPLOY block"
  rm -f "$PENDING_JSON"

  if [ -n "${LOCAL_BROADCAST:-}" ]; then
    python3 - "$REH/gas.json" "$RUN" "$GAS_USED" <<'PY'
import json, os, sys
path, run, labgas = sys.argv[1:4]
r = json.load(open(run))
gas = {t["hash"]: int(rc["gasUsed"], 16) for t in r["transactions"] for rc in r["receipts"] if rc["transactionHash"] == t["hash"]}
check = next((gas[t["hash"]] for t in r["transactions"] if t.get("contractName") == "PonchemCheck" and t["transactionType"] == "CREATE"), 0)
tables = next((gas[t["hash"]] for t in r["transactions"] if (t.get("function") or "").startswith("setTables")), 0)
out = json.load(open(path)) if os.path.exists(path) else {}
out.update({"checkGas": str(check), "deployGas": labgas, "tablesGas": str(tables)})
json.dump(out, open(path, "w"), indent=2)
print("  recorded deploy gas in", path)
PY
    warn "rehearsal: Sourcify cannot see a local anvil, so no source was submitted. The real run verifies."
  elif [ -z "${SKIP_VERIFY:-}" ]; then
    say ""
    bold "submitting sources to Sourcify"
    local vlog="${TMPDIR:-/tmp}/ponchem-verify.log"
    local args
    args="$(cast abi-encode 'constructor(address,address,address,uint16,uint256,uint256,uint64)' "$CHECK_ADDR" "$OWNER" "$TREASURY" "$FEE_BPS" "$RUN_FEE" "$RUN_PRICE" "$EPOCH")"
    if forge verify-contract "$CHECK_ADDR" src/PonchemCheck.sol:PonchemCheck --chain 4663 --verifier sourcify >"$vlog" 2>&1; then
      ok "  verified  PonchemCheck  $CHECK_ADDR"
    else
      warn "  not yet   PonchemCheck  $CHECK_ADDR  (details in $vlog)"
    fi
    if forge verify-contract "$LAB" src/PonchemLab.sol:PonchemLab --chain 4663 --verifier sourcify --constructor-args "$args" >>"$vlog" 2>&1; then
      ok "  verified  PonchemLab    $LAB"
    else
      warn "  not yet   PonchemLab    $LAB  (details in $vlog)"
      warn "  retry:    forge verify-contract $LAB src/PonchemLab.sol:PonchemLab --chain 4663 --verifier sourcify --constructor-args $args"
    fi
  else
    warn "SKIP_VERIFY is set: no source was submitted"
  fi
}

# fresh_build: recompile under the settings of this moment. NEVER `forge build --force` here: it empties out/, and
# out/rehearsal/ lives there. Removing just these artifacts makes forge rebuild them.
fresh_build() {
  bold "rebuilding the contracts and the deploy script"
  rm -rf "$HERE/out/PonchemLab.sol" "$HERE/out/PonchemCheck.sol" "$HERE/out/Deploy.s.sol"
  forge build >/dev/null 2>&1 || { forge build || true; die "the build failed. Nothing was sent."; }
  [ -f "$HERE/out/PonchemLab.sol/PonchemLab.json" ] && [ -f "$HERE/out/Deploy.s.sol/Deploy.json" ] ||
    die "the build did not produce the PonchemLab and Deploy artifacts. Nothing was sent."
  ok "  built"
}

# artifacts_aligned: true when the creation code the Deploy script would send carries the same compiler metadata
# hash as the standalone PonchemLab artifact, that is, when both come from one build.
artifacts_aligned() {
  python3 - "$HERE/out/PonchemLab.sol/PonchemLab.json" "$HERE/out/Deploy.s.sol/Deploy.json" <<'PY'
import json, re, sys
pat = r"a2646970667358221220([0-9a-f]{64})64736f6c6343"
own = re.findall(pat, json.load(open(sys.argv[1]))["bytecode"]["object"].lower())
inside = re.findall(pat, json.load(open(sys.argv[2]))["bytecode"]["object"].lower())
sys.exit(0 if own and own[-1] in inside else 1)
PY
}

if [ -n "${READBACK_ONLY:-}" ]; then
  [ -f "$RUN" ] || die "READBACK_ONLY=1 needs a broadcast record at $RUN"
  fresh_build
  readback
  bold "read back and recorded. PonchemLab $LAB"
  exit 0
fi

# --------------------------------------------------------------------- tests
fresh_build
if [ -z "${SKIP_TESTS:-}" ]; then
  bold "running the contract tests before anything is signed"
  if ! forge test >/dev/null 2>&1; then
    forge test || true
    die "tests failed. Nothing was sent."
  fi
  ok "  all tests pass"
else
  warn "  SKIP_TESTS is set: the tests were not run here"
fi
(cd "$ROOT" && node tools/abi.mjs --check >/dev/null) || die "js/abi.js is stale: run  cd \"$ROOT\" && node tools/abi.mjs  first. Nothing was sent."
ok "  js/abi.js matches this build"
say ""

# ----------------------------------------------------------------------- key
if [ -n "${LOCAL_BROADCAST:-}" ] && [ -z "${KEYSTORE_PATH:-}" ]; then
  SIGNER="$OWNER"
  SIGNER_ARGS=(--unlocked)
  cast rpc anvil_impersonateAccount "$SIGNER" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$SIGNER" 0x21E19E0C9BAB2400000 --rpc-url "$RPC" >/dev/null
else
  resolve_signer "${1:-pontoon-treasury}"
fi
DEPLOYER="$SIGNER"
[ "$(lower "$DEPLOYER")" = "$(lower "$OWNER")" ] || die "the deployer $DEPLOYER is not the owner $OWNER: setTables and every registration are owner-only, so the owner's keystore must deploy. Nothing was sent."

# --------------------------------------------------------------------- nonce
NONCE="$(cast nonce "$DEPLOYER" --rpc-url "$RPC")"
PENDING_NONCE="$(hex_to_dec "$(rpc_result "$RPC" eth_getTransactionCount "[\"$DEPLOYER\",\"pending\"]")")"
is_uint "$NONCE" || die "the node answered the nonce with something that is not a number"
[ -z "$PENDING_NONCE" ] || [ "$PENDING_NONCE" = "$NONCE" ] ||
  die "the deployer has pending transactions (nonce $NONCE, pending $PENDING_NONCE). Let them land first. Nothing was sent."

# ---------------------------------------------------------------------- plan
bold "the plan"
say "  deployer    $DEPLOYER  (nonce $NONCE)"
say "  owner       $OWNER"
say "  treasury    $TREASURY"
say "  fee         $FEE_BPS bps of each settled prize pool (cap 1000)"
say "  run fee     $RUN_FEE wei ($(cast to-unit "$RUN_FEE" ether) ETH) per docking test paid in ETH, to the treasury"
say "  run price   $RUN_PRICE (smallest unit) per docking test paid in the lab token, to the treasury"
say "  epoch       $EPOCH s"
say "  contracts   PonchemCheck, then PonchemLab, then setTables (three transactions); no proxy, no upgrade path"
say ""

# ------------------------------------------------------------------ simulate
bold "simulating against the chain (nothing is sent)"
SIM="$(forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --sender "$DEPLOYER" 2>&1)" || {
  printf '%s\n' "$SIM" | tail -40
  die "the simulation failed. Nothing was sent."
}
printf '%s\n' "$SIM" | script_logs
printf '%s\n' "$SIM" | grep -E 'Estimated (gas price|total gas used|amount required)' || true
say ""

FORGE_GAS="$(printf '%s\n' "$SIM" | sed -n 's/.*Estimated total gas used for script: *\([0-9][0-9]*\).*/\1/p' | tail -1)"
FORGE_ETH="$(printf '%s\n' "$SIM" | sed -n 's/.*Estimated amount required: *\([0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\) *ETH.*/\1/p' | tail -1)"
FORGE_WEI=0
if [ -n "$FORGE_ETH" ]; then FORGE_WEI="$(cast to-wei "$FORGE_ETH" ether)"; fi
is_uint "$FORGE_WEI" || FORGE_WEI=0
RAW_NODE_PRICE="$(rpc_result "$RPC" eth_gasPrice)"
NODE_PRICE="$(hex_to_dec "$RAW_NODE_PRICE")"
is_uint "$NODE_PRICE" || NODE_PRICE=0

# The registry estimate, from the data sizes (the rule of thumb of gas.md, measured on the rehearsal):
#   per blob of B bytes: 21,000 base + 32,000 CREATE + 200 x (B + 1) code deposit + 16 x calldata bytes
#   + the structural check (about 200 per pocket atom, 150 per topology entry) + about 140,000 storage and event.
bold "the registry"
EST="$(python3 - "$REGISTRY" "$ROOT" <<'PY'
import json, os, sys
path, root = sys.argv[1], sys.argv[2]
if not os.path.exists(path):
    print("MISSING")
    sys.exit(0)
reg = json.load(open(path))
def size(p):
    full = p if os.path.isabs(p) else os.path.join(root, p)
    return os.path.getsize(full) if os.path.exists(full) else None
tg = lg = 0; tb = lb = 0; missing = 0
for t in reg.get("targets", []):
    b = size(t.get("pocket", ""))
    if b is None: missing += 1; continue
    n = t.get("atoms") or max(0, (b - 28) // 7)
    tg += 21000 + 32000 + 200 * (28 + 9 * n + (b - 28 - 7 * n) + 1) + 16 * b + 220 * n + 140000
    tb += b
for l in reg.get("ligands", []):
    b = size(l.get("topology", ""))
    if b is None: missing += 1; continue
    lg += 21000 + 32000 + 200 * (b + 1) + 16 * b + 150 * (b // 4) + 140000
    lb += b
print(len(reg.get("targets", [])), len(reg.get("ligands", [])), tg, lg, tb, lb, missing)
PY
)"
if [ "$EST" = "MISSING" ]; then
  warn "  $REGISTRY is not there yet (the pipeline writes it): the registry cannot be estimated. register.sh estimates it again before sending."
  REG_GAS=0
else
  set -- $EST
  say "  targets     $1 pockets, $5 bytes, about $3 gas"
  say "  ligands     $2 topologies, $6 bytes, about $4 gas"
  [ "$7" = "0" ] || warn "  $7 registry entries point at files that do not exist yet"
  REG_GAS=$(( $3 + $4 ))
  set --
fi
DEPLOY_GAS="${FORGE_GAS:-0}"
is_uint "$DEPLOY_GAS" || DEPLOY_GAS=0
TOTAL_GAS=$(( DEPLOY_GAS + REG_GAS ))
say "  lab+tables  about $DEPLOY_GAS gas (forge's simulation of the three transactions)"
say "  TOTAL       about $TOTAL_GAS gas for the lab, the tables and every registration"
if [ "$NODE_PRICE" != "0" ]; then
  say "              at the node's gas price $(cast to-unit "$NODE_PRICE" gwei) gwei that is about $(cast to-unit "$(python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]))' "$TOTAL_GAS" "$NODE_PRICE")" ether) ETH"
fi
say ""

NEED="$(python3 -c 'import sys; print(max(int(sys.argv[1]), int(sys.argv[2]) * int(sys.argv[3])))' "$FORGE_WEI" "$DEPLOY_GAS" "$NODE_PRICE")"
[ "$NEED" != "0" ] || die "neither forge nor the node gave a cost estimate, so the balance cannot be checked. Nothing was sent."
BAL="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
is_uint "$BAL" || die "the node answered the balance with something that is not a number"
say "balance     $(cast to-unit "$BAL" ether) ETH"
if [ "$(python3 -c 'import sys; print(1 if int(sys.argv[1]) < int(sys.argv[2]) * 2 else 0)' "$BAL" "$NEED")" = "1" ]; then
  die "the deployer should hold at least twice the deploy estimate ($(cast to-unit "$NEED" ether) ETH). Top it up or pick another keystore. Nothing was sent."
fi
ok "            the balance covers twice the deploy estimate"
if [ "$NODE_PRICE" != "0" ] && [ "$REG_GAS" != "0" ]; then
  REG_WEI="$(python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]))' "$TOTAL_GAS" "$NODE_PRICE")"
  if [ "$(python3 -c 'import sys; print(1 if int(sys.argv[1]) < int(sys.argv[2]) else 0)' "$BAL" "$REG_WEI")" = "1" ]; then
    warn "            but not the whole registry (about $(cast to-unit "$REG_WEI" ether) ETH): top up before ./register.sh"
  else
    ok "            and the whole registry at today's gas price"
  fi
fi
say ""

artifacts_aligned || die "the Deploy script and the PonchemLab artifact come from different builds. Run ./deploy.sh again; if it persists, forge clean (it also removes out/rehearsal). Nothing was sent."
ok "the deploy script carries exactly the contract that was built and tested"
say ""

# ----------------------------------------------------------------- broadcast
if [ -n "${LOCAL_BROADCAST:-}" ]; then
  bold "that was a simulation. This is a REHEARSAL: the broadcast goes to the local anvil only."
else
  bold "that was a simulation. Broadcasting to Robinhood Chain is irreversible."
  [ "${SIGNER_ARGS[0]}" = "--keystore" ] && [ -z "${PASSWORD_FILE:-}" ] && say "forge will ask for the keystore password once more, to sign."
fi
CONFIRM=""
read -r -p "type 'deploy' to send it: " CONFIRM || true
[ "$CONFIRM" = "deploy" ] || { say ""; say "nothing was sent."; exit 0; }
say ""

python3 - "$PENDING_JSON" "$DEPLOYER" "$RPC" "$RUN" "$NONCE" <<'PY'
import datetime, json, sys
path, deployer, rpc, run, nonce = sys.argv[1:6]
json.dump({
    "status": "broadcast started, not read back",
    "deployer": deployer,
    "nonceBefore": int(nonce),
    "rpc": rpc,
    "broadcastRecord": run,
    "startedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}, open(path, "w"), indent=2)
PY

forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" "${SIGNER_ARGS[@]}" --sender "$DEPLOYER" \
  --broadcast --skip-simulation --slow || {
  warn "the broadcast stopped part way. Read the output above; $PENDING_JSON marks the unfinished run."
  warn "check the deployer's nonce first: cast nonce $DEPLOYER --rpc-url $RPC"
  warn "if it moved from $NONCE, record the result:  READBACK_ONLY=1 ./deploy.sh"
  exit 1
}

NONCE_AFTER="$(cast nonce "$DEPLOYER" --rpc-url "$RPC")"
if [ "$NONCE_AFTER" = "$((NONCE + 3))" ]; then
  ok "deployer nonce $NONCE -> $NONCE_AFTER: exactly three transactions"
else
  warn "deployer nonce $NONCE -> $NONCE_AFTER: expected exactly three transactions; check the explorer"
fi

[ -f "$RUN" ] || die "no broadcast record at $RUN; read the address from the output above"
readback

say ""
if [ -n "${LOCAL_BROADCAST:-}" ]; then
  bold "REHEARSAL passed on $RPC. PonchemLab $LAB (anvil only). Robinhood Chain was not touched."
  say "  outputs: $DEPLOYMENTS_JSON"
  say "           $CONFIG_JS"
  say "  next:    echo register | LOCAL_BROADCAST=1 ./register.sh"
  exit 0
fi
bold "PonchemLab is live: $LAB (block $BLOCK, genesis $GENESIS_RB)"
say ""
say "next:"
say "  1. register every target and ligand (resumable, sliced with LIMIT):"
say "     cd \"/Users/medikamedika/USELESS JOURNEY/ponchem/contracts\" && ./register.sh"
say "  2. js/config.js and contracts/deployments.json changed: commit them and ship the site."
