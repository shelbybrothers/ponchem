"""Pocket: PDB file -> pocket bytes (SPEC-ENGINE.md, sections 2 and 5).

Layout (big-endian), n atoms, grid nx*ny*nz cells:
  0    4 x ASCII   PDB id, upper case
  4    uint16      n_atoms
  6    uint16      hx   box half size x, centi-A
  8    uint16      hy
  10   uint16      hz
  12   int32       cx   box centre x, milli-A, absolute PDB frame
  16   int32       cy
  20   int32       cz
  24   uint8       nx   grid cells along x  (nx = (2*hx + 1600) // 800 + 1)
  25   uint8       ny
  26   uint8       nz
  27   uint8       version (1)
  28   n x (int16 x, int16 y, int16 z, uint8 type)   7 bytes each, centi-A relative to the centre,
                                                        sorted by cell index (stable)
  28+7n  (nx*ny*nz + 1) x uint16  cell offsets: atoms of cell c are indices [off[c], off[c+1])
Hash = keccak256 of the whole byte string.

Cell of an atom: cx = (x + hx + 800) // 800 (same for y, z); c = (cx * ny + cy) * nz + cz.
"""

from decimal import Decimal

from .constants import (
    BOX_MIN_HALF_MILLI, BOX_PAD_MILLI, POCKET_REACH_CENTI, CELL_CENTI, MAX_POCKET_ATOMS,
    POCKET_VERSION, div_round_half_even,
)
from .keccak import keccak256_hex
from .typing import receptor_atom_type, metal_type, WATER_RESIDUES, RESIDUE_TABLE


class PocketError(ValueError):
    pass


# ---- PDB parsing --------------------------------------------------------------------

def parse_pdb_first_model(text: str):
    """Returns a list of records of the first model: dicts with record, name, altloc, resname,
    chain, resseq, icode, x/y/z (int milli-A), element. Hydrogens are dropped here."""
    out = []
    for line in text.splitlines():
        rec = line[0:6]
        if rec == "ENDMDL":
            break
        if rec not in ("ATOM  ", "HETATM"):
            continue
        if len(line) < 54:
            continue
        element = line[76:78].strip().upper() if len(line) >= 78 else ""
        name = line[12:16].strip()
        if not element:
            # derive from the atom name (PDB convention: columns 13-14 hold the element)
            e2 = line[12:14].strip().upper()
            element = e2 if e2 in ("ZN", "MG", "MN", "CA", "FE", "NA", "CO", "NI", "CU", "CL", "BR", "SE") else name[0].upper()
            if rec == "ATOM  " and e2 == "CA":
                element = "C"
        if element in ("H", "D", "T"):
            continue
        out.append({
            "record": rec.strip(),
            "name": name,
            "altloc": line[16],
            "resname": line[17:20].strip(),
            "chain": line[21],
            "resseq": int(line[22:26]),
            "icode": line[26],
            "x": int(Decimal(line[30:38].strip()) * 1000),
            "y": int(Decimal(line[38:46].strip()) * 1000),
            "z": int(Decimal(line[46:54].strip()) * 1000),
            "element": element,
        })
    return out


def resolve_altlocs(records):
    """Keep one record per (chain, resseq, icode, resname, name): the first with altloc ' ' or 'A',
    else the first seen. Output keeps the input order of the kept records."""
    first = {}
    chosen = {}
    order = []
    for r in records:
        key = (r["chain"], r["resseq"], r["icode"], r["resname"], r["name"])
        if key not in first:
            first[key] = r
            order.append(key)
        if key not in chosen and r["altloc"] in (" ", "A"):
            chosen[key] = r
    return [chosen.get(k, first[k]) for k in order]


# ---- reference ligand ---------------------------------------------------------------

def select_reference_ligand(records, ccd_id: str, chain=None, resseq=None):
    """Heavy atoms of the reference ligand instance. The instance is the first HETATM group
    (by file order) whose residue name equals ccd_id, restricted to the given chain / resseq
    when provided."""
    ccd = ccd_id.upper()
    target = None
    for r in records:
        if r["record"] != "HETATM" or r["resname"] != ccd:
            continue
        if chain is not None and r["chain"] != chain:
            continue
        if resseq is not None and r["resseq"] != resseq:
            continue
        target = (r["chain"], r["resseq"], r["icode"])
        break
    if target is None:
        raise PocketError("reference ligand %s not found" % ccd)
    atoms = [r for r in records if r["record"] == "HETATM" and r["resname"] == ccd
             and (r["chain"], r["resseq"], r["icode"]) == target]
    return atoms, target


# ---- receptor atoms -----------------------------------------------------------------

def receptor_atoms(records, chains=None):
    """Typed receptor heavy atoms: protein residues from ATOM records (plus MSE from HETATM)
    of the selected chains (default: every chain), and metal ions from HETATM records of any
    chain. Waters and every other hetero group are dropped. Returns (atoms, stats)."""
    atoms = []
    dropped_unknown = {}
    for r in records:
        if r["resname"] in WATER_RESIDUES:
            continue
        if r["record"] == "HETATM" and r["resname"] != "MSE":
            t = metal_type(r["element"])
            if t is not None:
                atoms.append((r["x"], r["y"], r["z"], t, r))
            continue
        if chains is not None and r["chain"] not in chains:
            continue
        t = receptor_atom_type(r["resname"], r["name"])
        if t is None:
            k = r["resname"] if r["resname"] not in RESIDUE_TABLE else r["resname"] + ":" + r["name"]
            dropped_unknown[k] = dropped_unknown.get(k, 0) + 1
            continue
        atoms.append((r["x"], r["y"], r["z"], t, r))
    return atoms, {"dropped_unknown": dropped_unknown}


# ---- box and pocket ------------------------------------------------------------------

def box_from_ligand(lig_atoms):
    """Centre (milli-A, round half even of the centroid) and half sizes (centi-A):
    h = max(6.00 A, ceil(max_i |x_i - c| + 2.00 A))."""
    n = len(lig_atoms)
    if n == 0:
        raise PocketError("reference ligand has no heavy atoms")
    centre = []
    half = []
    for axis in ("x", "y", "z"):
        vals = [a[axis] for a in lig_atoms]
        c = div_round_half_even(sum(vals), n)
        dev = max(abs(v - c) for v in vals)
        h_milli = max(BOX_MIN_HALF_MILLI, dev + BOX_PAD_MILLI)
        h_centi = (h_milli + 9) // 10
        centre.append(c)
        half.append(h_centi)
    return centre, half


def milli_to_centi_rel(v_milli: int, c_milli: int) -> int:
    return div_round_half_even(v_milli - c_milli, 10)


def cell_of(v_centi: int, h_centi: int) -> int:
    return (v_centi + h_centi + POCKET_REACH_CENTI) // CELL_CENTI


def grid_dims(half):
    return [(2 * h + 2 * POCKET_REACH_CENTI) // CELL_CENTI + 1 for h in half]


def encode_pocket(pdb_id: str, centre_milli, half_centi, atoms):
    """Encode a pocket from relative atoms [(x, y, z, type), ...] in centi-A. Atoms are
    sorted by cell index (stable) and the cell offset table is appended."""
    pdb_id = pdb_id.upper()
    if len(pdb_id) != 4:
        raise PocketError("pdb id must be 4 characters")
    if len(atoms) > MAX_POCKET_ATOMS:
        raise PocketError("too many pocket atoms")
    half = list(half_centi)
    nx, ny, nz = grid_dims(half)
    if nx > 255 or ny > 255 or nz > 255:
        raise PocketError("grid too large")
    for (x, y, z, t) in atoms:
        for v, h in ((x, half[0]), (y, half[1]), (z, half[2])):
            if v < -32768 or v > 32767:
                raise PocketError("coordinate does not fit int16")
            if abs(v) > h + POCKET_REACH_CENTI:
                raise PocketError("pocket atom outside the reach cube")
        if t < 0 or t > 15:
            raise PocketError("bad type code")

    def cell_index(a):
        cx = cell_of(a[0], half[0])
        cy = cell_of(a[1], half[1])
        cz = cell_of(a[2], half[2])
        return (cx * ny + cy) * nz + cz

    ordered = sorted(atoms, key=cell_index)  # stable: keeps input order within a cell
    ncells = nx * ny * nz
    offsets = [0] * (ncells + 1)
    for a in ordered:
        offsets[cell_index(a) + 1] += 1
    for c in range(ncells):
        offsets[c + 1] += offsets[c]
    out = bytearray()
    out += pdb_id.encode("ascii")
    out += len(ordered).to_bytes(2, "big")
    for h in half:
        out += int(h).to_bytes(2, "big")
    for c in centre_milli:
        out += int(c).to_bytes(4, "big", signed=True)
    out += bytes([nx, ny, nz, POCKET_VERSION])
    for x, y, z, t in ordered:
        out += int(x).to_bytes(2, "big", signed=True)
        out += int(y).to_bytes(2, "big", signed=True)
        out += int(z).to_bytes(2, "big", signed=True)
        out += bytes([t])
    for o in offsets:
        out += o.to_bytes(2, "big")
    return bytes(out)


def build_pocket(pdb_text: str, pdb_id: str, ccd_id: str, chain=None, resseq=None, chains=None):
    """PDB text -> (pocket_bytes, info dict)."""
    pdb_id = pdb_id.upper()
    if len(pdb_id) != 4:
        raise PocketError("pdb id must be 4 characters")
    records = resolve_altlocs(parse_pdb_first_model(pdb_text))
    lig, instance = select_reference_ligand(records, ccd_id, chain, resseq)
    centre, half = box_from_ligand(lig)
    rec_atoms, stats = receptor_atoms(records, chains)
    cand = []
    for k, (x, y, z, t, r) in enumerate(rec_atoms):
        rx = milli_to_centi_rel(x, centre[0])
        ry = milli_to_centi_rel(y, centre[1])
        rz = milli_to_centi_rel(z, centre[2])
        if abs(rx) > half[0] + POCKET_REACH_CENTI or abs(ry) > half[1] + POCKET_REACH_CENTI \
                or abs(rz) > half[2] + POCKET_REACH_CENTI:
            continue
        for v in (rx, ry, rz):
            if v < -32768 or v > 32767:
                raise PocketError("coordinate does not fit int16")
        cand.append((rx, ry, rz, t, k, r))
    n_before_cap = len(cand)
    if len(cand) > MAX_POCKET_ATOMS:
        cand.sort(key=lambda a: (a[0] * a[0] + a[1] * a[1] + a[2] * a[2], a[4]))
        cand = cand[:MAX_POCKET_ATOMS]
        cand.sort(key=lambda a: a[4])
    dims = grid_dims(half)
    blob = encode_pocket(pdb_id, centre, half, [(a[0], a[1], a[2], a[3]) for a in cand])
    nx, ny, nz = dims
    ncells = nx * ny * nz
    type_hist = {}
    for a in cand:
        type_hist[a[3]] = type_hist.get(a[3], 0) + 1
    chains_seen = sorted(set(a[5]["chain"] for a in cand))
    info = {
        "pdb_id": pdb_id, "ccd_id": ccd_id.upper(),
        "reference_instance": {"chain": instance[0], "resseq": instance[1], "icode": instance[2].strip()},
        "reference_heavy_atoms": len(lig),
        "reference_atom_names": [a["name"] for a in lig],
        "centre_milli": centre, "half_centi": half,
        "centre_angstrom": [c / 1000.0 for c in centre], "half_angstrom": [h / 100.0 for h in half],
        "grid": dims, "n_cells": ncells,
        "receptor_atoms_total": len(rec_atoms), "pocket_atoms_before_cap": n_before_cap,
        "pocket_atoms": len(cand), "capped": n_before_cap > MAX_POCKET_ATOMS,
        "chains_in_pocket": chains_seen,
        "type_histogram": {str(k): v for k, v in sorted(type_hist.items())},
        "dropped_unknown": stats["dropped_unknown"],
        "bytes": len(blob), "keccak256": keccak256_hex(blob),
    }
    return blob, info, lig


# ---- reader ----------------------------------------------------------------------------

def parse_pocket(blob: bytes):
    if len(blob) < 28:
        raise PocketError("pocket too short")
    pdb_id = blob[0:4].decode("ascii")
    n = int.from_bytes(blob[4:6], "big")
    hx = int.from_bytes(blob[6:8], "big")
    hy = int.from_bytes(blob[8:10], "big")
    hz = int.from_bytes(blob[10:12], "big")
    cx = int.from_bytes(blob[12:16], "big", signed=True)
    cy = int.from_bytes(blob[16:20], "big", signed=True)
    cz = int.from_bytes(blob[20:24], "big", signed=True)
    nx, ny, nz, version = blob[24], blob[25], blob[26], blob[27]
    if version != POCKET_VERSION:
        raise PocketError("unsupported pocket version %d" % version)
    if n > MAX_POCKET_ATOMS:
        raise PocketError("too many pocket atoms")
    ncells = nx * ny * nz
    expected = 28 + 7 * n + 2 * (ncells + 1)
    if len(blob) != expected:
        raise PocketError("pocket length %d, expected %d" % (len(blob), expected))
    atoms = []
    off = 28
    for _ in range(n):
        x = int.from_bytes(blob[off:off + 2], "big", signed=True)
        y = int.from_bytes(blob[off + 2:off + 4], "big", signed=True)
        z = int.from_bytes(blob[off + 4:off + 6], "big", signed=True)
        t = blob[off + 6]
        atoms.append((x, y, z, t))
        off += 7
    offsets = []
    for _ in range(ncells + 1):
        offsets.append(int.from_bytes(blob[off:off + 2], "big"))
        off += 2
    return {"pdb_id": pdb_id, "n_atoms": n, "half": (hx, hy, hz), "centre_milli": (cx, cy, cz),
            "grid": (nx, ny, nz), "atoms": atoms, "offsets": offsets}
