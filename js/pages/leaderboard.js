// js/pages/leaderboard.js: best binders by target, cancer group and ligand; most active wallets; pools with Sponsor and Settle.
import {
  boot, catalog, chain, el, F, STR, EMPTY, CANCERS, cancerKey, cancerName, milliOf, lookup, empty, table, runsTable, walletCell, dgCell,
  targetHref, ligandHref, targetName, countdownTo, onRefresh, sponsor, settle, download, csv, toast, pkdText, leText, isMe, chainNote,
  gamify, gamifyData, reviewStatsByRun, runLink, runHref, stars,
} from './common.js';

boot({ onWallet: () => render() });
const $ = (s) => document.querySelector(s);

const state = { view: 'target', cancer: CANCERS[0].key, showTable: false, cat: null, status: null, bests: null, pools: null, runs: [], statusResult: null, game: null, G: null, reviewStats: new Map() };
let stopCountdown = () => {};

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-selected', b.dataset.view === v ? 'true' : 'false');
  $('[data-view-select]').value = v;
  $('[data-cancer-tabs]').hidden = v !== 'cancer';
  if (history.replaceState) history.replaceState(null, '', `#${v}`);
  render();
}
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
$('[data-view-select]').addEventListener('change', (e) => setView(e.target.value));

function cancerPills() {
  const host = $('[data-cancer-tabs]');
  host.replaceChildren(...CANCERS.map((c) => el('button', { type: 'button', class: 'pc-pill pc-pill--receptor', 'aria-pressed': state.cancer === c.key ? 'true' : 'false', onclick: () => { state.cancer = c.key; cancerPills(); render(); } }, c.name)));
}

const live = () => !!(state.status && state.status.live !== false);
const bestRows = (map) => (map instanceof Map ? [...map.values()] : Object.values(map || {})).filter(Boolean).sort((a, b) => milliOf(a) - milliOf(b));

function phoneCards(runs, { target = true, ligand = true } = {}) {
  const cat = state.cat;
  return el('div', { class: 'pc-lb-cards' }, runs.slice(0, 25).map((r, i) => {
    const t = lookup(cat.targetById, Number(r.targetId));
    const l = lookup(cat.ligandById, Number(r.ligandId));
    const pair = [target && t ? `${t.pdbId} ${t.gene || t.key}` : null, ligand && l ? l.name : null].filter(Boolean).join(' · ');
    return el('div', { class: `pc-card pc-lb-card${isMe(r.wallet) ? ' pc-tr-you' : ''}` }, [
      el('span', { class: `pc-rank${i < 3 ? ' pc-rank--top' : ''}` }, String(i + 1)),
      el('div', { class: 'pc-lb-card-main' }, [
        el('a', { class: 'pc-td-name', href: t && target ? targetHref(t) : l ? ligandHref(l) : '#' }, pair || F.EMPTY),
        el('span', { class: 'pc-caption' }, [walletCell(r.wallet), ` · pKd ${pkdText(milliOf(r))} · `, runLink(r.id, `test #${r.id}`, 'pc-link')]),
      ]),
      dgCell(milliOf(r)),
    ]);
  }));
}

function boardWithCards(runs, opts) {
  const tbl = runsTable(runs, state.cat, { ...opts, bars: true, reviews: state.reviewStats.size ? state.reviewStats : null });
  tbl.classList.add('pc-lb-table');
  tbl.hidden = !state.showTable;
  const toggle = el('div', { class: 'pc-lb-toggle' }, el('button', { type: 'button', class: 'pc-btn pc-btn--ghost pc-btn--sm', onclick: () => { state.showTable = !state.showTable; render(); } }, state.showTable ? 'Show cards' : 'Show table'));
  const cards = phoneCards(runs, opts);
  cards.hidden = state.showTable;
  return el('div', {}, [toggle, cards, tbl]);
}

function render() {
  const board = $('[data-board]');
  const note = $('[data-chain-note]');
  if (!state.cat) return;
  note.hidden = true;
  if (!live()) {
    note.textContent = chainNote(state.statusResult);
    note.hidden = false;
    board.replaceChildren(state.view === 'pools' ? poolsTable() : empty(EMPTY.leaderboard));
    return;
  }
  const bests = state.bests || {};
  if (state.view === 'target') {
    const rows = bestRows(bests.byTarget);
    board.replaceChildren(rows.length ? boardWithCards(rows, { target: true, ligand: true }) : empty(EMPTY.leaderboard));
  } else if (state.view === 'ligand') {
    const rows = bestRows(bests.byLigand);
    board.replaceChildren(rows.length ? boardWithCards(rows, { target: true, ligand: true }) : empty(EMPTY.leaderboard));
  } else if (state.view === 'cancer') {
    const rows = bestRows(bests.byTarget).filter((r) => { const t = lookup(state.cat.targetById, Number(r.targetId)); return t && (t.cancers || []).some((c) => cancerKey(c) === state.cancer); });
    board.replaceChildren(el('h2', { class: 'pc-h3 pc-cap', style: { marginBottom: '12px' } }, cancerName(state.cancer)), rows.length ? boardWithCards(rows, { target: true, ligand: true }) : empty(EMPTY.report));
  } else if (state.view === 'wallets') {
    board.replaceChildren(walletsTable());
  } else if (state.view === 'reviewed') {
    board.replaceChildren(reviewedList());
  } else {
    board.replaceChildren(poolsTable());
  }
}

function walletsTable() {
  const G = state.G;
  const rows = G && state.game ? G.rank(state.game).slice(0, 50) : [];
  if (!rows.length) return empty(EMPTY.wallets);
  return el('div', { class: 'pc-stack' }, [
    table({
      caption: 'Wallets by XP',
      rowClass: (r) => (isMe(r.wallet) ? 'pc-tr-you' : null),
      columns: [
        { label: 'Rank', cls: 'pc-rank', render: (r, i) => el('span', { class: `pc-rank${i < 3 ? ' pc-rank--top' : ''}` }, String(i + 1)) },
        { label: 'Wallet', mono: true, render: (r) => walletCell(r.wallet) },
        { label: 'Level', render: (r) => (r.level && r.level.name) || G.levelOf(r.xp).name },
        { label: 'XP', num: true, render: (r) => F.num(r.xp) },
        { label: 'Tests', num: true, render: (r) => F.num(r.tests) },
        { label: 'dG (kcal/mol)', num: true, render: (r) => (r.best === null || r.best === undefined ? F.EMPTY : dgCell(r.best)) },
      ],
      rows,
    }),
    el('p', { class: 'pc-caption' }, ['XP and levels follow the rules in the docs: ', el('a', { class: 'pc-link', href: '/docs#levels' }, 'Levels and badges'), '.']),
  ]);
}

function reviewedList() {
  const cat = state.cat;
  const byRun = state.reviewStats;
  const rows = [...byRun.entries()].map(([id, s]) => ({ id, s, run: state.runs.find((r) => Number(r.id) === Number(id)) || null })).filter((x) => x.s.count > 0)
    .sort((a, b) => b.s.count - a.s.count || b.s.avg - a.s.avg || a.id - b.id).slice(0, 25);
  if (!rows.length) return empty(EMPTY.mostReviewed);
  return el('div', { class: 'pc-stack' }, [
    el('h2', { class: 'pc-h3' }, 'Most reviewed tests'),
    table({
      caption: 'Most reviewed tests',
      rowClass: (x) => (x.run && isMe(x.run.wallet) ? 'pc-tr-you' : null),
      columns: [
        { label: 'Rank', cls: 'pc-rank', render: (x, i) => el('span', { class: `pc-rank${i < 3 ? ' pc-rank--top' : ''}` }, String(i + 1)) },
        { label: 'Test', mono: true, render: (x) => runLink(x.id) },
        { label: 'Pair', name: true, render: (x) => { if (!x.run) return F.EMPTY; const t = lookup(cat.targetById, Number(x.run.targetId)); const l = lookup(cat.ligandById, Number(x.run.ligandId)); return el('a', { href: runHref(x.id) }, `${l ? l.name : x.run.ligandId} into ${t ? t.gene || t.key : x.run.targetId}`); } },
        { label: 'dG (kcal/mol)', num: true, render: (x) => (x.run ? dgCell(milliOf(x.run)) : F.EMPTY) },
        { label: 'Stars', render: (x) => el('span', { class: 'pc-review-cell' }, [stars(x.s.avg, { size: 14 }), el('span', { class: 'pc-td-mono' }, F.fixed(x.s.avg, 1))]) },
        { label: 'Reviews', num: true, render: (x) => F.num(x.s.count) },
      ],
      rows,
    }),
  ]);
}

function poolsTable() {
  const cat = state.cat;
  const pools = state.pools;
  const epoch = state.status ? Number(state.status.epoch) : null;
  const end = state.status ? Number(state.status.epochEnd) : null;
  const ended = end !== null && Date.now() / 1000 >= end;
  const rows = cat.targets.map((t) => {
    const pool = pools ? lookup(pools, t.id) : null;
    const bestEpoch = state.bests && epoch !== null ? lookup(state.bests.byTargetEpoch, `${t.id}:${epoch}`) : null;
    const prev = state.bests && epoch !== null && epoch > 0 ? lookup(state.bests.byTargetEpoch, `${t.id}:${epoch - 1}`) : null;
    return { t, pool, bestEpoch, prev };
  }).sort((a, b) => Number((b.pool || 0n) - (a.pool || 0n)) || targetName(a.t).localeCompare(targetName(b.t)));
  const shown = rows.filter((r) => r.pool && BigInt(r.pool) > 0n);
  const list = (shown.length ? shown : rows.slice(0, 25));
  const sponsorCell = (r) => {
    const form = el('form', { class: 'pc-input-row', onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.setAttribute('aria-busy', 'true');
      const res = await sponsor(r.t.id, form.querySelector('input').value, { label: r.t.gene || r.t.key });
      btn.removeAttribute('aria-busy');
      if (res && res.status === 'success') refresh();
    } }, [
      el('input', { class: 'pc-input pc-input--mono', type: 'text', inputmode: 'decimal', placeholder: '0.01', 'aria-label': `Amount in ETH for ${r.t.gene || r.t.key}`, style: { minHeight: '36px', width: '110px' } }),
      el('button', { type: 'submit', class: 'pc-btn pc-btn--receptor pc-btn--sm' }, 'Sponsor'),
    ]);
    return form;
  };
  const settleCell = (r) => {
    const canSettle = live() && ((r.prev && r.pool && BigInt(r.pool) > 0n) || (ended && r.bestEpoch));
    if (!canSettle) return el('span', { class: 'pc-muted pc-small' }, r.bestEpoch ? 'Epoch running' : STR.noRunsEpoch);
    const e = ended && r.bestEpoch ? epoch : epoch - 1;
    return el('button', { type: 'button', class: 'pc-btn pc-btn--outline pc-btn--sm', onclick: async (ev) => { ev.target.setAttribute('aria-busy', 'true'); await settle(r.t.id, e); refresh(); } }, 'Settle');
  };
  return table({
    caption: 'Prize pools',
    columns: [
      { label: 'Target', name: true, render: (r) => el('a', { href: targetHref(r.t) }, [el('span', { class: 'pc-td-id' }, r.t.pdbId), ' ', r.t.gene || r.t.key]) },
      { label: 'Pool (ETH)', num: true, render: (r) => (r.pool === null || r.pool === undefined ? '·' : F.units(r.pool, 18, 5)) },
      { label: 'Best this epoch', render: (r) => (r.bestEpoch ? el('span', { class: 'pc-row' }, [dgCell(milliOf(r.bestEpoch)), walletCell(r.bestEpoch.wallet)]) : el('span', { class: 'pc-muted pc-small' }, 'No runs this epoch yet')) },
      { label: 'Sponsor', wide: true, render: sponsorCell },
      { label: 'Settle', render: settleCell },
    ],
    rows: list,
  });
}

function exportCsv() {
  const cat = state.cat;
  const rows = [['rank', 'target', 'pdb', 'ligand', 'dG_kcal_mol', 'pKd', 'LE', 'wallet', 'run_id']];
  const src = state.view === 'ligand' ? bestRows((state.bests || {}).byLigand) : bestRows((state.bests || {}).byTarget);
  src.forEach((r, i) => {
    const t = lookup(cat.targetById, Number(r.targetId));
    const l = lookup(cat.ligandById, Number(r.ligandId));
    rows.push([i + 1, t ? t.gene || t.key : r.targetId, t ? t.pdbId : '', l ? l.name : r.ligandId, (milliOf(r) / 1000).toFixed(3), pkdText(milliOf(r)), leText(milliOf(r), l && l.heavyAtoms), r.wallet, r.id]);
  });
  download(`ponchem-leaderboard-${state.view}.csv`, csv(rows), 'text/csv');
  toast('CSV downloaded', { kind: 'success' });
}
$('[data-csv]').addEventListener('click', exportCsv);

async function refresh() {
  const [s, b, p, r] = await Promise.all([chain('labStatus'), chain('bests'), chain('pools'), chain('runs', { limit: 1000 })]);
  state.status = s.ok ? s.value : null;
  state.statusResult = s;
  state.bests = b.ok ? b.value : null;
  state.pools = p.ok ? p.value : null;
  state.runs = r.ok && Array.isArray(r.value) ? r.value : [];
  if (live()) {
    if (!state.G) state.G = await gamify();
    state.game = await gamifyData();
    state.reviewStats = reviewStatsByRun(state.game.reviews);
  } else { state.game = null; state.reviewStats = new Map(); }
  stopCountdown();
  const ep = $('[data-epoch]');
  if (live() && state.status.epochEnd) stopCountdown = countdownTo(Number(state.status.epochEnd), ep, { ended: 'Epoch ended, ready to settle' });
  else ep.textContent = '';
  render();
}

catalog().then(async (c) => {
  state.cat = c;
  cancerPills();
  const h = location.hash.replace('#', '');
  if (['target', 'cancer', 'ligand', 'wallets', 'reviewed', 'pools'].includes(h)) setView(h);
  await refresh();
  onRefresh(refresh);
}).catch(() => { $('[data-board]').replaceChildren(el('p', { class: 'pc-alert pc-alert--bad' }, STR.catalogFailed)); });
