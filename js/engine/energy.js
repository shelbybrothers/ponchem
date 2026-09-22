/*
 * js/engine/energy.js: the smooth float objective of the search (SPEC-ENGINE.md section 7), with analytic gradients.
 *
 * total = inter + intra + box
 *   inter: the five Vina terms over ligand x pocket pairs within 8 A, on d = r - Ri - Rj. The per-class energy
 *          E_class(d) is tabulated at 0.01 A from the FROZEN integer tables (gauss1, gauss2 in micro units) plus the
 *          exact piecewise terms, and interpolated linearly: no Math.exp, so every machine evaluates the same number.
 *   intra: the same terms over ligand pairs at graph distance >= 4, plus a clash penalty for every pair at graph
 *          distance >= 3 closer than the float floor (2.20 A on chain + margin): CLASH_W2 c^2 + CLASH_W1 c.
 *   box:   per coordinate over = max(0, |x| - (half - margin)): BOX_W2 over^2 + BOX_W1 over.
 * affinity = inter / (1 + 0.0585 Nrot) is what the progress caption shows (the browser estimate); the number
 * reported at the end is always the integer scorer's.
 *
 *   makeEnergyModel(pocket, topology, ligandModel, tables) -> model
 *   model.evaluate(X, grad | null) -> total   (also sets model.inter, model.intra, model.box, model.violation)
 */
import { RADIUS_CENTI, PAIR_CLASS, CELL_CENTI, REACH_CENTI } from './score.js';

export const CLASH_FLOOR_A = 2.20;
export const CLASH_MARGIN = 0.06;
export const BOX_MARGIN = 0.06;
export const CLASH_W2 = 50, CLASH_W1 = 5;
export const BOX_W2 = 20, BOX_W1 = 2;
const CUTOFF = 8.0, CUTOFF2 = 64.0;
const TABLE_N = 1002;

let classTables = null;

/** Three Float64Array(1002): energy per class at d = -4.40 + 0.01 i (i = 0..1001), from the frozen integer tables. */
export function buildClassTables(tables) {
  if (classTables && classTables.hash === tables.hash) return classTables;
  const out = [new Float64Array(TABLE_N), new Float64Array(TABLE_N), new Float64Array(TABLE_N)];
  for (let i = 0; i < TABLE_N; i++) {
    const ii = Math.min(i, 1000);
    const d = (ii - 440) / 100;
    const base = (-35600 * tables.g1[ii] - 5160 * tables.g2[ii]) / 1e12 + (d < 0 ? 0.84 * d * d : 0);
    const hyd = d <= 0.5 ? 1 : d >= 1.5 ? 0 : 1.5 - d;
    const hb = d <= -0.7 ? 1 : d >= 0 ? 0 : -d / 0.7;
    out[0][i] = base;
    out[1][i] = base - 0.0351 * hyd;
    out[2][i] = base - 0.587 * hb;
  }
  classTables = { hash: tables.hash, tables: out };
  return classTables;
}

export function makeEnergyModel(pocket, topology, lig, tables) {
  const { tables: T } = buildClassTables(tables);
  const T0 = T[0], T1 = T[1], T2 = T[2];
  const np = pocket.n;
  const px = new Float64Array(np), py = new Float64Array(np), pz = new Float64Array(np), prad = new Float64Array(np);
  const ptype = pocket.types;
  for (let k = 0; k < np; k++) {
    px[k] = pocket.atoms[3 * k] / 100; py[k] = pocket.atoms[3 * k + 1] / 100; pz[k] = pocket.atoms[3 * k + 2] / 100;
    prad[k] = RADIUS_CENTI[ptype[k]] / 100;
  }
  const n = topology.n;
  const ltype = topology.types;
  const lrad = new Float64Array(n);
  for (let i = 0; i < n; i++) lrad[i] = RADIUS_CENTI[ltype[i]] / 100;
  const [hx, hy, hz] = pocket.halfCenti;
  const [nx, ny, nz] = pocket.grid;
  const off = pocket.offsets;
  const half = [hx / 100 - BOX_MARGIN, hy / 100 - BOX_MARGIN, hz / 100 - BOX_MARGIN];
  const floor = CLASH_FLOOR_A + CLASH_MARGIN;
  // intramolecular pair lists from the topology's bond graph
  const gd = lig.graphDist;
  const vinaPairs = [], clashPairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = gd[i * n + j];
      if (d >= 3) clashPairs.push(i, j);
      if (d >= 4) vinaPairs.push(i, j, PAIR_CLASS[ltype[i] * 16 + ltype[j]]);
    }
  }
  const VP = Int32Array.from(vinaPairs), CP = Int32Array.from(clashPairs);
  const nrotPenalty = 1 + 0.0585 * topology.nrot;

  const model = {
    n, inter: 0, intra: 0, box: 0, violation: 0, evaluations: 0, nrotPenalty,
    half, floor, vinaPairs: VP.length / 3, clashPairs: CP.length / 2,
    affinity() { return model.inter / nrotPenalty; },

    evaluate(X, grad) {
      model.evaluations++;
      if (grad) grad.fill(0);
      const half = model.half, floor = model.floor;   // the polish widens these while it nudges
      let inter = 0, intra = 0, box = 0, violation = 0;
      for (let a = 0; a < n; a++) {
        const xa = X[3 * a], ya = X[3 * a + 1], za = X[3 * a + 2];
        const ra = lrad[a];
        const rowClass = ltype[a] * 16;
        let gx = 0, gy = 0, gz = 0;
        let cx = ((xa * 100 + hx + REACH_CENTI) / CELL_CENTI) | 0;
        let cy = ((ya * 100 + hy + REACH_CENTI) / CELL_CENTI) | 0;
        let cz = ((za * 100 + hz + REACH_CENTI) / CELL_CENTI) | 0;
        if (cx < 0) cx = 0; else if (cx > nx - 1) cx = nx - 1;
        if (cy < 0) cy = 0; else if (cy > ny - 1) cy = ny - 1;
        if (cz < 0) cz = 0; else if (cz > nz - 1) cz = nz - 1;
        const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < nx - 1 ? cx + 1 : nx - 1;
        const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < ny - 1 ? cy + 1 : ny - 1;
        const z0 = cz > 0 ? cz - 1 : 0, z1 = cz < nz - 1 ? cz + 1 : nz - 1;
        for (let ix = x0; ix <= x1; ix++) {
          for (let iy = y0; iy <= y1; iy++) {
            for (let iz = z0; iz <= z1; iz++) {
              const c = (ix * ny + iy) * nz + iz;
              const from = off[c], to = off[c + 1];
              for (let k = from; k < to; k++) {
                const dx = xa - px[k], dy = ya - py[k], dz = za - pz[k];
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 > CUTOFF2) continue;
                const r = Math.sqrt(r2);
                const d = r - ra - prad[k];
                let idx = (d + 4.4) * 100;
                if (idx < 0) idx = 0; else if (idx > 1000) idx = 1000;
                const i0 = idx | 0;
                const f = idx - i0;
                const cls = PAIR_CLASS[rowClass + ptype[k]];
                const tab = cls === 0 ? T0 : cls === 1 ? T1 : T2;
                const e0 = tab[i0], slope = tab[i0 + 1] - e0;
                inter += e0 + f * slope;
                if (grad && r > 1e-9) {
                  const s = slope * 100 / r;
                  gx += s * dx; gy += s * dy; gz += s * dz;
                }
              }
            }
          }
        }
        // box
        const lim0 = half[0], lim1 = half[1], lim2 = half[2];
        const ox = Math.abs(xa) - lim0, oy = Math.abs(ya) - lim1, oz = Math.abs(za) - lim2;
        if (ox > 0) { box += BOX_W2 * ox * ox + BOX_W1 * ox; violation += ox; if (grad) gx += (2 * BOX_W2 * ox + BOX_W1) * (xa < 0 ? -1 : 1); }
        if (oy > 0) { box += BOX_W2 * oy * oy + BOX_W1 * oy; violation += oy; if (grad) gy += (2 * BOX_W2 * oy + BOX_W1) * (ya < 0 ? -1 : 1); }
        if (oz > 0) { box += BOX_W2 * oz * oz + BOX_W1 * oz; violation += oz; if (grad) gz += (2 * BOX_W2 * oz + BOX_W1) * (za < 0 ? -1 : 1); }
        if (grad) { grad[3 * a] += gx; grad[3 * a + 1] += gy; grad[3 * a + 2] += gz; }
      }
      // intramolecular Vina terms (graph distance >= 4)
      for (let q = 0; q < VP.length; q += 3) {
        const i = VP[q], j = VP[q + 1], cls = VP[q + 2];
        const dx = X[3 * i] - X[3 * j], dy = X[3 * i + 1] - X[3 * j + 1], dz = X[3 * i + 2] - X[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > CUTOFF2) continue;
        const r = Math.sqrt(r2);
        const d = r - lrad[i] - lrad[j];
        let idx = (d + 4.4) * 100;
        if (idx < 0) idx = 0; else if (idx > 1000) idx = 1000;
        const i0 = idx | 0;
        const f = idx - i0;
        const tab = cls === 0 ? T0 : cls === 1 ? T1 : T2;
        const e0 = tab[i0], slope = tab[i0 + 1] - e0;
        intra += e0 + f * slope;
        if (grad && r > 1e-9) {
          const s = slope * 100 / r;
          grad[3 * i] += s * dx; grad[3 * i + 1] += s * dy; grad[3 * i + 2] += s * dz;
          grad[3 * j] -= s * dx; grad[3 * j + 1] -= s * dy; grad[3 * j + 2] -= s * dz;
        }
      }
      // clash floor (graph distance >= 3)
      for (let q = 0; q < CP.length; q += 2) {
        const i = CP[q], j = CP[q + 1];
        const dx = X[3 * i] - X[3 * j], dy = X[3 * i + 1] - X[3 * j + 1], dz = X[3 * i + 2] - X[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= floor * floor) continue;
        const r = Math.sqrt(r2);
        const c = floor - r;
        intra += CLASH_W2 * c * c + CLASH_W1 * c;
        violation += c;
        if (grad && r > 1e-9) {
          const s = -(2 * CLASH_W2 * c + CLASH_W1) / r;
          grad[3 * i] += s * dx; grad[3 * i + 1] += s * dy; grad[3 * i + 2] += s * dz;
          grad[3 * j] -= s * dx; grad[3 * j + 1] -= s * dy; grad[3 * j + 2] -= s * dz;
        }
      }
      model.inter = inter; model.intra = intra; model.box = box; model.violation = violation;
      return inter + intra + box;
    },
  };
  return model;
}
