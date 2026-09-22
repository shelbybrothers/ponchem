"""Ligand topology: SDF (V2000) -> topology bytes (SPEC-ENGINE.md, section 4).

Layout (big-endian), N atoms, B bonds, P 1-3 pairs:
  0   uint8  version (1)
  1   uint8  N   (1..64)
  2   uint8  B
  3   uint8  Nrot
  4   uint16 P
  6   uint16 reserved (0)
  8   N x uint8            type code per atom, in SDF heavy-atom order
  8+N          B x (uint8 i, uint8 j, uint16 ideal)   i < j, ideal 1-2 distance in centi-A
  8+N+4B       P x (uint8 i, uint8 j, uint16 ideal)   i < j, ideal 1-3 distance in centi-A
  8+N+4B+4P    N x uint64 near mask: bit j set iff graph distance(i, j) <= 2 (bit i itself set)
Total 8 + 9N + 4B + 4P bytes. Hash = keccak256 of the whole byte string.
"""

import math
from collections import deque
from decimal import Decimal

from .constants import MAX_LIGAND_ATOMS, MIN_LIGAND_ATOMS, TOPOLOGY_VERSION, TOL_ABS_CENTI, TOL_PCT, CLASH_FLOOR_CENTI
from .keccak import keccak256_hex
from .typing import ligand_atom_type, UnsupportedElement

HYDROGEN = ("H", "D", "T")


class TopologyError(ValueError):
    pass


# ---- SDF parsing -----------------------------------------------------------------

def parse_sdf_v2000(text: str):
    """Returns (atoms, bonds, charges). atoms: list of (x_tenmilli, y, z, element) with
    coordinates as exact integers in 0.0001 A; bonds: list of (i, j, order) 0-based;
    charges: dict atom index -> formal charge (from M  CHG lines)."""
    lines = text.splitlines()
    if len(lines) < 4:
        raise TopologyError("SDF too short")
    counts = lines[3]
    if "V3000" in counts:
        raise TopologyError("V3000 SDF not supported; export V2000")
    na = int(counts[0:3])
    nb = int(counts[3:6])
    atoms = []
    for i in range(na):
        l = lines[4 + i]
        x = int(Decimal(l[0:10].strip()) * 10000)
        y = int(Decimal(l[10:20].strip()) * 10000)
        z = int(Decimal(l[20:30].strip()) * 10000)
        el = l[31:34].strip()
        atoms.append((x, y, z, el))
    bonds = []
    for i in range(nb):
        l = lines[4 + na + i]
        a = int(l[0:3]) - 1
        b = int(l[3:6]) - 1
        order = int(l[6:9])
        if a == b or a < 0 or b < 0 or a >= na or b >= na:
            raise TopologyError("bad bond line: " + l)
        bonds.append((min(a, b), max(a, b), order))
    charges = {}
    for l in lines[4 + na + nb:]:
        if l.startswith("M  CHG"):
            parts = l.split()
            n = int(parts[2])
            for k in range(n):
                idx = int(parts[3 + 2 * k]) - 1
                charges[idx] = int(parts[4 + 2 * k])
        if l.startswith("M  END"):
            break
    return atoms, bonds, charges


# ---- graph helpers ---------------------------------------------------------------

def _adjacency(n, bonds):
    adj = [[] for _ in range(n)]
    for i, j, _o in bonds:
        adj[i].append(j)
        adj[j].append(i)
    return adj


def graph_distances(n, bonds):
    adj = _adjacency(n, bonds)
    dist = [[255] * n for _ in range(n)]
    for s in range(n):
        dist[s][s] = 0
        q = deque([s])
        while q:
            u = q.popleft()
            for v in adj[u]:
                if dist[s][v] == 255:
                    dist[s][v] = dist[s][u] + 1
                    q.append(v)
    return dist


def _connected_without(n, bonds, skip, a, b):
    adj = [[] for _ in range(n)]
    for k, (i, j, _o) in enumerate(bonds):
        if k == skip:
            continue
        adj[i].append(j)
        adj[j].append(i)
    seen = {a}
    q = deque([a])
    while q:
        u = q.popleft()
        if u == b:
            return True
        for v in adj[u]:
            if v not in seen:
                seen.add(v)
                q.append(v)
    return False


def ring_bond_flags(n, bonds):
    """bond k is a ring bond iff its endpoints stay connected when it is removed."""
    return [_connected_without(n, bonds, k, i, j) for k, (i, j, _o) in enumerate(bonds)]


def rotatable_bonds(n, bonds, elements):
    """Nrot rule (SPEC-ENGINE.md 4.3): a bond is rotatable iff
      1. its order is 1 (single),
      2. it is not a ring bond,
      3. both endpoints have heavy degree >= 2,
      4. neither endpoint takes part in a triple bond,
      5. it is not an amide bond: C(=O)-N in either direction.
    Returns the list of bond indices that are rotatable, in bond order."""
    adj = _adjacency(n, bonds)
    ring = ring_bond_flags(n, bonds)
    triple = [False] * n
    dbl_o = [False] * n   # carbon with a double bond to oxygen
    for i, j, o in bonds:
        if o == 3:
            triple[i] = triple[j] = True
        if o == 2:
            if elements[i] == "C" and elements[j] == "O":
                dbl_o[i] = True
            if elements[j] == "C" and elements[i] == "O":
                dbl_o[j] = True
    out = []
    for k, (i, j, o) in enumerate(bonds):
        if o != 1 or ring[k]:
            continue
        if len(adj[i]) < 2 or len(adj[j]) < 2:
            continue
        if triple[i] or triple[j]:
            continue
        amide = (elements[i] == "C" and dbl_o[i] and elements[j] == "N") or \
                (elements[j] == "C" and dbl_o[j] and elements[i] == "N")
        if amide:
            continue
        out.append(k)
    return out


def dist_centi(a, b):
    """Nearest centi-A distance between two points given in 0.0001 A integers.
    s = squared distance in 1e-8 A^2; r_tenmilli = isqrt(s); ideal = (r_tenmilli + 50) // 100."""
    s = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
    return (math.isqrt(s) + 50) // 100


# ---- builder ----------------------------------------------------------------------

def build_topology(sdf_text: str):
    """SDF text -> (topology_bytes, info dict). Hydrogens are stripped here; H counts are
    taken from explicit hydrogens when the file has any, otherwise from RDKit valence."""
    atoms, bonds, charges = parse_sdf_v2000(sdf_text)
    n_all = len(atoms)
    heavy_index = {}
    heavy = []
    for i, a in enumerate(atoms):
        if a[3].upper() not in HYDROGEN:
            heavy_index[i] = len(heavy)
            heavy.append(i)
    n = len(heavy)
    if n < MIN_LIGAND_ATOMS or n > MAX_LIGAND_ATOMS:
        raise TopologyError("heavy atom count %d outside [%d, %d]" % (n, MIN_LIGAND_ATOMS, MAX_LIGAND_ATOMS))
    has_explicit_h = n_all > n
    h_count = [0] * n
    hbonds = []
    for i, j, o in bonds:
        hi = i in heavy_index
        hj = j in heavy_index
        if hi and hj:
            hbonds.append((heavy_index[i], heavy_index[j], o))
        elif hi and not hj:
            h_count[heavy_index[i]] += 1
        elif hj and not hi:
            h_count[heavy_index[j]] += 1
    hbonds.sort()
    if len(set((i, j) for i, j, _o in hbonds)) != len(hbonds):
        raise TopologyError("duplicate bond")
    if len(hbonds) > 255:
        raise TopologyError("too many bonds")
    elements = [atoms[k][3].upper() for k in heavy]
    coords = [(atoms[k][0], atoms[k][1], atoms[k][2]) for k in heavy]
    if not has_explicit_h:
        h_count = _rdkit_h_counts(sdf_text, n)
    adj = _adjacency(n, hbonds)
    types = []
    for i in range(n):
        try:
            types.append(ligand_atom_type(elements[i], [elements[j] for j in adj[i]], h_count[i],
                                          charges.get(heavy[i], 0)))
        except UnsupportedElement as e:
            raise TopologyError(str(e))
    dist = graph_distances(n, hbonds)
    bond_rows = [(i, j, dist_centi(coords[i], coords[j])) for i, j, _o in hbonds]
    pair13 = []
    for i in range(n):
        for j in range(i + 1, n):
            if dist[i][j] == 2:
                pair13.append((i, j, dist_centi(coords[i], coords[j])))
    if len(pair13) > 65535:
        raise TopologyError("too many 1-3 pairs")
    near = []
    for i in range(n):
        m = 0
        for j in range(n):
            if dist[i][j] <= 2:
                m |= 1 << j
        near.append(m)
    rot = rotatable_bonds(n, hbonds, elements)
    nrot = len(rot)
    if nrot > 255:
        raise TopologyError("too many rotatable bonds")
    # geometry sanity of the ideal conformer against the on-chain rules (information only)
    min14 = None
    min4p = None
    for i in range(n):
        for j in range(i + 1, n):
            if dist[i][j] >= 3:
                d = dist_centi(coords[i], coords[j])
                if dist[i][j] == 3:
                    min14 = d if min14 is None else min(min14, d)
                else:
                    min4p = d if min4p is None else min(min4p, d)
    ideal_passes = all(d >= CLASH_FLOOR_CENTI for d in (min14, min4p) if d is not None)

    out = bytearray()
    out += bytes([TOPOLOGY_VERSION, n, len(hbonds), nrot])
    out += len(pair13).to_bytes(2, "big")
    out += (0).to_bytes(2, "big")
    out += bytes(types)
    for i, j, d in bond_rows:
        out += bytes([i, j]) + d.to_bytes(2, "big")
    for i, j, d in pair13:
        out += bytes([i, j]) + d.to_bytes(2, "big")
    for m in near:
        out += m.to_bytes(8, "big")
    blob = bytes(out)
    info = {
        "n_atoms": n, "n_bonds": len(hbonds), "n_pairs13": len(pair13), "nrot": nrot,
        "rotatable_bond_indices": rot,
        "rotatable_bonds": [[hbonds[k][0], hbonds[k][1]] for k in rot],
        "elements": elements, "types": types, "h_count": h_count,
        "bonds": [[i, j, o] for i, j, o in hbonds],
        "bond_ideal_centi": [d for _i, _j, d in bond_rows],
        "pairs13": [[i, j, d] for i, j, d in pair13],
        "near_masks_hex": ["0x%016x" % m for m in near],
        "ideal_coords_tenmilli": [list(c) for c in coords],
        "explicit_hydrogens": has_explicit_h,
        "min_dist14_centi": min14, "min_dist4plus_centi": min4p,
        "ideal_passes_clash_floor": ideal_passes,
        "bytes": len(blob), "keccak256": keccak256_hex(blob),
    }
    return blob, info


def _rdkit_h_counts(sdf_text, n):
    try:
        from rdkit import Chem
    except ImportError:
        raise TopologyError("SDF has no explicit hydrogens and RDKit is not available")
    mol = Chem.MolFromMolBlock(sdf_text, removeHs=False)
    if mol is None:
        raise TopologyError("RDKit could not read the SDF to count implicit hydrogens")
    hc = []
    for a in mol.GetAtoms():
        if a.GetAtomicNum() > 1:
            hc.append(a.GetTotalNumHs(includeNeighbors=True))
    if len(hc) != n:
        raise TopologyError("RDKit heavy atom count differs from the parser")
    return hc


# ---- reader --------------------------------------------------------------------------

def parse_topology(blob: bytes):
    if len(blob) < 8:
        raise TopologyError("topology too short")
    version = blob[0]
    if version != TOPOLOGY_VERSION:
        raise TopologyError("unsupported topology version %d" % version)
    n = blob[1]
    b = blob[2]
    nrot = blob[3]
    p = int.from_bytes(blob[4:6], "big")
    expected = 8 + 9 * n + 4 * b + 4 * p
    if len(blob) != expected:
        raise TopologyError("topology length %d, expected %d" % (len(blob), expected))
    if n < MIN_LIGAND_ATOMS or n > MAX_LIGAND_ATOMS:
        raise TopologyError("atom count out of range")
    off = 8
    types = list(blob[off:off + n])
    off += n
    bonds = []
    for _ in range(b):
        i, j = blob[off], blob[off + 1]
        d = int.from_bytes(blob[off + 2:off + 4], "big")
        bonds.append((i, j, d))
        off += 4
    pairs13 = []
    for _ in range(p):
        i, j = blob[off], blob[off + 1]
        d = int.from_bytes(blob[off + 2:off + 4], "big")
        pairs13.append((i, j, d))
        off += 4
    near = []
    for _ in range(n):
        near.append(int.from_bytes(blob[off:off + 8], "big"))
        off += 8
    return {"n_atoms": n, "n_bonds": b, "n_pairs13": p, "nrot": nrot, "types": types,
            "bonds": bonds, "pairs13": pairs13, "near": near}


def tolerance_centi(ideal: int) -> int:
    return TOL_ABS_CENTI + (ideal * TOL_PCT) // 100
