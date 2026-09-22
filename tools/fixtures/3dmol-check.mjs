#!/usr/bin/env node
/*
 * 3dmol-check.mjs: does the self-hosted 3Dmol.js work under the production CSP, in real headless Chrome?
 *
 *   node tools/fixtures/3dmol-check.mjs              try the Chrome flag sets below in turn and report each
 *   node tools/fixtures/3dmol-check.mjs --flags "--use-angle=swiftshader --enable-unsafe-swiftshader"
 *
 * It serves the project root itself (with vercel.json's exact CSP on every answer, tools/ included), opens
 * tools/fixtures/3dmol-test.html in headless Chrome, and reads the 3DMOL_RESULT line the page logs: atom count of
 * 1M17 as parsed by 3Dmol against the file's ATOM/HETATM lines with altLoc blank or A, WebGL renderer, surface (blob: worker),
 * plus every console error and every CSP violation. Exit 0 when at least one flag set renders with WebGL.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage, sleep } from '../lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flagArg = (() => { const i = args.indexOf('--flags'); return i >= 0 ? args[i + 1] : null; })();
const FLAG_SETS = flagArg !== null ? [flagArg.split(/\s+/).filter(Boolean)] : [
  [],
  ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ['--use-angle=metal'],
];
const CHROME_PORT = Number(process.env.CHROME_PORT || 9531);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const CSP = cfg.headers.find((h) => h.source === '/(.*)').headers.find((h) => /^content-security-policy$/i.test(h.key)).value;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
  res.setHeader('content-security-policy', CSP);
  res.setHeader('cache-control', 'no-store');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`3Dmol check\n  serving ${ROOT} at ${base} with the production CSP\n  CSP: ${CSP}\n`);

let anyGood = false;
for (const flags of FLAG_SETS) {
  const label = flags.length ? flags.join(' ') : '(no GPU flags)';
  const profile = fs.mkdtempSync(path.join(fs.existsSync(path.join(ROOT, '.tmp')) ? path.join(ROOT, '.tmp') : os.tmpdir(), 'chrome-3dmol-'));
  let chrome;
  try {
    chrome = await launchChrome({ port: CHROME_PORT, profile, extraArgs: flags });
  } catch (e) {
    console.log(`  ${label}\n    Chrome did not start: ${e.message}`);
    continue;
  }
  const page = await openPage({ port: CHROME_PORT, width: 800, height: 600 });
  let result = null;
  const violations = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
    if (text.startsWith('3DMOL_RESULT ')) { try { result = JSON.parse(text.slice('3DMOL_RESULT '.length)); } catch { /* not JSON */ } }
  });
  page.on('Log.entryAdded', (p) => { const e = p.entry || {}; if (/Content Security Policy/i.test(e.text || '')) violations.push(e.text); });
  await page.goto(`${base}/tools/fixtures/3dmol-test.html`, { settle: 200 });
  const t0 = Date.now();
  while (!result && Date.now() - t0 < 60000) await sleep(200);
  const errors = page.errors.map((e) => `${e.kind}: ${e.text.slice(0, 200)}`);
  const failedReq = [...page.requests.values()].filter((q) => (q.failed && !q.canceled) || (q.status && q.status >= 400)).map((q) => `${q.status || q.errorText} ${q.url}`);
  console.log(`  ${label}\n    Chrome ${chrome.version}`);
  if (!result) console.log('    no 3DMOL_RESULT within 60 s');
  else console.log(`    ${JSON.stringify(result)}`);
  if (errors.length) console.log(`    console errors:\n      ${errors.join('\n      ')}`);
  if (violations.length) console.log(`    CSP violations:\n      ${violations.join('\n      ')}`);
  if (failedReq.length) console.log(`    failed requests:\n      ${failedReq.join('\n      ')}`);
  const good = !!(result && result.ok && result.webgl && result.atoms > 0 && result.atoms === result.expected && !violations.length && !errors.length);
  console.log(`    => ${good ? 'WORKS' : 'does not work'}\n`);
  anyGood = anyGood || good;
  await page.close();
  await chrome.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
server.close();
process.exit(anyGood ? 0 : 1);
