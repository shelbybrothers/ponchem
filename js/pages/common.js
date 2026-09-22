/*
 * js/pages/common.js: what every page module shares (pages builder).
 *
 *   boot()                         initShell + the wallet button + the wrong-network band + body scroll lock
 *   catalog()                      js/catalog.js loadCatalog() when it exists, else the same shape read from data/catalog
 *   chain(name, ...args)           a guarded call into js/chain.js: { ok, value, reason: null | 'absent' | 'error' }
 *   lab()                          js/lab.js or null
 *   mountStructure(host, opts)     js/viewer.js when it exports mountStructure, else own 3Dmol path, else the RCSB image
 *   mountLigand(host, opts)        same for a ligand SDF (fallback: the CCD depiction or a formula tile)
 *   band / derived / kdText / dgCell / bandBadge   energy display helpers (float, display only)
 *   table / empty / icon / skel / chip / targetCard / ligandCard / ladder   DOM builders (el() only, never innerHTML)
 *   sponsor / settle / withdraw    the write flows (js/lab.js builders + js/wallet.js sendTx + the copy deck toasts)
 *
 * Rule: chain and RCSB text reaches the page through el() text nodes only.
 */
import { initShell, initWalletButton, toast, el, copyText, openWalletMenu, shortAddr as shellShort } from '../shell.js';
import * as F from '../format.js';
import { CHAIN, BRAND, TOKEN, LAB, EXPLORER, PROTOCOL, labLive } from '../config.js';
import * as W from '../wallet.js';
import * as XP from './xp.js';

export { el, toast, copyText, openWalletMenu, F, CHAIN, BRAND, TOKEN, LAB, EXPLORER, PROTOCOL, W, labLive, XP };

// ---------------------------------------------------------------------------------------------------------
// constants (copy deck strings the modules share)

export const CANCERS = [
  ['lung', 'lung'], ['colorectal', 'colorectal'], ['liver', 'liver'], ['breast', 'breast'], ['stomach', 'stomach'],
  ['pancreatic', 'pancreatic'], ['prostate', 'prostate'], ['esophageal', 'esophageal'], ['cervical', 'cervical'],
  ['leukemia', 'leukemia'], ['lymphoma', 'lymphoma'], ['brain', 'brain'], ['melanoma', 'melanoma'], ['ovarian', 'ovarian'],
  ['bladder', 'bladder'], ['kidney', 'kidney'], ['myeloma', 'myeloma'], ['head-and-neck', 'head and neck'],
  ['thyroid', 'thyroid'], ['sarcoma', 'sarcoma'],
].map(([key, name], bit) => ({ bit, key, name }));

export const cancerKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
export const cancerName = (keyOrName) => (CANCERS.find((c) => c.key === cancerKey(keyOrName)) || { name: String(keyOrName || '') }).name;

export const STR = Object.freeze({
  unreachable: 'Could not reach Robinhood Chain. Reads will retry.',
  notLive: 'The lab opens when the contract is live.',
  unreachSuffix: '(chain unreachable)',
  txSent: 'Transaction sent. Waiting for confirmation.',
  txReverted: 'Transaction reverted. Nothing was recorded.',
  txFailed: 'The transaction failed on chain. Nothing was recorded.',
  rejected: 'The wallet rejected the request.',
  amountZero: 'Amount must be greater than zero.',
  notEnded: (time) => `The epoch has not ended yet. It ends in ${time}.`,
  nothingToSettle: 'Nothing to settle: no run was recorded this epoch.',
  nothingToClaim: 'Nothing to claim from this wallet.',
  catalogFailed: 'The catalog could not be loaded. Reload the page.',
  unknownTarget: 'Unknown target id.',
  unknownLigand: 'Unknown ligand id.',
  noRunsEpoch: 'No runs this epoch yet. The pool rolls over.',
  viewerLoading: 'Loading structure from the Protein Data Bank',
  viewerFallback: '3D view unavailable. Showing the RCSB entry image.',
  structureLoaded: 'Structure loaded from RCSB',
  structureFailed: 'Could not load the structure file. Showing the RCSB image.',
  // v2 (SPEC 9)
  unknownRun: 'Unknown docking test id.',
  runNotFound: 'Docking test not found',
  runNotFoundLine: 'No docking test with this id is recorded on chain.',
  agree: 'Chain and browser agree',
  disagree: (chain, browser) => `The chain scored ${chain} kcal/mol, the browser ${browser} kcal/mol.`,
  poseMissing: 'The pose of this test is not in the index yet, so the browser cannot re-score it.',
  engineMissing: 'The docking engine could not be loaded, so the browser cannot re-score this test.',
  linkCopied: 'Link copied',
  reportDownloaded: 'Report downloaded',
  reviewSent: 'Review recorded on chain',
  reviewOwn: 'You cannot review your own docking test.',
  reviewConnect: 'Connect a wallet to write a review.',
  reviewStars: 'Pick one to five stars.',
  reviewNoteLong: 'A review note has at most 280 characters.',
  analysisAttached: 'Analysis attached on chain',
  analysisNotConnected: 'not connected',
  analysisNone: 'AI analysis is not connected on this server.',
  analysisFailed: 'The analysis could not be generated. Try again in a minute.',
  analysisUnverified: "The text is the model's own output and is not verified. Keys never reach the browser.",
  methodNone: 'This test did not record a method.',
  methodInvalid: 'The recorded method does not pass the schema, so the lab will not load it.',
  tokenSoon: 'after the $PONCHEM launch',
  xPost: 'Post on X',
  copyLink: 'Copy link',
  downloadReport: 'Download report',
  useMethod: 'Use this method',
});

export const EMPTY = Object.freeze({
  leaderboard: ['No runs recorded yet', 'The first recorded run on this target starts its leaderboard.', 'Open the lab', '/lab'],
  report: ['Nothing recorded for this group yet', 'Dock any of its targets and the report fills in.', 'See targets', '/targets'],
  walletRuns: ['No runs from this wallet', 'Your recorded runs will list here with their chain scores.', 'Open the lab', '/lab'],
  walletPrizes: ['Nothing to claim', 'Win an epoch on a target and the prize appears here.', 'See pools', '/leaderboard#pools'],
  walletSponsorships: ['No sponsorships yet', "Fund a target's pool to move people toward it.", 'Sponsor a target', '/targets'],
  search: ['No matches', 'Try a shorter name or a PDB id.', 'Clear search'],
  filter: ['Nothing in this group yet', 'Clear the filter to see the whole library.', 'Clear filter'],
  // v2 (SPEC 9)
  dashTests: ['No docking tests from this wallet', 'Your docking tests will list here with their chain scores.', 'Open the lab', '/lab'],
  dashBest: ['No best scores yet', 'Your best test on each target appears here.', 'Open the lab', '/lab'],
  reviewsReceived: ['No reviews received yet', 'Reviews other wallets write on your tests appear here.', 'See the leaderboard', '/leaderboard'],
  reviewsWritten: ['No reviews written yet', 'Open any docking test and write a review.', 'See the leaderboard', '/leaderboard'],
  reviews: ['No reviews yet', 'The first review on this test starts its list.', null],
  mostReviewed: ['No reviews yet', 'The first review on a docking test starts this list.', 'See tests', '/leaderboard#target'],
  wallets: ['No wallets ranked yet', 'The first docking test starts the wallet ranking.', 'Open the lab', '/lab'],
});

// ---------------------------------------------------------------------------------------------------------
// boot

let netBand = null;
function paintNetBand() {
  const wrong = !!W.account() && W.chainId() !== null && W.chainId() !== CHAIN.id;
  if (!wrong) { if (netBand) { netBand.remove(); netBand = null; } return; }
  if (netBand) return;
  const nav = document.querySelector('nav.pc-nav');
  if (!nav) return;
  netBand = el('div', { class: 'pc-netband', role: 'status' }, [
    el('div', { class: 'pc-container pc-netband-inner' }, [
      icon('alert'),
      el('span', {}, 'Your wallet is on another network. Ponchem records runs on Robinhood Chain.'),
      el('button', { class: 'pc-btn pc-btn--warn pc-btn--sm', type: 'button', onclick: () => W.ensureChain().then(() => toast('Switched to Robinhood Chain', { kind: 'success' })).catch((e) => toast(e && e.message ? e.message : 'The wallet could not switch networks. Add Robinhood Chain manually; the docs list the parameters.', { kind: 'error' })) }, 'Switch network'),
    ]),
  ]);
  nav.insertAdjacentElement('afterend', netBand);
}

export function boot({ onWallet } = {}) {
  initShell();
  watchNames();
  initWalletButton({ onChange: (s) => { paintNetBand(); if (onWallet) onWallet(s); } });
  paintNetBand();
  const nav = document.querySelector('nav.pc-nav');
  if (nav && 'MutationObserver' in window) {
    new MutationObserver(() => document.body.classList.toggle('pc-nav-locked', nav.hasAttribute('data-nav-open')))
      .observe(nav, { attributes: true, attributeFilter: ['data-nav-open'] });
  }
  // outbound links get the arrow and open in a new tab
  for (const a of document.querySelectorAll('a[href^="http"]')) {
    if (!a.hasAttribute('data-out') && !a.classList.contains('pc-btn') && !a.closest('.pc-footer')) a.setAttribute('data-out', '');
  }
}

export const qs = (k) => new URLSearchParams(location.search).get(k);

// ---------------------------------------------------------------------------------------------------------
// the other builders' modules, loaded once and guarded

const mods = new Map();
function mod(path) {
  if (!mods.has(path)) mods.set(path, import(path).catch(() => null));
  return mods.get(path);
}
export const catalogMod = () => mod('../catalog.js');
export const chainMod = () => mod('../chain.js');
export const labMod = () => mod('../lab.js');
export const viewerMod = () => mod('../viewer.js');
export const derivedMod = () => mod('../engine/derived.js');
export const scoreMod = () => mod('../engine/score.js');
export const engineMod = () => mod('../engine/index.js');
export const methodMod = () => mod('../engine/method.js');
export const gamifyMod = () => mod('../gamify.js');

// map-or-object lookup (the data layer may hand either)
export function lookup(coll, key) {
  if (!coll) return undefined;
  if (coll instanceof Map) return coll.get(key) ?? coll.get(String(key)) ?? coll.get(Number(key));
  return coll[key];
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

let catalogPromise = null;
async function loadCatalogFallback() {
  const [t, l] = await Promise.all([fetchJson('/data/catalog/targets.json'), fetchJson('/data/catalog/ligands.json')]);
  const targets = (Array.isArray(t) ? t : t.targets || []).map((x) => ({ ...x }));
  const ligands = (Array.isArray(l) ? l : l.ligands || []).map((x) => ({ ...x }));
  let reg = null;
  if (await fileExists('/data/registry.json')) { try { reg = await fetchJson('/data/registry.json'); } catch { reg = null; } }
  const byKey = (list) => new Map((list || []).map((x) => [x.key, x]));
  const rt = byKey(reg && reg.targets);
  const rl = byKey(reg && reg.ligands);
  targets.forEach((x, i) => { const r = rt.get(x.key); Object.assign(x, r || {}, { id: r && r.id ? r.id : i + 1 }); });
  ligands.forEach((x, i) => { const r = rl.get(x.key); Object.assign(x, r || {}, { id: r && r.id ? r.id : i + 1 }); });
  const map = (list, k) => new Map(list.map((x) => [x[k], x]));
  return { targets, ligands, cancers: CANCERS, targetById: map(targets, 'id'), ligandById: map(ligands, 'id'), targetByKey: map(targets, 'key'), ligandByKey: map(ligands, 'key') };
}

// a HEAD probe so an optional file is asked for once and a missing one is not a failed fetch of the page's own
const probes = new Map();
export function fileExists(url) {
  if (!probes.has(url)) probes.set(url, fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false));
  return probes.get(url);
}

export function catalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const m = await catalogMod();
      if (m && typeof m.loadCatalog === 'function') {
        try { return await m.loadCatalog(); } catch { /* fall back to the files */ }
      }
      return loadCatalogFallback();
    })();
  }
  return catalogPromise;
}

export async function fetchLigandSdf(lig) {
  const m = await catalogMod();
  if (m && typeof m.fetchLigandSdf === 'function') { try { return await m.fetchLigandSdf(lig.key); } catch { /* files */ } }
  const r = await fetch(`/${(lig.file || `data/ligands/${lig.key}.sdf`).replace(/^\//, '')}`);
  if (!r.ok) throw new Error('sdf');
  return r.text();
}

export async function fetchStructure(pdbId) {
  const m = await catalogMod();
  if (m && typeof m.fetchStructure === 'function') { try { return await m.fetchStructure(pdbId); } catch { /* direct */ } }
  const r = await fetch(`https://files.rcsb.org/download/${encodeURIComponent(String(pdbId).toUpperCase())}.pdb`);
  if (!r.ok) throw new Error('structure');
  return r.text();
}

export const rcsbImage = (t) => (t && t.image) || `https://cdn.rcsb.org/images/structures/${String(t && t.pdbId ? t.pdbId : t).toLowerCase()}_assembly-1.jpeg`;
export const ccdImage = (ccd) => (ccd ? `https://cdn.rcsb.org/images/ccd/labeled/${ccd[0].toUpperCase()}/${ccd.toUpperCase()}.svg` : null);
export const rcsbEntry = (pdbId) => `https://www.rcsb.org/structure/${String(pdbId).toUpperCase()}`;
export const rcsbMolstar = (pdbId) => `https://www.rcsb.org/3d-view/${String(pdbId).toUpperCase()}`;
export const rcsbLigand = (ccd) => `https://www.rcsb.org/ligand/${String(ccd).toUpperCase()}`;
export const pubchemUrl = (cid) => `https://pubchem.ncbi.nlm.nih.gov/compound/${encodeURIComponent(String(cid))}`;
export const doiUrl = (doi) => `https://doi.org/${String(doi)}`;

// direct links whose text names the destination (SPEC 9.4): `RCSB 4WKQ`, `RCSB AQ4`, `PubChem 5280343`
export const rcsbStructureLink = (pdbId, cls) => outLink(rcsbEntry(pdbId), `RCSB ${String(pdbId).toUpperCase()}`, cls);
export const rcsbLigandLink = (ccd, cls) => outLink(rcsbLigand(ccd), `RCSB ${String(ccd).toUpperCase()}`, cls);
export const pubchemLink = (cid, cls) => outLink(pubchemUrl(cid), `PubChem ${cid}`, cls);
/** The ligand's own source page: its RCSB chemical component when it has a CCD id, else its PubChem compound. */
export function ligandSourceLink(l, cls) {
  if (!l) return null;
  if (l.ccd) return rcsbLigandLink(l.ccd, cls);
  if (l.pubchemCid) return pubchemLink(l.pubchemCid, cls);
  return null;
}
export const runHref = (id) => `/run?id=${encodeURIComponent(id)}`;
export const runUrl = (id) => `${BRAND.url}${runHref(id)}`;
export const runLink = (id, text = `#${id}`, cls = 'pc-link pc-run-link') => el('a', { class: cls, href: runHref(id) }, text);

/** { ok, value, reason }: reason 'absent' while js/chain.js or the contract is missing, 'error' when the read threw. */
export async function chain(name, ...args) {
  const m = await chainMod();
  if (!m || typeof m[name] !== 'function') return { ok: false, value: null, reason: 'absent' };
  try {
    const value = await m[name](...args);
    return { ok: true, value, reason: null };
  } catch (e) {
    return { ok: false, value: null, reason: 'error', error: e };
  }
}

/** True when a labStatus() result says the contract is live. */
export const isLive = (s) => !!(s && s.ok && s.value && s.value.live !== false);
/** The sentence a page shows when it cannot read chain data: the module's own reason when it gives one. */
export function chainNote(s) {
  if (s && s.value && typeof s.value.reason === 'string' && s.value.reason) return s.value.reason;
  return s && s.reason === 'error' ? STR.unreachable : STR.notLive;
}
export const isUnreachable = (s) => !!(s && (s.reason === 'error' || (s.value && s.value.reason === STR.unreachable)));

let explainerOn = false;
export async function lab() {
  const m = await labMod();
  if (!m || typeof m.buildFund !== 'function') return null;
  if (!explainerOn && typeof m.registerRevertExplainer === 'function') { try { m.registerRevertExplainer(); explainerOn = true; } catch { /* optional */ } }
  return m;
}

/** Runs a refresh every new block (js/chain.js onBlock) or every 12 s; returns unsubscribe. */
export async function onRefresh(fn) {
  const m = await chainMod();
  let last = 0;
  const guarded = () => { const now = Date.now(); if (now - last < 4000) return; last = now; Promise.resolve().then(fn).catch(() => null); };
  if (m && typeof m.onBlock === 'function') { try { return m.onBlock(guarded); } catch { /* timer */ } }
  const t = setInterval(() => { if (!document.hidden) guarded(); }, 12000);
  return () => clearInterval(t);
}

// ---------------------------------------------------------------------------------------------------------
// energy helpers (display only, float; SPEC-ENGINE 3.6)

export const WEIGHTS_LOCAL = Object.freeze([
  ['gauss 1', -0.0356], ['gauss 2', -0.00516], ['repulsion', 0.84], ['hydrophobic', -0.0351], ['hydrogen bond', -0.587],
]);
export async function weights() {
  const m = await scoreMod();
  if (m) {
    const vals = ['W_G1', 'W_G2', 'W_REP', 'W_HYD', 'W_HB'].map((k) => m[k]);
    if (vals.every((v) => typeof v === 'bigint' || typeof v === 'number')) return WEIGHTS_LOCAL.map(([name], i) => [name, Number(vals[i]) / 1e6]);
  }
  return WEIGHTS_LOCAL;
}

export const milliOf = (run) => (run && run.scoreMilli !== undefined && run.scoreMilli !== null ? Number(run.scoreMilli) : null);
export function band(milli) {
  if (milli === null || milli === undefined || !Number.isFinite(Number(milli))) return null;
  const m = Number(milli);
  if (m <= -9000) return 'strong';
  if (m <= -6000) return 'moderate';
  if (m < 0) return 'weak';
  return 'none';
}
export const BAND_SHORT = { strong: 'strong', moderate: 'moderate', weak: 'weak', none: 'no binding' };
export const BAND_LONG = { strong: 'strong binder', moderate: 'moderate binder', weak: 'weak binder', none: 'no binding' };

export function derived(milli, heavy) {
  const dG = Number(milli) / 1000;
  const pKd = -dG / 1.36423;
  const kd = Math.pow(10, -pKd);
  const le = heavy ? -dG / Number(heavy) : null;
  return { dG, pKd, kd, le };
}
export function kdText(kd) {
  if (!Number.isFinite(kd)) return F.EMPTY;
  const units = [['pM', 1e-12], ['nM', 1e-9], ['uM', 1e-6], ['mM', 1e-3], ['M', 1]];
  for (const [u, s] of units) { const v = kd / s; if (v < 1000 || u === 'M') return `${F.num(v, { digits: v < 10 ? 2 : v < 100 ? 1 : 0 })} ${u}`; }
  return F.EMPTY;
}
export const dgText = (milli, digits = 3) => (milli === null || milli === undefined ? F.EMPTY : F.kcal(BigInt(Math.trunc(Number(milli))), digits, false));
export const pkdText = (milli) => (milli === null || milli === undefined ? F.EMPTY : F.fixed(derived(milli).pKd, 2));
export const leText = (milli, heavy) => { const d = derived(milli, heavy); return d.le === null ? F.EMPTY : F.fixed(d.le, 2); };

export function dgCell(milli, { digits = 3, plain = false, unit = false } = {}) {
  const b = band(milli);
  const node = el('span', { class: `pc-dg${b ? ` pc-dg--${b}` : ' pc-dg--plain'}${plain ? ' pc-dg--plain' : ''}` }, dgText(milli, digits));
  if (unit) node.append(el('span', { class: 'pc-unit' }, 'kcal/mol'));
  return node;
}
export function bandBadge(milli) {
  const b = band(milli);
  return b ? el('span', { class: `pc-badge pc-badge--${b}` }, BAND_SHORT[b]) : null;
}

export function parseEth(text) {
  const s = String(text || '').trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [i = '0', f = ''] = s.split('.');
  const wei = BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return wei;
}

// ---------------------------------------------------------------------------------------------------------
// DOM builders

const ICONS = {
  wallet: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1.5M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 1 3 7.5Zm13 6.5h.01',
  flask: 'M9 3h6M10 3v5.5L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 8.5V3M7.5 14h9',
  ligand: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3Zm7.8 4.5L22 5',
  receptor: 'M15.5 4.2A9 9 0 1 0 19.8 8.5M15.5 4.2 19.8 8.5',
  chain: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  'arrow-ne': 'M7 17L17 7M9 7h8v8',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 9v4.5M12 17h.01M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z',
  info: 'M12 11v5M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  download: 'M12 4v11M7 10l5 5 5-5M4 19h16',
  print: 'M6 9V4h12v5M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M6 14h12v6H6z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM20 20l-4.5-4.5',
  filter: 'M4 5h16l-6 8v6l-4-2v-4L4 5Z',
  sort: 'M8 5v14M8 19l-3-3M8 19l3-3M16 19V5M16 5l-3 3M16 5l3 3',
  menu: 'M4 8h16M4 16h16',
  close: 'M6 6l12 12M18 6L6 18',
  reset: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4V8Zm8 4l8-4M12 12v8M12 12 4 8',
  surface: 'M4 14c2-4 5-4 8 0s6 4 8 0M4 9c2-4 5-4 8 0s6 4 8 0',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  'x-logo': 'M5 4l14 16M19 4L5 20',
  spinner: 'M12 3a9 9 0 1 1-6.4 2.6',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.8L12 3.5Z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  // badges (SPEC 9.5), one visual language, 24 px grid
  'first-test': 'M9 3h6M10 3v5.5L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 8.5V3M7.5 14h9',
  'ten-tests': 'M4 6h16M4 12h16M4 18h9M16 17l2 2 3-4',
  'fifty-tests': 'M4 7l8-4 8 4-8 4-8-4Zm0 5l8 4 8-4M4 17l8 4 8-4',
  'ten-targets': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v2M12 19v2M3 12h2M19 12h2',
  'strong-binder': 'M12 3v12M7 10l5 5 5-5M5 21h14',
  'best-on-target': 'M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.8L12 3.5Z',
  'epoch-winner': 'M7 4h10v4a5 5 0 0 1-10 0V4ZM7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3M12 13v4M8 21h8M9 17h6',
  sponsor: 'M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10Z',
  reviewer: 'M4 5h16v11H9l-5 4V5Z',
  'well-reviewed': 'M4 5h16v11H9l-5 4V5Zm5 5.5l2 2 4-4',
};
const SVG = 'http://www.w3.org/2000/svg';
export function icon(name, size = 20, cls = 'pc-icon') {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.75');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  s.append(p);
  return s;
}
export function markMono(size = 48) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 64 64');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const [d, w] of [['M36.2 12.8A24 24 0 1 0 53.2 29.8', 5], ['M32 21L43.3 27.5V40.5L32 47L20.7 40.5V27.5Z', 4.5], ['M43.3 27.5L51.5 18.5', 4.5]]) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke-width', String(w));
    s.append(p);
  }
  return s;
}

export const skel = (w = 48) => el('span', { class: 'pc-skel', style: { width: `${w}px` }, 'aria-hidden': 'true' });
export const chip = (text, kind = '') => el('span', { class: `pc-chip${kind ? ` pc-chip--${kind}` : ''}` }, text);
export const outLink = (href, text, cls = 'pc-link pc-link--out') => el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, text);
export const txLink = (hash, text = 'View tx') => outLink(EXPLORER.tx(hash), text);

export function empty([h4, line, action, href], onAction) {
  const act = href
    ? el('a', { class: 'pc-btn pc-btn--outline', href }, action)
    : el('button', { class: 'pc-btn pc-btn--outline', type: 'button', onclick: onAction }, action);
  return el('div', { class: 'pc-empty' }, [markMono(48), el('h4', {}, h4), el('p', {}, line), action ? act : null]);
}

/**
 * columns: [{ label, key | render(row, i), num, id, mono, wide, cls }]
 * rows: any[]; each td carries data-label so .pc-table--stack works on a phone.
 */
export function table({ columns, rows, stack = true, compact = false, rowClass, caption }) {
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', { scope: 'col', class: c.num ? 'pc-td-num' : null }, c.label))));
  const tbody = el('tbody', {}, rows.map((r, i) => {
    const cls = rowClass ? rowClass(r, i) : null;
    return el('tr', { class: cls }, columns.map((c) => {
      const v = typeof c.render === 'function' ? c.render(r, i) : r[c.key];
      const classes = [c.num ? 'pc-td-num' : '', c.id ? 'pc-td-id' : '', c.mono ? 'pc-td-mono' : '', c.wide ? 'pc-td-wide' : '', c.name ? 'pc-td-name' : '', c.cls || ''].filter(Boolean).join(' ') || null;
      return el('td', { class: classes, 'data-label': c.label }, v === undefined || v === null ? F.EMPTY : v);
    }));
  }));
  const t = el('table', { class: `pc-table${stack ? ' pc-table--stack' : ''}${compact ? ' pc-table--compact' : ''}` }, [caption ? el('caption', { class: 'pc-visually-hidden' }, caption) : null, thead, tbody]);
  return el('div', { class: 'pc-table-frame' }, t);
}

export const runTime = (run) => { const t = Number(run && run.time); if (!Number.isFinite(t) || t <= 0) return null; return t < 1e12 ? t * 1000 : t; };

/**
 * A table of runs. cat: the catalog; opts: { target, ligand, wallet, rank, bars, test (a Test column linking to /run),
 * links (RCSB and PubChem links after the names, SPEC 9.4), reviews: Map<runId, { count, avg }> (a Reviews column) }
 */
export function runsTable(runs, cat, { target = true, ligand = true, wallet = true, rank = true, bars = false, test = true, links = false, reviews = null, caption } = {}) {
  const worst = runs.reduce((m, r) => Math.max(m, Math.abs(Number(milliOf(r) || 0))), 0) || 1;
  const columns = [];
  if (rank) columns.push({ label: 'Rank', render: (r, i) => el('span', { class: `pc-rank${i < 3 ? ' pc-rank--top' : ''}` }, String(i + 1)), cls: 'pc-rank' });
  if (target) columns.push({ label: 'Target', name: true, render: (r) => { const t = lookup(cat.targetById, Number(r.targetId)); return t ? el('span', { class: 'pc-td-links' }, [el('a', { href: targetHref(t) }, [el('span', { class: 'pc-td-id' }, t.pdbId), ' ', t.gene || t.key]), links ? rcsbStructureLink(t.pdbId, 'pc-link pc-link--out pc-small') : null]) : String(r.targetId); } });
  if (ligand) columns.push({ label: 'Ligand', name: true, render: (r) => { const l = lookup(cat.ligandById, Number(r.ligandId)); return l ? el('span', { class: 'pc-td-links' }, [el('a', { href: ligandHref(l) }, l.name), links ? ligandSourceLink(l, 'pc-link pc-link--out pc-small') : null]) : String(r.ligandId); } });
  columns.push({ label: 'dG (kcal/mol)', num: true, render: (r, i) => {
    const m = milliOf(r);
    const cell = dgCell(m);
    if (bars && i < 3 && m !== null && m < 0) cell.append(el('span', { class: 'pc-bar', 'aria-hidden': 'true' }, el('span', { style: { width: `${Math.round(Math.min(100, (Math.abs(m) / worst) * 100))}%` } })));
    return cell;
  } });
  columns.push({ label: 'pKd', num: true, render: (r) => pkdText(milliOf(r)) });
  columns.push({ label: 'LE', num: true, render: (r) => { const l = lookup(cat.ligandById, Number(r.ligandId)); return leText(milliOf(r), l && l.heavyAtoms); } });
  if (wallet) columns.push({ label: 'Wallet', mono: true, render: (r) => walletCell(r.wallet) });
  if (reviews) columns.push({ label: 'Reviews', render: (r) => reviewsCell(lookup(reviews, Number(r.id))) });
  columns.push({ label: 'Recorded', mono: true, render: (r) => { const t = runTime(r); const cell = t ? F.ago(t) : F.EMPTY; return r.tx ? outLink(EXPLORER.tx(r.tx), cell, 'pc-link') : cell; } });
  if (test) columns.push({ label: 'Test', mono: true, render: (r) => (r.id !== undefined && r.id !== null ? runLink(r.id) : F.EMPTY) });
  return table({ columns, rows: runs, caption, rowClass: (r) => (isMe(r.wallet) ? 'pc-tr-you' : null) });
}

/** The Reviews cell: average stars and the count, or `--` for a test nobody reviewed. */
export function reviewsCell(s) {
  if (!s || !Number(s.count)) return el('span', { class: 'pc-muted pc-small' }, F.EMPTY);
  return el('span', { class: 'pc-review-cell' }, [stars(s.avg, { size: 14 }), el('span', { class: 'pc-td-mono' }, `${F.fixed(s.avg, 1)} (${F.num(s.count)})`)]);
}

export function ladder(rows) {
  return el('dl', { class: 'pc-ladder' }, rows.filter(Boolean).map(([k, v, mono]) => el('div', { class: 'pc-ladder-row' }, [el('dt', {}, k), el('dd', { class: mono ? 'pc-mono' : null }, v)])));
}

export const captionOf = (t) => [t.resolution ? `${F.num(t.resolution, { digits: 2 })} A` : null, methodShort(t.method), t.organism || null].filter(Boolean).join(' · ');
export function methodShort(m) {
  const s = String(m || '');
  if (/x-ray/i.test(s)) return 'X-ray';
  if (/electron microscopy/i.test(s)) return 'Cryo-EM';
  if (/nmr/i.test(s)) return 'NMR';
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : '';
}
export function methodLong(m) {
  const s = String(m || '');
  if (/x-ray/i.test(s)) return 'X-ray diffraction';
  if (/electron microscopy/i.test(s)) return 'Electron microscopy';
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : F.EMPTY;
}
export const targetName = (t) => t.protein || t.gene || t.key;
export const targetHref = (t) => `/target?id=${encodeURIComponent(t.id)}`;
export const ligandHref = (l) => `/ligand?id=${encodeURIComponent(l.id)}`;

export function targetCard(t, { best = null, pool = null, scroll = false } = {}) {
  const groups = (t.cancers || []).map(cancerName);
  const img = el('img', { src: rcsbImage(t), alt: `RCSB entry image for ${t.pdbId}`, loading: 'lazy', width: 400, height: 300 });
  const media = el('div', { class: 'pc-card-media' }, [
    img,
    el('span', { class: 'pc-card-badge' }, t.pdbId),
    groups.length ? el('span', { class: 'pc-chip pc-chip--receptor pc-card-chip' }, groups.length > 1 ? `${groups[0]} +${groups.length - 1}` : groups[0]) : null,
  ]);
  const bestMilli = milliOf(best);
  const body = el('div', { class: 'pc-card-body' }, [
    el('h3', { class: 'pc-card-title' }, targetName(t)),
    el('div', { class: 'pc-card-caption' }, captionOf(t)),
    el('div', { class: 'pc-card-stats' }, [
      el('div', { class: 'pc-ministat' }, [el('span', { class: 'pc-ministat-label' }, 'Best dG'), el('span', { class: 'pc-ministat-value' }, bestMilli === null ? '·' : dgCell(bestMilli, { plain: true }))]),
      el('div', { class: 'pc-ministat' }, [el('span', { class: 'pc-ministat-label' }, 'Pool'), el('span', { class: 'pc-ministat-value' }, pool === null || pool === undefined ? '·' : F.eth(pool, 4))]),
    ]),
  ]);
  const link = el('a', { class: 'pc-card pc-card--link', href: targetHref(t), 'aria-label': `${targetName(t)}, PDB ${t.pdbId}` }, [media, body]);
  const foot = el('div', { class: 'pc-card-foot' }, [
    el('a', { class: 'pc-btn pc-btn--ghost pc-btn--sm', href: `/lab?target=${encodeURIComponent(t.id)}` }, 'Dock'),
    rcsbStructureLink(t.pdbId),
  ]);
  link.append(foot);
  return link;
}

export function ligandMedia(l, { detail = false } = {}) {
  const media = el('div', { class: 'pc-card-media pc-card-media--ligand' });
  const fallback = () => {
    media.classList.add('pc-card-media--fallback');
    media.replaceChildren(markMono(40), el('span', { class: 'pc-formula' }, l.formula || l.name), el('span', { class: 'pc-caption' }, 'Topology on chain, depiction from the 3D file'));
  };
  const src = ccdImage(l.ccd);
  if (src) {
    const img = el('img', { src, alt: `RCSB component depiction of ${l.name} (${l.ccd})`, loading: detail ? 'eager' : 'lazy', width: 400, height: 300 });
    img.addEventListener('error', () => { img.remove(); fallback(); }, { once: true });
    media.append(img);
  } else fallback();
  return media;
}

export function ligandCard(l, { best = null, bestTarget = null, scroll = false } = {}) {
  const media = ligandMedia(l);
  media.append(
    el('span', { class: 'pc-card-badge' }, l.ccd || (l.pubchemCid ? `CID ${l.pubchemCid}` : l.key)),
    l.plant ? el('span', { class: 'pc-chip pc-chip--ligand pc-card-chip' }, l.plant.split(',')[0].trim()) : null,
  );
  const bestMilli = milliOf(best);
  const body = el('div', { class: 'pc-card-body' }, [
    el('h3', { class: 'pc-card-title' }, l.name),
    el('div', { class: 'pc-card-caption' }, [l.formula, l.mw ? `${F.num(l.mw, { digits: 1 })} g/mol` : null, l.heavyAtoms ? `${l.heavyAtoms} heavy atoms` : null, l.rotatableBonds !== undefined ? `${l.rotatableBonds} rotatable` : null].filter(Boolean).join(' · ')),
    el('div', { class: 'pc-card-stats' }, [
      el('div', { class: 'pc-ministat' }, [el('span', { class: 'pc-ministat-label' }, 'Best dG'), el('span', { class: 'pc-ministat-value' }, bestMilli === null ? '·' : dgCell(bestMilli, { plain: true }))]),
      el('div', { class: 'pc-ministat' }, [el('span', { class: 'pc-ministat-label' }, 'Best target'), el('span', { class: 'pc-ministat-value' }, bestTarget ? (bestTarget.gene || bestTarget.key) : '·')]),
    ]),
  ]);
  const link = el('a', { class: 'pc-card pc-card--link', href: ligandHref(l), 'aria-label': `${l.name}` }, [media, body]);
  link.append(el('div', { class: 'pc-card-foot' }, [
    el('a', { class: 'pc-btn pc-btn--ghost pc-btn--sm', href: `/lab?ligand=${encodeURIComponent(l.id)}` }, 'Dock'),
    ligandSourceLink(l) || el('span'),
  ]));
  return link;
}

export function me() { return W.account(); }
export const isMe = (a) => !!a && !!W.account() && String(a).toLowerCase() === W.account().toLowerCase();
export function walletCell(a) {
  const s = F.shortAddr(a);
  const short = s === F.EMPTY ? shellShort(a) : s;
  // data-wallet: hydrateNames() puts the researcher name in front of the address once it is read from chain
  return el('span', { class: 'pc-td-mono', 'data-wallet': a || null, 'data-short': short }, [el('span', { 'data-wallet-text': '' }, short), isMe(a) ? el('span', { class: 'pc-you' }, 'you') : null]);
}

/** Researcher names for every [data-wallet] on the page, now and as tables render later (one batched read). */
let nameTimer = null;
export function hydrateNames() {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(async () => {
    const cells = [...document.querySelectorAll('[data-wallet]:not([data-named])')];
    if (!cells.length) return;
    let labMod;
    try { labMod = await import('../lab.js'); } catch { return; }
    let names;
    try { names = await labMod.namesOf(cells.map((c) => c.dataset.wallet)); } catch { return; }
    for (const c of cells) {
      c.setAttribute('data-named', '');
      const n = names.get(String(c.dataset.wallet).toLowerCase());
      const t = c.querySelector('[data-wallet-text]');
      if (n && t) { t.textContent = `${n} (${c.dataset.short})`; c.title = c.dataset.wallet; }
    }
  }, 150);
}
function watchNames() {
  if (typeof MutationObserver === 'undefined') return;
  new MutationObserver((muts) => { if (muts.some((m) => m.addedNodes.length)) hydrateNames(); })
    .observe(document.body, { childList: true, subtree: true });
  hydrateNames();
}

export function tabs(root, { onChange } = {}) {
  const list = root.querySelectorAll('[role="tab"]');
  const panels = [...list].map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const select = (i) => {
    list.forEach((t, j) => { t.setAttribute('aria-selected', i === j ? 'true' : 'false'); t.tabIndex = i === j ? 0 : -1; });
    panels.forEach((p, j) => { if (p) p.hidden = i !== j; });
    if (onChange) onChange(list[i].dataset.tab || i);
  };
  list.forEach((t, i) => {
    t.addEventListener('click', () => select(i));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { select((i + 1) % list.length); list[(i + 1) % list.length].focus(); }
      if (e.key === 'ArrowLeft') { select((i - 1 + list.length) % list.length); list[(i - 1 + list.length) % list.length].focus(); }
    });
  });
  const wanted = location.hash ? [...list].findIndex((t) => `#${t.dataset.tab}` === location.hash) : -1;
  select(wanted >= 0 ? wanted : 0);
  return select;
}

export function setTitle(title, description) {
  document.title = `Ponchem · ${title}`;
  const og = document.querySelector('meta[property="og:title"]');
  if (og) og.setAttribute('content', `Ponchem · ${title}`);
  if (description) {
    for (const sel of ['meta[name="description"]', 'meta[property="og:description"]']) { const m = document.querySelector(sel); if (m) m.setAttribute('content', description); }
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3D views: js/viewer.js first, own 3Dmol path second, the RCSB image last

const LIGAND_COLORS = { C: '#B5480C', N: '#3050F8', O: '#E53935', S: '#C9A800', P: '#FF8000', F: '#2E8B57', Cl: '#2E8B57', Br: '#2E8B57', I: '#2E8B57' };
const REF_COLORS = { ...LIGAND_COLORS, C: '#1F5F8B' };
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasWebGL = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } };

// lib/3Dmol-min.js is a classic script (window.$3Dmol); it is fetched only when a page really renders a 3D view
let dmolPromise = null;
export function ensure3Dmol() {
  if (window.$3Dmol) return Promise.resolve(true);
  if (!hasWebGL()) return Promise.resolve(false);
  if (!dmolPromise) {
    dmolPromise = new Promise((resolve) => {
      const s = el('script', { src: '/lib/3Dmol-min.js', async: true });
      s.addEventListener('load', () => resolve(!!window.$3Dmol));
      s.addEventListener('error', () => resolve(false));
      document.head.append(s);
    });
  }
  return dmolPromise;
}

function ownViewer(host, { background = '#FFFFFF', transparent = false, spin = true } = {}) {
  const $3 = window.$3Dmol;
  if (!$3 || !hasWebGL()) return null;
  const slot = el('div', { class: 'pc-viewer-host' });
  host.append(slot);
  let viewer;
  try {
    viewer = $3.createViewer(slot, { backgroundColor: background, backgroundAlpha: transparent ? 0 : 1, antialias: true });
  } catch { slot.remove(); return null; }
  let spinning = false;
  const setSpin = (on) => { if (!viewer) return; spinning = on; try { viewer.spin(on && spin && !reducedMotion() ? 'y' : false, 0.18); } catch { /* not ready */ } };
  const onVis = () => setSpin(!document.hidden);
  const onResize = () => { try { viewer.resize(); } catch { /* gone */ } };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', onResize);
  slot.addEventListener('pointerenter', () => setSpin(false));
  slot.addEventListener('pointerleave', () => setSpin(true));
  slot.addEventListener('touchstart', () => setSpin(false), { passive: true });
  return {
    viewer,
    start() { setSpin(true); },
    pause() { setSpin(false); },
    resume() { setSpin(true); },
    destroy() {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      try { viewer.spin(false); viewer.clear(); } catch { /* gone */ }
      slot.remove();
      viewer = null;
    },
    get spinning() { return spinning; },
  };
}

// the lab builder's wrapper: createViewer(el, { style }) + showStructure / showLigand / spin / dispose
async function viaViewerModule(host, kind, payload, { transparent = false, spin = true, pdbId, refCcd, chain, frameAll = false, orangeReference = false, pose = null, box = null } = {}) {
  const vm = await viewerMod();
  if (!vm || typeof vm.createViewer !== 'function') return null;
  if (!(await ensure3Dmol())) return null;
  if (typeof vm.supported === 'function' && !vm.supported()) return null;
  const slot = el('div', { class: 'pc-viewer-host' });
  host.append(slot);
  try {
    const h = vm.createViewer(slot, { style: transparent ? 'hero' : 'card' });
    if (kind === 'structure') {
      await h.showStructure(payload, { id: pdbId, chain, ligandCcd: refCcd, highlightPocket: box && box.center && box.half ? { center: box.center, half: box.half } : null });
      if (orangeReference && refCcd && h.viewer) {
        try {
          if (typeof h.setReference === 'function') await h.setReference(false);
          h.viewer.setStyle({ resn: String(refCcd).toUpperCase(), hetflag: true }, { stick: { radius: 0.24, colorscheme: { prop: 'elem', map: LIGAND_COLORS } } });
        } catch { /* keep the ghost */ }
      }
      if (pose && pose.sdfText && pose.poseAbs && typeof h.showPose === 'function') {
        try { h.showPose(pose.sdfText, pose.poseAbs); } catch { /* the structure alone */ }
      }
      if (frameAll && h.viewer) { try { h.viewer.zoomTo(); h.viewer.render(); } catch { /* keep the pocket framing */ } }
      else if (h.viewer) { try { h.viewer.render(); } catch { /* fine */ } }
    } else {
      await h.showLigand(payload);
    }
    h.spin(spin);
    return {
      handle: h,
      destroy() { try { h.dispose(); } catch { /* gone */ } slot.remove(); },
      pause() { try { h.spin(false); } catch { /* gone */ } },
      resume() { try { h.spin(spin); } catch { /* gone */ } },
    };
  } catch {
    slot.remove();
    return null;
  }
}

/** The ligand's SDF with its coordinates replaced by the pose (absolute angstrom, 3 per heavy atom, topology order). */
export function sdfWithPoseLocal(sdfText, poseAbs) {
  const lines = String(sdfText).split(/\r?\n/);
  if (lines.length < 4) return sdfText;
  const n = parseInt(lines[3].slice(0, 3), 10);
  if (!Number.isFinite(n) || !poseAbs || poseAbs.length < 3 * n) return sdfText;
  const f = (v) => Number(v).toFixed(4).padStart(10, ' ');
  for (let i = 0; i < n; i++) {
    const line = lines[4 + i] || '';
    lines[4 + i] = `${f(poseAbs[3 * i])}${f(poseAbs[3 * i + 1])}${f(poseAbs[3 * i + 2])}${line.slice(30)}`;
  }
  return lines.join('\n');
}

/**
 * host: the .pc-viewer element (position relative). opts: { pdbId, refCcd, chain, image, transparent, spin, frameAll, onState(state),
 * pose: { sdfText, poseAbs } (a docked pose drawn on the receptor, SPEC 9.3), box: { center, half } (angstrom) }
 * state: 'loading' | 'ready' | 'image'. Returns a handle with destroy().
 */
export async function mountStructure(host, opts) {
  const { pdbId, refCcd, chain: chainId = null, image, transparent = false, spin = true, frameAll = false, onState = () => {}, pose = null, box = null } = opts;
  host.replaceChildren();
  const img = el('img', { class: 'pc-viewer-img', src: image || rcsbImage(pdbId), alt: `RCSB entry image for ${pdbId}` });
  const caption = el('div', { class: 'pc-viewer-caption' }, STR.viewerLoading);
  host.append(img, caption);
  onState('loading');
  const toImage = (why) => { img.classList.add('pc-viewer-img--solo'); caption.textContent = STR.viewerFallback; onState('image', why); return { destroy() { host.replaceChildren(); }, pause() {}, resume() {} }; };
  let text;
  try { text = await fetchStructure(pdbId); } catch { return toImage('fetch'); }
  if (!host.isConnected) return { destroy() {}, pause() {}, resume() {} };
  const shared = await viaViewerModule(host, 'structure', text, { transparent, spin, pdbId, refCcd, chain: chainId, frameAll, orangeReference: transparent, pose, box });
  if (shared) { img.remove(); caption.remove(); onState('ready'); return shared; }
  if (!(await ensure3Dmol())) return toImage('webgl');
  const own = ownViewer(host, { transparent, spin });
  if (!own) return toImage('webgl');
  try {
    const v = own.viewer;
    v.addModel(text, 'pdb');
    v.setStyle({}, { cartoon: { color: '#9DB7CC' } });
    v.setStyle({ hetflag: true }, {});
    if (refCcd) {
      v.setStyle({ resn: refCcd }, { stick: { radius: 0.15, opacity: 0.55, colorscheme: { prop: 'elem', map: REF_COLORS } } });
    }
    if (pose && pose.sdfText && pose.poseAbs) {
      const m = v.addModel(sdfWithPoseLocal(pose.sdfText, pose.poseAbs), 'sdf');
      m.setStyle({}, { stick: { radius: 0.22, colorscheme: { prop: 'elem', map: LIGAND_COLORS } } });
      v.zoomTo({ model: m });
    } else v.zoomTo();
    v.render();
    own.start();
  } catch { own.destroy(); return toImage('render'); }
  img.remove();
  caption.remove();
  onState('ready');
  return own;
}

/** host: the .pc-viewer element. opts: { ligand (catalog entry), sdfText?, spin } */
export async function mountLigand(host, opts) {
  const { ligand: l, spin = true, onState = () => {} } = opts;
  host.replaceChildren();
  const tile = ligandMedia(l, { detail: true });
  tile.classList.add('pc-viewer-tile');
  const caption = el('div', { class: 'pc-viewer-caption' }, 'Loading the 3D file');
  host.append(tile, caption);
  onState('loading');
  const toTile = () => { caption.textContent = l.ccd ? 'Depiction from the RCSB chemical component dictionary' : '2D depiction unavailable. Topology and 3D file on chain.'; onState('image'); return { destroy() { host.replaceChildren(); }, pause() {}, resume() {} }; };
  let sdf = opts.sdfText;
  if (!sdf) { try { sdf = await fetchLigandSdf(l); } catch { return toTile(); } }
  const shared = await viaViewerModule(host, 'ligand', sdf, { spin });
  if (shared) { tile.remove(); caption.remove(); onState('ready'); return shared; }
  if (!(await ensure3Dmol())) return toTile();
  const own = ownViewer(host, { spin });
  if (!own) return toTile();
  try {
    const v = own.viewer;
    v.addModel(sdf, 'sdf');
    v.setStyle({}, { stick: { radius: 0.22, colorscheme: { prop: 'elem', map: LIGAND_COLORS } }, sphere: { scale: 0.22, colorscheme: { prop: 'elem', map: LIGAND_COLORS } } });
    v.zoomTo();
    v.render();
    own.start();
  } catch { own.destroy(); return toTile(); }
  tile.remove();
  caption.remove();
  onState('ready');
  return own;
}

export { REF_COLORS };

// ---------------------------------------------------------------------------------------------------------
// write flows

function walletMessage(e, fallback) {
  if (e && e.code === 'rejected') return STR.rejected;
  return (e && e.message) || fallback;
}

/** Sponsor a target's pool. amountText is the ETH field's value. Returns the receipt or null. */
export async function sponsor(targetId, amountText, { label = 'the target' } = {}) {
  const wei = parseEth(amountText);
  if (wei === null || wei <= 0n) { toast(STR.amountZero, { kind: 'error' }); return null; }
  if (!W.account()) { openWalletMenu(); return null; }
  const L = await lab();
  if (!L) { toast(STR.notLive, { kind: 'error' }); return null; }
  try {
    const built = L.buildFund(Number(targetId), wei);
    const { hash, wait } = await W.sendTx(built);
    toast(STR.txSent);
    const r = await wait();
    if (r.status === 'success') toast([`Pool sponsored with ${F.units(wei, 18, 6)} ETH `, txLink(hash)], { kind: 'success', ms: 8000 });
    else toast(r.error || STR.txFailed, { kind: 'error', ms: 10000 });
    return r;
  } catch (e) {
    toast(walletMessage(e, STR.txFailed), { kind: 'error', ms: 8000 });
    return null;
  }
}

export async function settle(targetId, epoch) {
  if (!W.account()) { openWalletMenu(); return null; }
  const L = await lab();
  if (!L || typeof L.buildSettle !== 'function') { toast(STR.notLive, { kind: 'error' }); return null; }
  try {
    const built = L.buildSettle(Number(targetId), Number(epoch));
    const { hash, wait } = await W.sendTx(built);
    toast(STR.txSent);
    const r = await wait();
    if (r.status === 'success') {
      let amount = null;
      try {
        const log = (r.logs || []).find((g) => g.data && g.data.length >= 130);
        if (log) amount = BigInt('0x' + log.data.slice(-64));
      } catch { amount = null; }
      toast([amount !== null ? `Epoch settled. ${F.units(amount, 18, 6)} ETH sent to the best wallet. ` : 'Epoch settled. ', txLink(hash)], { kind: 'success', ms: 8000 });
    } else toast(r.error || STR.txFailed, { kind: 'error', ms: 10000 });
    return r;
  } catch (e) {
    toast(walletMessage(e, STR.txFailed), { kind: 'error', ms: 8000 });
    return null;
  }
}

/** setName flow for the dashboard: one transaction, then the page's wallet cells pick the new name up. */
export async function saveName(name) {
  if (!W.account()) { openWalletMenu(); return null; }
  const L = await lab();
  if (!L || typeof L.buildSetName !== 'function') { toast(STR.notLive, { kind: 'error' }); return null; }
  try {
    const built = L.buildSetName(name);
    const { hash, wait } = await W.sendTx(built);
    toast(STR.txSent);
    const r = await wait();
    if (r.status === 'success') {
      L.forgetName(W.account());
      for (const c of document.querySelectorAll('[data-wallet][data-named]')) c.removeAttribute('data-named');
      hydrateNames();
      toast([String(name).trim() ? 'Researcher name saved ' : 'Researcher name cleared ', txLink(hash)], { kind: 'success', ms: 8000 });
    } else toast(r.error || STR.txFailed, { kind: 'error', ms: 10000 });
    return r;
  } catch (e) {
    toast(walletMessage(e, 'The name could not be saved.'), { kind: 'error', ms: 8000 });
    return null;
  }
}

export async function withdraw() {
  if (!W.account()) { openWalletMenu(); return null; }
  const L = await lab();
  if (!L || typeof L.buildWithdraw !== 'function') { toast(STR.notLive, { kind: 'error' }); return null; }
  try {
    const built = L.buildWithdraw();
    const { hash, wait } = await W.sendTx(built);
    toast(STR.txSent);
    const r = await wait();
    if (r.status === 'success') toast(['Prize claimed ', txLink(hash)], { kind: 'success', ms: 8000 });
    else toast(r.error || STR.txFailed, { kind: 'error', ms: 10000 });
    return r;
  } catch (e) {
    toast(walletMessage(e, STR.nothingToClaim), { kind: 'error', ms: 8000 });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// misc

export function countdownTo(endSeconds, node, { ended = 'Epoch ended, ready to settle' } = {}) {
  const paint = () => {
    const left = Math.floor(Number(endSeconds) - Date.now() / 1000);
    node.textContent = left > 0 ? `Epoch ends in ${F.countdown(left)}` : ended;
    return left > 0;
  };
  if (!paint()) return () => {};
  const t = setInterval(() => { if (!document.hidden && !paint()) clearInterval(t); }, 1000);
  return () => clearInterval(t);
}

export function reveal() {
  if (!('IntersectionObserver' in window)) { document.querySelectorAll('.pc-reveal').forEach((n) => n.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.pc-reveal').forEach((n) => io.observe(n));
}

export function dayIndex(n) {
  return n > 0 ? Math.floor(Date.now() / 86400000) % n : 0;
}

export function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function csv(rows) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export const utcStamp = (d = new Date()) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;

// ---------------------------------------------------------------------------------------------------------
// v2 (SPEC 9): stars, reviews, docking tests by id, the X intent, the test report, the AI analysis route,
// and the gamification data. Every read of the data layer's new surface is guarded: an absent function
// degrades (a run is found in the run list, reviews are empty with the note), never a crash.

export function starIcon(lit, size = 16) {
  const s = icon('star', size, 'pc-star');
  if (lit) { s.setAttribute('fill', 'currentColor'); s.setAttribute('data-lit', '1'); }
  return s;
}
/** Five stars, the first round(value) lit. */
export function stars(value, { size = 16, label = null } = {}) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  const host = el('span', { class: 'pc-stars', role: 'img', 'aria-label': label || `${F.fixed(v, 1)} of 5 stars` });
  for (let i = 1; i <= 5; i++) host.append(starIcon(i <= Math.round(v), size));
  return host;
}
/** A stars picker: five 44 px buttons, aria-pressed, keyboard arrows. onChange(n). */
export function starsPicker({ value = 0, onChange = () => {} } = {}) {
  let current = value;
  const host = el('div', { class: 'pc-stars-picker', role: 'radiogroup', 'aria-label': 'Stars' });
  const buttons = [];
  const paint = () => buttons.forEach((b, i) => { b.setAttribute('aria-checked', i + 1 === current ? 'true' : 'false'); b.replaceChildren(starIcon(i + 1 <= current, 24)); b.tabIndex = (current ? i + 1 === current : i === 0) ? 0 : -1; });
  for (let i = 1; i <= 5; i++) {
    const b = el('button', { type: 'button', class: 'pc-star-btn', role: 'radio', 'aria-label': `${i} ${i === 1 ? 'star' : 'stars'}`, onclick: () => { current = i; paint(); onChange(current); } });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); current = Math.min(5, (current || 0) + 1); paint(); buttons[current - 1].focus(); onChange(current); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); current = Math.max(1, (current || 1) - 1); paint(); buttons[current - 1].focus(); onChange(current); }
    });
    buttons.push(b);
    host.append(b);
  }
  paint();
  return Object.assign(host, { get value() { return current; }, set value(v) { current = v; paint(); } });
}

/** Try the data layer's reads by name, in order; the first one that exists answers. */
export async function read(names, ...args) {
  for (const n of [].concat(names)) {
    const r = await chain(n, ...args);
    if (r.reason !== 'absent') return { ...r, name: n };
  }
  return { ok: false, value: null, reason: 'absent', name: null };
}
const unwrap = (v, keys) => { if (Array.isArray(v)) return v; if (v && typeof v === 'object') for (const k of keys) if (Array.isArray(v[k])) return v[k]; return []; };

export function normReview(r) {
  if (!r || typeof r !== 'object') return null;
  const reviewer = r.reviewer || r.wallet || r.from || null;
  const runId = Number(r.runId ?? r.run ?? r.id);
  const s = Number(r.stars);
  if (!reviewer || !Number.isFinite(runId) || !Number.isFinite(s)) return null;
  return { runId, reviewer, stars: Math.max(0, Math.min(5, s)), note: typeof r.note === 'string' ? r.note : typeof r.text === 'string' ? r.text : '', time: r.time ?? null, block: r.block ?? null, tx: r.tx || null, logIndex: r.logIndex ?? null };
}
const newestFirst = (a, b) => (Number(b.block) || 0) - (Number(a.block) || 0) || (Number(b.time) || 0) - (Number(a.time) || 0) || (Number(b.logIndex) || 0) - (Number(a.logIndex) || 0);

/** Reviews of one docking test, newest first: { ok, list, reason }. A full run (runById) already carries reviewList. */
export async function reviewsOf(runId, run = null) {
  if (run && Array.isArray(run.reviewList)) return { ok: true, list: run.reviewList.map(normReview).filter(Boolean).sort(newestFirst), reason: null };
  const r = await read(['reviewsOf'], Number(runId));
  if (!r.ok) return { ok: false, list: [], reason: r.reason };
  const list = unwrap(r.value, ['reviews', 'list', 'items']).map(normReview).filter(Boolean).filter((x) => x.runId === Number(runId)).sort(newestFirst);
  return { ok: true, list, reason: null };
}
/** Every resolved review on chain (the ledger's list; for the report and the landing count): { ok, list }. */
export async function allReviews() {
  const l = await chain('ledger');
  if (l.ok && l.value && Array.isArray(l.value.reviews)) return { ok: true, list: l.value.reviews.map(normReview).filter(Boolean).sort(newestFirst), reason: null };
  const r = await read(['allReviews'], { limit: 5000 });
  if (!r.ok) return { ok: false, list: [], reason: r.reason };
  return { ok: true, list: unwrap(r.value, ['reviews', 'list', 'items']).map(normReview).filter(Boolean).sort(newestFirst), reason: null };
}
/** { count, starSum, avg } of a review list. */
export function reviewSummary(list) {
  const count = list.length;
  const starSum = list.reduce((n, x) => n + Number(x.stars), 0);
  return { count, starSum, avg: count ? starSum / count : 0 };
}
/** Map<runId, { count, starSum, avg }> from a review list. */
export function reviewStatsByRun(list) {
  const by = new Map();
  for (const r of list) { const a = by.get(r.runId) || []; a.push(r); by.set(r.runId, a); }
  return new Map([...by.entries()].map(([id, l]) => [id, reviewSummary(l)]));
}

export function normRun(v) {
  if (!v || typeof v !== 'object') return null;
  const r = v.run && typeof v.run === 'object' ? { ...v.run, ...v, run: undefined } : v;
  if (r.id === undefined || r.id === null || !r.wallet) return null;
  if (typeof r.pose === 'string' && /^0x([0-9a-fA-F]{4})*$/.test(r.pose)) {
    const n = (r.pose.length - 2) / 4;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = (parseInt(r.pose.slice(2 + i * 4, 6 + i * 4), 16) << 16) >> 16;
    r.pose = out;
  } else if (Array.isArray(r.pose)) r.pose = Int16Array.from(r.pose, Number);
  return r;
}
/** One docking test by id: runById from the data layer v2, else found in the run list. { ok, run, reason } */
export async function runById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { ok: false, run: null, reason: 'bad-id' };
  const r = await read(['runById', 'runOf', 'getRun'], n);
  if (r.ok) return { ok: true, run: normRun(r.value), reason: null };
  if (r.reason === 'error') return { ok: false, run: null, reason: 'error' };
  const page = await chain('runsPage', { limit: 1, offset: 0, order: 'asc' });
  const total = page.ok && page.value ? Number(page.value.total) : null;
  if (total !== null && n > total) return { ok: true, run: null, reason: null };
  // the run list is newest first: the test is at offset total - n when the ids are dense (they are: runs are 1-based)
  if (total !== null) {
    const p = await chain('runsPage', { limit: 1, offset: total - n, order: 'desc' });
    const hit = p.ok && p.value && Array.isArray(p.value.runs) ? p.value.runs.map(normRun).find((x) => x && Number(x.id) === n) : null;
    if (hit) return { ok: true, run: hit, reason: null };
  }
  const all = await chain('runs', { limit: 1000 });
  if (!all.ok) return { ok: false, run: null, reason: all.reason };
  return { ok: true, run: (all.value || []).map(normRun).find((x) => x && Number(x.id) === n) || null, reason: null };
}
/** The attached AI analysis of a test (event Analysis, SPEC 9.8): { ok, analysis: { provider, model, text, time, block, tx } | null }. */
export async function analysisOf(runId, run = null) {
  const shape = (v) => (v && typeof v.text === 'string' && v.text ? { provider: String(v.provider || ''), model: v.model ? String(v.model) : null, text: v.text, time: v.time ?? null, block: v.block ?? null, tx: v.tx || null } : null);
  if (run && 'analysis' in run) return { ok: true, analysis: shape(run.analysis), reason: null };
  const r = await read(['analysesOf', 'analysisOf'], Number(runId));
  if (!r.ok) return { ok: false, analysis: null, reason: r.reason };
  let v = r.value;
  if (Array.isArray(v)) v = v.length ? v[v.length - 1] : null; // block order: the last one is the current attachment
  return { ok: true, analysis: shape(v), reason: null };
}
/** The method JSON a test recorded (event Method, SPEC 9.7) as a string, '' when none: { ok, json }. */
export async function methodOf(run) {
  if (!run) return { ok: false, json: '' };
  if (typeof run.method === 'string') return { ok: true, json: run.method };
  if (run.method && typeof run.method === 'object') return { ok: true, json: JSON.stringify(run.method) };
  if ('method' in run) return { ok: true, json: '' };
  const r = await read(['methodOf'], Number(run.id));
  if (!r.ok) return { ok: false, json: '' };
  const v = r.value;
  if (typeof v === 'string') return { ok: true, json: v };
  if (v && typeof v === 'object' && typeof v.json === 'string') return { ok: true, json: v.json };
  return { ok: true, json: '' };
}
/** Settled events (epoch wins): { ok, list: [{ targetId, epoch, winner, runId, amount }] } */
export async function settledEvents() {
  const r = await read(['settledAll', 'settled'], {});
  if (!r.ok) return { ok: false, list: [], reason: r.reason };
  return { ok: true, list: unwrap(r.value, ['settled', 'list', 'items']).filter((x) => x && x.winner), reason: null };
}

/**
 * Everything the XP needs (SPEC 9.5): the data layer's ledger() when it exists ({ runs ascending, settled, funded, reviews,
 * analyses }), else assembled from the older reads. { runs, reviews, settled, funded, analyses, bests, have: { reviews, settled, funded } }
 */
export async function gamifyData() {
  const l = await chain('ledger');
  if (l.ok && l.value && Array.isArray(l.value.runs)) {
    const v = l.value;
    const runs = v.runs.map(normRun).filter(Boolean).sort((x, y) => Number(x.id) - Number(y.id));
    return { ...v, runs, reviews: (v.reviews || []).map(normReview).filter(Boolean), settled: v.settled || [], funded: v.funded || [], analyses: v.analyses || [], bests: null, have: { reviews: true, settled: true, funded: true } };
  }
  const [all, rv, st, b] = await Promise.all([chain('allRuns'), allReviews(), settledEvents(), chain('bests')]);
  let runs = all.ok && all.value && Array.isArray(all.value.runs) ? all.value.runs : null;
  if (!runs) { const r = await chain('runs', { limit: 1000, order: 'asc' }); runs = r.ok && Array.isArray(r.value) ? r.value : []; }
  runs = runs.map(normRun).filter(Boolean).sort((x, y) => Number(x.id) - Number(y.id));
  return { runs, reviews: rv.list, settled: st.list, funded: [], analyses: [], bests: b.ok ? b.value : null, have: { reviews: rv.ok, settled: st.ok, funded: false } };
}

/** X intent link (SPEC 9.3): https://x.com/intent/post?text=<encoded>&url=<encoded> */
export const xIntent = (text, url) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
/** Model text made safe for a post or a report: no em or en dashes, no emoji, one line. */
export function cleanModelText(s) {
  return String(s || '')
    .replace(/\s*[\u{2013}\u{2014}]\s*/gu, ', ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const providerLabel = (a) => (a && (a.model || a.provider) ? `${a.provider || ''}${a.provider && a.model ? ' ' : ''}${a.model || ''}`.trim() : 'AI analysis');
/** The X post text of a docking test (SPEC 9.3 and 9.8). t, l: catalog entries; analysis: the attached one or null. */
export function testPostText(run, t, l, analysis = null, researcher = null) {
  const m = milliOf(run);
  const by = researcher ? ` by ${researcher}` : '';
  let s = `Docking test #${run.id}${by} on Ponchem: ${l ? l.name : `ligand ${run.ligandId}`} into ${t ? t.gene || t.key : `target ${run.targetId}`}${t ? ` (${t.pdbId})` : ''}. dG ${dgText(m)} kcal/mol, pKd ${pkdText(m)}, scored on Robinhood Chain.`;
  if (analysis && analysis.text) s += ` ${providerLabel(analysis)}: ${cleanModelText(analysis.text).slice(0, 500)}`;
  return s;
}
export const testPostLink = (run, t, l, analysis = null, researcher = null) => xIntent(testPostText(run, t, l, analysis, researcher), runUrl(run.id));

/** The Markdown report of a docking test, built in the browser (SPEC 9.3). */
export function testMarkdown({ run, t, l, browser = null, reviews = [], method = '', analysis = null }) {
  const m = milliOf(run);
  const d = derived(m, l && l.heavyAtoms);
  const b = band(m);
  const lines = [];
  lines.push(`# Docking test #${run.id} on Ponchem`, '');
  lines.push(`${l ? l.name : `ligand ${run.ligandId}`} into ${t ? `${t.gene || t.key} (${t.pdbId})` : `target ${run.targetId}`}, scored on Robinhood Chain.`, '');
  lines.push(`- Wallet: ${run.wallet}`);
  if (runTime(run)) lines.push(`- Recorded: ${new Date(runTime(run)).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  if (run.tx) lines.push(`- Transaction: ${EXPLORER.tx(run.tx)}`);
  lines.push(`- Page: ${runUrl(run.id)}`, '');
  lines.push('## Score', '');
  lines.push(`- dG: ${dgText(m)} kcal/mol (${BAND_LONG[b] || b})`);
  lines.push(`- pKd: ${pkdText(m)}`);
  lines.push(`- Kd: ${kdText(d.kd)}`);
  lines.push(`- Ligand efficiency: ${d.le === null ? F.EMPTY : F.fixed(d.le, 2)} kcal/mol per heavy atom`);
  if (browser && browser.terms) {
    lines.push('', '| Term | kcal/mol |', '|---|---|');
    for (const [k, name] of [['g1', 'gauss 1'], ['g2', 'gauss 2'], ['rep', 'repulsion'], ['hyd', 'hydrophobic'], ['hb', 'hydrogen bond']]) lines.push(`| ${name} | ${F.fixed(browser.terms[k], 3)} |`);
    lines.push(`| divided by | ${F.fixed(browser.divisor, 4)} |`);
  }
  if (browser) lines.push('', browser.agree ? `Geometry proof: ${browser.ok ? 'passes' : 'fails'}. ${STR.agree}.` : `Geometry proof: ${browser.ok ? 'passes' : 'fails'}. ${browser.note || ''}`.trim());
  lines.push('', '## Provenance', '');
  if (t) lines.push(`- Target: ${targetName(t)}, RCSB ${t.pdbId}: ${rcsbEntry(t.pdbId)}`);
  if (t && t.ligand && t.ligand.ccd) lines.push(`- Reference ligand: RCSB ${t.ligand.ccd}: ${rcsbLigand(t.ligand.ccd)}`);
  if (l) lines.push(`- Ligand: ${l.name}${l.ccd ? `, RCSB ${l.ccd}: ${rcsbLigand(l.ccd)}` : l.pubchemCid ? `, PubChem ${l.pubchemCid}: ${pubchemUrl(l.pubchemCid)}` : ''}`);
  lines.push('', '## Method', '');
  if (method) { lines.push('```json'); try { lines.push(JSON.stringify(JSON.parse(method), null, 2)); } catch { lines.push(String(method)); } lines.push('```'); } else lines.push(STR.methodNone);
  lines.push('', '## Reviews', '');
  const s = reviewSummary(reviews);
  lines.push(s.count ? `${F.fixed(s.avg, 1)} of 5 stars from ${F.num(s.count)} ${s.count === 1 ? 'review' : 'reviews'}.` : 'No reviews yet.');
  for (const r of reviews.slice(0, 20)) lines.push(`- ${r.stars} of 5 by ${r.reviewer}${r.note ? `: ${cleanModelText(r.note).replace(/\|/g, ' ')}` : ''}`);
  if (analysis && analysis.text) { lines.push('', `## AI analysis (${providerLabel(analysis)}, unverified model output)`, '', cleanModelText(analysis.text).slice(0, 500)); }
  lines.push('', 'Estimates from computational screening with a Vina-style scoring function. Not clinical results.', '', `${BRAND.footer}, compiled from Robinhood Chain`, '');
  return lines.join('\n');
}

// the AI analysis route (SPEC 9.8)
export const ANALYSIS_PROVIDERS = Object.freeze([
  { id: 'claude', name: 'Claude Fable 5.1' }, { id: 'gpt', name: 'GPT' }, { id: 'kimi', name: 'Kimi' }, { id: 'jev', name: 'Jev AI' },
].map(Object.freeze));
const providerNorm = (p) => {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || p.provider || p.key || '').trim();
  if (!id) return null;
  const known = ANALYSIS_PROVIDERS.find((k) => k.id === id.toLowerCase() || (p.name && String(p.name).toLowerCase().includes(k.name.toLowerCase().split(' ')[0])));
  return { id, name: String(p.name || p.label || (known && known.name) || id), model: p.model ? String(p.model) : null, connected: p.connected === true || p.available === true };
};
/** GET /api/analyze: { ok, providers: [{ id, name, model, connected }], reason }. Absent route: the four providers, none connected. */
export async function analysisProviders() {
  const blank = ANALYSIS_PROVIDERS.map((p) => ({ ...p, model: null, connected: false }));
  try {
    const r = await fetch('/api/analyze', { cache: 'no-cache', headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, providers: blank, reason: r.status === 404 ? 'absent' : 'error' };
    const j = await r.json();
    const list = (Array.isArray(j) ? j : unwrap(j, ['providers', 'list', 'items'])).map(providerNorm).filter(Boolean);
    return { ok: true, providers: list.length ? list : blank, reason: null };
  } catch {
    return { ok: false, providers: blank, reason: 'error' };
  }
}
/** POST /api/analyze { runId, provider }: { ok, provider, model, text, generatedAt, error } */
export async function analyzeTest(runId, provider) {
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ runId: Number(runId), provider }) });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || !j || typeof j.text !== 'string' || !j.text) return { ok: false, error: (j && (j.message || j.error)) ? String(j.message || j.error) : STR.analysisFailed };
    return { ok: true, provider: String(j.provider || provider), model: j.model ? String(j.model) : null, text: j.text, generatedAt: j.generatedAt || null };
  } catch {
    return { ok: false, error: STR.analysisFailed };
  }
}

/** A block of model or review text, paragraph by paragraph, through text nodes only. */
export function textBlock(text, cls = 'pc-text-block') {
  const host = el('div', { class: cls });
  for (const para of String(text || '').split(/\n{2,}/)) {
    const p = el('p');
    const lines = para.split(/\n/);
    lines.forEach((line, i) => { if (i) p.append(el('br')); p.append(line); });
    host.append(p);
  }
  return host;
}

/** base64url of a compact JSON string (the lab's ?method= form, SPEC 9.7). */
export function base64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The gamification rules: js/gamify.js (computeProfile, rankWallets, levelFor, LEVELS, BADGES, XP_RULES) when it ships,
 * else js/pages/xp.js. Every answer is normalised to one Profile shape (see xp.js) so the pages never see two.
 */
export async function gamify() {
  const G = await gamifyMod();
  const shared = !!(G && typeof G.computeProfile === 'function' && typeof G.rankWallets === 'function');
  const LEVELS = shared && Array.isArray(G.LEVELS) && G.LEVELS.length && G.LEVELS.every((l) => l && typeof l.name === 'string' && Number.isFinite(Number(l.min))) ? G.LEVELS.map((l) => ({ key: l.key || String(l.name).toLowerCase().replace(/\s+/g, '-'), name: l.name, min: Number(l.min) })) : XP.LEVELS;
  const BADGES = shared && Array.isArray(G.BADGES) && G.BADGES.length && G.BADGES.every((b) => b && typeof (b.id || b.key) === 'string' && typeof b.name === 'string')
    ? G.BADGES.map((b) => { const key = b.id || b.key; return { key, name: b.name, rule: b.rule || b.text || '', path: typeof b.path === 'string' ? b.path : null, icon: b.icon && ICONS[b.icon] ? b.icon : ICONS[key] ? key : 'best-on-target' }; })
    : XP.BADGES;
  const XP_RULES = shared && Array.isArray(G.XP_RULES) && G.XP_RULES.every((r) => r && Number.isFinite(Number(r.xp ?? r.points)) && typeof (r.sentence || r.text) === 'string')
    ? G.XP_RULES.map((r) => ({ key: r.id || r.key, points: Number(r.xp ?? r.points), text: r.sentence || r.text }))
    : XP.XP_RULES;
  const levelOf = (xp) => {
    const x = Math.max(0, Number(xp) || 0);
    let index = 0;
    for (let i = 0; i < LEVELS.length; i++) if (x >= LEVELS[i].min) index = i;
    const here = LEVELS[index];
    const next = LEVELS[index + 1] || null;
    return { index, key: here.key, name: here.name, min: here.min, next, progress: next ? Math.min(1, (x - here.min) / (next.min - here.min)) : 1, toNext: next ? Math.max(0, next.min - x) : 0 };
  };
  const fromShared = (pr) => {
    if (!pr || typeof pr !== 'object' || !Number.isFinite(Number(pr.xp))) return null;
    const c = pr.counts || {};
    const xp = Number(pr.xp);
    const lvl = levelOf(xp);
    if (pr.next && typeof pr.next === 'object' && Number.isFinite(Number(pr.next.remaining))) lvl.toNext = Number(pr.next.remaining);
    if (Number.isFinite(Number(pr.progress))) lvl.progress = Number(pr.progress);
    if (typeof pr.title === 'string') lvl.name = pr.title;
    const badges = Array.isArray(pr.badges) ? pr.badges.filter((b) => b && (b.earned === undefined || b.earned)).map((b) => (typeof b === 'string' ? b : b.id || b.key)).filter(Boolean) : [];
    return {
      wallet: pr.address || pr.wallet, xp, level: lvl, tests: Number(c.tests ?? pr.tests ?? 0), targets: Number(c.targets ?? pr.targets ?? 0), best: c.best ?? pr.best ?? null,
      strong: Number(c.strongBinders ?? 0), currentBest: Number(c.bests ?? 0), bestAtRecord: Number(c.bests ?? 0), reviewsWritten: Number(c.reviewsWritten ?? pr.reviewsWritten ?? 0),
      reviewsReceived: Number(c.reviewsReceived ?? pr.reviewsReceived ?? 0), goodReviewsReceived: Number(c.goodReviewsReceived ?? 0), epochsWon: Number(c.epochsWon ?? pr.epochsWon ?? 0),
      sponsoredTargets: Number(c.sponsoredTargets ?? 0), badges, badgeCount: Array.isArray(pr.badges) ? badges.length : Number(pr.badges || 0), breakdown: pr.breakdown || null,
    };
  };
  return {
    shared, LEVELS, BADGES, XP_RULES, levelOf,
    profileOf(address, data) {
      if (shared) { try { const p = fromShared(G.computeProfile(address, data)); if (p) return p; } catch { /* local */ } }
      return XP.profileOf(address, data);
    },
    rank(data) {
      if (shared) { try { const rows = G.rankWallets(data); if (Array.isArray(rows)) { const out = rows.map(fromShared).filter(Boolean); if (out.length === rows.length) return out; } } catch { /* local */ } }
      return XP.rankWallets(data);
    },
  };
}

/** A badge tile: the 24 px stroke icon, the name, the rule; earned tiles carry data-earned. */
export function badgeTile(b, earned) {
  let ic;
  if (b.path) { ic = icon('info', 24); ic.querySelector('path').setAttribute('d', b.path); } else ic = icon(b.icon || b.key, 24);
  return el('div', { class: 'pc-badge-tile', 'data-earned': earned ? '1' : null, title: b.rule || '' }, [
    el('span', { class: 'pc-badge-icon' }, ic),
    el('span', { class: 'pc-badge-name' }, b.name),
    el('span', { class: 'pc-badge-rule' }, b.rule || ''),
  ]);
}
