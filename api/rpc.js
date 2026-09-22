// Read-only JSON-RPC proxy from the browser to Robinhood Chain.
//
// The public RPC sends no CORS headers, so pages call this same-origin endpoint.
// Wallets sign and broadcast their own transactions, so every write method is
// refused here. Batches are capped at 5 calls, which is what the node tolerates.
// The node answers 429 and 5xx at random under load: those get up to three quiet retries
// (the third only inside a short time budget) before the browser sees anything.
// Params are forwarded exactly as sent, so eth_call's optional third param (a state override object)
// reaches the node untouched.
// The body cap is 1 MB, far above any read the site makes.
import { postJson, looksLikeDnsFailure } from './_doh.mjs';

const UPSTREAM = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const MAX_BATCH = 5;
const MAX_BODY = 1024 * 1024;
const TIMEOUT_MS = 9000;

const ALLOW = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber',
  'eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBalance', 'eth_getTransactionCount',
  'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
]);
const WRITES = /^(eth_sendRawTransaction|eth_sendTransaction|eth_sign|eth_signTransaction|eth_signTypedData(_v\d)?|personal_\w+|wallet_\w+)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((ok, fail) => {
    if (req.body !== undefined) {
      if (typeof req.body === 'string') return ok(req.body);
      if (Buffer.isBuffer(req.body)) return ok(req.body.toString('utf8'));
      return ok(JSON.stringify(req.body));
    }
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { fail(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

// After one DNS-shaped failure, go straight to DoH for ten minutes instead of
// paying for a doomed normal lookup on every request.
let dohUntil = 0;
async function forwardOnce(text) {
  if (Date.now() < dohUntil) return postJson(UPSTREAM, text, { accept: 'application/json' }, TIMEOUT_MS);
  try {
    const r = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: text,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    if (!looksLikeDnsFailure(e)) throw e;
    dohUntil = Date.now() + 10 * 60 * 1000;
    return postJson(UPSTREAM, text, { accept: 'application/json' }, TIMEOUT_MS);
  }
}

async function forward(text) {
  let last = null;
  let lastErr = null;
  const t0 = Date.now();
  for (const wait of [0, 350, 900, 1800]) {
    // the last, longer pause only when the earlier answers came back fast (a short 429 or 5xx burst)
    if (wait && Date.now() - t0 + wait > 4000) break;
    if (wait) await sleep(wait);
    try {
      last = await forwardOnce(text);
      if (last.status === 200) return last;
    } catch (e) {
      lastErr = e;
    }
  }
  if (last) return last;
  throw lastErr || new Error('upstream failed');
}

function reply(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return reply(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'POST a JSON-RPC body to this endpoint' } });
  }
  let parsed;
  try {
    const text = await readBody(req);
    if (text.length > MAX_BODY) return reply(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request body too large' } });
    parsed = JSON.parse(text);
  } catch {
    return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'body is not valid JSON' } });
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_BATCH) {
    return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `send between 1 and ${MAX_BATCH} calls per request` } });
  }
  for (const c of calls) {
    const method = c && typeof c.method === 'string' ? c.method : '';
    if (WRITES.test(method)) {
      return reply(res, 403, { jsonrpc: '2.0', id: c.id ?? null, error: { code: -32601, message: `${method} is refused: this endpoint is read-only. Send transactions from your wallet.` } });
    }
    if (!ALLOW.has(method)) {
      return reply(res, 403, { jsonrpc: '2.0', id: c && c.id !== undefined ? c.id : null, error: { code: -32601, message: `method not available on this read-only endpoint: ${String(method).slice(0, 64) || '(none)'}` } });
    }
  }
  try {
    const r = await forward(JSON.stringify(parsed));
    let body = r.text;
    try { JSON.parse(body); } catch {
      body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `upstream answered HTTP ${r.status} without JSON` } });
    }
    return reply(res, r.status === 200 ? 200 : 502, body);
  } catch (e) {
    return reply(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: `upstream unreachable: ${String((e && e.message) || e).slice(0, 120)}` } });
  }
}
