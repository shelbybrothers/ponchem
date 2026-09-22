/*
 * js/pages/lab.js: the docking app at /lab. Wires the pickers, the 3D viewer, the run controls, the method panel,
 * the results panel, the docking test flow and the screening queue (SPEC.md 3, 9.1, 9.4, 9.7; SPEC-DESIGN.md 5.6
 * and 5.7; docs/copy.md 2).
 *
 * Modules it leans on (dynamic imports, so a missing one degrades the page instead of breaking it):
 *   js/catalog.js        loadCatalog, fetchLigandSdf, fetchPocket, fetchTopology, fetchStructure, rcsbImage, CANCERS
 *   js/engine/index.js   parseSdf, loadPocket, loadTopology, scoreInt, dock, cancel, derived
 *   js/engine/method.js  METHOD_PRESETS, validateMethod, methodToCompact, methodToQuery, methodFromQuery (SPEC 9.7);
 *                        absent: the Method panel shows the engine-unavailable line and the depth control drives the run
 *   js/chain.js          labStatus          js/lab.js   buildSubmitRun, quote, buildApprove, allowanceOf (+ the revert explainer)
 * URL: /lab?target=<id|key|pdbId>&ligand=<id|key|ccd>&depth=quick|standard|deep&seed=<uint32>&mode=pair|target-many|ligand-many
 *      &method=<base64url of the method JSON>   (method wins over depth; an invalid one falls back to Standard with a toast)
 */
import { initShell, initWalletButton, toast, el, copyText } from '../shell.js';
import * as W from '../wallet.js';
import { CHAIN } from '../config.js';
import * as V from '../viewer.js';
import { S, fill, DEPTHS } from '../lab-ui/strings.js';
import { icon } from '../lab-ui/icons.js';
import { createPicker } from '../lab-ui/pickers.js';
import { createSheet } from '../lab-ui/sheet.js';
import { createResults } from '../lab-ui/results.js';
import { createRecorder } from '../lab-ui/record.js';
import { createRunner } from '../lab-ui/run.js';
import { createMethodApi, createMethodPanel } from '../lab-ui/method.js';
import { fmtDg } from '../lab-ui/derive.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const phone = () => matchMedia('(max-width: 767px)').matches;

initShell();

const main = $('[data-lab]');
if (!main) throw new Error('lab.html has no [data-lab] main');

// ---------------------------------------------------------------------------------------------------------
// modules

async function load(path) {
  try { return { mod: await import(path), error: null }; } catch (e) { return { mod: null, error: e }; }
}
const [catalogL, engineL, methodL, chainL, labL] = await Promise.all([load('../catalog.js'), load('../engine/index.js'), load('../engine/method.js'), load('../chain.js'), load('../lab.js')]);
const catalog = catalogL.mod;
const engine = engineL.mod;
const chain = chainL.mod;
const lab = labL.mod;
// the engine's own index may re-export the method API; the dedicated module wins when it exists
const methodApi = createMethodApi(methodL.mod) || createMethodApi(engine);

function fatal(message) {
  const box = el('div', { class: 'lab-fatal', role: 'alert' }, [
    el('img', { src: '/img/brand/mark-mono.svg', alt: '', width: 48, height: 48, class: 'lab-empty-mark' }),
    el('h2', {}, message),
  ]);
  const grid = $('.lab-grid', main);
  if (grid) grid.replaceWith(box); else main.append(box);
  main.dataset.state = 'error';
}

let cat = null;
try {
  if (!catalog) throw catalogL.error || new Error('no catalog module');
  cat = await catalog.loadCatalog();
  if (!cat || !Array.isArray(cat.targets) || !Array.isArray(cat.ligands)) throw new Error('catalog shape');
} catch (e) {
  console.warn('catalog', e);
  fatal(S.errCatalog);
  initWalletButton({});
}

if (cat) boot();

// ---------------------------------------------------------------------------------------------------------

function boot() {
  const targets = cat.targets.slice();
  const ligands = cat.ligands.slice();
  const cancers = (cat.cancers || (catalog && catalog.CANCERS) || []).map((c) => ({ key: c.key, name: c.name }));
  const ligandClasses = [...new Set(ligands.map((l) => l.class).filter(Boolean))].sort().map((c) => ({ key: c, name: c }));
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const ligandById = new Map(ligands.map((l) => [l.id, l]));

  const findTarget = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s) && targetById.has(Number(s))) return targetById.get(Number(s));
    const up = s.toUpperCase();
    return targets.find((t) => String(t.key).toUpperCase() === up || String(t.pdbId).toUpperCase() === up || String(t.id) === s) || null;
  };
  const findLigand = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s) && ligandById.has(Number(s))) return ligandById.get(Number(s));
    const up = s.toUpperCase();
    return ligands.find((l) => String(l.key).toUpperCase() === up || (l.ccd && String(l.ccd).toUpperCase() === up) || String(l.id) === s) || null;
  };

  const methodShort = (m) => {
    const s = String(m || '').toUpperCase();
    if (s.includes('X-RAY')) return 'X-ray';
    if (s.includes('ELECTRON MICROSCOPY')) return 'Cryo-EM';
    if (s.includes('NMR')) return 'NMR';
    return m || '';
  };
  const resA = (r) => (Number.isFinite(Number(r)) ? `${Number(r).toFixed(2).replace(/\.?0+$/, '')} A` : '');
  const safeId = (v) => String(v || '').trim().replace(/[^A-Za-z0-9_-]/g, '');

  // SPEC.md 9.4: the direct links. Target -> the RCSB entry; ligand -> its CCD page, else its PubChem compound page.
  const targetLink = (t) => (t && t.pdbId ? { href: `https://www.rcsb.org/structure/${safeId(t.pdbId).toUpperCase()}`, label: fill(S.rcsbLink, { id: safeId(t.pdbId).toUpperCase() }), source: 'rcsb' } : null);
  const ligandLink = (l) => {
    if (l && l.ccd && safeId(l.ccd)) return { href: `https://www.rcsb.org/ligand/${safeId(l.ccd).toUpperCase()}`, label: fill(S.rcsbLink, { id: safeId(l.ccd).toUpperCase() }), source: 'rcsb' };
    const cid = l && Number(l.pubchemCid);
    if (Number.isInteger(cid) && cid > 0) return { href: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`, label: fill(S.pubchemLink, { id: cid }), source: 'pubchem' };
    return null;
  };

  // ---------------------------------------------------------------------------------------------------------
  // state

  const state = {
    mode: 'pair',
    target: null,
    ligand: null,
    depth: 'standard',
    seed: randomSeed(),
    running: false,
    current: null, // the last single run (Run object from run.js)
    screen: null, // { rows: Map<id, Run|null>, pairs }
  };

  const dock = $('[data-lab-dock]');

  function randomSeed() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  }

  // ---------------------------------------------------------------------------------------------------------
  // pickers

  const rcsbImage = (pdbId) => (catalog && typeof catalog.rcsbImage === 'function' ? catalog.rcsbImage(pdbId) : `https://cdn.rcsb.org/images/structures/${String(pdbId).toLowerCase()}_assembly-1.jpeg`);

  const groupKeysOf = (t) => {
    if (Array.isArray(t.cancerKeys)) return t.cancerKeys;
    if (catalog && typeof catalog.cancersOf === 'function') { try { return catalog.cancersOf(t).map((c) => c.key); } catch { /* fall through */ } }
    return (t.cancers || []).map((c) => String(c).trim().toLowerCase().replace(/[\s_]+/g, '-'));
  };
  const targetPicker = createPicker({
    kind: 'target',
    host: $('[data-picker-host="target"]'),
    eyebrow: S.eyebrowTarget,
    placeholder: S.searchTargets,
    items: targets,
    groups: cancers,
    groupsOf: groupKeysOf,
    textOf: (t) => [t.key, t.gene, t.protein, t.pdbId, t.title, ...(t.cancers || []), t.class].filter(Boolean).join(' ').toLowerCase(),
    rowOf: (t) => ({ id: t.id, title: t.protein || t.key, caption: [t.pdbId, resA(t.resolution), methodShort(t.method)].filter(Boolean).join(' · '), badge: t.pdbId, image: rcsbImage(t.pdbId), imageAlt: fill(S.rcsbAlt, { id: t.pdbId }), link: targetLink(t) }),
    onPick: (t) => { setTarget(t); if (sheet.isOpen()) sheet.close(); },
    onChange: () => refreshRunButton(),
  });
  const ligandPicker = createPicker({
    kind: 'ligand',
    host: $('[data-picker-host="ligand"]'),
    eyebrow: S.eyebrowLigand,
    placeholder: S.searchLigands,
    items: ligands,
    groups: ligandClasses,
    groupsOf: (l) => [l.class].filter(Boolean),
    textOf: (l) => [l.key, l.name, l.plant, l.latin, l.class, l.ccd, l.formula].filter(Boolean).join(' ').toLowerCase(),
    rowOf: (l) => ({ id: l.id, title: l.name, caption: [l.plant, `${l.heavyAtoms} heavy atoms`].filter(Boolean).join(' · '), badge: l.ccd || '', image: null, link: ligandLink(l) }),
    onPick: (l) => { setLigand(l); if (sheet.isOpen()) sheet.close(); },
    onChange: () => refreshRunButton(),
  });

  // ---------------------------------------------------------------------------------------------------------
  // phone sheet and pair bar

  const sheet = createSheet();
  ($('[data-lab-sheet-host]') || document.body).append(sheet.el);
  const chipTarget = $('[data-chip="target"]');
  const chipLigand = $('[data-chip="ligand"]');
  chipTarget.addEventListener('click', () => sheet.open({ title: S.sheetTarget, content: targetPicker.el, onClose: paintDock }));
  chipLigand.addEventListener('click', () => sheet.open({ title: S.sheetLigand, content: ligandPicker.el, onClose: paintDock }));

  function paintChips() {
    const t = state.target;
    const l = state.ligand;
    chipTarget.replaceChildren(el('span', { class: 'lab-chip-text' }, t ? fill(S.chipTarget, { target: t.key }) : S.chooseTarget), icon('chevronDown', { size: 16 }));
    chipTarget.dataset.empty = t ? '' : '1';
    chipLigand.replaceChildren(el('span', { class: 'lab-chip-text' }, l ? fill(S.chipLigand, { ligand: l.name }) : S.chooseLigand), icon('chevronDown', { size: 16 }));
    chipLigand.dataset.empty = l ? '' : '1';
    const vt = $('[data-chip-target]');
    const vl = $('[data-chip-ligand]');
    if (vt) { vt.textContent = t ? `${t.pdbId} · ${t.key}` : ''; vt.hidden = !t; }
    if (vl) { vl.textContent = l ? `${l.ccd || l.key} · ${l.name}` : ''; vl.hidden = !l; }
  }

  // ---------------------------------------------------------------------------------------------------------
  // viewer

  const viewerCard = $('[data-lab-viewer-card]');
  const viewerHost = $('[data-viewer-host]');
  const viewerStatus = $('[data-viewer-status]');
  const viewerFallback = $('[data-viewer-fallback]');
  const viewerImg = $('img', viewerFallback);
  const viewerCaption = $('[data-viewer-caption]');
  const viewerLink = $('[data-viewer-rcsb]');
  let viewer = null;
  let viewerFailed = false;
  let viewerReady = null;
  let structureToken = 0;
  const shownStructure = { pdbId: null, box: null };

  const setViewerStatus = (text) => { viewerStatus.textContent = text || ''; viewerStatus.hidden = !text; };

  async function setupViewer() {
    if (!V.supported()) { viewerFailed = true; viewerCard.dataset.viewer = 'off'; showFallback(S.errWebgl); return; }
    try {
      await V.ready();
      viewer = V.createViewer(viewerHost, { style: 'card' });
      viewerCard.dataset.viewer = 'on';
      viewer.setReference(toolState.reference);
      viewer.setPocket(toolState.pocket);
    } catch (e) {
      console.warn('viewer', e);
      viewerFailed = true;
      viewerCard.dataset.viewer = 'off';
      showFallback(S.viewerFallback);
    }
  }

  function showFallback(caption) {
    viewerFallback.hidden = false;
    viewerHost.hidden = true;
    setViewerStatus(caption);
    if (state.target) { viewerImg.src = rcsbImage(state.target.pdbId); viewerImg.alt = fill(S.rcsbAlt, { id: state.target.pdbId }); }
  }
  function hideFallback() {
    viewerFallback.hidden = true;
    viewerHost.hidden = false;
  }

  function boxOf(target) {
    const b = target && target.box;
    if (!b) return null;
    if (Array.isArray(b.center) && Array.isArray(b.half)) return { center: b.center.map(Number), half: b.half.map(Number) };
    if (Array.isArray(b) && b.length === 6) return { center: b.slice(0, 3).map(Number), half: b.slice(3).map(Number) };
    if (b.center && b.half && 'x' in b.center) return { center: [b.center.x, b.center.y, b.center.z], half: [b.half.x, b.half.y, b.half.z] };
    return null;
  }

  async function showStructure(target) {
    const token = ++structureToken;
    shownStructure.pdbId = null;
    shownStructure.box = boxOf(target);
    viewerCaption.textContent = target ? `${target.pdbId} · ${target.title || target.protein}` : '';
    const link = targetLink(target);
    viewerLink.href = link ? link.href : 'https://www.rcsb.org';
    viewerLink.replaceChildren(link ? link.label : 'RCSB', icon('external', { size: 14 }));
    viewerLink.hidden = !target;
    if (!target) return;
    if (viewerReady) { try { await viewerReady; } catch { /* reported by setupViewer */ } }
    if (token !== structureToken) return;
    if (viewerFailed || !viewer) { showFallback(viewerFailed ? (V.supported() ? S.viewerFallback : S.errWebgl) : S.viewerLoading); return; }
    hideFallback();
    setViewerStatus(S.viewerLoading);
    viewerCard.dataset.loading = '1';
    try {
      const text = await catalog.fetchStructure(target.pdbId);
      if (token !== structureToken) return;
      const info = viewer.showStructure(text, { id: target.pdbId, chain: target.chain || null, ligandCcd: target.ligand && target.ligand.ccd, highlightPocket: shownStructure.box });
      shownStructure.pdbId = target.pdbId;
      viewer.setBoxVisible(toolState.box);
      viewer.setReference(toolState.reference);
      setViewerStatus('');
      viewerCard.dataset.loading = '';
      viewerCard.dataset.reference = info.reference ? '1' : '';
      if (toolState.surface) viewer.setSurface(true).catch(() => null);
    } catch (e) {
      if (token !== structureToken) return;
      console.warn('structure', e);
      viewerCard.dataset.loading = '';
      showFallback(S.viewerFallback);
      toast(S.toastStructureFail, { kind: 'error' });
    }
  }

  const toolState = { reference: true, box: true, pocket: true, surface: false };
  for (const b of $$('[data-tool]', viewerCard)) {
    const tool = b.dataset.tool;
    if (tool in toolState) b.setAttribute('aria-pressed', toolState[tool] ? 'true' : 'false');
    b.addEventListener('click', async () => {
      if (tool === 'reset') { if (viewer) viewer.resetView(); return; }
      if (tool === 'fullscreen') { toggleFullscreen(); return; }
      toolState[tool] = !toolState[tool];
      b.setAttribute('aria-pressed', toolState[tool] ? 'true' : 'false');
      if (!viewer) return;
      if (tool === 'reference') viewer.setReference(toolState.reference);
      else if (tool === 'box') viewer.setBoxVisible(toolState.box);
      else if (tool === 'pocket') viewer.setPocket(toolState.pocket);
      else if (tool === 'surface') { const ok = await viewer.setSurface(toolState.surface); if (toolState.surface && !ok) { toolState.surface = false; b.setAttribute('aria-pressed', 'false'); } }
    });
  }
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (viewerCard.requestFullscreen) viewerCard.requestFullscreen();
    } catch { /* not allowed */ }
  }
  document.addEventListener('fullscreenchange', () => { viewerCard.dataset.fullscreen = document.fullscreenElement === viewerCard ? '1' : ''; setTimeout(() => viewer && viewer.resize(), 60); });

  // ---------------------------------------------------------------------------------------------------------
  // run controls

  const runner = createRunner({ engine, catalog });
  const depthBtns = $$('[data-depth-key]');
  const seedInput = $('[data-seed]');
  const seedRandom = $('[data-seed-random]');
  const runBtn = $('[data-run]');
  const dockRunBtn = $('[data-dock-run]');
  const runNote = $('[data-run-note]');
  const progress = $('[data-progress]');
  const progressBar = $('[data-progress-bar]');
  const progressFill = $('[data-progress-fill]');
  const progressCaption = $('[data-progress-caption]');
  const progressStage = $('[data-progress-stage]');
  const progressQueue = $('[data-progress-queue]');

  // ---------------------------------------------------------------------------------------------------------
  // the method panel (SPEC.md 9.7)

  const methodCard = $('[data-lab-method]');
  const methodHost = $('[data-method-host]');
  const methodOpen = $('[data-method-open]');
  const methodClose = $('[data-method-close]');
  const methodNameEl = $('[data-method-name]');
  // syncingMethod: the panel is being driven from here (or is still being built): its onChange must not echo back
  let syncingMethod = true;
  const methodPanel = createMethodPanel({
    api: methodApi,
    onChange: () => { if (!syncingMethod) onMethodChange(); },
    onShare: () => { syncUrl(); shareRun(); },
  });
  syncingMethod = false;
  if (methodHost) methodHost.append(methodPanel.el);
  main.dataset.methods = methodApi ? 'on' : 'off';

  /** The active method: { name, resolved (object | null), valid, compact } from the panel, or the depth without a module. */
  function activeMethod() {
    const m = methodPanel.state();
    if (!methodApi || !m.available) return { name: (DEPTHS.find((d) => d.key === state.depth) || DEPTHS[1]).label, resolved: null, raw: null, valid: true, key: state.depth };
    return { name: m.name, resolved: m.method, raw: m.raw, valid: m.valid, key: m.key };
  }

  function paintMethodName() {
    const m = activeMethod();
    if (methodNameEl) methodNameEl.textContent = m.name;
    if (methodOpen) methodOpen.setAttribute('aria-label', fill(S.methodChip, { name: m.name }));
    main.dataset.method = m.key;
  }

  function onMethodChange() {
    const m = activeMethod();
    // the depth control mirrors the Quick / Standard / Deep presets; anything else leaves it unpressed
    state.depth = ['quick', 'standard', 'deep'].includes(m.key) ? m.key : null;
    paintDepth();
    paintMethodName();
    refreshRunButton();
    syncUrl();
  }

  function setMethodOpen(open) {
    if (!methodCard) return;
    if (phone()) {
      if (open) sheet.open({ title: S.methodTitle, content: methodPanel.el, onClose: () => { paintDock(); methodOpen.setAttribute('aria-expanded', 'false'); } });
      else if (sheet.isOpen() && sheet.content() === methodPanel.el) sheet.close();
      methodOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    methodCard.hidden = !open;
    methodOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const first = methodCard.querySelector('select, textarea'); if (first) first.focus({ preventScroll: true }); methodCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  if (methodOpen) methodOpen.addEventListener('click', () => setMethodOpen(phone() ? true : methodCard.hidden));
  if (methodClose) methodClose.addEventListener('click', () => setMethodOpen(false));

  function paintDepth() {
    for (const b of depthBtns) b.setAttribute('aria-pressed', b.dataset.depthKey === state.depth ? 'true' : 'false');
  }
  for (const b of depthBtns) {
    b.addEventListener('click', () => {
      if (methodApi) {
        syncingMethod = true;
        const ok = methodPanel.setPreset(b.dataset.depthKey);
        syncingMethod = false;
        if (ok) { onMethodChange(); return; }
      }
      state.depth = b.dataset.depthKey;
      paintDepth();
      paintMethodName();
      syncUrl();
    });
  }

  function setSeed(v) {
    state.seed = Number(v) >>> 0;
    seedInput.value = String(state.seed);
    syncUrl();
  }
  seedInput.addEventListener('change', () => {
    const s = seedInput.value.trim();
    if (/^\d{1,10}$/.test(s) && Number(s) <= 0xffffffff) setSeed(Number(s)); else setSeed(randomSeed());
  });
  seedRandom.addEventListener('click', () => { setSeed(randomSeed()); seedInput.focus(); });

  const engineOk = !!engine && typeof engine.dock === 'function';
  const workersOk = typeof Worker === 'function';

  function pairsForRun() {
    if (state.mode === 'pair') return state.target && state.ligand ? [{ target: state.target, ligand: state.ligand }] : [];
    if (state.mode === 'target-many') return state.target ? ligandPicker.checked().map((id) => ({ target: state.target, ligand: ligandById.get(id) })).filter((p) => p.ligand) : [];
    return state.ligand ? targetPicker.checked().map((id) => ({ target: targetById.get(id), ligand: state.ligand })).filter((p) => p.target) : [];
  }

  function refreshRunButton() {
    const pairs = pairsForRun();
    const m = activeMethod();
    const can = engineOk && workersOk && pairs.length > 0 && !state.running && m.valid;
    const label = state.running ? S.stop : state.current || (state.screen && state.mode !== 'pair') ? S.runAgain : S.run;
    for (const b of [runBtn, dockRunBtn]) {
      if (!b) continue;
      b.replaceChildren(icon(state.running ? 'stop' : 'play', { size: 20 }), label);
      b.disabled = state.running ? false : !can;
      b.classList.toggle('lab-btn-outline', state.running);
      b.classList.toggle('lab-btn-primary', !state.running);
      b.dataset.state = state.running ? 'running' : 'idle';
    }
    runNote.textContent = !workersOk ? S.errWorkers : !engineOk ? S.engineMissing : !m.valid ? S.methodFixFirst : state.mode !== 'pair' && !pairs.length && (state.mode === 'target-many' ? state.target : state.ligand) ? S.screenEmpty : '';
    runNote.hidden = !runNote.textContent;
    runNote.dataset.kind = !engineOk || !workersOk || !m.valid ? 'error' : 'note';
    main.dataset.engine = engineOk ? 'on' : 'off';
    paintDock();
  }

  let lastPaint = 0;
  function paintProgress(p, queuePos) {
    const now = Date.now();
    if (now - lastPaint < 200 && p.done < 1) return;
    lastPaint = now;
    const pct = Math.max(0, Math.min(100, Math.round((p.done || 0) * 100)));
    progressFill.style.width = `${pct}%`;
    progressBar.setAttribute('aria-valuenow', String(pct));
    progressCaption.textContent = fill(S.progress, { percent: pct, dG: p.best === null || p.best === undefined ? '--' : fmtDg(p.best) });
    if (queuePos) progressQueue.textContent = fill(S.screenProgress, queuePos); else progressQueue.textContent = '';
  }
  function setStage(text) { progressStage.textContent = text || ''; }
  function showProgress(on) {
    progress.hidden = !on;
    if (on) { progressFill.style.width = '0%'; progressBar.setAttribute('aria-valuenow', '0'); progressCaption.textContent = fill(S.progress, { percent: 0, dG: '--' }); progressQueue.textContent = ''; }
  }

  /** What one run is asked with: the resolved method (seed filled in), its name and the seed. */
  function runPlan() {
    const m = activeMethod();
    const method = m.resolved ? { ...m.resolved } : null;
    let seed = state.seed;
    if (method && Number.isInteger(Number(method.seed)) && Number(method.seed) >= 0) seed = Number(method.seed) >>> 0;
    if (method) method.seed = seed;
    return { method, methodName: m.name, seed, depthKey: state.depth || 'standard' };
  }

  /**
   * The compact method JSON that goes on chain with the pose (SPEC.md 9.7): the engine's canonical string of the
   * reproducible method (Result.methodCompact: budget as the steps run, the chains used, the seed), else our own
   * compact of the resolved method the run was asked with, the seed filled in.
   */
  function methodJsonOf(run, plan) {
    if (!methodApi || !plan.method) return '';
    const r = run.result || {};
    if (typeof r.methodCompact === 'string' && r.methodCompact.trim().startsWith('{')) return r.methodCompact;
    const echoed = r.method && typeof r.method === 'object' ? r.method : plan.method;
    try { return methodApi.compact({ ...echoed, seed: run.seed }); } catch { return methodApi.compact(plan.method); }
  }

  async function onRunClick() {
    if (state.running) { runner.cancel(); return; }
    const pairs = pairsForRun();
    if (!pairs.length) return;
    if (!activeMethod().valid) { toast(S.methodFixFirst, { kind: 'error' }); return; }
    if (state.mode === 'pair') await runPair(pairs[0]);
    else await runScreen(pairs);
  }
  runBtn.addEventListener('click', onRunClick);
  if (dockRunBtn) dockRunBtn.addEventListener('click', onRunClick);

  async function runPair({ target, ligand }) {
    state.running = true;
    state.current = null;
    refreshRunButton();
    showProgress(true);
    setStage(S.stagePreparing);
    if (viewer) viewer.clearPose();
    const plan = runPlan();
    if (plan.seed !== state.seed) { state.seed = plan.seed; seedInput.value = String(plan.seed); }
    try {
      const run = await runner.dock({ target, ligand, depthKey: plan.depthKey, seed: plan.seed, method: plan.method, methodName: plan.methodName, onProgress: (p) => paintProgress(p), onStage: setStage });
      run.methodJson = methodJsonOf(run, plan);
      paintProgress({ done: 1, best: run.view.scoreMilli });
      state.current = run;
      results.showRun(run.view);
      if (run.cancelled) toast(S.errStopped, { kind: 'info' });
      showPose(run);
      recorder.update();
    } catch (e) {
      if (e && (e.code === 'cancelled' || e.name === 'CancelledError')) toast(S.errStopped, { kind: 'info' });
      else { console.warn('dock', e); toast((e && e.message) || S.engineMissing, { kind: 'error', ms: 8000 }); }
    } finally {
      state.running = false;
      showProgress(false);
      setStage('');
      refreshRunButton();
      paintDock();
    }
  }

  function showPose(run) {
    if (!viewer || !run) return;
    try {
      if (shownStructure.pdbId !== run.target.pdbId) {
        // the structure of another target (screening): load it, then place the pose
        showStructure(run.target).then(() => { if (viewer && shownStructure.pdbId === run.target.pdbId) placePose(run); });
        return;
      }
      placePose(run);
    } catch (e) { console.warn('pose', e); }
  }
  function placePose(run) {
    if (!shownStructure.box && run.inputs && run.inputs.pocket && run.inputs.pocket.center) {
      shownStructure.box = { center: [...run.inputs.pocket.center], half: [...run.inputs.pocket.half] };
      viewer.setBox(shownStructure.box.center, shownStructure.box.half);
      viewer.setBoxVisible(toolState.box);
    }
    viewer.showPose(run.inputs.sdf, run.poseAbs);
  }

  // ---------------------------------------------------------------------------------------------------------
  // screening

  async function runScreen(pairs) {
    state.running = true;
    state.current = null;
    refreshRunButton();
    const many = state.mode === 'target-many' ? 'ligand' : 'target';
    const rowOf = (p) => (many === 'ligand'
      ? { id: `${p.target.id}:${p.ligand.id}`, kind: 'ligand', name: p.ligand.name, code: p.ligand.ccd || p.ligand.key, heavyAtoms: p.ligand.heavyAtoms, state: 'queued', scoreMilli: null, checksOk: null }
      : { id: `${p.target.id}:${p.ligand.id}`, kind: 'target', name: p.target.protein || p.target.key, code: p.target.pdbId, heavyAtoms: p.ligand.heavyAtoms, state: 'queued', scoreMilli: null, checksOk: null });
    state.screen = { runs: new Map(), pairs };
    results.showScreen(pairs.map(rowOf));
    showProgress(true);
    const plan = runPlan();
    if (plan.seed !== state.seed) { state.seed = plan.seed; seedInput.value = String(plan.seed); }
    try {
      await runner.queue(pairs, {
        depthKey: plan.depthKey,
        seed: plan.seed,
        method: plan.method,
        methodName: plan.methodName,
        onStart: (i, p) => { results.updateRow(rowOf(p).id, { state: 'running' }); },
        onStage: setStage,
        onProgress: (i, p) => paintProgress(p, { i: i + 1, n: pairs.length, name: many === 'ligand' ? pairs[i].ligand.name : pairs[i].target.key }),
        onRow: (i, run) => {
          const id = rowOf(pairs[i]).id;
          if (run && run.view) {
            run.methodJson = methodJsonOf(run, plan);
            state.screen.runs.set(id, run);
            results.updateRow(id, { state: 'done', scoreMilli: run.view.scoreMilli, checksOk: run.view.checks.ok, heavyAtoms: run.view.heavyAtoms });
            if (i === 0 || state.mode === 'target-many') showPose(run);
          } else {
            results.updateRow(id, { state: 'failed' });
          }
        },
      });
      // pairs that never ran (stopped) stay queued; say so once
      const left = pairs.filter((p) => !state.screen.runs.has(rowOf(p).id));
      if (left.length && left.length < pairs.length) toast(S.errStopped, { kind: 'info' });
    } catch (e) {
      console.warn('screen', e);
      toast((e && e.message) || S.engineMissing, { kind: 'error', ms: 8000 });
    } finally {
      state.running = false;
      showProgress(false);
      setStage('');
      refreshRunButton();
      paintDock();
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // results and the docking test

  const results = createResults({
    host: $('[data-lab-results-host]'),
    engine,
    onRun: () => { if (phone() && !(state.target && state.ligand)) { (state.target ? chipLigand : chipTarget).click(); return; } onRunClick(); },
    onShare: shareRun,
    onShowRow: (row) => { const run = state.screen && state.screen.runs.get(row.id); if (run) showPose(run); },
    onRecordRow: (row) => recordRow(row),
    onRecordBest: (row) => recordRow(row),
  });

  // the contract's custom errors become sentences (js/lab.js); the context lets it name the fee and the price
  if (lab && typeof lab.registerRevertExplainer === 'function') {
    lab.registerRevertExplainer(() => { const st = recorder ? recorder.status() : null; return st ? { runFee: st.runFee, runPrice: st.runPrice, epochEnd: st.epochEnd, token: st.token, payWithToken: recorder.payment() === 'token' } : {}; });
  }
  const recorder = createRecorder({
    slots: [results.actionSlot, $('[data-dock-record]')],
    chain,
    lab,
    getRun: () => (state.mode === 'pair' ? state.current : null),
    onChain: (run, chainView) => {
      if (run === state.current) results.setChain(chainView);
      if (state.screen) for (const [id, r] of state.screen.runs) if (r === run) results.updateRow(id, { chain: chainView, recording: 'done' });
    },
    onState: () => paintDock(),
  });

  async function recordRow(row) {
    const run = state.screen && state.screen.runs.get(row.id);
    if (!run) return;
    if (!recorder.live()) { toast(S.labNotLive, { kind: 'info' }); return; }
    results.updateRow(row.id, { recording: 'pending' });
    try {
      await recorder.record(run);
    } finally {
      if (!run.chain) results.updateRow(row.id, { recording: 'idle' });
    }
  }

  function shareRun() {
    copyText(location.href).then((ok) => toast(ok ? S.toastLinkCopied : 'Could not copy. Try again.', { kind: ok ? 'success' : 'error' }));
  }

  // ---------------------------------------------------------------------------------------------------------
  // modes

  const modeBtns = $$('button[data-mode]');
  function setMode(mode) {
    state.mode = ['pair', 'target-many', 'ligand-many'].includes(mode) ? mode : 'pair';
    for (const b of modeBtns) b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
    main.dataset.mode = state.mode;
    targetPicker.setMulti(state.mode === 'ligand-many');
    ligandPicker.setMulti(state.mode === 'target-many');
    if (state.mode === 'pair') { if (state.current) results.showRun(state.current.view); else results.showEmpty(); }
    else if (!state.screen) results.showEmpty();
    refreshRunButton();
    syncUrl();
  }
  for (const b of modeBtns) b.addEventListener('click', () => setMode(b.dataset.mode));

  // ---------------------------------------------------------------------------------------------------------
  // selection, url, dock

  function setTarget(t, { silent = false } = {}) {
    if (state.running) return;
    state.target = t || null;
    targetPicker.setSelected(t ? t.id : null);
    paintChips();
    if (!silent) syncUrl();
    showStructure(state.target);
    if (state.current && (!t || state.current.target.id !== t.id)) { state.current = null; if (state.mode === 'pair') results.showEmpty(); if (viewer) viewer.clearPose(); }
    refreshRunButton();
    recorder.update();
  }
  function setLigand(l, { silent = false } = {}) {
    if (state.running) return;
    state.ligand = l || null;
    ligandPicker.setSelected(l ? l.id : null);
    paintChips();
    if (!silent) syncUrl();
    if (state.current && (!l || state.current.ligand.id !== l.id)) { state.current = null; if (state.mode === 'pair') results.showEmpty(); if (viewer) viewer.clearPose(); }
    refreshRunButton();
    recorder.update();
  }

  function syncUrl() {
    const u = new URL(location.href);
    const p = u.searchParams;
    const set = (k, v) => { if (v === null || v === undefined || v === '') p.delete(k); else p.set(k, String(v)); };
    set('target', state.target ? state.target.id : null);
    set('ligand', state.ligand ? state.ligand.id : null);
    const m = activeMethod();
    const depthPreset = ['quick', 'standard', 'deep'].includes(m.key);
    set('depth', depthPreset ? (m.key === 'standard' ? null : m.key) : null);
    // SPEC.md 9.7: ?method=<base64url of the JSON>, only when the method is not one of the three depth presets
    set('method', methodApi && !depthPreset && m.raw ? methodApi.toQuery(m.raw) : null);
    set('seed', state.seed);
    set('mode', state.mode === 'pair' ? null : state.mode);
    const next = `${u.pathname}${p.toString() ? `?${p}` : ''}${u.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', next);
  }

  function paintDock() {
    if (!dock) return;
    const showRecord = state.mode === 'pair' && !!state.current && !state.running;
    dock.dataset.show = showRecord ? 'record' : 'run';
    dock.hidden = sheet.isOpen();
  }

  // wrong network band
  const band = $('[data-lab-network]');
  const bandBtn = $('[data-lab-network-switch]');
  if (bandBtn) bandBtn.addEventListener('click', async () => { try { await W.ensureChain(); } catch (e) { toast(e && e.message ? e.message : S.errRejected, { kind: 'error' }); } });
  function paintBand() {
    const wrong = !!W.account() && W.chainId() !== null && W.chainId() !== CHAIN.id;
    if (band) band.hidden = !wrong;
  }
  initWalletButton({ onChange: () => { paintBand(); recorder.update(); } });
  paintBand();

  // ---------------------------------------------------------------------------------------------------------
  // start

  const params = new URL(location.href).searchParams;
  const d = params.get('depth');
  if (DEPTHS.some((x) => x.key === d)) state.depth = d;
  const sd = params.get('seed');
  if (sd && /^\d{1,10}$/.test(sd) && Number(sd) <= 0xffffffff) state.seed = Number(sd) >>> 0;
  seedInput.value = String(state.seed);
  // the method: ?method= wins, else the depth preset; the panel's default is Standard
  syncingMethod = true;
  let badLink = false;
  if (methodApi) {
    const q = params.get('method');
    if (q) { const r = methodPanel.applyQuery(q); if (!r.ok) { badLink = true; methodPanel.setPreset('standard'); } }
    else methodPanel.setPreset(state.depth);
    const m = activeMethod();
    state.depth = ['quick', 'standard', 'deep'].includes(m.key) ? m.key : null;
  }
  syncingMethod = false;
  paintDepth();
  paintMethodName();
  if (badLink) toast(S.methodBadLink, { kind: 'error', ms: 8000 });
  const t0 = findTarget(params.get('target'));
  const l0 = findLigand(params.get('ligand'));
  if (params.get('target') && !t0) toast(S.errUnknownTarget, { kind: 'error' });
  if (params.get('ligand') && !l0) toast(S.errUnknownLigand, { kind: 'error' });
  main.dataset.targets = String(targets.length);
  main.dataset.ligands = String(ligands.length);

  // selection and mode apply at once; only the structure fetch waits for the viewer (viewerReady, used in showStructure)
  viewerReady = setupViewer();
  setTarget(t0, { silent: true });
  setLigand(l0, { silent: true });
  setMode(params.get('mode') || 'pair');
  paintChips();
  refreshRunButton();
  syncUrl();
  main.dataset.state = 'ready';
}
