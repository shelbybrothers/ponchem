// js/pages/home.js: the landing page (hero structure, stat strip, five weights, featured targets, token state).
import {
  boot, reveal, catalog, chain, weights, el, F, STR, dayIndex, mountStructure, rcsbEntry, targetCard, milliOf, lookup,
  methodShort, targetName, TOKEN, isLive, isUnreachable, allReviews,
} from './common.js';

boot();
reveal();

const $ = (s) => document.querySelector(s);

// weights: from js/engine/derived.js when it exists, else the local constant equal to SPEC-ENGINE
weights().then((w) => {
  w.forEach(([, value], i) => {
    const cell = document.querySelector(`[data-weight="${i}"]`);
    if (cell) cell.textContent = String(value);
  });
});

// stat strip
const statNode = (k) => document.querySelector(`[data-stat="${k}"]`);
const setStat = (k, text, unit) => {
  const n = statNode(k);
  if (!n) return;
  n.replaceChildren(...[document.createTextNode(text), unit ? el('span', { class: 'pc-stat-unit' }, unit) : null].filter(Boolean));
};
const unreachable = (k) => {
  const label = document.querySelector(`[data-stat-label="${k}"]`);
  if (label && !label.querySelector('.pc-unreach')) label.append(' ', el('span', { class: 'pc-unreach' }, STR.unreachSuffix));
};

let cat = null;
catalog().then((c) => {
  cat = c;
  setStat('targets', F.num(c.targets.length));
  setStat('ligands', F.num(c.ligands.length));
  hero(c);
}).catch(() => {
  setStat('targets', '·');
  setStat('ligands', '·');
  $('[data-hero-title]').textContent = STR.catalogFailed;
});

const statusP = chain('labStatus');
statusP.then((s) => {
  if (isLive(s)) {
    setStat('runs', F.num(s.value.runCount ?? 0));
    setStat('pools', F.units(s.value.poolTotal ?? 0n, 18, 4), 'ETH');
    const fee = s.value.runFee !== undefined && s.value.runFee !== null && BigInt(s.value.runFee) > 0n ? F.units(s.value.runFee, 18, 6) : null;
    const price = s.value.runPrice !== undefined && s.value.runPrice !== null && BigInt(s.value.runPrice) > 0n ? F.units(s.value.runPrice, 18, 2) : null;
    if (fee || price) {
      const p = $('[data-price-line]');
      p.textContent = `On chain now: a docking test costs ${price ? `${price} $${TOKEN.symbol}` : `$${TOKEN.symbol} after the launch`} or ${fee || '0.0001'} ETH.`;
      p.hidden = false;
    }
  } else {
    setStat('runs', '·');
    setStat('pools', '·', 'ETH');
    if (isUnreachable(s)) { unreachable('runs'); unreachable('pools'); unreachable('reviews'); }
  }
});

// reviews: every Reviewed event (data layer v2); the cell reads · until the reviews index exists
statusP.then(async (s) => {
  if (!isLive(s)) { setStat('reviews', '·'); return; }
  const r = await allReviews();
  setStat('reviews', r.ok ? F.num(r.list.length) : '·');
});

// featured targets: the six best scored this epoch, else the first six of the catalog
Promise.all([catalog(), statusP, chain('bests'), chain('pools')]).then(([c, s, b, p]) => {
  const host = $('[data-featured]');
  const byTarget = b.ok && b.value ? b.value.byTarget : null;
  const byEpoch = b.ok && b.value ? b.value.byTargetEpoch : null;
  const pools = p.ok ? p.value : null;
  let picks = [];
  if (byEpoch && s.ok && s.value && s.value.epoch !== undefined) {
    const epoch = Number(s.value.epoch);
    const rows = [];
    for (const [k, run] of byEpoch instanceof Map ? byEpoch.entries() : Object.entries(byEpoch)) {
      const [tid, e] = String(k).split(':').map(Number);
      if (e === epoch && run) rows.push([tid, milliOf(run)]);
    }
    rows.sort((x, y) => x[1] - y[1]);
    picks = rows.map(([tid]) => lookup(c.targetById, tid)).filter(Boolean).slice(0, 6);
  }
  if (picks.length < 6) for (const t of c.targets) { if (picks.length >= 6) break; if (!picks.includes(t)) picks.push(t); }
  host.replaceChildren(...picks.map((t) => targetCard(t, { best: byTarget ? lookup(byTarget, t.id) : null, pool: pools ? lookup(pools, t.id) : null })));
}).catch(() => { const host = $('[data-featured]'); if (host) host.replaceChildren(); });

// hero: one real structure with its reference ligand, deterministic per day, Next structure cycles
let heroHandle = null;
let heroIdx = 0;
let candidates = [];
async function showHero(i) {
  const t = candidates[i];
  if (!t) return;
  const viewer = $('[data-hero-viewer]');
  $('[data-hero-id]').textContent = t.pdbId;
  $('[data-hero-title]').textContent = t.title || targetName(t);
  $('[data-hero-rcsb]').href = rcsbEntry(t.pdbId);
  $('[data-hero-caption]').textContent = `In the viewer: ${t.pdbId} · ${t.title || targetName(t)} · ${F.num(t.resolution, { digits: 2 })} A · ${methodShort(t.method)}`;
  if (heroHandle) { try { heroHandle.destroy(); } catch { /* gone */ } heroHandle = null; }
  const mine = ++heroSeq;
  const h = await mountStructure(viewer, { pdbId: t.pdbId, refCcd: t.ligand && t.ligand.ccd, chain: t.chain, image: t.image, transparent: true, spin: true, frameAll: true });
  if (mine !== heroSeq) { try { h.destroy(); } catch { /* gone */ } return; }
  heroHandle = h;
}
let heroSeq = 0;
function hero(c) {
  candidates = c.targets.filter((t) => t.ligand && t.ligand.ccd && /x-ray/i.test(t.method || '') && t.resolution && t.resolution <= 3.0);
  if (!candidates.length) candidates = c.targets.slice();
  heroIdx = dayIndex(candidates.length);
  showHero(heroIdx);
  $('[data-hero-next]').addEventListener('click', () => { heroIdx = (heroIdx + 1) % candidates.length; showHero(heroIdx); });
}
