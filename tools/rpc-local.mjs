#!/usr/bin/env node
/*
 * rpc-local.mjs: a localhost JSON-RPC forwarder for forge, cast and the Ponchem contract scripts.
 *
 *   node tools/rpc-local.mjs                    listens on http://127.0.0.1:8670
 *   PORT=8680 node tools/rpc-local.mjs          another port
 *   forge script ... --rpc-url http://127.0.0.1:8670
 *
 * Why it exists: on this machine the Robinhood Chain RPC hostname resolves to a hijacked
 * private address, and forge only takes a URL. This relays over DNS-over-HTTPS (lib/doh.js)
 * to the real node (ported from ponbio), and smooths over the node's habits on the way:
 *  - paced: at most RPC_CONCURRENCY (2) upstream requests at a time, RPC_PACE_MS (120) apart;
 *  - retries HTTP 429 and 5xx, connection failures and rate-limit errors with backoff,
 *    honouring Retry-After, up to RPC_MAX_ATTEMPTS (8) tries;
 *  - splits JSON-RPC batches larger than 5 calls, which the node refuses, and reassembles them;
 *  - a re-sent eth_sendRawTransaction that comes back "already known" is reported as the
 *    transaction hash, because the first attempt did reach the node.
 *
 * THIS IS NOT THE SITE'S /api/rpc. That endpoint is public and refuses every write.
 * This one relays everything, eth_sendRawTransaction included, because its job is to let
 * you broadcast a deploy. That is only safe because it binds to 127.0.0.1 and never sees a
 * key: forge signs locally and hands it an already signed transaction. Do not expose it.
 */
import http from 'node:http';
import { postJson, resolve } from '../lib/doh.js';

const PORT = Number(process.env.PORT || 8670);
const HOST = '127.0.0.1';
const UPSTREAM = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const PACE_MS = Number(process.env.RPC_PACE_MS || 120);
const CONCURRENCY = Math.max(1, Number(process.env.RPC_CONCURRENCY || 2));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.RPC_MAX_ATTEMPTS || 8));
const MAX_BATCH = 5;
const TIMEOUT_MS = 30000;
const QUIET = process.env.RPC_QUIET === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pacing gate: CONCURRENCY slots, and each start waits PACE_MS after the previous start.
let active = 0;
let lastStart = 0;
const waiters = [];
async function gate(fn) {
  while (active >= CONCURRENCY) await new Promise((r) => waiters.push(r));
  active++;
  try {
    const wait = lastStart + PACE_MS - Date.now();
    lastStart = Math.max(Date.now(), lastStart + PACE_MS);
    if (wait > 0) await sleep(wait);
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

const RATE_LIMITED = /rate|too many|429|limit exceeded|temporar|try again|busy/i;
const ALREADY_KNOWN = /already known|known transaction|alreadyknown|already imported/i;

// the hash of a signed raw transaction is keccak256 of its bytes (js/rpc.js has the hash; no ethers needed)
let keccak = null;
async function txHash(raw) {
  if (!keccak) {
    const mod = await import('../js/rpc.js').catch(() => null);
    keccak = mod ? mod.keccak256 : () => null;
  }
  try { return keccak(raw); } catch { return null; }
}

function backoff(attempt, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(15000, ra * 1000);
  return Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
}

let seen = 0;
function announce(calls) {
  for (const c of calls) {
    const method = c && c.method;
    if (typeof method !== 'string') continue;
    seen++;
    if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction') console.log(`  -> ${method}   (this one broadcasts)`);
    else if (!QUIET && (seen <= 8 || seen % 50 === 0)) console.log(`  -> ${method}   (#${seen})`);
  }
}

// Forward one JSON text (a single call or a batch of at most 5) with retries.
async function forward(text, calls) {
  const sendsRaw = calls.some((c) => c && c.method === 'eth_sendRawTransaction');
  let last = null;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt) {
      const wait = backoff(attempt - 1, last && last.headers && last.headers['retry-after']);
      console.log(`  retry ${attempt + 1}/${MAX_ATTEMPTS} in ${wait} ms (${lastErr ? lastErr.message : `HTTP ${last && last.status}`})`);
      await sleep(wait);
    }
    lastErr = null;
    try {
      last = await gate(() => postJson(UPSTREAM, text, { accept: 'application/json' }, TIMEOUT_MS));
    } catch (e) {
      lastErr = e;
      last = null;
      continue;
    }
    if (last.status === 429 || last.status >= 500) continue;
    let parsed = null;
    try { parsed = JSON.parse(last.text); } catch { /* let the caller see it */ }
    const items = parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : [];
    const limited = items.some((x) => x && x.error && (x.error.code === -32005 || RATE_LIMITED.test(x.error.message || '')));
    if (limited && attempt < MAX_ATTEMPTS - 1) continue;
    if (sendsRaw && attempt > 0 && items.length) {
      // The first try reached the node even though its answer was lost.
      let changed = false;
      for (const item of items) {
        if (!item || !item.error || !ALREADY_KNOWN.test(item.error.message || '')) continue;
        const call = calls.find((c) => c && c.id === item.id && c.method === 'eth_sendRawTransaction');
        const hash = call && Array.isArray(call.params) ? await txHash(call.params[0]) : null;
        if (hash) {
          console.log(`  already known upstream, answering with ${hash}`);
          delete item.error;
          item.result = hash;
          changed = true;
        }
      }
      if (changed) return { status: 200, text: JSON.stringify(Array.isArray(parsed) ? items : items[0]) };
    }
    return last;
  }
  if (last) return last;
  throw lastErr || new Error('upstream failed');
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > 8 * 1024 * 1024) { fail(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('POST a JSON-RPC body\n');
  }
  let text;
  try {
    text = await readBody(req);
  } catch (e) {
    res.writeHead(413, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: String(e.message) } }));
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* relay as-is and let the node judge */ }
  const calls = parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : [];
  announce(calls);

  try {
    if (Array.isArray(parsed) && parsed.length > MAX_BATCH) {
      const answers = [];
      for (let i = 0; i < parsed.length; i += MAX_BATCH) {
        const part = parsed.slice(i, i + MAX_BATCH);
        const r = await forward(JSON.stringify(part), part);
        let body;
        try { body = JSON.parse(r.text); } catch { body = null; }
        if (r.status !== 200 || !Array.isArray(body)) {
          for (const c of part) answers.push({ jsonrpc: '2.0', id: c && c.id !== undefined ? c.id : null, error: { code: -32000, message: `upstream HTTP ${r.status}` } });
        } else {
          answers.push(...body);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(answers));
    }
    const r = await forward(text, calls);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    return res.end(r.text);
  } catch (e) {
    console.error('  upstream failed:', (e && e.message) || e);
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: String((e && e.message) || e) } }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`rpc-local: port ${PORT} is already in use (PORT=<port> to pick another).`);
  else console.error(e);
  process.exit(1);
});

const ips = await resolve(new URL(UPSTREAM).hostname).catch(() => ['(DoH lookup failed)']);
server.listen(PORT, HOST, () => {
  console.log(`rpc-local  ${UPSTREAM}  ->  ${ips[0]}`);
  console.log(`listening  http://${HOST}:${PORT}   localhost only, relays writes, paced ${PACE_MS} ms x${CONCURRENCY}, ${MAX_ATTEMPTS} tries`);
  console.log(`point forge at it:  --rpc-url http://${HOST}:${PORT}`);
});
