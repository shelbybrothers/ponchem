/*
 * tools/fixtures/3dmol-test.js: runs inside tools/fixtures/3dmol-test.html. Fetches 1M17 from files.rcsb.org, builds a
 * 3Dmol viewer on it, renders it, asks for a surface (which needs a blob: worker under the CSP) and reports one JSON
 * line on the console, prefixed 3DMOL_RESULT, that tools/fixtures/3dmol-check.mjs reads.
 */
(async () => {
  const out = document.getElementById('out');
  const report = (o) => { const s = JSON.stringify(o); out.textContent = s; console.log('3DMOL_RESULT ' + s); };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    const t0 = performance.now();
    const r = await fetch('https://files.rcsb.org/download/1M17.pdb');
    if (!r.ok) throw new Error(`files.rcsb.org answered ${r.status}`);
    const pdb = await r.text();
    const fetched = Math.round(performance.now() - t0);
    const lines = pdb.split('\n');
    const atomLines = lines.filter((l) => /^(ATOM|HETATM)/.test(l)).length;
    // 3Dmol keeps one conformer: atoms whose altLoc column (17) is blank or A
    const expected = lines.filter((l) => /^(ATOM|HETATM)/.test(l) && (l[16] === ' ' || l[16] === 'A')).length;
    const viewer = $3Dmol.createViewer('viewer', { backgroundColor: 'white' });
    viewer.addModel(pdb, 'pdb');
    const model = viewer.getModel();
    const atoms = model.selectedAtoms({}).length;
    const het = model.selectedAtoms({ hetflag: true });
    const hetNames = [...new Set(het.map((a) => a.resn))].sort();
    viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
    viewer.addStyle({ hetflag: true }, { stick: {} });
    viewer.zoomTo();
    viewer.render();
    let surface = null;
    try {
      const t1 = performance.now();
      await viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.7 }, { hetflag: true, not: { resn: 'HOH' } });
      viewer.render();
      surface = `ok in ${Math.round(performance.now() - t1)} ms`;
    } catch (e) {
      surface = `failed: ${String((e && e.message) || e)}`;
    }
    const png = viewer.pngURI();
    report({ ok: true, version: typeof $3Dmol.version === 'string' ? $3Dmol.version : null, webgl: !!gl, webgl2: !!(gl && gl instanceof WebGL2RenderingContext), renderer, fetchMs: fetched, pdbBytes: pdb.length, atomLines, expected, atoms, hetero: het.length, hetNames, surface, pngBytes: png.length, title: (lines.find((l) => l.startsWith('TITLE')) || '').slice(10).trim() });
  } catch (e) {
    report({ ok: false, error: String((e && e.message) || e) });
  }
})();
