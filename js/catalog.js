/*
 * js/catalog.js: the library. Targets (receptors from the RCSB Protein Data Bank), ligands (plant compounds), the
 * cancer groups, and the data files behind the lab (SDF, pocket bytes, topology bytes, the structure for the viewer).
 * Browser ES module with no DOM access at import time; Node imports it too (tools, the API routes). Everything is
 * read through fetch() and cached in memory for the life of the page.
 *
 * SHIPPED API (SPEC.md 8.4)
 *   loadCatalog({ registry = true, fresh = false } = {}) -> Promise<Catalog>
 *       Catalog { targets, ligands, cancers: CANCERS, targetById: Map, ligandById: Map, targetByKey: Map, ligandByKey: Map,
 *                 registry: bool, generated: { targets, ligands }, unregistered: { targets: [key], ligands: [key] } }
 *       targets: catalog entries + { id, cancerBits, cancerKeys, pocket, hash?, atoms, box? }   ligands: + { id, topology, hash?, atoms, nrot }
 *       ids come from data/registry.json when it is used, else catalog order (1-based). registry:
 *         true    (default) read data/registry.json: its entries ARE the library (the pipeline registers a curated
 *                 subset of the catalog, 100 targets of 188 on 2026-09-22), merged over the matching catalog entry;
 *                 a 404 is silent and gives catalog order. The file ships with the site (SPEC.md 8.3).
 *         'auto'  read it only when the lab is live (LAB.address set, or the localhost ?contract= override): the
 *                 mode to use if the file is ever absent, because tools/verify.mjs fails any request answering 4xx
 *         false   never
 *   loadRegistry() -> Promise<registry | null>          data/registry.json, null when it does not exist
 *   assembleCatalog(targetsDoc, ligandsDoc, registryDoc | null) -> Catalog     pure, for the server and tests
 *   fetchLigandSdf(keyOrLigand)  -> text          data/ligands/<KEY>.sdf (heavy atoms only, topology order)
 *   fetchPocket(pdbIdOrTarget)   -> Uint8Array    data/pockets/<PDB>.bin (bytes exactly as registered on chain)
 *   fetchTopology(keyOrLigand)   -> Uint8Array    data/topologies/<KEY>.bin
 *   fetchStructure(pdbId)        -> text          https://files.rcsb.org/download/<PDB>.pdb (3D viewer only)
 *   rcsbImage(pdbId)             -> url           https://cdn.rcsb.org/images/structures/<pdb lower>_assembly-1.jpeg
 *   rcsbEntryUrl(pdbId)          -> url           https://www.rcsb.org/structure/<PDB>
 *   CANCERS                      -> [{ bit, key, name }] in SPEC order (bit = index)
 *   cancerByKey(keyOrName)       -> CANCERS entry | null      accepts 'head-and-neck', 'head and neck', 'Head and neck'
 *   cancerBitsOf(names)          -> uint32 with one bit per group named
 *   cancersOf(target)            -> CANCERS entries of a target (from cancerBits when it is a number, else cancers[])
 *   targetsForCancer(bitOrKey, targets) -> targets in that group, catalog order
 *   filterTargets(targets, { q, cancer, cls })   filterLigands(ligands, { q, cls, plant })   text search + filters
 *   matchesTarget(target, q)     matchesLigand(ligand, q)      one entry against a lower-cased query
 *   classesOf(list)              -> [{ key, count }] sorted by count then name (target classes or ligand classes)
 *   plantsOf(ligands)            -> [{ key, count }] one entry per plant named in `plant`
 *   ligandUrl(keyOrLigand) pocketUrl(pdbIdOrTarget) topologyUrl(keyOrLigand)   the site paths (for prefetch links)
 *   CATALOG_ERROR                 the copy deck's sentence when a catalog file cannot be read
 *
 * Every string that reaches a page from here is other people's text (RCSB titles, plant names) and goes through
 * textContent or el(), never innerHTML.
 */
import { siteUrl, overrides } from './rpc.js';
import { LAB } from './config.js';

export const CATALOG_ERROR = 'The catalog could not be loaded. Reload the page.';

export const CANCERS = Object.freeze([
  ['lung', 'Lung'], ['colorectal', 'Colorectal'], ['liver', 'Liver'], ['breast', 'Breast'], ['stomach', 'Stomach'],
  ['pancreatic', 'Pancreatic'], ['prostate', 'Prostate'], ['esophageal', 'Esophageal'], ['cervical', 'Cervical'],
  ['leukemia', 'Leukemia'], ['lymphoma', 'Lymphoma'], ['brain', 'Brain'], ['melanoma', 'Melanoma'], ['ovarian', 'Ovarian'],
  ['bladder', 'Bladder'], ['kidney', 'Kidney'], ['myeloma', 'Myeloma'], ['head-and-neck', 'Head and neck'],
  ['thyroid', 'Thyroid'], ['sarcoma', 'Sarcoma'],
].map(([key, name], bit) => Object.freeze({ bit, key, name })));

const cancerIndex = new Map(CANCERS.map((c) => [c.key, c]));

/** 'Head and neck' / 'head_and_neck' / 'head-and-neck' -> 'head-and-neck' */
export function cancerKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

export function cancerByKey(keyOrName) {
  if (typeof keyOrName === 'number') return CANCERS[keyOrName] || null;
  return cancerIndex.get(cancerKey(keyOrName)) || null;
}

export function cancerBitsOf(names) {
  let bits = 0;
  for (const n of names || []) {
    const c = cancerByKey(n);
    if (c) bits |= 1 << c.bit;
  }
  return bits >>> 0;
}

export function cancersOf(target) {
  if (!target) return [];
  if (typeof target.cancerBits === 'number') return CANCERS.filter((c) => (target.cancerBits >>> c.bit) & 1);
  if (typeof target.cancerBits === 'bigint') return CANCERS.filter((c) => (target.cancerBits >> BigInt(c.bit)) & 1n);
  return CANCERS.filter((c) => cancerBitsOf(target.cancers) & (1 << c.bit));
}

export function targetsForCancer(bitOrKey, targets) {
  const c = cancerByKey(bitOrKey);
  if (!c) return [];
  return (targets || []).filter((t) => cancersOf(t).includes(c));
}

// ---------------------------------------------------------------------------------------------------------
// paths and fetching

const keyOf = (x) => String(x && typeof x === 'object' ? x.key : x || '').trim();
const pdbOf = (x) => String(x && typeof x === 'object' ? x.pdbId : x || '').trim().toUpperCase();
const sitePath = (p) => (p.startsWith('/') ? p : `/${p}`);

export function ligandUrl(keyOrLigand) {
  const file = keyOrLigand && typeof keyOrLigand === 'object' && keyOrLigand.file;
  return sitePath(file || `data/ligands/${keyOf(keyOrLigand).toUpperCase()}.sdf`);
}
export function topologyUrl(keyOrLigand) {
  const file = keyOrLigand && typeof keyOrLigand === 'object' && keyOrLigand.topology;
  return sitePath(file || `data/topologies/${keyOf(keyOrLigand).toUpperCase()}.bin`);
}
export function pocketUrl(pdbIdOrTarget) {
  const file = pdbIdOrTarget && typeof pdbIdOrTarget === 'object' && pdbIdOrTarget.pocket;
  return sitePath(file || `data/pockets/${pdbOf(pdbIdOrTarget)}.bin`);
}
export function rcsbImage(pdbId) {
  return `https://cdn.rcsb.org/images/structures/${pdbOf(pdbId).toLowerCase()}_assembly-1.jpeg`;
}
export function rcsbEntryUrl(pdbId) {
  return `https://www.rcsb.org/structure/${pdbOf(pdbId)}`;
}

const fileCache = new Map(); // url -> Promise<text | Uint8Array>

async function fetchOnce(url, kind, { fresh = false, missingOk = false, signal } = {}) {
  const key = `${kind}:${url}`;
  if (!fresh && fileCache.has(key)) return fileCache.get(key);
  const p = (async () => {
    let r;
    try {
      r = await fetch(url, { signal, headers: { accept: kind === 'json' ? 'application/json' : kind === 'bytes' ? 'application/octet-stream' : 'text/plain' } });
    } catch (e) {
      throw new Error(`${CATALOG_ERROR} (${String((e && e.message) || e).slice(0, 80)})`);
    }
    if (r.status === 404 && missingOk) return null;
    if (!r.ok) throw new Error(`${CATALOG_ERROR} (${url.replace(/^https?:\/\/[^/]+/, '')} answered ${r.status})`);
    if (kind === 'json') return r.json();
    if (kind === 'bytes') return new Uint8Array(await r.arrayBuffer());
    return r.text();
  })();
  fileCache.set(key, p);
  p.catch(() => fileCache.delete(key));
  return p;
}

export function fetchLigandSdf(keyOrLigand, opts) {
  return fetchOnce(siteUrl(ligandUrl(keyOrLigand)), 'text', opts);
}
export function fetchPocket(pdbIdOrTarget, opts) {
  return fetchOnce(siteUrl(pocketUrl(pdbIdOrTarget)), 'bytes', opts);
}
export function fetchTopology(keyOrLigand, opts) {
  return fetchOnce(siteUrl(topologyUrl(keyOrLigand)), 'bytes', opts);
}
export function fetchStructure(pdbId, opts) {
  const id = pdbOf(pdbId);
  if (!/^[0-9][A-Z0-9]{3}$/.test(id)) return Promise.reject(new Error('Unknown target id.'));
  return fetchOnce(`https://files.rcsb.org/download/${id}.pdb`, 'text', opts);
}

export function loadRegistry({ fresh = false, signal } = {}) {
  return fetchOnce(siteUrl('/data/registry.json'), 'json', { fresh, missingOk: true, signal });
}

// ---------------------------------------------------------------------------------------------------------
// assembling the catalog

const list = (doc, name) => (Array.isArray(doc) ? doc : (doc && Array.isArray(doc[name]) ? doc[name] : []));
const asInt = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

function finishTarget(t) {
  const cancers = Array.isArray(t.cancers) ? t.cancers : [];
  const cancerBits = typeof t.cancerBits === 'number' ? t.cancerBits >>> 0 : cancerBitsOf(cancers);
  const cancerKeys = CANCERS.filter((c) => (cancerBits >>> c.bit) & 1).map((c) => c.key);
  const ligand = t.ligand && typeof t.ligand === 'object' ? t.ligand : {};
  return {
    ...t,
    id: asInt(t.id),
    pdbId: pdbOf(t),
    cancers,
    cancerBits,
    cancerKeys,
    pocket: t.pocket || `data/pockets/${pdbOf(t)}.bin`,
    atoms: asInt(t.atoms, 0),
    name: t.name || t.gene || t.key,
    referenceAtoms: asInt(ligand.heavyAtoms, 0),
  };
}

function finishLigand(l) {
  return {
    ...l,
    id: asInt(l.id),
    key: keyOf(l).toUpperCase(),
    topology: l.topology || `data/topologies/${keyOf(l).toUpperCase()}.bin`,
    file: l.file || `data/ligands/${keyOf(l).toUpperCase()}.sdf`,
    atoms: asInt(l.atoms, asInt(l.heavyAtoms, 0)),
    heavyAtoms: asInt(l.heavyAtoms, asInt(l.atoms, 0)),
    nrot: asInt(l.nrot, asInt(l.rotatableBonds, 0)),
  };
}

/** Pure: the three documents in, the Catalog out. registryDoc may be null. */
export function assembleCatalog(targetsDoc, ligandsDoc, registryDoc = null) {
  const catT = list(targetsDoc, 'targets');
  const catL = list(ligandsDoc, 'ligands');
  const unregistered = { targets: [], ligands: [] };
  let targets;
  let ligands;
  const useRegistry = !!(registryDoc && (Array.isArray(registryDoc.targets) || Array.isArray(registryDoc.ligands)));
  if (useRegistry) {
    const tByKey = new Map(catT.map((t) => [keyOf(t), t]));
    const tByPdb = new Map(catT.map((t) => [pdbOf(t), t]));
    const lByKey = new Map(catL.map((l) => [keyOf(l).toUpperCase(), l]));
    const seenT = new Set();
    const seenL = new Set();
    targets = list(registryDoc, 'targets').map((r) => {
      const base = tByKey.get(keyOf(r)) || tByPdb.get(pdbOf(r)) || {};
      if (base.key) seenT.add(keyOf(base));
      return finishTarget({ ...base, ...r });
    });
    ligands = list(registryDoc, 'ligands').map((r) => {
      const base = lByKey.get(keyOf(r).toUpperCase()) || {};
      if (base.key) seenL.add(keyOf(base).toUpperCase());
      return finishLigand({ ...base, ...r });
    });
    unregistered.targets = catT.map(keyOf).filter((k) => !seenT.has(k));
    unregistered.ligands = catL.map((l) => keyOf(l).toUpperCase()).filter((k) => !seenL.has(k));
  } else {
    targets = catT.map((t, i) => finishTarget({ ...t, id: i + 1 }));
    ligands = catL.map((l, i) => finishLigand({ ...l, id: i + 1 }));
  }
  targets.sort((a, b) => a.id - b.id);
  ligands.sort((a, b) => a.id - b.id);
  return {
    targets,
    ligands,
    cancers: CANCERS,
    targetById: new Map(targets.map((t) => [t.id, t])),
    ligandById: new Map(ligands.map((l) => [l.id, l])),
    targetByKey: new Map(targets.map((t) => [t.key, t])),
    ligandByKey: new Map(ligands.map((l) => [l.key, l])),
    targetByPdb: new Map(targets.map((t) => [t.pdbId, t])),
    registry: useRegistry,
    generated: { targets: (targetsDoc && targetsDoc.generated) || null, ligands: (ligandsDoc && ligandsDoc.generated) || null, registry: (registryDoc && registryDoc.generated) || null },
    unregistered,
  };
}

/** True when the registry should be read: the lab is live in config, or the page runs against a local chain. */
export function registryWanted() {
  if (LAB.address) return true;
  try { return !!overrides().contract; } catch { return false; }
}

let catalogPromise = null;
let catalogMode = null;

export function loadCatalog({ registry = true, fresh = false, signal } = {}) {
  const want = registry === 'auto' ? registryWanted() : !!registry;
  if (!fresh && catalogPromise && catalogMode === want) return catalogPromise;
  catalogMode = want;
  catalogPromise = (async () => {
    const [t, l, r] = await Promise.all([
      fetchOnce(siteUrl('/data/catalog/targets.json'), 'json', { fresh, signal }),
      fetchOnce(siteUrl('/data/catalog/ligands.json'), 'json', { fresh, signal }),
      want ? loadRegistry({ fresh, signal }).catch(() => null) : Promise.resolve(null),
    ]);
    return assembleCatalog(t, l, r);
  })();
  catalogPromise.catch(() => { if (catalogMode === want) catalogPromise = null; });
  return catalogPromise;
}

// ---------------------------------------------------------------------------------------------------------
// search and filters for the list pages and the lab pickers

const norm = (s) => String(s || '').toLowerCase();
const tokens = (q) => norm(q).split(/\s+/).filter(Boolean);

function haystackTarget(t) {
  if (!t.__hay) {
    const lig = t.ligand && typeof t.ligand === 'object' ? t.ligand : {};
    Object.defineProperty(t, '__hay', { value: [t.key, t.gene, t.protein, t.pdbId, t.title, t.uniprot, t.uniprotName, t.entityDescription, t.class, lig.name, lig.ccd, ...(t.cancers || [])].map(norm).join(' | '), enumerable: false });
  }
  return t.__hay;
}
function haystackLigand(l) {
  if (!l.__hay) {
    Object.defineProperty(l, '__hay', { value: [l.key, l.name, l.plant, l.latin, l.class, l.formula, l.ccd, l.ccdName, l.pubchemCid].map(norm).join(' | '), enumerable: false });
  }
  return l.__hay;
}

export function matchesTarget(t, q) {
  const words = tokens(q);
  if (!words.length) return true;
  const hay = haystackTarget(t);
  return words.every((w) => hay.includes(w));
}
export function matchesLigand(l, q) {
  const words = tokens(q);
  if (!words.length) return true;
  const hay = haystackLigand(l);
  return words.every((w) => hay.includes(w));
}

export function filterTargets(targets, { q = '', cancer = null, cls = null } = {}) {
  const c = cancer === null || cancer === undefined || cancer === '' ? null : cancerByKey(cancer);
  const klass = cls ? norm(cls) : null;
  return (targets || []).filter((t) => (c ? cancersOf(t).includes(c) : true) && (klass ? norm(t.class) === klass : true) && matchesTarget(t, q));
}

export function filterLigands(ligands, { q = '', cls = null, plant = null } = {}) {
  const klass = cls ? norm(cls) : null;
  const p = plant ? norm(plant) : null;
  return (ligands || []).filter((l) => (klass ? norm(l.class) === klass : true) && (p ? plantsNamed(l).includes(p) : true) && matchesLigand(l, q));
}

const plantsNamed = (l) => norm(l.plant).split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);

function counted(keys) {
  const m = new Map();
  for (const k of keys) if (k) m.set(k, (m.get(k) || 0) + 1);
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
export function classesOf(entries) {
  return counted((entries || []).map((e) => String(e.class || '').trim()));
}
export function plantsOf(ligands) {
  return counted((ligands || []).flatMap(plantsNamed));
}
