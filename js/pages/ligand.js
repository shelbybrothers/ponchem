// js/pages/ligand.js: one ligand (?id= registry id or key): provenance ladder, 3D of the SDF, best targets, runs.
import {
  boot, qs, catalog, chain, el, F, STR, EMPTY, milliOf, lookup, empty, ladder, outLink, setTitle, tabs, runsTable, mountLigand,
  onRefresh, runTime, isUnreachable, rcsbLigandLink, pubchemLink,
} from './common.js';

boot();
const $ = (s) => document.querySelector(s);

let lig = null;
let cat = null;

function unknown() {
  $('[data-page]').hidden = true;
  $('[data-unknown]').hidden = false;
  setTitle('Not found', STR.unknownLigand);
}

function coordsSource(l) {
  const c = String(l.coords || '');
  if (c.startsWith('rcsb-ccd:')) return `RCSB chemical component ${c.slice(9)} ideal coordinates`;
  if (c.startsWith('pubchem-3d:')) return `PubChem 3D conformer for CID ${c.slice(11)}`;
  if (c.startsWith('rdkit-etkdg')) return 'RDKit ETKDG conformer generated for this library';
  return c || F.EMPTY;
}

function paintStatic(l) {
  setTitle(l.name, `${l.name} from ${l.plant || l.latin || 'a plant source'}: formula, heavy atoms, rotatable bonds and its best cancer targets by estimated binding free energy.`);
  $('[data-comp-id]').textContent = l.ccd || (l.pubchemCid ? `CID ${l.pubchemCid}` : l.key);
  $('[data-title]').textContent = l.name;
  $('[data-mechanism]').textContent = l.mechanism ? l.mechanism.charAt(0).toUpperCase() + l.mechanism.slice(1) + '.' : '';
  $('[data-image-links]').replaceChildren(
    l.ccd ? rcsbLigandLink(l.ccd) : null,
    l.pubchemCid ? pubchemLink(l.pubchemCid) : null,
  );
  const source = [l.plant, l.latin ? `(${l.latin})` : null].filter(Boolean).join(' ');
  $('[data-ladder]').replaceChildren(ladder([
    ['Source', source || F.EMPTY],
    l.class ? ['Class', l.class] : null,
    ['Formula', l.formula || F.EMPTY, true],
    ['Weight', l.mw ? `${F.num(l.mw, { digits: 2 })} g/mol` : F.EMPTY, true],
    ['Heavy atoms', l.heavyAtoms !== undefined ? String(l.heavyAtoms) : F.EMPTY, true],
    ['Rotatable bonds', l.rotatableBonds !== undefined ? String(l.rotatableBonds) : F.EMPTY, true],
    l.donors !== undefined && l.acceptors !== undefined ? ['Donors / acceptors', `${l.donors} / ${l.acceptors}`, true] : null,
    l.ccd ? ['Component id', rcsbLigandLink(l.ccd), true] : null,
    l.pubchemCid ? ['PubChem CID', pubchemLink(l.pubchemCid), true] : null,
    ['Coordinates', coordsSource(l)],
    l.hash ? ['Topology hash', String(l.hash).slice(0, 18), true] : null,
  ]));
  $('[data-dock]').href = `/lab?ligand=${encodeURIComponent(l.id)}`;
  $('[data-screen]').href = `/lab?ligand=${encodeURIComponent(l.id)}&mode=ligand-vs-many`;
  $('[data-provenance]').textContent = `${l.name} comes from ${source || 'its source plant'}. Its coordinates are ${coordsSource(l)}.${l.note ? ` ${l.note.charAt(0).toUpperCase()}${l.note.slice(1)}.` : ''}`;
}

async function paintChain() {
  const l = lig;
  if (!l) return;
  const bp = $('[data-panel="best"]');
  const rp = $('[data-panel="runs"]');
  const r = await chain('runs', { ligand: l.id, limit: 500 });
  if (!r.ok || !Array.isArray(r.value) || !r.value.length) {
    const e = isUnreachable(r) ? el('p', { class: 'pc-alert pc-alert--warn' }, STR.unreachable) : null;
    bp.replaceChildren(e || empty(EMPTY.leaderboard));
    rp.replaceChildren(empty(EMPTY.leaderboard));
    return;
  }
  const bestPer = new Map();
  for (const run of r.value) {
    const cur = bestPer.get(Number(run.targetId));
    if (!cur || milliOf(run) < milliOf(cur)) bestPer.set(Number(run.targetId), run);
  }
  const ranked = [...bestPer.values()].sort((a, b) => milliOf(a) - milliOf(b)).slice(0, 25);
  bp.replaceChildren(runsTable(ranked, cat, { ligand: false, bars: true, caption: 'Best targets for this ligand' }));
  const all = r.value.slice().sort((a, b) => (runTime(b) || 0) - (runTime(a) || 0));
  rp.replaceChildren(runsTable(all.slice(0, 50), cat, { ligand: false, rank: false, caption: 'All runs of this ligand' }));
}

catalog().then(async (c) => {
  cat = c;
  const id = qs('id');
  lig = (id && (lookup(c.ligandById, Number(id)) || lookup(c.ligandByKey, id) || lookup(c.ligandByKey, String(id).toUpperCase()))) || null;
  if (!lig) return unknown();
  paintStatic(lig);
  tabs($('[data-tabs]'));
  mountLigand($('[data-viewer]'), { ligand: lig, spin: true });
  await paintChain();
  onRefresh(paintChain);
}).catch(() => unknown());
