// js/pages/target.js: one target (?id= registry id or key): provenance ladder, pool + sponsor, settle, tabs.
import {
  boot, qs, catalog, chain, el, F, STR, EMPTY, cancerName, captionOf, methodLong, targetName, milliOf, lookup, empty, ladder,
  rcsbImage, rcsbEntry, rcsbMolstar, doiUrl, outLink, setTitle, tabs, runsTable, walletCell, dgCell, mountStructure, sponsor, settle, rcsbLigandLink, rcsbStructureLink,
  countdownTo, onRefresh, W, PROTOCOL, labLive, runTime, isLive, chainNote,
} from './common.js';

boot({ onWallet: () => paintChain() });
const $ = (s) => document.querySelector(s);

let target = null;
let cat = null;
let status = null;
let viewerMounted = false;
let stopCountdown = () => {};

function unknown() {
  $('[data-page]').hidden = true;
  $('[data-unknown]').hidden = false;
  setTitle('Not found', STR.unknownTarget);
}

function paintStatic(t) {
  setTitle(`${t.gene || t.key} (${t.pdbId})`, `${targetName(t)}, PDB ${t.pdbId}, ${F.num(t.resolution, { digits: 2 })} A. Pocket, prize pool, epoch and the best recorded binders on Robinhood Chain.`);
  const img = el('img', { src: rcsbImage(t), alt: `RCSB entry image for ${t.pdbId}`, width: 400, height: 300 });
  $('[data-image]').replaceChildren(img, el('span', { class: 'pc-card-badge' }, t.pdbId));
  $('[data-image-links]').replaceChildren(outLink(rcsbEntry(t.pdbId), 'View on RCSB'), rcsbStructureLink(t.pdbId), outLink(rcsbMolstar(t.pdbId), 'Open in Mol* on rcsb.org'));
  $('[data-pdb-id]').textContent = t.pdbId;
  $('[data-title]').textContent = t.title || targetName(t);
  const pocket = t.box || t.atoms ? pocketLine(t) : null;
  $('[data-ladder]').replaceChildren(ladder([
    ['Target', targetName(t)],
    ['Cancer groups', (t.cancers || []).map(cancerName).join(', ') || F.EMPTY],
    t.organism ? ['Organism', t.organism] : null,
    ['Method', methodLong(t.method)],
    ['Resolution', t.resolution ? `${F.num(t.resolution, { digits: 2 })} A` : F.EMPTY, true],
    ['Reference ligand', t.ligand ? el('span', { class: 'pc-td-links' }, [el('span', {}, [el('span', { class: 'pc-td-id' }, t.ligand.ccd), t.ligand.name ? ` (${t.ligand.name})` : '', t.ligand.heavyAtoms ? el('span', { class: 'pc-muted' }, ` · ${t.ligand.heavyAtoms} heavy atoms`) : null]), t.ligand.ccd ? rcsbLigandLink(t.ligand.ccd) : null]) : F.EMPTY],
    t.chain ? ['Chain', t.chain, true] : null,
    t.released ? ['Released', t.released, true] : null,
    ['DOI', t.doi ? outLink(doiUrl(t.doi), t.doi) : F.EMPTY, true],
    pocket ? ['Pocket', pocket, true] : null,
    t.class ? ['Class', t.class] : null,
  ]));
  $('[data-dock]').href = `/lab?target=${encodeURIComponent(t.id)}`;
  $('[data-why]').textContent = t.why || '';
  $('[data-rcsb-link]').href = rcsbEntry(t.pdbId);
  $('.pc-viewer-strip .pc-viewer-title').textContent = `${t.pdbId} · ${captionOf(t)}`;
}

function pocketLine(t) {
  const box = t.box || {};
  const half = box.half || box.halfA || box.halfSize || (box.hx !== undefined ? [box.hx, box.hy, box.hz] : null);
  const size = half ? half.map((h) => F.num(Number(h) * (Number(h) > 100 ? 0.02 : 2), { digits: 1 })) : null;
  const parts = [];
  if (size) parts.push(`box ${size[0]} x ${size[1]} x ${size[2]} A`);
  if (t.atoms) parts.push(`${F.num(t.atoms)} pocket atoms`);
  if (t.hash) parts.push(`hash ${String(t.hash).slice(0, 10)}`);
  return parts.length ? parts.join(' · ') : null;
}

async function paintChain() {
  const t = target;
  if (!t) return;
  const [s, p, b] = await Promise.all([chain('labStatus'), chain('pools'), chain('bests')]);
  status = s.ok ? s.value : null;
  const live = isLive(s);
  const amount = $('[data-pool-amount]');
  const epochNode = $('[data-pool-epoch]');
  const best = $('[data-pool-best]');
  const note = $('[data-pool-note]');
  const settleBtn = $('[data-settle]');
  stopCountdown();
  if (!live) {
    amount.textContent = '·';
    epochNode.textContent = '';
    best.hidden = true;
    note.textContent = chainNote(s);
    note.hidden = false;
    settleBtn.disabled = true;
    $('[data-sponsor]').disabled = true;
    paintLeaderboard(null, null);
    return;
  }
  note.hidden = true;
  $('[data-sponsor]').disabled = false;
  const pool = p.ok ? lookup(p.value, t.id) : null;
  amount.replaceChildren(document.createTextNode(pool === null || pool === undefined ? '·' : F.units(pool, 18, 5)), el('span', { class: 'pc-stat-unit' }, 'ETH'));
  if (status.feeBps !== undefined) $('[data-fee-note]').textContent = `Sponsorships join the pool. The lab fee is ${F.num(Number(status.feeBps) / 100, { digits: 2 })} percent of a settled prize.`;
  const epoch = Number(status.epoch);
  const end = Number(status.epochEnd);
  stopCountdown = countdownTo(end, epochNode);
  const bests = b.ok ? b.value : null;
  const thisEpoch = bests ? lookup(bests.byTargetEpoch, `${t.id}:${epoch}`) : null;
  const prevEpoch = epoch > 0 && bests ? lookup(bests.byTargetEpoch, `${t.id}:${epoch - 1}`) : null;
  best.hidden = false;
  if (thisEpoch) {
    best.replaceChildren(
      el('div', { class: 'pc-eyebrow' }, 'Best this epoch'),
      el('div', { class: 'pc-row' }, [dgCell(milliOf(thisEpoch), { unit: true }), walletCell(thisEpoch.wallet)]),
    );
  } else best.replaceChildren(el('div', { class: 'pc-muted' }, STR.noRunsEpoch));
  // settle: the previous epoch has ended; it can be settled when it holds a run (else the pool rolls)
  const ended = Date.now() / 1000 >= end;
  const canSettle = (prevEpoch && pool && BigInt(pool) > 0n) || (ended && thisEpoch);
  settleBtn.disabled = !canSettle;
  settleBtn.onclick = async () => {
    const e = ended && thisEpoch ? epoch : epoch - 1;
    settleBtn.setAttribute('aria-busy', 'true');
    await settle(t.id, e);
    settleBtn.removeAttribute('aria-busy');
    paintChain();
  };
  const runs = await chain('runs', { target: t.id, limit: 500 });
  paintLeaderboard(runs.ok ? runs.value : null, bests);
}

function paintLeaderboard(runs, bests) {
  const lb = $('[data-panel="leaderboard"]');
  const rp = $('[data-panel="runs"]');
  if (!runs || !runs.length) {
    lb.replaceChildren(empty(EMPTY.leaderboard));
    rp.replaceChildren(empty(EMPTY.leaderboard));
    return;
  }
  // best per (ligand, wallet), lowest score first
  const bestPer = new Map();
  for (const r of runs) {
    const k = `${r.ligandId}:${String(r.wallet).toLowerCase()}`;
    const cur = bestPer.get(k);
    if (!cur || milliOf(r) < milliOf(cur)) bestPer.set(k, r);
  }
  const ranked = [...bestPer.values()].sort((a, b) => milliOf(a) - milliOf(b)).slice(0, 25);
  lb.replaceChildren(runsTable(ranked, cat, { target: false, bars: true, caption: 'Best runs on this target' }));
  const all = runs.slice().sort((a, b) => (runTime(b) || 0) - (runTime(a) || 0));
  rp.replaceChildren(runsTable(all.slice(0, 50), cat, { target: false, rank: false, caption: 'All runs on this target' }));
  if (all.length > 50) rp.append(el('div', { class: 'pc-more' }, el('button', { class: 'pc-btn pc-btn--outline', type: 'button', onclick: (e) => { rp.replaceChildren(runsTable(all, cat, { target: false, rank: false })); } }, 'Load more')));
}

$('[data-sponsor-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('[data-sponsor]');
  const input = $('#sponsor-amount');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  const r = await sponsor(target.id, input.value, { label: target.gene || target.key });
  btn.removeAttribute('aria-busy');
  btn.disabled = false;
  if (r && r.status === 'success') { input.value = ''; paintChain(); }
});
$('[data-sponsor-jump]').addEventListener('click', () => { $('#pool').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => $('#sponsor-amount').focus(), 400); });

catalog().then(async (c) => {
  cat = c;
  const id = qs('id');
  target = (id && (lookup(c.targetById, Number(id)) || lookup(c.targetByKey, id) || lookup(c.targetByKey, String(id).toUpperCase()))) || null;
  if (!target) return unknown();
  paintStatic(target);
  tabs($('[data-tabs]'), { onChange: (name) => { if (name === '3d' && !viewerMounted) { viewerMounted = true; mountStructure($('[data-viewer]'), { pdbId: target.pdbId, refCcd: target.ligand && target.ligand.ccd, chain: target.chain, image: target.image, spin: true }); } } });
  await paintChain();
  onRefresh(paintChain);
}).catch(() => unknown());

export { W, PROTOCOL, labLive };
