/*
 * js/rpc.js: JSON-RPC transport, Multicall3 and a small ABI codec for the Ponchem chain layer.
 * Browser ES module with no DOM access at import time; Node imports it too (global fetch, node >= 22).
 *
 * SHIPPED API
 *
 *   rpc(method, params = [], { signal, timeoutMs, retries } = {}) -> result
 *       One JSON-RPC call through the read-only proxy /api/rpc (or the ?rpc= override on localhost).
 *       Retries HTTP 429/5xx, network failures and rate-limit errors quietly (4 tries, backoff).
 *       Never retries a revert. Throws RpcError { message, code, data (revert data hex), method, transient }.
 *   rpcBatch([{ method, params }], { signal }) -> [{ ok: true, result } | { ok: false, error: RpcError }]
 *       Any number of calls, at most 5 per HTTP request (the node's batch cap), two requests in flight.
 *   multicall(calls, { allowFailure = true, blockTag = 'latest', chunk = 700, signal } = {})
 *       Multicall3.aggregate3 in as few eth_calls as possible (chunks of `chunk` calls, <= 5 per HTTP request).
 *       calls: [{ target, fn: 'function balanceOf(address) view returns (uint256)', args: [..] }]
 *            | [{ target, data: '0x..' }]                                  (raw: value is the return hex)
 *       -> [{ ok: true, value, data } | { ok: false, error, data }] in call order. A single-output function
 *          gives its value directly; several outputs give an array. Empty return data counts as a failure.
 *          allowFailure: false throws when any call fails.
 *   ethCall({ to, data, from? }, { blockTag, stateOverride, signal }) -> hex   eth_call with an optional state
 *       override object passed as the third param (simulations against a contract that is not deployed yet can use this).
 *
 *   ABI helpers (no ethers needed):
 *   keccak256(bytes | '0x..' | utf8 string) -> '0x..'       selector(sigOrFragment) -> '0x12345678'
 *   parseFragment('function arb(address[] pools, ...) returns (...)') -> { type, name, inputs, outputs, signature, selector }
 *   fragment(abiList, name) -> the parsed fragment named `name` from a human-readable ABI list (cached)
 *   encodeCall(fragment | 'function ...', args) -> calldata hex
 *   decodeResult(fragment | 'function ...', hex) -> value (single output) or array
 *   encodeAbi(types, values) -> hex (no selector)            decodeAbi(types, hex) -> values
 *   getAddress(addr) -> EIP-55 checksum address (throws on a malformed one)      isAddress(a) -> bool
 *   toHex(bigint|number) -> '0x..' quantity                   hexToBytes / bytesToHex
 *
 *   Endpoint and localhost overrides:
 *   overrides(href = location.href) -> { local, rpc, contract }   rpc/contract are null unless the page runs on
 *       localhost/127.0.0.1 AND ?rpc= points at a loopback http(s) URL / ?contract= is a 0x address.
 *   endpoint() -> the URL reads go to now.   siteUrl('/data/targets.json') -> absolute URL on this site.
 *   configure({ base, rpc, href, timeoutMs }) -> for Node tools: base = 'http://127.0.0.1:6130' (site origin used
 *       for /api/rpc and /data), rpc = a direct JSON-RPC URL (skips the proxy), href = a pretend page URL whose
 *       ?rpc=/?contract= are then judged by the same localhost rule, timeoutMs = per-request timeout (default 15 s;
 *       a cold anvil fork can take a while on the first read). configure({}) resets.
 */
import { CHAIN, MULTICALL3 } from './config.js';

// ---------------------------------------------------------------------------------------------------------
// hex and bytes

const HEX = /^0x[0-9a-fA-F]*$/;
const enc = new TextEncoder();

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error('not a hex string');
  let h = hex.slice(2);
  if (h.length % 2) h = '0' + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function toHex(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error('negative quantity');
  return '0x' + n.toString(16);
}

// ---------------------------------------------------------------------------------------------------------
// keccak256 (Keccak-f[1600] on BigInt lanes; used for selectors, event topics and checksums only)

const MASK64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64);

function keccakF(s) {
  const C = new Array(5);
  const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK64 & B[((x + 2) % 5) + y]);
    }
    s[0] ^= RC[round];
  }
}

export function keccak256(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (typeof input === 'string' && HEX.test(input) && input.length % 2 === 0 && input.length > 2) bytes = hexToBytes(input);
  else bytes = enc.encode(String(input));
  const rate = 136;
  const padLen = rate - (bytes.length % rate);
  const msg = new Uint8Array(bytes.length + padLen);
  msg.set(bytes);
  msg[bytes.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return bytesToHex(out);
}

// ---------------------------------------------------------------------------------------------------------
// addresses

export function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

const checksumCache = new Map();
export function getAddress(a) {
  if (!isAddress(a)) throw new Error('not an address');
  const lower = a.slice(2).toLowerCase();
  const hit = checksumCache.get(lower);
  if (hit) return hit;
  const hash = keccak256(enc.encode(lower)).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  if (checksumCache.size > 4000) checksumCache.clear();
  checksumCache.set(lower, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// ABI types: uintN intN address bool bytesN bytes string T[] T[k] (tuple)

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// "address[] pools" -> "address[]"; "(address target, bool x)[] calls" -> "(address,bool)[]"
function canonicalParam(p) {
  p = p.trim().replace(/\s+(indexed|calldata|memory|storage|payable)\b/g, '');
  if (p.startsWith('tuple(')) p = p.slice(5);
  if (p.startsWith('(')) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '(') depth++;
      if (p[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const inner = splitTop(p.slice(1, end)).map(canonicalParam).join(',');
    const rest = p.slice(end + 1).trim();
    const suffix = (rest.match(/^((\[\d*\])*)/) || ['', ''])[1];
    return `(${inner})${suffix}`;
  }
  const t = p.split(/\s+/)[0];
  if (t === 'uint') return 'uint256';
  if (t === 'int') return 'int256';
  return t.replace(/^uint\[/, 'uint256[').replace(/^int\[/, 'int256[');
}

function paramIndexed(p) {
  return /\sindexed\b/.test(p);
}

const typeCache = new Map();
function parseType(t) {
  const hit = typeCache.get(t);
  if (hit) return hit;
  let out;
  const arr = t.match(/^(.*)\[(\d*)\]$/);
  if (arr) out = { kind: 'array', inner: parseType(arr[1]), len: arr[2] === '' ? null : Number(arr[2]) };
  else if (t.startsWith('(')) out = { kind: 'tuple', comps: splitTop(t.slice(1, -1)).map(parseType) };
  else if (t === 'address') out = { kind: 'address' };
  else if (t === 'bool') out = { kind: 'bool' };
  else if (t === 'bytes') out = { kind: 'bytes' };
  else if (t === 'string') out = { kind: 'string' };
  else if (/^bytes(\d+)$/.test(t)) out = { kind: 'fixedbytes', size: Number(t.slice(5)) };
  else if (/^uint(\d+)$/.test(t)) out = { kind: 'uint', bits: Number(t.slice(4)) };
  else if (/^int(\d+)$/.test(t)) out = { kind: 'int', bits: Number(t.slice(3)) };
  else throw new Error(`unsupported ABI type ${t}`);
  out.name = t;
  typeCache.set(t, out);
  return out;
}

function isDynamic(T) {
  if (T.kind === 'bytes' || T.kind === 'string') return true;
  if (T.kind === 'array') return T.len === null || isDynamic(T.inner);
  if (T.kind === 'tuple') return T.comps.some(isDynamic);
  return false;
}

function headSize(T) {
  if (isDynamic(T)) return 32;
  if (T.kind === 'array') return T.len * headSize(T.inner);
  if (T.kind === 'tuple') return T.comps.reduce((s, c) => s + headSize(c), 0);
  return 32;
}

const word = (n) => n.toString(16).padStart(64, '0');

function encodeInt(v, bits, signed) {
  let n = BigInt(v);
  if (signed) {
    const lim = 1n << BigInt(bits - 1);
    if (n < -lim || n >= lim) throw new Error(`int${bits} out of range`);
    if (n < 0n) n = (1n << 256n) + n;
  } else if (n < 0n || n >= 1n << BigInt(bits)) {
    throw new Error(`uint${bits} out of range: ${v}`);
  }
  return word(n);
}

function encodeBytesTail(bytes) {
  const hex = bytesToHex(bytes).slice(2);
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return word(BigInt(bytes.length)) + padded;
}

function encodeValue(T, v) {
  switch (T.kind) {
    case 'uint': return encodeInt(v, T.bits, false);
    case 'int': return encodeInt(v, T.bits, true);
    case 'bool': return word(v ? 1n : 0n);
    case 'address': {
      if (!isAddress(v)) throw new Error(`not an address: ${v}`);
      return v.slice(2).toLowerCase().padStart(64, '0');
    }
    case 'fixedbytes': {
      const h = String(v).slice(2);
      if (h.length !== T.size * 2) throw new Error(`bytes${T.size} needs ${T.size} bytes`);
      return h.toLowerCase().padEnd(64, '0');
    }
    case 'bytes': return encodeBytesTail(typeof v === 'string' ? hexToBytes(v) : v);
    case 'string': return encodeBytesTail(enc.encode(String(v)));
    case 'array': {
      const list = Array.from(v);
      if (T.len !== null && list.length !== T.len) throw new Error(`${T.name} needs ${T.len} items`);
      const body = encodeTuple(list.map(() => T.inner), list);
      return T.len === null ? word(BigInt(list.length)) + body : body;
    }
    case 'tuple': {
      const vals = Array.isArray(v) ? v : Object.values(v);
      return encodeTuple(T.comps, vals);
    }
    default: throw new Error(`cannot encode ${T.name}`);
  }
}

function encodeTuple(Ts, vals) {
  if (Ts.length !== vals.length) throw new Error(`expected ${Ts.length} values, got ${vals.length}`);
  const heads = [];
  const tails = [];
  let tailOffset = Ts.reduce((s, T) => s + headSize(T), 0);
  Ts.forEach((T, i) => {
    const e = encodeValue(T, vals[i]);
    if (isDynamic(T)) {
      heads.push(word(BigInt(tailOffset)));
      tails.push(e);
      tailOffset += e.length / 2;
    } else {
      heads.push(e);
    }
  });
  return heads.join('') + tails.join('');
}

function readWord(hex, byteOff) {
  const s = hex.slice(byteOff * 2, byteOff * 2 + 64);
  if (s.length !== 64) throw new Error('ABI data too short');
  return BigInt('0x' + s);
}

function decodeValue(T, hex, off) {
  switch (T.kind) {
    case 'uint': return readWord(hex, off) & ((1n << BigInt(T.bits)) - 1n);
    case 'int': {
      let n = readWord(hex, off) & ((1n << BigInt(T.bits)) - 1n);
      if (n >= 1n << BigInt(T.bits - 1)) n -= 1n << BigInt(T.bits);
      return n;
    }
    case 'bool': return readWord(hex, off) !== 0n;
    case 'address': return getAddress('0x' + hex.slice(off * 2 + 24, off * 2 + 64));
    case 'fixedbytes': return '0x' + hex.slice(off * 2, off * 2 + T.size * 2);
    case 'bytes':
    case 'string': {
      const len = Number(readWord(hex, off));
      const start = (off + 32) * 2;
      if (hex.length < start + len * 2) throw new Error('ABI data too short');
      const h = '0x' + hex.slice(start, start + len * 2);
      return T.kind === 'bytes' ? h : new TextDecoder().decode(hexToBytes(h));
    }
    case 'array': {
      let len = T.len;
      let base = off;
      if (len === null) { len = Number(readWord(hex, off)); base = off + 32; }
      if (len > 100000) throw new Error('ABI array too long');
      return decodeTupleAt(new Array(len).fill(T.inner), hex, base);
    }
    case 'tuple': return decodeTupleAt(T.comps, hex, off);
    default: throw new Error(`cannot decode ${T.name}`);
  }
}

function decodeTupleAt(Ts, hex, base) {
  const out = [];
  let cur = base;
  for (const T of Ts) {
    if (isDynamic(T)) {
      const rel = Number(readWord(hex, cur));
      out.push(decodeValue(T, hex, base + rel));
    } else {
      out.push(decodeValue(T, hex, cur));
    }
    cur += headSize(T);
  }
  return out;
}

/** encodeAbi(['address[]', 'uint256'], [[a, b], 5n]) -> '0x...' */
export function encodeAbi(types, values) {
  return '0x' + encodeTuple(types.map((t) => parseType(canonicalParam(t))), values);
}

/** decodeAbi(['uint256', 'bool[]'], '0x...') -> [1n, [true]] */
export function decodeAbi(types, data) {
  const hex = String(data || '').replace(/^0x/, '');
  return decodeTupleAt(types.map((t) => parseType(canonicalParam(t))), hex, 0);
}

// ---------------------------------------------------------------------------------------------------------
// human-readable fragments ('function x(...) view returns (...)', 'event ...', 'error ...')

const fragCache = new Map();
export function parseFragment(src) {
  const hit = fragCache.get(src);
  if (hit) return hit;
  const s = String(src).trim();
  const m = s.match(/^(function|event|error)\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (!m) throw new Error(`cannot parse ABI fragment: ${s.slice(0, 80)}`);
  let depth = 0;
  let open = s.indexOf('(');
  let close = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  const rawInputs = splitTop(s.slice(open + 1, close));
  const rest = s.slice(close + 1);
  let outputs = [];
  const r = rest.match(/returns\s*\(/);
  if (r) {
    const o = rest.indexOf('(', r.index);
    let d = 0;
    let e = -1;
    for (let i = o; i < rest.length; i++) {
      if (rest[i] === '(') d++;
      if (rest[i] === ')') { d--; if (d === 0) { e = i; break; } }
    }
    outputs = splitTop(rest.slice(o + 1, e)).map(canonicalParam);
  }
  const inputs = rawInputs.map(canonicalParam);
  const names = rawInputs.map((p) => {
    const words = p.replace(/\s+(indexed|calldata|memory|storage)\b/g, '').trim().split(/\s+/);
    return words.length > 1 && !words[words.length - 1].includes(')') ? words[words.length - 1] : null;
  });
  const signature = `${m[2]}(${inputs.join(',')})`;
  const hash = keccak256(enc.encode(signature));
  const frag = {
    type: m[1],
    name: m[2],
    inputs,
    names,
    indexed: rawInputs.map(paramIndexed),
    outputs,
    signature,
    selector: hash.slice(0, 10),
    topic: hash,
  };
  fragCache.set(src, frag);
  return frag;
}

const listCache = new WeakMap();
/** fragment(LAB_ABI, 'getRun') -> parsed fragment (functions, events and errors by name). */
export function fragment(abi, name) {
  let map = listCache.get(abi);
  if (!map) {
    map = new Map();
    for (const f of abi) {
      try { const p = parseFragment(f); if (!map.has(p.name)) map.set(p.name, p); } catch { /* skip constructor etc. */ }
    }
    listCache.set(abi, map);
  }
  const f = map.get(name);
  if (!f) throw new Error(`${name} is not in the ABI`);
  return f;
}

/** Every parsed `error` fragment of an ABI list, keyed by selector. */
export function errorsOf(abi) {
  const out = new Map();
  for (const f of abi) {
    try { const p = parseFragment(f); if (p.type === 'error') out.set(p.selector, p); } catch { /* ignore */ }
  }
  return out;
}

export function selector(sigOrFragment) {
  const s = String(sigOrFragment).trim();
  if (/^(function|event|error)\s/.test(s)) return parseFragment(s).selector;
  return keccak256(enc.encode(s.replace(/\s+/g, ''))).slice(0, 10);
}

const asFrag = (f) => (typeof f === 'string' ? parseFragment(f) : f);

export function encodeCall(frag, args = []) {
  const f = asFrag(frag);
  return f.selector + encodeAbi(f.inputs, args).slice(2);
}

export function decodeResult(frag, data) {
  const f = asFrag(frag);
  const vals = decodeAbi(f.outputs, data);
  return vals.length === 1 ? vals[0] : vals;
}

// ---------------------------------------------------------------------------------------------------------
// endpoint and the localhost-only overrides

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
let conf = { base: null, rpc: null, href: null, timeoutMs: 15000 };

/** For Node tools and tests. configure({}) resets to the browser defaults. */
export function configure({ base = null, rpc: direct = null, href = null, timeoutMs = 15000 } = {}) {
  conf = { base: base ? String(base).replace(/\/+$/, '') : null, rpc: direct || null, href: href || null, timeoutMs: Number(timeoutMs) || 15000 };
}

function pageHref() {
  if (conf.href) return conf.href;
  try { return globalThis.location && globalThis.location.href ? String(globalThis.location.href) : null; } catch { return null; }
}

/**
 * The ?rpc= and ?contract= overrides, honoured only when the page itself runs on localhost or 127.0.0.1.
 * rpc must be an http(s) URL on a loopback host; contract must be a 0x address. Anything else is null.
 */
export function overrides(href = pageHref()) {
  const none = { local: false, rpc: null, contract: null };
  if (!href) return none;
  let u;
  try { u = new URL(href); } catch { return none; }
  if (!LOCAL_HOSTS.has(u.hostname)) return none;
  const out = { local: true, rpc: null, contract: null };
  const r = u.searchParams.get('rpc');
  if (r) {
    try {
      const ru = new URL(r);
      if (/^https?:$/.test(ru.protocol) && LOCAL_HOSTS.has(ru.hostname)) out.rpc = ru.href.replace(/\/$/, '');
    } catch { /* ignored */ }
  }
  const e = u.searchParams.get('contract');
  if (e && isAddress(e)) out.contract = getAddress(e);
  return out;
}

/** Absolute URL of a path on this site (the page's origin, or configure({ base }) in Node). */
export function siteUrl(path) {
  if (conf.base) return conf.base + path;
  const href = pageHref();
  if (href) { try { return new URL(path, href).href; } catch { /* fall through */ } }
  return path;
}

/** Where reads go now: configure({ rpc }), else the localhost ?rpc= override, else the /api/rpc proxy. */
export function endpoint() {
  if (conf.rpc) return conf.rpc;
  const o = overrides();
  if (o.rpc) return o.rpc;
  return siteUrl(CHAIN.rpcProxy);
}

// ---------------------------------------------------------------------------------------------------------
// transport

export class RpcError extends Error {
  constructor(message, { code = null, data = null, method = null, transient = false, status = null } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.method = method;
    this.transient = transient;
    this.status = status;
  }
}

const sleep = (ms, signal) => new Promise((ok, fail) => {
  if (signal && signal.aborted) return fail(abortError());
  const t = setTimeout(ok, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); fail(abortError()); }, { once: true });
});

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

const TRANSIENT = /rate|too many|429|limit exceeded|timeout|timed out|header not found|temporar|try again|busy|unavailable|bad gateway|upstream|502|503|504|connection refused|connection reset|dial tcp|no such host|i\/o timeout|EOF|broken pipe|internal error/i;
function transientError(err) {
  if (!err) return false;
  if (err.code === -32005 || err.code === 429) return true;
  if (typeof err.data === 'string' && err.data.length > 2) return false; // revert data: final
  if (/revert/i.test(err.message || '')) return false;
  return TRANSIENT.test(err.message || '');
}

let idSeq = 1;

async function post(body, { signal, timeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    if (signal && signal.aborted) throw abortError();
    throw new RpcError(`RPC unreachable: ${String((e && e.message) || e).slice(0, 140)}`, { transient: true });
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const BACKOFF = [0, 300, 800, 1800];

// One HTTP request of at most 5 calls; retried as a whole on transport failures and per call on transient errors.
async function sendChunk(chunk, { signal, timeoutMs = conf.timeoutMs, retries = BACKOFF.length - 1 } = {}) {
  const results = new Array(chunk.length);
  let pending = chunk.map((_, i) => i);
  let lastErr = null;
  for (let attempt = 0; attempt <= retries && pending.length; attempt++) {
    if (attempt) await sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)] + Math.floor(Math.random() * 120), signal);
    const ids = pending.map(() => idSeq++);
    const single = pending.length === 1;
    const reqs = pending.map((idx, j) => ({ jsonrpc: '2.0', id: ids[j], method: chunk[idx].method, params: chunk[idx].params || [] }));
    let r;
    try {
      r = await post(JSON.stringify(single ? reqs[0] : reqs), { signal, timeoutMs });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e;
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { /* handled below */ }
    if (r.status !== 200 && !(parsed && (Array.isArray(parsed) || parsed.error))) {
      lastErr = new RpcError(`RPC answered HTTP ${r.status}`, { status: r.status, transient: true });
      continue;
    }
    if (!parsed) {
      lastErr = new RpcError('RPC answered with something that is not JSON', { transient: true });
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const byId = new Map(list.map((x) => [x && x.id, x]));
    const still = [];
    pending.forEach((idx, j) => {
      const method = chunk[idx].method;
      let item = byId.get(ids[j]);
      if (!item && !Array.isArray(parsed) && parsed.error) item = parsed; // proxy-level error for the request
      if (!item) {
        lastErr = new RpcError('RPC dropped a call', { method, transient: true });
        still.push(idx);
        return;
      }
      if (item.error) {
        const err = new RpcError(item.error.message || 'RPC error', { code: item.error.code, data: item.error.data ?? null, method, status: r.status });
        const retryable = r.status === 429 || r.status >= 500 || transientError(item.error);
        if (retryable && r.status !== 403) { err.transient = true; lastErr = err; still.push(idx); } else results[idx] = { ok: false, error: err };
        return;
      }
      if (!('result' in item)) {
        lastErr = new RpcError('RPC answer had neither result nor error', { method, transient: true });
        still.push(idx);
        return;
      }
      results[idx] = { ok: true, result: item.result };
    });
    pending = still;
  }
  for (const idx of pending) results[idx] = { ok: false, error: lastErr || new RpcError('RPC read failed', { transient: true }) };
  return results;
}

/** Any number of calls: 5 per HTTP request, two requests in flight. Never throws for a failed call. */
export async function rpcBatch(calls, opts = {}) {
  const max = Math.max(1, Math.min(CHAIN.maxBatch || 5, 5));
  const out = new Array(calls.length);
  const chunks = [];
  for (let i = 0; i < calls.length; i += max) chunks.push([i, calls.slice(i, i + max)]);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const [at, chunk] = chunks[next++];
      const res = await sendChunk(chunk, opts);
      res.forEach((r, j) => { out[at + j] = r; });
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

/** One JSON-RPC call. Resolves to the raw result or throws RpcError. */
export async function rpc(method, params = [], opts = {}) {
  const [r] = await sendChunk([{ method, params }], opts);
  if (!r.ok) throw r.error;
  return r.result;
}

/** eth_call with an optional state override (third param, passed through the proxy untouched). */
export async function ethCall(tx, { blockTag = 'latest', stateOverride = null, signal, timeoutMs } = {}) {
  const params = [tx, blockTag];
  if (stateOverride) params.push(stateOverride);
  return rpc('eth_call', params, { signal, timeoutMs });
}

// ---------------------------------------------------------------------------------------------------------
// Multicall3

const AGG3 = parseFragment('function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)');

/**
 * Multicall3.aggregate3 in as few eth_calls as possible. See the header for the call shapes.
 * blockTag may be 'latest' or a block number (number/bigint/hex).
 */
export async function multicall(calls, { allowFailure = true, blockTag = 'latest', chunk = 700, signal, stateOverride = null } = {}) {
  const out = new Array(calls.length);
  const prepared = [];
  calls.forEach((c, idx) => {
    try {
      const f = c.fn ? asFrag(c.fn) : null;
      const data = c.data || encodeCall(f, c.args || []);
      if (!isAddress(c.target)) throw new Error(`bad target ${c.target}`);
      prepared.push({ idx, f, target: c.target, data });
    } catch (e) {
      out[idx] = { ok: false, error: new RpcError(`could not encode call: ${(e && e.message) || e}`), data: null };
    }
  });
  const groups = [];
  for (let k = 0; k < prepared.length; k += chunk) groups.push(prepared.slice(k, k + chunk));
  const tag = typeof blockTag === 'string' ? blockTag : toHex(blockTag);
  const params = (g) => {
    const p = [{ to: MULTICALL3, data: encodeCall(AGG3, [g.map((x) => [x.target, true, x.data])]) }, tag];
    if (stateOverride) p.push(stateOverride);
    return p;
  };
  const answers = await rpcBatch(groups.map((g) => ({ method: 'eth_call', params: params(g) })), { signal });
  groups.forEach((g, gi) => {
    const a = answers[gi];
    if (!a.ok) { for (const p of g) out[p.idx] = { ok: false, error: a.error, data: null }; return; }
    let rows;
    try {
      rows = decodeResult(AGG3, a.result);
    } catch {
      for (const p of g) out[p.idx] = { ok: false, error: new RpcError('Multicall3 answer did not decode'), data: null };
      return;
    }
    g.forEach((p, j) => {
      const row = rows[j];
      if (!row || !row[0]) { out[p.idx] = { ok: false, error: new RpcError('call reverted', { data: row ? row[1] : null }), data: row ? row[1] : null }; return; }
      const data = row[1];
      if (!data || data === '0x') { out[p.idx] = { ok: false, error: new RpcError('call returned no data'), data }; return; }
      if (!p.f) { out[p.idx] = { ok: true, value: data, data }; return; }
      try {
        out[p.idx] = { ok: true, value: decodeResult(p.f, data), data };
      } catch {
        out[p.idx] = { ok: false, error: new RpcError('answer did not decode'), data };
      }
    });
  });
  if (!allowFailure) {
    const bad = out.find((r) => !r.ok);
    if (bad) throw bad.error;
  }
  return out;
}
