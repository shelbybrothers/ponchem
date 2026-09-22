// js/pages/report.js: the cancer research report from chain.report(), printable, with a Markdown download.
import {
  boot, catalog, chain, el, F, STR, EMPTY, CANCERS, cancerKey, cancerName, milliOf, lookup, empty, table, dgCell, pkdText, leText,
  targetHref, ligandHref, rcsbImage, ligandMedia, fileExists, download, toast, utcStamp, targetName, onRefresh, chainNote,
  rcsbStructureLink, ligandSourceLink, runLink, runHref, allReviews, reviewStatsByRun, reviewsCell,
} from './common.js';

boot();
const $ = (s) => document.querySelector(s);
let cat = null;
let report = null;
let reviewStats = new Map();

function groupRows(g) {
  return (g.bestPairs || []).slice().sort((a, b) => milliOf(a) - milliOf(b)).slice(0, 10);
}

function compact(kind, entity, run) {
  const media = kind === 'target'
    ? el('div', { class: 'pc-card-media' }, el('img', { src: rcsbImage(entity), alt: `RCSB entry image for ${entity.pdbId}`, loading: 'lazy' }))
    : ligandMedia(entity);
  const card = el('a', { class: 'pc-card pc-card--link pc-report-compact', href: kind === 'target' ? targetHref(entity) : ligandHref(entity) }, [
    media,
    el('div', { class: 'pc-report-compact-body' }, [
      el('span', { class: 'pc-eyebrow' }, kind === 'target' ? 'Target' : 'Ligand'),
      el('span', { class: 'pc-h4' }, kind === 'target' ? targetName(entity) : entity.name),
      el('span', { class: 'pc-caption' }, kind === 'target' ? `${entity.pdbId} · ${F.num(entity.resolution, { digits: 2 })} A` : (entity.formula || '')),
      run ? dgCell(milliOf(run), { unit: true }) : null,
    ]),
  ]);
  const links = el('div', { class: 'pc-report-compact-links pc-row' }, [kind === 'target' ? rcsbStructureLink(entity.pdbId, 'pc-link pc-link--out pc-small') : ligandSourceLink(entity, 'pc-link pc-link--out pc-small'), run ? runLink(run.id, `Test #${run.id}`, 'pc-link pc-small') : null]);
  return el('div', { class: 'pc-report-compact-wrap' }, [card, links]);
}

function groupSection(g) {
  const key = cancerKey(g.key || g.name);
  const rows = groupRows(g);
  const targets = g.targets || [];
  const runs = targets.reduce((n, t) => n + Number(t.runs || 0), 0);
  const wallets = g.wallets !== undefined ? Number(g.wallets) : targets.reduce((n, t) => n + Number(t.wallets || 0), 0);
  const section = el('section', { class: 'pc-card pc-report-group', id: `group-${key}` }, [el('h2', { class: 'pc-h2' }, cancerName(g.name || g.key))]);
  if (!rows.length) { section.append(empty(EMPTY.report)); return section; }
  const best = rows[0];
  const t = lookup(cat.targetById, Number(best.targetId));
  const l = lookup(cat.ligandById, Number(best.ligandId));
  section.append(
    el('div', { class: 'pc-eyebrow' }, 'Best pair'),
    el('div', { class: 'pc-report-pair' }, [t ? compact('target', t, best) : null, l ? compact('ligand', l, best) : null]),
    table({
      caption: 'Top ten pairs by binding free energy',
      columns: [
        { label: 'Rank', cls: 'pc-rank', render: (r, i) => el('span', { class: `pc-rank${i < 3 ? ' pc-rank--top' : ''}` }, String(i + 1)) },
        { label: 'Target', name: true, render: (r) => { const x = lookup(cat.targetById, Number(r.targetId)); return x ? el('span', { class: 'pc-td-links' }, [el('a', { href: targetHref(x) }, [el('span', { class: 'pc-td-id' }, x.pdbId), ' ', x.gene || x.key]), rcsbStructureLink(x.pdbId, 'pc-link pc-link--out pc-small')]) : String(r.targetId); } },
        { label: 'Ligand', name: true, render: (r) => { const x = lookup(cat.ligandById, Number(r.ligandId)); return x ? el('span', { class: 'pc-td-links' }, [el('a', { href: ligandHref(x) }, x.name), ligandSourceLink(x, 'pc-link pc-link--out pc-small')]) : String(r.ligandId); } },
        { label: 'dG (kcal/mol)', num: true, render: (r) => dgCell(milliOf(r)) },
        { label: 'pKd', num: true, render: (r) => pkdText(milliOf(r)) },
        { label: 'LE', num: true, render: (r) => { const x = lookup(cat.ligandById, Number(r.ligandId)); return leText(milliOf(r), x && x.heavyAtoms); } },
        { label: 'Runs', num: true, render: (r) => { const tt = targets.find((x) => Number(x.id) === Number(r.targetId)); return tt ? F.num(tt.runs || 0) : F.EMPTY; } },
        { label: 'Wallets', num: true, render: (r) => { const tt = targets.find((x) => Number(x.id) === Number(r.targetId)); return tt ? F.num(tt.wallets || 0) : F.EMPTY; } },
        { label: 'Reviews', render: (r) => reviewsCell(reviewStats.get(Number(r.id))) },
        { label: 'Test', mono: true, render: (r) => (r.id !== undefined && r.id !== null ? runLink(r.id) : F.EMPTY) },
      ],
      rows,
    }),
    el('p', { class: 'pc-report-foot' }, `${F.num(runs)} runs · ${F.num(wallets)} wallets · ${F.num(targets.length)} targets in this group`),
  );
  return section;
}

function renderReport() {
  const body = $('[data-body]');
  const toc = $('[data-toc]');
  const jump = $('[data-jump]');
  const groups = report && Array.isArray(report.cancers) && report.cancers.length ? report.cancers : CANCERS.map((c) => ({ key: c.key, name: c.name, targets: [], bestPairs: [] }));
  body.replaceChildren(...groups.map(groupSection));
  toc.replaceChildren(el('div', { class: 'pc-eyebrow', style: { marginBottom: '8px' } }, 'Groups'), ...groups.map((g) => el('a', { href: `#group-${cancerKey(g.key || g.name)}` }, cancerName(g.name || g.key))));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  jump.replaceChildren(...groups.map((g) => el('option', { value: `#group-${cancerKey(g.key || g.name)}` }, cap(cancerName(g.name || g.key)))));
}

function markdown() {
  const stamp = utcStamp();
  const blockNo = report ? (report.head ?? report.block) : null;
  const block = blockNo !== null && blockNo !== undefined ? F.num(blockNo) : F.EMPTY;
  const lines = [`Ponchem cancer research report, compiled from Robinhood Chain at block ${block} on ${stamp} UTC. Estimates from computational screening with a Vina-style scoring function. Not clinical results.`, ''];
  const groups = report && report.cancers ? report.cancers : [];
  for (const g of groups) {
    lines.push(`## ${cancerName(g.name || g.key)}`, '');
    const rows = groupRows(g);
    if (!rows.length) { lines.push('Nothing recorded for this group yet.', ''); continue; }
    lines.push('| Rank | Target | PDB | Ligand | dG (kcal/mol) | pKd | LE | Reviews | Test |', '|---|---|---|---|---|---|---|---|---|');
    rows.forEach((r, i) => {
      const t = lookup(cat.targetById, Number(r.targetId));
      const l = lookup(cat.ligandById, Number(r.ligandId));
      const rs = reviewStats.get(Number(r.id));
      lines.push(`| ${i + 1} | ${t ? t.gene || t.key : r.targetId} | ${t ? t.pdbId : ''} | ${l ? l.name : r.ligandId} | ${(milliOf(r) / 1000).toFixed(3)} | ${pkdText(milliOf(r))} | ${leText(milliOf(r), l && l.heavyAtoms)} | ${rs && rs.count ? `${rs.avg.toFixed(1)} (${rs.count})` : ''} | ${runHref(r.id).replace('/run', 'https://ponchem.ai/run')} |`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

$('[data-print]').addEventListener('click', () => window.print());
$('[data-jump]').addEventListener('change', (e) => { const t = document.querySelector(e.target.value); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('[data-download]').addEventListener('click', async (e) => {
  const ok = await fileExists('/api/report.md');
  if (ok) { toast('Markdown downloaded', { kind: 'success' }); return; }
  e.preventDefault();
  download('ponchem-report.md', markdown(), 'text/markdown');
  toast('Markdown downloaded', { kind: 'success' });
});

async function refresh() {
  const [r, rv] = await Promise.all([chain('report'), allReviews()]);
  report = r.ok ? r.value : null;
  reviewStats = reviewStatsByRun(rv.list);
  const note = $('[data-chain-note]');
  const compiled = $('[data-compiled]');
  if (report) {
    const when = report.generatedAt ? new Date(report.generatedAt) : new Date();
    const head = report.head ?? report.block;
    compiled.textContent = `Compiled from Robinhood Chain · block ${head !== null && head !== undefined ? F.num(head) : F.EMPTY} · ${utcStamp(when)} UTC`;
    $('[data-print-header]').textContent = `Ponchem · Cancer research report · ${utcStamp(when).slice(0, 10)}`;
  } else {
    compiled.textContent = `Compiled from Robinhood Chain · ${utcStamp()} UTC`;
  }
  renderReport();
  if (!report || report.live === false) {
    const p = el('p', { class: 'pc-alert pc-alert--warn' }, chainNote(r));
    $('[data-body]').prepend(p);
  }
}

catalog().then(async (c) => {
  cat = c;
  await refresh();
  onRefresh(refresh);
}).catch(() => { $('[data-body]').replaceChildren(el('p', { class: 'pc-alert pc-alert--bad' }, STR.catalogFailed)); });
