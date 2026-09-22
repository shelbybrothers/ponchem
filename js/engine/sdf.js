/*
 * js/engine/sdf.js: MDL V2000 SDF/mol parser for the browser engine (SPEC-ENGINE.md 4.1).
 *
 *   parseSdf(text) -> { atoms: [{ el, x, y, z, charge, hcount }], bonds: [[i, j, order]], name, heavyAtoms,
 *                       explicitHydrogens }
 *
 * Heavy atoms only, in SDF order (hydrogens H, D, T are dropped, bonds re-indexed to heavy indices, i < j,
 * sorted by (i, j) like the Python reference). Coordinates are angstrom floats. `hcount` is the number of
 * explicit hydrogens bonded to the heavy atom in the file (0 when the file carries none: data/ligands/*.sdf are
 * heavy-atom files; the types then come from the topology bytes, never from this parser). `M  CHG` lines set
 * formal charges. V3000 files are refused.
 */

const HYDROGEN = new Set(['H', 'D', 'T']);

function normaliseElement(raw) {
  const s = raw.trim();
  if (!s) throw new Error('SDF atom line without an element symbol');
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

function num(field, what) {
  const v = Number(field.trim());
  if (!Number.isFinite(v)) throw new Error(`SDF: bad ${what} "${field.trim()}"`);
  return v;
}

export function parseSdf(text) {
  if (typeof text !== 'string') throw new Error('parseSdf expects a string');
  const lines = text.split(/\r?\n/);
  if (lines.length < 4) throw new Error('SDF too short');
  const counts = lines[3];
  if (/V3000/.test(counts)) throw new Error('V3000 SDF not supported; export V2000');
  const na = parseInt(counts.slice(0, 3), 10);
  const nb = parseInt(counts.slice(3, 6), 10);
  if (!Number.isInteger(na) || !Number.isInteger(nb) || na < 1) throw new Error('SDF: bad counts line');
  if (lines.length < 4 + na + nb) throw new Error('SDF: truncated atom or bond block');
  const all = [];
  for (let i = 0; i < na; i++) {
    const l = lines[4 + i];
    if (l.length < 34) throw new Error(`SDF: short atom line ${i + 1}`);
    all.push({ el: normaliseElement(l.slice(31, 34)), x: num(l.slice(0, 10), 'x'), y: num(l.slice(10, 20), 'y'), z: num(l.slice(20, 30), 'z'), charge: 0 });
  }
  const rawBonds = [];
  for (let i = 0; i < nb; i++) {
    const l = lines[4 + na + i];
    const a = parseInt(l.slice(0, 3), 10) - 1;
    const b = parseInt(l.slice(3, 6), 10) - 1;
    const order = parseInt(l.slice(6, 9), 10);
    if (!(a >= 0 && b >= 0 && a < na && b < na) || a === b || !Number.isInteger(order)) throw new Error(`SDF: bad bond line ${i + 1}`);
    rawBonds.push([a, b, order]);
  }
  for (let k = 4 + na + nb; k < lines.length; k++) {
    const l = lines[k];
    if (l.startsWith('M  CHG')) {
      const parts = l.trim().split(/\s+/);
      const n = parseInt(parts[2], 10);
      for (let q = 0; q < n; q++) {
        const idx = parseInt(parts[3 + 2 * q], 10) - 1;
        const chg = parseInt(parts[4 + 2 * q], 10);
        if (all[idx]) all[idx].charge = chg;
      }
    }
    if (l.startsWith('M  END') || l.startsWith('$$$$')) break;
  }
  const heavyIndex = new Int32Array(na).fill(-1);
  const atoms = [];
  for (let i = 0; i < na; i++) {
    if (HYDROGEN.has(all[i].el.toUpperCase())) continue;
    heavyIndex[i] = atoms.length;
    atoms.push({ el: all[i].el, x: all[i].x, y: all[i].y, z: all[i].z, charge: all[i].charge, hcount: 0 });
  }
  const bonds = [];
  const seen = new Set();
  for (const [a, b, order] of rawBonds) {
    const ha = heavyIndex[a], hb = heavyIndex[b];
    if (ha >= 0 && hb >= 0) {
      const i = Math.min(ha, hb), j = Math.max(ha, hb);
      const key = i * 256 + j;
      if (seen.has(key)) throw new Error('SDF: duplicate bond');
      seen.add(key);
      bonds.push([i, j, order]);
    } else if (ha >= 0) atoms[ha].hcount++;
    else if (hb >= 0) atoms[hb].hcount++;
  }
  bonds.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  return {
    name: (lines[0] || '').trim(),
    atoms,
    bonds,
    heavyAtoms: atoms.length,
    explicitHydrogens: all.length > atoms.length,
  };
}

/** Float64Array(3n) of the heavy-atom coordinates in angstrom, SDF order. */
export function sdfCoords(parsed) {
  const out = new Float64Array(parsed.atoms.length * 3);
  parsed.atoms.forEach((a, i) => { out[3 * i] = a.x; out[3 * i + 1] = a.y; out[3 * i + 2] = a.z; });
  return out;
}
