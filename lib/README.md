# lib/

Third-party code that ships with the site (deployed, unlike tools/). Nothing here is edited by hand.

| file | what | version | license |
|---|---|---|---|
| `3Dmol-min.js` | 3Dmol.js, the molecular viewer for the 3D views | 2.5.5 (npm `3dmol@2.5.5`, `build/3Dmol-min.js`, sha256 `f7cc78921ae72e7623e89cdd111434f58c2efddd2ffda1cd212644b406fb8016`, fetched 2026-09-22 with `npm pack`) | BSD-3-Clause, `3Dmol-LICENSE.txt` (also GLmol MIT/LGPL3, three.js MIT, jQuery MIT, as that file states); `3Dmol-min.js.LICENSE.txt` is the banner webpack split out |
| `doh.js` | re-export of `api/_doh.mjs` for the local tools | own code | |

Load it with `<script src="/lib/3Dmol-min.js"></script>`; it defines `window.$3Dmol`. There is no ES module build
that works without a bundler, so it stays a classic script.

Under the production CSP (vercel.json):
- `script-src 'self'`: the file is same-origin. 3Dmol never uses `new Function` or WebAssembly. Its one `eval` sits in
  `makeFunction` and only runs when a callback is passed as a STRING (the `data-*` embed API): pass real functions and it
  is never reached, so no `'unsafe-eval'` and no `'wasm-unsafe-eval'`.
- `worker-src 'self' blob:`: `addSurface` builds its workers from a `Blob` URL (`$3Dmol.SurfaceWorker`). Without `blob:`
  surfaces fail; everything else works.
- `connect-src` allows `files.rcsb.org` and `data.rcsb.org`: fetch structures yourself and hand the text to
  `viewer.addModel(text, 'pdb' | 'sdf' | 'mol2' | 'cif')`. `$3Dmol.download('pdb:1M17', viewer)` also works (it hits
  files.rcsb.org/view/), but `mmtf:` (models.rcsb.org) and `cid:` (PubChem) are blocked on purpose.
- WebGL needs no CSP. `viewer.pngURI()` returns a data: URL, allowed by `img-src data:`.

Proof: `node tools/fixtures/3dmol-check.mjs` loads 1M17 from RCSB in headless Chrome under this exact CSP.
