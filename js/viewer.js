/*
 * js/viewer.js: the shared 3Dmol.js wrapper for every 3D view on Ponchem (the lab, the target and ligand pages,
 * the landing hero). It wraps window.$3Dmol from /lib/3Dmol-min.js, which the page loads once with a static
 * <script src="/lib/3Dmol-min.js" defer></script> tag in its head (the CSP allows script-src 'self'; nothing is
 * injected here). Structure and ligand text is fetched by the caller (js/catalog.js) and handed in as text.
 *
 * SHIPPED API
 *   ready()                     -> Promise<$3Dmol>   resolves once window.$3Dmol exists (rejects after 20 s)
 *   supported()                 -> bool              WebGL is available in this browser (cached probe)
 *   FALLBACK_CAPTION            '3D view unavailable. Showing the RCSB entry image.'   (docs/copy.md)
 *   WEBGL_OFF                   'WebGL is not available, so the 3D view is off. Scores and records still work.'
 *   createViewer(el, { style = 'card' | 'paper' | 'hero', background, quality }) -> handle
 *       style: 'card' white canvas (cards and the lab), 'paper' the paper token, 'hero' transparent so the grid
 *       paper of the landing hero shows through. `background` overrides the colour. The element becomes the
 *       viewer container (position: relative is set here; give it a size in CSS).
 *   handle:
 *     showStructure(pdbText, { id, chain, ligandCcd, highlightPocket: { center, half } }) -> { atoms, reference, pocketResidues }
 *         receptor cartoon in the muted receptor tone, the residues around the reference ligand (or inside the
 *         box when there is no reference) as thin sticks, the reference co-crystal ligand as a blue ghost
 *         (toggle with setReference), the box when highlightPocket is given (toggle with setBoxVisible).
 *         Any earlier structure, pose and surface are removed. center and half are in angstrom, absolute frame.
 *     showLigand(sdfText)                      the ligand alone, sticks in the ligand accent (ligand page)
 *     showPose(sdfText, poseAbs: Float64Array)  the same SDF with its coordinates replaced by the pose (absolute
 *         angstrom, 3 per heavy atom, topology order), sticks in the ligand accent, over the current structure
 *     clearPose()                              remove the docked pose
 *     setBox(center, half)                     a translucent box (wireframe plus a faint fill), [x,y,z] angstrom
 *     setBoxVisible(on) setReference(on) setPocket(on) setSurface(on) -> Promise   the toolbar toggles
 *     resetView()                              back to the pocket framing
 *     spin(on)                                 slow auto rotation (one turn per 40 s); off under reduced motion,
 *                                              paused while the pointer is over the canvas and while the tab is hidden
 *     resize()  dispose()  toPng() -> data URL
 *     state()   -> { structure, pose, reference, box, pocket, surface } (what is shown; mirrored on data-* attributes
 *                  of the element: data-structure, data-pose, so a test can read them)
 *
 * Colours follow SPEC-DESIGN.md 1.6: cartoon #9DB7CC, pocket carbons #8A93A3 with CPK hetero atoms, our ligand
 * carbons #B5480C (N #3050F8, O #E53935, S #C9A800, halogens #2E8B57), the reference ligand carbons #1F5F8B at
 * 55 percent, the box in --ink-3 at 40 percent. No surface by default (phones); the toggle adds one.
 */

export const FALLBACK_CAPTION = '3D view unavailable. Showing the RCSB entry image.';
export const WEBGL_OFF = 'WebGL is not available, so the 3D view is off. Scores and records still work.';

const COLOR = {
  cartoon: '#9DB7CC',
  pocketC: '#8A93A3',
  ligandC: '#B5480C',
  referenceC: '#1F5F8B',
  box: '#5F6673',
  surface: '#9DB7CC',
  N: '#3050F8',
  O: '#E53935',
  S: '#C9A800',
  halogen: '#2E8B57',
};
const BACKGROUND = { card: '#FFFFFF', paper: '#F5F3EC', hero: '#F5F3EC' };
const LIGAND_MAP = { C: COLOR.ligandC, N: COLOR.N, O: COLOR.O, S: COLOR.S, F: COLOR.halogen, Cl: COLOR.halogen, Br: COLOR.halogen, I: COLOR.halogen };
const POCKET_MAP = { C: COLOR.pocketC };
const REFERENCE_MAP = { C: COLOR.referenceC };
const WATER = new Set(['HOH', 'WAT', 'DOD', 'H2O']);
const TURN_SECONDS = 40;

let readyPromise = null;
let webgl = null;

const hasWindow = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/** Resolves with window.$3Dmol once the classic script has run. */
export function ready({ timeoutMs = 20000 } = {}) {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    if (!hasWindow()) { reject(new Error('no window')); return; }
    if (window.$3Dmol) { resolve(window.$3Dmol); return; }
    const t0 = Date.now();
    let done = false;
    const finish = (err) => { if (done) return; done = true; if (err) reject(err); else resolve(window.$3Dmol); };
    const tick = () => {
      if (done) return;
      if (window.$3Dmol) { finish(); return; }
      if (Date.now() - t0 > timeoutMs) { finish(new Error('3Dmol did not load')); return; }
      setTimeout(tick, 50);
    };
    for (const s of document.querySelectorAll('script[src*="3Dmol"]')) {
      s.addEventListener('load', tick, { once: true });
      s.addEventListener('error', () => finish(new Error('3Dmol failed to load')), { once: true });
    }
    tick();
  });
  readyPromise.catch(() => { readyPromise = null; });
  return readyPromise;
}

/** WebGL probe, cached. */
export function supported() {
  if (webgl !== null) return webgl;
  try {
    if (!hasWindow()) return (webgl = false);
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    webgl = !!gl;
    if (gl && gl.getExtension) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
  } catch {
    webgl = false;
  }
  return webgl;
}

const reducedMotion = () => hasWindow() && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone = () => hasWindow() && typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;

// ---------------------------------------------------------------------------------------------------------
// SDF helpers (V2000, heavy atoms only as data/ligands/*.sdf are)

function sdfAtomCount(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 4) throw new Error('not an SDF');
  const n = parseInt(lines[3].slice(0, 3), 10);
  if (!Number.isFinite(n) || n < 1) throw new Error('SDF has no atoms');
  return { lines, n };
}

const coord = (v) => {
  let s = v.toFixed(4);
  if (s.length > 10) s = v.toFixed(Math.max(0, 9 - Math.trunc(Math.abs(v)).toString().length - (v < 0 ? 1 : 0)));
  return s.padStart(10);
};

/** The SDF with every heavy atom moved to the pose (absolute angstrom, topology order). */
export function sdfWithPose(sdfText, poseAbs) {
  const { lines, n } = sdfAtomCount(sdfText);
  if (!poseAbs || poseAbs.length !== 3 * n) throw new Error(`pose has ${poseAbs ? poseAbs.length / 3 : 0} atoms, the SDF has ${n}`);
  for (let i = 0; i < n; i++) {
    const line = lines[4 + i];
    if (!line || line.length < 31) throw new Error('short SDF atom line');
    lines[4 + i] = coord(poseAbs[3 * i]) + coord(poseAbs[3 * i + 1]) + coord(poseAbs[3 * i + 2]) + line.slice(30);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// PDB helpers

function ligandResidue(atoms, ccd, chain) {
  if (!ccd) return null;
  const want = String(ccd).toUpperCase();
  let pick = null;
  for (const a of atoms) {
    if (!a.hetflag || String(a.resn || '').toUpperCase() !== want) continue;
    if (chain && a.chain !== chain) { if (!pick) pick = { resn: want, chain: a.chain, resi: a.resi, fallback: true }; continue; }
    return { resn: want, chain: a.chain, resi: a.resi };
  }
  return pick;
}

// residues (chain + resi) with a protein atom inside the box: for the pocket sticks when there is no reference
function residuesInBox(atoms, center, half) {
  const keys = new Map();
  for (const a of atoms) {
    if (a.hetflag) continue;
    if (Math.abs(a.x - center[0]) > half[0] || Math.abs(a.y - center[1]) > half[1] || Math.abs(a.z - center[2]) > half[2]) continue;
    const c = a.chain || '';
    if (!keys.has(c)) keys.set(c, new Set());
    keys.get(c).add(a.resi);
  }
  const or = [];
  for (const [chain, set] of keys) or.push({ chain, resi: [...set] });
  return or;
}

// ---------------------------------------------------------------------------------------------------------

export function createViewer(el, { style = 'card', background, quality } = {}) {
  if (!hasWindow()) throw new Error('no window');
  if (!el || !(el instanceof Element)) throw new Error('createViewer needs an element');
  const $3Dmol = window.$3Dmol;
  if (!$3Dmol) throw new Error('3Dmol is not loaded yet: await ready() first');
  if (!supported()) throw new Error(WEBGL_OFF);
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.dataset.viewer = 'ready';
  const bg = background || BACKGROUND[style] || BACKGROUND.card;
  const config = {
    backgroundColor: bg,
    backgroundAlpha: style === 'hero' ? 0 : 1,
    antialias: true,
    cartoonQuality: quality || (phone() ? 5 : 8),
    disableFog: false,
  };
  const viewer = $3Dmol.createViewer(el, config);
  if (!viewer) throw new Error('3Dmol could not create a viewer');

  const state = {
    structure: null, // { id, chain, ccd }
    pose: false,
    reference: true,
    box: false,
    pocket: true,
    surface: false,
    spinning: false,
    hovered: false,
    disposed: false,
  };
  let structureModel = null;
  let referenceModel = null;
  let poseModel = null;
  let ligandModel = null;
  let boxShapes = [];
  let boxSpec = null; // { center, half }
  let pocketSel = null; // selection of the pocket residues in structureModel
  let referenceSel = null;
  let surfaceId = null;
  let surfacePending = null;
  let homeView = null;
  let spinTimer = null;

  const mirror = () => {
    el.dataset.structure = state.structure ? state.structure.id || 'loaded' : '';
    el.dataset.pose = state.pose ? '1' : '';
    el.dataset.reference = referenceModel ? (state.reference ? 'on' : 'off') : '';
    el.dataset.box = boxShapes.length ? (state.box ? 'on' : 'off') : '';
    el.dataset.surface = state.surface ? 'on' : 'off';
  };

  const render = () => { if (!state.disposed) viewer.render(); };

  // spin: 3Dmol's own spin uses setInterval; we drive it ourselves to pause on hover and hidden tabs
  const startSpin = () => {
    stopSpinTimer();
    if (!state.spinning || reducedMotion() || state.hovered || document.hidden) return;
    const step = 360 / (TURN_SECONDS * 20);
    spinTimer = setInterval(() => {
      if (state.disposed) { stopSpinTimer(); return; }
      if (document.hidden || state.hovered) return;
      viewer.rotate(step, 'y');
    }, 50);
  };
  function stopSpinTimer() { if (spinTimer) { clearInterval(spinTimer); spinTimer = null; } }
  const onVisibility = () => { if (document.hidden) stopSpinTimer(); else startSpin(); };
  document.addEventListener('visibilitychange', onVisibility);
  const onEnter = () => { state.hovered = true; };
  const onLeave = () => { state.hovered = false; };
  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('touchstart', onEnter, { passive: true });
  el.addEventListener('touchend', () => setTimeout(onLeave, 1500), { passive: true });

  // keep the canvas the size of the element
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (!state.disposed) { try { viewer.resize(); } catch { /* not attached yet */ } } });
    ro.observe(el);
  }

  const dropSurface = () => {
    if (surfaceId !== null) { try { viewer.removeSurface(surfaceId); } catch { /* gone */ } surfaceId = null; }
    surfacePending = null;
    state.surface = false;
  };
  const dropBox = () => {
    for (const s of boxShapes) { try { viewer.removeShape(s); } catch { /* gone */ } }
    boxShapes = [];
  };
  const dropModel = (m) => { if (m) { try { viewer.removeModel(m); } catch { /* gone */ } } return null; };

  const drawBox = () => {
    dropBox();
    if (!boxSpec) return;
    const { center, half } = boxSpec;
    const spec = { center: { x: center[0], y: center[1], z: center[2] }, dimensions: { w: 2 * half[0], h: 2 * half[1], d: 2 * half[2] } };
    const wire = viewer.addBox({ ...spec, color: COLOR.box, opacity: 0.4, wireframe: true });
    const fill = viewer.addBox({ ...spec, color: COLOR.box, opacity: 0.06 });
    boxShapes = [wire, fill];
    if (!state.box) for (const s of boxShapes) s.hidden = true;
  };

  const applyStructureStyle = () => {
    if (!structureModel) return;
    const ccd = state.structure && state.structure.ccd;
    structureModel.setStyle({}, { cartoon: { color: COLOR.cartoon } });
    // other hetero groups (cofactors, metals) as thin ball and stick; waters never; the reference ligand is drawn
    // as its own model so it can be translucent, so it stays hidden in this one
    structureModel.setStyle(
      { hetflag: true, not: { resn: [...WATER, ...(ccd ? [ccd] : [])] } },
      { stick: { radius: 0.12, colorscheme: { prop: 'elem', map: POCKET_MAP } }, sphere: { radius: 0.25, colorscheme: { prop: 'elem', map: POCKET_MAP } } },
    );
    if (pocketSel && state.pocket) {
      structureModel.setStyle(pocketSel, { cartoon: { color: COLOR.cartoon }, stick: { radius: 0.12, colorscheme: { prop: 'elem', map: POCKET_MAP } } });
    }
  };

  const frame = () => {
    if (pocketSel && structureModel) viewer.zoomTo({ ...pocketSel, model: structureModel });
    else if (referenceSel && referenceModel) viewer.zoomTo({ model: referenceModel });
    else viewer.zoomTo();
    homeView = viewer.getView();
  };

  const handle = {
    viewer,
    state: () => ({ structure: state.structure, pose: state.pose, reference: state.reference, box: state.box, pocket: state.pocket, surface: state.surface }),

    showStructure(pdbText, { id = null, chain = null, ligandCcd = null, highlightPocket = null } = {}) {
      if (state.disposed) throw new Error('viewer disposed');
      dropSurface();
      dropBox();
      structureModel = dropModel(structureModel);
      referenceModel = dropModel(referenceModel);
      poseModel = dropModel(poseModel);
      ligandModel = dropModel(ligandModel);
      pocketSel = null;
      referenceSel = null;
      boxSpec = null;
      state.pose = false;
      structureModel = viewer.addModel(pdbText, 'pdb', { keepH: false });
      const atoms = structureModel.selectedAtoms({});
      const ccd = ligandCcd ? String(ligandCcd).toUpperCase() : null;
      state.structure = { id: id ? String(id).toUpperCase() : null, chain, ccd };
      const ref = ligandResidue(atoms, ccd, chain);
      if (ref) {
        referenceSel = { resn: ref.resn, chain: ref.chain, resi: ref.resi };
        // a second copy of just the reference ligand, so its opacity is its own
        const lines = pdbText.split(/\r?\n/).filter((l) => /^HETATM/.test(l) && l.slice(17, 20).trim().toUpperCase() === ref.resn && l[21] === ref.chain && parseInt(l.slice(22, 26), 10) === ref.resi);
        if (lines.length) {
          referenceModel = viewer.addModel(lines.join('\n') + '\nEND\n', 'pdb');
          referenceModel.setStyle({}, { stick: { radius: 0.15, opacity: 0.55, colorscheme: { prop: 'elem', map: REFERENCE_MAP } } });
          referenceModel.hide();
          if (state.reference) referenceModel.show();
        }
        pocketSel = { within: { distance: 4.5, sel: referenceSel }, byres: true, hetflag: false };
      }
      if (highlightPocket && highlightPocket.center && highlightPocket.half) {
        boxSpec = { center: [...highlightPocket.center], half: [...highlightPocket.half] };
        if (!pocketSel) {
          const or = residuesInBox(atoms, boxSpec.center, boxSpec.half);
          if (or.length) pocketSel = { or, hetflag: false };
        }
        drawBox();
      }
      applyStructureStyle();
      frame();
      render();
      mirror();
      const pocketResidues = pocketSel ? new Set(structureModel.selectedAtoms(pocketSel).map((a) => `${a.chain}:${a.resi}`)).size : 0;
      return { atoms: atoms.length, reference: !!referenceModel, pocketResidues };
    },

    showLigand(sdfText) {
      if (state.disposed) throw new Error('viewer disposed');
      dropSurface();
      dropBox();
      structureModel = dropModel(structureModel);
      referenceModel = dropModel(referenceModel);
      poseModel = dropModel(poseModel);
      ligandModel = dropModel(ligandModel);
      pocketSel = null;
      referenceSel = null;
      boxSpec = null;
      state.structure = null;
      state.pose = false;
      ligandModel = viewer.addModel(sdfText, 'sdf');
      ligandModel.setStyle({}, { stick: { radius: 0.22, colorscheme: { prop: 'elem', map: LIGAND_MAP } } });
      viewer.zoomTo();
      homeView = viewer.getView();
      render();
      mirror();
      return { atoms: ligandModel.selectedAtoms({}).length };
    },

    showPose(sdfText, poseAbs) {
      if (state.disposed) throw new Error('viewer disposed');
      const text = sdfWithPose(sdfText, poseAbs);
      poseModel = dropModel(poseModel);
      ligandModel = dropModel(ligandModel);
      poseModel = viewer.addModel(text, 'sdf');
      poseModel.setStyle({}, { stick: { radius: 0.22, colorscheme: { prop: 'elem', map: LIGAND_MAP } } });
      state.pose = true;
      if (!structureModel) { viewer.zoomTo(); homeView = viewer.getView(); }
      render();
      mirror();
      return { atoms: poseModel.selectedAtoms({}).length };
    },

    clearPose() {
      poseModel = dropModel(poseModel);
      state.pose = false;
      render();
      mirror();
    },

    setBox(center, half) {
      boxSpec = { center: [...center], half: [...half] };
      state.box = true;
      drawBox();
      render();
      mirror();
    },

    setBoxVisible(on) {
      state.box = !!on;
      for (const s of boxShapes) { s.hidden = !state.box; }
      render();
      mirror();
    },

    setReference(on) {
      state.reference = !!on;
      if (referenceModel) { if (state.reference) referenceModel.show(); else referenceModel.hide(); }
      render();
      mirror();
    },

    setPocket(on) {
      state.pocket = !!on;
      applyStructureStyle();
      render();
      mirror();
    },

    async setSurface(on) {
      if (!on) { dropSurface(); render(); mirror(); return false; }
      if (!structureModel || !pocketSel) return false;
      if (surfaceId !== null || surfacePending) return true;
      state.surface = true;
      mirror();
      const p = viewer.addSurface('VDW', { opacity: 0.35, color: COLOR.surface }, { ...pocketSel, model: structureModel });
      surfacePending = p;
      try {
        const id = await p;
        if (surfacePending !== p) { try { viewer.removeSurface(id); } catch { /* gone */ } return false; }
        surfaceId = id;
        render();
        return true;
      } catch {
        if (surfacePending === p) { surfacePending = null; state.surface = false; mirror(); }
        return false;
      } finally {
        if (surfacePending === p) surfacePending = null;
      }
    },

    resetView() {
      if (homeView) viewer.setView(homeView); else frame();
      render();
    },

    spin(on) {
      state.spinning = !!on;
      if (state.spinning) startSpin(); else stopSpinTimer();
    },

    resize() { try { viewer.resize(); } catch { /* not attached */ } render(); },

    toPng() { return viewer.pngURI(); },

    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stopSpinTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      if (ro) ro.disconnect();
      dropSurface();
      dropBox();
      try { viewer.removeAllModels(); viewer.removeAllShapes(); viewer.clear(); } catch { /* gone */ }
      const canvas = el.querySelector('canvas');
      if (canvas) {
        try { const gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); const ext = gl && gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch { /* fine */ }
        canvas.remove();
      }
      delete el.dataset.viewer;
      delete el.dataset.structure;
      delete el.dataset.pose;
    },
  };
  mirror();
  return handle;
}
