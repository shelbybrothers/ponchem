/*
 * DNS-over-HTTPS transport for the Robinhood Chain RPC.
 *
 * On some networks (this dev machine included) the RPC hostname resolves to a
 * hijacked private address, so a plain fetch() fails before it ever reaches the
 * node. This module asks IP-literal resolvers over HTTPS instead (no DNS needed
 * to bootstrap), then connects straight to the returned address with the real
 * hostname in SNI and in the Host header, so TLS still validates against the
 * real certificate.
 *
 * Production resolves normally and only lands here after a normal fetch failed
 * in a way that looks like a DNS or connection problem.
 *
 * lib/doh.js re-exports this file for the local tools, because Vercel does not
 * upload /lib and the deployed proxy needs its own copy.
 */
import https from 'node:https';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // host -> { ips, at }

const RESOLVERS = [
  (host) => `https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`,
  (host) => `https://8.8.8.8/resolve?name=${encodeURIComponent(host)}&type=A`,
];

/**
 * True when a request never reached the real server: the name did not resolve,
 * or it resolved somewhere that refuses or drops the connection. A hijacked
 * record usually shows up as ECONNREFUSED or a timeout rather than ENOTFOUND, so
 * connection-level failures count too. Every part of the error is inspected
 * because fetch() hides the useful code inside `cause`.
 */
export function looksLikeDnsFailure(err) {
  const parts = [
    err && err.cause && err.cause.code,
    err && err.cause && err.cause.message,
    err && err.code,
    err && err.name,
    err && err.message,
    String(err),
  ].filter(Boolean).join(' ');
  return /ENOTFOUND|EAI_AGAIN|EAI_NODATA|ERR_NAME_NOT_RESOLVED|getaddrinfo|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_TLS_CERT_ALTNAME_INVALID|UND_ERR|TimeoutError|AbortError/i.test(parts);
}

/** Resolve A records for `host` over DoH. Cached for five minutes. */
export async function resolve(host, { fresh = false } = {}) {
  const hit = cache.get(host);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.ips;
  let lastErr = null;
  for (const endpoint of RESOLVERS) {
    try {
      const r = await fetch(endpoint(host), {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error(`DoH answered HTTP ${r.status}`);
      const j = await r.json();
      const ips = (j.Answer || [])
        .filter((a) => a && a.type === 1 && typeof a.data === 'string')
        .map((a) => a.data);
      if (!ips.length) throw new Error('DoH returned no A record');
      cache.set(host, { ips, at: Date.now() });
      return ips;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('DoH lookup failed');
}

function postToAddress(ip, u, payload, headers, timeoutMs) {
  return new Promise((ok, fail) => {
    const req = https.request({
      host: ip,
      servername: u.hostname, // SNI and certificate checks use the real name
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        ...headers,
        host: u.hostname,
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
      res.on('error', fail);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`DoH request timed out after ${timeoutMs} ms`)));
    req.on('error', fail);
    req.end(payload);
  });
}

/**
 * POST a JSON body to `url` over the DoH path. Tries every resolved address,
 * then re-resolves once if all of them failed. Resolves to { status, text, headers }.
 */
export async function postJson(url, body, headers = {}, timeoutMs = 9000) {
  const u = new URL(url);
  const payload = Buffer.from(body, 'utf8');
  let ips = await resolve(u.hostname);
  let lastErr = null;
  for (let pass = 0; pass < 2; pass++) {
    for (const ip of ips) {
      try {
        return await postToAddress(ip, u, payload, headers, timeoutMs);
      } catch (e) {
        lastErr = e;
      }
    }
    if (pass === 0) {
      const next = await resolve(u.hostname, { fresh: true }).catch(() => ips);
      if (next.join() === ips.join()) break;
      ips = next;
    }
  }
  throw lastErr || new Error('DoH request failed');
}
