// js/pages/targets.js: the target library with search, cancer and class filters, sort and paging.
import { boot, catalog, chain, el, F, STR, EMPTY, CANCERS, cancerKey, cancerName, targetCard, targetName, milliOf, lookup, empty, isUnreachable } from './common.js';

boot();
const $ = (s) => document.querySelector(s);
const PAGE = 24;

const state = { q: '', cancer: null, cls: null, sort: 'best', shown: PAGE, bests: null, pools: null, runs: new Map() };
let all = [];

const grid = $('[data-grid]');
const count = $('[data-count]');
const emptyHost = $('[data-empty]');
const more = $('[data-more]');
const note = $('[data-chain-note]');

function pill(label, pressed, onclick, cls = '') {
  return el('button', { type: 'button', class: `pc-pill ${cls}`.trim(), 'aria-pressed': pressed ? 'true' : 'false', onclick }, label);
}

function renderPills() {
  const present = new Map();
  for (const t of all) for (const c of t.cancers || []) { const k = cancerKey(c); present.set(k, (present.get(k) || 0) + 1); }
  const host = $('[data-pills]');
  host.replaceChildren(
    pill('All cancers', state.cancer === null, () => { state.cancer = null; state.shown = PAGE; renderPills(); render(); }, 'pc-pill--receptor'),
    ...CANCERS.filter((c) => present.has(c.key)).map((c) => pill(`${c.name} (${present.get(c.key)})`, state.cancer === c.key, () => { state.cancer = state.cancer === c.key ? null : c.key; state.shown = PAGE; renderPills(); render(); }, 'pc-pill--receptor')),
  );
  const classes = new Map();
  for (const t of all) if (t.class) classes.set(t.class, (classes.get(t.class) || 0) + 1);
  const ch = $('[data-classes]');
  ch.replaceChildren(
    pill('All classes', state.cls === null, () => { state.cls = null; state.shown = PAGE; renderPills(); render(); }),
    ...[...classes.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => pill(`${k} (${n})`, state.cls === k, () => { state.cls = state.cls === k ? null : k; state.shown = PAGE; renderPills(); render(); })),
  );
}

const bestOf = (t) => (state.bests ? milliOf(lookup(state.bests.byTarget, t.id)) : null);
const poolOf = (t) => (state.pools ? lookup(state.pools, t.id) : null);
const runsOf = (t) => state.runs.get(t.id) || 0;

function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = all.filter((t) => {
    if (state.cancer && !(t.cancers || []).some((c) => cancerKey(c) === state.cancer)) return false;
    if (state.cls && t.class !== state.cls) return false;
    if (!q) return true;
    const hay = [t.key, t.gene, t.protein, t.pdbId, t.title, t.uniprotName, t.entityDescription, t.ligand && t.ligand.name, ...(t.cancers || [])].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  const num = (v) => (v === null || v === undefined ? Infinity : Number(v));
  const bigNum = (v) => (v === null || v === undefined ? -1 : Number(BigInt(v)) / 1e18);
  if (state.sort === 'best') list.sort((a, b) => num(bestOf(a)) - num(bestOf(b)) || targetName(a).localeCompare(targetName(b)));
  else if (state.sort === 'pool') list.sort((a, b) => bigNum(poolOf(b)) - bigNum(poolOf(a)) || targetName(a).localeCompare(targetName(b)));
  else if (state.sort === 'runs') list.sort((a, b) => runsOf(b) - runsOf(a) || targetName(a).localeCompare(targetName(b)));
  else list.sort((a, b) => targetName(a).localeCompare(targetName(b)));
  return list;
}

function render() {
  const list = filtered();
  count.textContent = `${F.num(list.length)} targets`;
  const page = list.slice(0, state.shown);
  grid.replaceChildren(...page.map((t) => targetCard(t, { best: state.bests ? lookup(state.bests.byTarget, t.id) : null, pool: poolOf(t) })));
  emptyHost.replaceChildren();
  if (!list.length) {
    if (state.q.trim()) emptyHost.append(empty(EMPTY.search, () => { state.q = ''; $('[data-search]').value = ''; render(); }));
    else emptyHost.append(empty(EMPTY.filter, () => { state.cancer = null; state.cls = null; renderPills(); render(); }));
  }
  more.hidden = list.length <= state.shown;
}

$('[data-search]').addEventListener('input', (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
$('[data-sort]').addEventListener('change', (e) => { state.sort = e.target.value; state.shown = PAGE; render(); });
more.addEventListener('click', () => { state.shown += PAGE; render(); });

catalog().then(async (c) => {
  all = c.targets;
  const pre = new URLSearchParams(location.search).get('cancer');
  if (pre && CANCERS.some((x) => x.key === cancerKey(pre))) state.cancer = cancerKey(pre);
  renderPills();
  render();
  const [b, p, r] = await Promise.all([chain('bests'), chain('pools'), chain('runs', { limit: 1000 })]);
  if (b.ok) state.bests = b.value;
  if (p.ok) state.pools = p.value;
  if (r.ok && Array.isArray(r.value)) for (const run of r.value) state.runs.set(Number(run.targetId), (state.runs.get(Number(run.targetId)) || 0) + 1);
  if (isUnreachable(b) || isUnreachable(p)) { note.textContent = STR.unreachable; note.hidden = false; }
  render();
}).catch(() => { count.textContent = STR.catalogFailed; });

export { cancerName };
