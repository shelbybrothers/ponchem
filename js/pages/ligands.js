// js/pages/ligands.js: the ligand library with search, class filter, sort and paging.
import { boot, catalog, chain, el, F, STR, EMPTY, ligandCard, milliOf, lookup, empty, isUnreachable } from './common.js';

boot();
const $ = (s) => document.querySelector(s);
const PAGE = 24;

const state = { q: '', cls: null, sort: 'best', shown: PAGE, bests: null, runs: new Map(), targetById: null };
let all = [];

const grid = $('[data-grid]');
const count = $('[data-count]');
const emptyHost = $('[data-empty]');
const more = $('[data-more]');
const note = $('[data-chain-note]');

function pill(label, pressed, onclick) {
  return el('button', { type: 'button', class: 'pc-pill', 'aria-pressed': pressed ? 'true' : 'false', onclick }, label);
}

function renderPills() {
  const classes = new Map();
  for (const l of all) if (l.class) classes.set(l.class, (classes.get(l.class) || 0) + 1);
  const host = $('[data-pills]');
  host.replaceChildren(
    pill('All classes', state.cls === null, () => { state.cls = null; state.shown = PAGE; renderPills(); render(); }),
    ...[...classes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => pill(`${k} (${n})`, state.cls === k, () => { state.cls = state.cls === k ? null : k; state.shown = PAGE; renderPills(); render(); })),
  );
}

const bestRun = (l) => (state.bests ? lookup(state.bests.byLigand, l.id) : null);
const bestOf = (l) => milliOf(bestRun(l));
const bestTarget = (l) => { const r = bestRun(l); return r && state.targetById ? lookup(state.targetById, Number(r.targetId)) : null; };
const runsOf = (l) => state.runs.get(l.id) || 0;

function filtered() {
  const q = state.q.trim().toLowerCase();
  const list = all.filter((l) => {
    if (state.cls && l.class !== state.cls) return false;
    if (!q) return true;
    const hay = [l.key, l.name, l.plant, l.latin, l.class, l.ccd, l.formula, l.mechanism].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  const num = (v) => (v === null || v === undefined ? Infinity : Number(v));
  if (state.sort === 'best') list.sort((a, b) => num(bestOf(a)) - num(bestOf(b)) || a.name.localeCompare(b.name));
  else if (state.sort === 'runs') list.sort((a, b) => runsOf(b) - runsOf(a) || a.name.localeCompare(b.name));
  else if (state.sort === 'heavy') list.sort((a, b) => (a.heavyAtoms || 0) - (b.heavyAtoms || 0) || a.name.localeCompare(b.name));
  else list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function render() {
  const list = filtered();
  count.textContent = `${F.num(list.length)} ligands`;
  grid.replaceChildren(...list.slice(0, state.shown).map((l) => ligandCard(l, { best: bestRun(l), bestTarget: bestTarget(l) })));
  emptyHost.replaceChildren();
  if (!list.length) {
    if (state.q.trim()) emptyHost.append(empty(EMPTY.search, () => { state.q = ''; $('[data-search]').value = ''; render(); }));
    else emptyHost.append(empty(EMPTY.filter, () => { state.cls = null; renderPills(); render(); }));
  }
  more.hidden = list.length <= state.shown;
}

$('[data-search]').addEventListener('input', (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
$('[data-sort]').addEventListener('change', (e) => { state.sort = e.target.value; state.shown = PAGE; render(); });
more.addEventListener('click', () => { state.shown += PAGE; render(); });

catalog().then(async (c) => {
  all = c.ligands;
  state.targetById = c.targetById;
  renderPills();
  render();
  const [b, r] = await Promise.all([chain('bests'), chain('runs', { limit: 1000 })]);
  if (b.ok) state.bests = b.value;
  if (r.ok && Array.isArray(r.value)) for (const run of r.value) state.runs.set(Number(run.ligandId), (state.runs.get(Number(run.ligandId)) || 0) + 1);
  if (isUnreachable(b)) { note.textContent = STR.unreachable; note.hidden = false; }
  render();
}).catch(() => { count.textContent = STR.catalogFailed; });
