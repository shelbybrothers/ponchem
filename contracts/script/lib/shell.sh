# shellcheck shell=bash
# Shared helpers for the Ponchem contract scripts. Sourced by deploy.sh; never run on its own.
# Written for the bash 3.2 that ships with macOS.

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

need_tools() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed."; done
}

# rpc_result URL METHOD [PARAMS_JSON]: prints the JSON-RPC result (strings bare, objects as JSON), or nothing.
# The answer is data: callers validate it before use and never paste it into code.
rpc_result() {
  local url="$1" method="$2" params="${3:-[]}"
  # a node that does not answer gives nothing (not a pipeline failure under set -o pipefail): the caller says so
  { curl -s --max-time 15 -X POST "$url" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" 2>/dev/null || true; } |
    python3 -c 'import json, sys
try:
    r = json.load(sys.stdin).get("result")
    if r is not None:
        print(r if isinstance(r, str) else json.dumps(r))
except Exception:
    pass'
}

# Robinhood Chain was past block 67.7 million on 2026-09-20. A node whose head is lower is not the live chain.
RH_MIN_HEAD=67000000

# hex_to_dec HEX: the decimal value of a 0x quantity, or nothing when HEX is not one. The value is matched against a
# strict pattern and handed to python as an argument.
hex_to_dec() {
  [[ "${1:-}" =~ ^0x[0-9a-fA-F]{1,64}$ ]] || return 0
  python3 -c 'import sys; print(int(sys.argv[1], 16))' "$1"
}

# is_uint VALUE: true for a plain non-negative decimal integer.
is_uint() {
  [[ "${1:-}" =~ ^[0-9]{1,78}$ ]]
}

# lower VALUE: VALUE in lower case, for comparing addresses whatever their checksum casing.
lower() {
  printf '%s' "${1:-}" | tr 'A-F' 'a-f'
}

# head_block URL: the node's head block in decimal, or nothing.
head_block() {
  hex_to_dec "$(rpc_result "$1" eth_blockNumber)"
}

# is_rh_relay URL: true when URL answers like the live Robinhood Chain: chain id 0x1237, a head above RH_MIN_HEAD, and
# a client that does not call itself a development node.
is_rh_relay() {
  local url="$1" head
  [ "$(rpc_result "$url" eth_chainId)" = "0x1237" ] || return 1
  head="$(head_block "$url")"
  [ -n "$head" ] || return 1
  [ "$(python3 -c 'import sys; print(int(sys.argv[1]) > int(sys.argv[2]))' "$head" "$RH_MIN_HEAD")" = "True" ] || return 1
  if rpc_result "$url" web3_clientVersion | grep -qiE 'anvil|hardhat|ganache|tenderly'; then return 1; fi
  return 0
}

# True when RPC is an anvil node (a fork or a local chain). The forwarder relays to the real chain and says so.
is_anvil() {
  rpc_result "$RPC" web3_clientVersion | grep -qi anvil
}

# free_port: an unused TCP port on 127.0.0.1.
free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

PONCHEM_FORWARDER_PID=""
# stop_own_forwarder: stop the forwarder resolve_rpc started, if it started one. It runs on EXIT.
stop_own_forwarder() {
  if [ -n "$PONCHEM_FORWARDER_PID" ]; then
    kill "$PONCHEM_FORWARDER_PID" 2>/dev/null || true
    PONCHEM_FORWARDER_PID=""
  fi
}

# resolve_rpc ROOT: sets RPC. RPC_URL wins. Otherwise the shared forwarder on 127.0.0.1:8670 is used only when it
# answers like the live chain (is_rh_relay); anything else there is ignored, and the script starts its own
# ROOT/tools/rpc-local.mjs on a free port and stops it when the script exits. The forwarder exists because the chain's
# RPC hostname resolves to a hijacked address on this machine and forge only takes a URL: it looks the name up over
# DNS-over-HTTPS and relays. It binds to 127.0.0.1 and never sees a key, forge signs locally.
resolve_rpc() {
  local root="$1" i port log
  if [ -n "${RPC_URL:-}" ]; then
    RPC="$RPC_URL"
    return
  fi
  RPC="http://127.0.0.1:8670"
  if is_rh_relay "$RPC"; then
    say "using the Robinhood Chain relay on 127.0.0.1:8670 (chain 4663, head $(head_block "$RPC"))"
    return
  fi
  if [ -n "$(rpc_result "$RPC" eth_chainId)" ]; then
    warn "127.0.0.1:8670 answers, but not like the live Robinhood Chain (chain id, head block or client). Not using it."
  fi
  [ -f "$root/tools/rpc-local.mjs" ] || die "tools/rpc-local.mjs is missing. Start a forwarder yourself and pass its address in RPC_URL."
  port="$(free_port)"
  log="${TMPDIR:-/tmp}/ponchem-rpc-local-$port.log"
  RPC="http://127.0.0.1:$port"
  say "starting its own tools/rpc-local.mjs on 127.0.0.1:$port (log: $log)"
  PORT="$port" RPC_QUIET=1 nohup node "$root/tools/rpc-local.mjs" >"$log" 2>&1 &
  PONCHEM_FORWARDER_PID=$!
  trap stop_own_forwarder EXIT
  for i in $(seq 1 60); do
    sleep 0.5
    is_rh_relay "$RPC" && return
  done
  die "the forwarder on $RPC did not reach Robinhood Chain. See $log"
}

require_chain_4663() {
  local id
  id="$(rpc_result "$RPC" eth_chainId)"
  [ "$id" = "0x1237" ] || die "$RPC is not chain 4663 (it answered '${id:-nothing}')."
}

# resolve_signer DEFAULT_KEYSTORE_NAME: sets SIGNER (address) and SIGNER_ARGS (forge wallet flags). Keystores only:
# this script never takes a raw private key.
#   KEYSTORE_PATH=/file        a keystore file anywhere
#   KEYSTORE=name              a keystore in ~/.foundry/keystores (default: the argument)
#   PASSWORD_FILE=/file        the keystore password, so forge does not ask
resolve_signer() {
  local default_name="$1" ks
  if [ -n "${KEYSTORE_PATH:-}" ]; then
    ks="$KEYSTORE_PATH"
  else
    ks="$HOME/.foundry/keystores/${KEYSTORE:-$default_name}"
  fi
  [ -f "$ks" ] || die "no keystore at $ks"
  SIGNER_ARGS=(--keystore "$ks")
  if [ -n "${PASSWORD_FILE:-}" ]; then
    [ -f "$PASSWORD_FILE" ] || die "PASSWORD_FILE does not exist: $PASSWORD_FILE"
    SIGNER_ARGS+=(--password-file "$PASSWORD_FILE")
  fi
  SIGNER="$(cast wallet address "${SIGNER_ARGS[@]}")" || die "could not unlock the keystore at $ks"
  [[ "$SIGNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "the keystore did not give an address"
}

# script_logs: the console.log section of a forge script run, read from stdin.
script_logs() {
  awk '/== Logs ==/{on=1; next} on && /^[^ ]/{on=0} on'
}
