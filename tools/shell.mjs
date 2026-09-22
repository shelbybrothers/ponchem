#!/usr/bin/env node
/*
 * shell.mjs: stamp the shared head tags, nav and footer into every page, so they exist once (partials/*.html).
 *
 *   node tools/shell.mjs            rewrite the regions in every root *.html
 *   node tools/shell.mjs --check    exit 1 if a page is out of date (writes nothing)
 *
 * A page opts in with marker comments; whatever sits between them is replaced. One region per partial file:
 *   <!-- shell:head -->    ...  <!-- /shell:head -->      partials/head.html     (inside <head>, after the page's own
 *                                                          <title>, description, canonical and og:* tags)
 *   <!-- shell:nav -->     ...  <!-- /shell:nav -->       partials/nav.html      (first thing in <body>)
 *   <!-- shell:footer -->  ...  <!-- /shell:footer -->    partials/footer.html   (after <main>)
 * Any other partials/<name>.html is a region <!-- shell:<name> --> too.
 *
 * partials are written in the blank $PONCHEM state (Buy inert and reading soon, Copy CA disabled). Once TOKEN in
 * js/config.js carries a CA and a buy link, every [data-shell="buy"] and [data-shell="ca"] is stamped live, so a
 * page is right before any script runs. js/shell.js does the same at run time from the same TOKEN and wires the copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const PARTIALS = path.join(ROOT, 'partials');
const names = fs.existsSync(PARTIALS) ? fs.readdirSync(PARTIALS).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)) : [];
if (!names.length) { console.error('shell.mjs: partials/ has no *.html'); process.exit(2); }
const parts = Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(PARTIALS, `${n}.html`), 'utf8').replace(/\s+$/, '')]));

const { TOKEN } = await import(path.join(ROOT, 'js/config.js'));
if (TOKEN.ca && TOKEN.buyUrl) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const keepClass = (tag) => { const m = /\sclass="([^"]*)"/.exec(tag); return m ? ` class="${m[1]}"` : ''; };
  let stamped = 0;
  for (const n of names) {
    parts[n] = parts[n]
      .replace(/<a\b[^>]*data-shell="buy"[^>]*>[\s\S]*?<\/a>/g, (tag) => { stamped++; return `<a${keepClass(tag)} data-shell="buy" href="${esc(TOKEN.buyUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Buy $${esc(TOKEN.symbol)}">Buy $${esc(TOKEN.symbol)}</a>`; })
      .replace(/<button\b[^>]*data-shell="ca"[^>]*>[\s\S]*?<\/button>/g, (tag) => { stamped++; return `<button type="button"${keepClass(tag)} data-shell="ca" aria-label="Copy the $${esc(TOKEN.symbol)} CA">Copy CA</button>`; });
  }
  if (!stamped) { console.error('shell.mjs: no partial has a data-shell="buy" / data-shell="ca" control to stamp'); process.exit(2); }
}

let stale = 0;
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
for (const file of pages) {
  const full = path.join(ROOT, file);
  const before = fs.readFileSync(full, 'utf8');
  let after = before;
  for (const [name, html] of Object.entries(parts)) {
    const re = new RegExp(`([ \\t]*)<!-- shell:${name} -->[\\s\\S]*?<!-- /shell:${name} -->`, 'g');
    after = after.replace(re, (_, indent) => `${indent}<!-- shell:${name} -->\n${html}\n${indent}<!-- /shell:${name} -->`);
  }
  for (const name of ['head', 'nav', 'footer']) {
    if (parts[name] && !after.includes(`<!-- shell:${name} -->`)) console.error(`note: ${file} has no <!-- shell:${name} --> region`);
  }
  if (after !== before) {
    stale++;
    if (CHECK) console.error(`${file} is out of date: run node tools/shell.mjs`);
    else { fs.writeFileSync(full, after); console.log(`stamped ${file}`); }
  }
}
if (CHECK && stale) process.exit(1);
if (!pages.length) console.log('no root *.html yet: nothing to stamp (partials are valid)');
else if (!stale) console.log(`every page carries the current shell (${pages.length} pages)`);
