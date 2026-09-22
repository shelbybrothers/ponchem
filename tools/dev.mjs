#!/usr/bin/env node
/*
 * PONCHEM local dev server. No dependencies beyond Node (22 or later).
 *
 *   node tools/dev.mjs                    -> http://127.0.0.1:6130   (PORT defaults to 6130)
 *   PORT=6131 node tools/dev.mjs          another port (one server per author)
 *   HOST=0.0.0.0 node tools/dev.mjs       to reach it from a phone on the LAN
 *
 * It refuses to start when something already listens on the port (it never takes over another author's server).
 *
 * It behaves like production (Vercel) so a page that works here works there:
 *  - clean URLs: /lab serves lab.html; /lab.html and /lab/ redirect (308) to /lab; / serves index.html
 *  - /api/<name> runs the default export of api/<name>.js as handler(req, res), with the
 *    Vercel helpers req.query, req.body, res.status(), res.json(), res.send();
 *    files starting with an underscore are private and never routed.
 *    A route file is re-imported when it changes; restart after editing api/_*.mjs.
 *  - the headers from vercel.json are applied (security headers and the CSP), except that
 *    static files are always served with cache-control: no-store here, and the CSP's connect-src
 *    also allows http://127.0.0.1:* and http://localhost:* so the localhost-only ?rpc= override
 *    (js/rpc.js) can reach a local node. Production pages never connect anywhere but 'self' and RCSB;
 *  - dotfile paths and everything .vercelignore keeps out of a deploy answer 404;
 *  - unknown paths get 404.html with status 404 (or a plain 404 while the page does not exist yet);
 *  - byte ranges work, so <video> loads, seeks and loops as it does in production.
 *
 * Dev-only routes, never deployed (this file is not):
 *  - /__shell      a page made of the partials (head, nav, footer) with an empty main, so the shared shell, the
 *                  blank $PONCHEM controls and the wallet button can be seen and tested before any real page exists
 *  - /__shell.js   the module that page runs: initShell() and initWalletButton() from js/shell.js
 */
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolvePath(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 6130);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdb': 'chemical/x-pdb',
  '.sdf': 'chemical/x-mdl-sdfile',
  '.mol': 'chemical/x-mdl-molfile',
  '.cif': 'chemical/x-mmcif',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

// vercel.json "source" patterns: literal paths, (.*) groups and :param segments.
function sourceToRegex(src) {
  let re = '';
  for (let i = 0; i < src.length;) {
    if (src.startsWith('(.*)', i)) { re += '(.*)'; i += 4; continue; }
    const m = /^:([A-Za-z_]\w*)([*+?])?/.exec(src.slice(i));
    if (m) { re += m[2] === '*' || m[2] === '+' ? '(.*)' : '([^/]+)'; i += m[0].length; continue; }
    re += src[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}

let vercelCache = { mtime: -1, rules: [] };
async function headerRules() {
  const file = join(ROOT, 'vercel.json');
  const s = await stat(file).catch(() => null);
  if (!s) return [];
  if (s.mtimeMs !== vercelCache.mtime) {
    try {
      const cfg = JSON.parse(await readFile(file, 'utf8'));
      vercelCache = {
        mtime: s.mtimeMs,
        rules: (cfg.headers || []).map((h) => ({ re: sourceToRegex(h.source), headers: h.headers || [] })),
      };
    } catch (e) {
      console.error('vercel.json did not parse:', e.message);
      vercelCache = { mtime: s.mtimeMs, rules: [] };
    }
  }
  return vercelCache.rules;
}

let ignoreCache = { mtime: -1, rules: [] };
async function ignoreRules() {
  const file = join(ROOT, '.vercelignore');
  const s = await stat(file).catch(() => null);
  if (!s) return [];
  if (s.mtimeMs !== ignoreCache.mtime) {
    const lines = (await readFile(file, 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    ignoreCache = {
      mtime: s.mtimeMs,
      rules: lines.map((l) => {
        const anchored = l.startsWith('/') ? l : `/${l}`;
        const body = anchored.replace(/\/+$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        return new RegExp(`^${body}(/.*)?$`);
      }),
    };
  }
  return ignoreCache.rules;
}

async function applyHeaders(res, path) {
  for (const rule of await headerRules()) {
    if (!rule.re.test(path)) continue;
    for (const h of rule.headers) {
      const local = /^content-security-policy$/i.test(h.key) ? h.value.replace(/connect-src ([^;]*)/, (all, v) => `connect-src ${v} http://127.0.0.1:* http://localhost:*`) : h.value;
      res.setHeader(h.key, local);
    }
  }
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function notFound(req, res) {
  const page = await readFile(join(ROOT, '404.html')).catch(() => null);
  res.statusCode = 404;
  res.setHeader('cache-control', 'no-store');
  if (page) {
    res.setHeader('content-type', MIME['.html']);
    return res.end(req.method === 'HEAD' ? undefined : page);
  }
  return sendText(res, 404, 'Not found');
}

function redirect(res, location) {
  res.statusCode = 308;
  res.setHeader('location', location);
  res.setHeader('cache-control', 'no-store');
  res.end();
}

function serveFile(req, res, file, size) {
  res.setHeader('content-type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('accept-ranges', 'bytes');
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    let bad = !m || (m[1] === '' && m[2] === '');
    if (!bad) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      bad = start > end || start >= size;
    }
    if (bad) {
      res.statusCode = 416;
      res.setHeader('content-range', `bytes */${size}`);
      return res.end();
    }
    status = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  }
  res.statusCode = status;
  res.setHeader('content-length', size === 0 ? 0 : end - start + 1);
  if (req.method === 'HEAD' || size === 0) return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function readRawBody(req, limit) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { fail(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

// The subset of Vercel's Node helpers that route files may lean on.
async function vercelShim(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await readRawBody(req, 1024 * 1024);
    const type = String(req.headers['content-type'] || '');
    if (/json/i.test(type)) {
      try { req.body = JSON.parse(buf.toString('utf8')); } catch { req.body = buf.toString('utf8'); }
    } else if (/^text\/|urlencoded/i.test(type)) {
      req.body = buf.toString('utf8');
    } else {
      req.body = buf.length ? buf : '';
    }
  }
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    if (!res.getHeader('content-type')) res.setHeader('content-type', Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/html; charset=utf-8');
    res.end(body);
    return res;
  };
}

async function handleApi(req, res, path, url) {
  const name = path.slice('/api/'.length).replace(/\.md$/, ''); // /api/report.md is api/report.js (vercel.json rewrites it too)
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return sendText(res, 404, JSON.stringify({ ok: false, error: 'no such API route' }), 'application/json; charset=utf-8');
  const file = join(ROOT, 'api', `${name}.js`);
  const s = await stat(file).catch(() => null);
  if (!s || !s.isFile()) return sendText(res, 404, JSON.stringify({ ok: false, error: 'no such API route' }), 'application/json; charset=utf-8');
  let handler;
  try {
    handler = (await import(`${pathToFileURL(file).href}?v=${s.mtimeMs}`)).default;
  } catch (e) {
    console.error(`api/${name}.js failed to load:`, e);
    return sendText(res, 500, JSON.stringify({ ok: false, error: `api/${name}.js failed to load: ${e.message}` }), 'application/json; charset=utf-8');
  }
  if (typeof handler !== 'function') return sendText(res, 500, JSON.stringify({ ok: false, error: `api/${name}.js has no default export function` }), 'application/json; charset=utf-8');
  try {
    await vercelShim(req, res, url);
    await handler(req, res);
  } catch (e) {
    console.error(`api/${name} threw:`, e);
    if (!res.headersSent) sendText(res, e.status || 500, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
    else res.end();
  }
}

// ---------------------------------------------------------------------------------------------------------
// the dev-only shell page

const SHELL_JS = `import { initShell, initWalletButton } from '/js/shell.js';\ninitShell();\ninitWalletButton({ onChange: (s) => console.log('wallet', s) });\n`;

async function shellPage() {
  const part = async (n) => (await readFile(join(ROOT, 'partials', `${n}.html`), 'utf8').catch(() => `<!-- partials/${n}.html is missing -->`)).replace(/\s+$/, '');
  const [head, nav, footer] = await Promise.all(['head', 'nav', 'footer'].map(part));
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Ponchem · Shell</title>',
    '    <meta name="description" content="The shared shell on the dev server: nav, footer, the blank $PONCHEM controls and the wallet button." />',
    '    <!-- shell:head -->', head, '    <!-- /shell:head -->',
    '  </head>',
    '  <body>',
    '      <!-- shell:nav -->', nav, '      <!-- /shell:nav -->',
    '      <main class="pc-main">',
    '        <section class="pc-section">',
    '          <h1>Shell check</h1>',
    '          <p>This page exists only on the dev server. It shows the shared nav and footer, the Buy $PONCHEM and Copy CA controls in their current state, and the wallet button.</p>',
    '        </section>',
    '      </main>',
    '      <!-- shell:footer -->', footer, '      <!-- /shell:footer -->',
    '    <script type="module" src="/__shell.js"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return notFound(req, res); }
    if (path.includes('\0') || path.includes('\\')) return notFound(req, res);
    await applyHeaders(res, path);

    if (path === '/api' || path.startsWith('/api/')) return handleApi(req, res, path, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendText(res, 405, 'Method not allowed');
    }
    if (path === '/__shell') return sendText(res, 200, await shellPage(), MIME['.html']);
    if (path === '/__shell.js') return sendText(res, 200, SHELL_JS, MIME['.js']);
    // Never serve dotfiles (.env*, .git, .venv) or anything a deploy would not contain.
    if (path.split('/').some((seg) => seg.startsWith('.'))) return notFound(req, res);
    if (path.length > 1 && path.endsWith('/')) return redirect(res, path.replace(/\/+$/, '') + url.search);
    if (path.endsWith('.html')) return redirect(res, (path === '/index.html' ? '/' : path.slice(0, -5)) + url.search);

    let file = path === '/' ? join(ROOT, 'index.html') : join(ROOT, path);
    if (file !== ROOT && !file.startsWith(ROOT + '/')) return notFound(req, res);
    let s = await stat(file).catch(() => null);
    if (s && !s.isFile()) s = null; // no directory listings
    if (!s && !extname(path)) {
      file = join(ROOT, `${path}.html`);
      s = await stat(file).catch(() => null);
    }
    if (!s || !s.isFile()) return notFound(req, res);
    // .vercelignore rules apply to the file a deploy would carry, not to the URL: /docs serves docs.html
    // even though the rule /docs keeps the docs/ folder out of the deploy.
    const rel = '/' + file.slice(ROOT.length + 1);
    for (const re of await ignoreRules()) if (re.test(rel)) return notFound(req, res);
    return serveFile(req, res, file, s.size);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendText(res, 500, 'Internal error');
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`port ${PORT} is already in use by another server: not starting. Pick your own with PORT=<port>.`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`ponchem dev  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
});
