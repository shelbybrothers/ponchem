"""Pure-integer evaluation (SPEC-ENGINE.md, section 6).

No numpy, no floats. Every intermediate is a Python int and the algorithm is
written so that a Solidity port (int256 / uint256) and a JS port (Number for
everything below 2^53, BigInt for the weighted sum and the final division)
produce identical results.

Pose: list of N (x, y, z) int16 triples in centi-A relative to the box centre.
Pose bytes: N x (int16 x, int16 y, int16 z), big-endian, 6 bytes per atom.
"""

from .constants import (
    RADIUS_CENTI, HYD_MASK, DON_MASK, ACC_MASK, CUTOFF_R2, TERM_ONE,
    W_G1, W_G2, W_REP, W_HYD, W_HB, NROT_NUM, NROT_DEN,
    HYD_GOOD, HYD_BAD, HB_GOOD, POCKET_REACH_CENTI, CELL_CENTI,
    CLASH_FLOOR_R2, OK, ERR_ATOM_COUNT, ERR_BOX, ERR_BOND, ERR_PAIR13, ERR_CLASH, ERROR_NAMES, tdiv,
)
from .topology import tolerance_centi

INT16_MIN = -32768
INT16_MAX = 32767


# ---- pose encoding ---------------------------------------------------------------------

def encode_pose(pose):
    out = bytearray()
    for x, y, z in pose:
        for v in (x, y, z):
            if v < INT16_MIN or v > INT16_MAX:
                raise ValueError("pose coordinate does not fit int16")
            out += int(v).to_bytes(2, "big", signed=True)
    return bytes(out)


def decode_pose(blob: bytes):
    if len(blob) % 6 != 0:
        raise ValueError("pose bytes length must be a multiple of 6")
    pose = []
    for off in range(0, len(blob), 6):
        x = int.from_bytes(blob[off:off + 2], "big", signed=True)
        y = int.from_bytes(blob[off + 2:off + 4], "big", signed=True)
        z = int.from_bytes(blob[off + 4:off + 6], "big", signed=True)
        pose.append((x, y, z))
    return pose


# ---- per-pair terms ----------------------------------------------------------------------

def hydrophobic_micro(d: int) -> int:
    if d <= HYD_GOOD:
        return TERM_ONE
    if d >= HYD_BAD:
        return 0
    return (HYD_BAD - d) * 10000            # (150 - d) / 100 in micro units, exact


def hbond_micro(d: int) -> int:
    if d <= HB_GOOD:
        return TERM_ONE
    if d >= 0:
        return 0
    return ((-d) * 100000) // 7            # (-d / 70) in micro units, floor (operands positive)


def repulsion_micro(d: int) -> int:
    if d < 0:
        return d * d * 100                  # d^2 in micro-A^2
    return 0


def pair_terms(tables, ta: int, tb: int, r2: int):
    """All intermediates for one pair. Returns None when r2 > CUTOFF_R2 (pair skipped)."""
    if r2 > CUTOFF_R2:
        return None
    r = tables.isqrt(r2)
    d = r - (RADIUS_CENTI[ta] + RADIUS_CENTI[tb])
    g1 = tables.g1(d)
    g2 = tables.g2(d)
    rep = repulsion_micro(d)
    both_hyd = ((HYD_MASK >> ta) & 1) == 1 and ((HYD_MASK >> tb) & 1) == 1
    hyd = hydrophobic_micro(d) if both_hyd else 0
    da = (((DON_MASK >> ta) & 1) == 1 and ((ACC_MASK >> tb) & 1) == 1) or \
         (((ACC_MASK >> ta) & 1) == 1 and ((DON_MASK >> tb) & 1) == 1)
    hb = hbond_micro(d) if da else 0
    e_pico = W_G1 * g1 + W_G2 * g2 + W_REP * rep + W_HYD * hyd + W_HB * hb
    return {"r_centi": r, "d_centi": d, "g1": g1, "g2": g2, "rep": rep, "hyd": hyd, "hb": hb,
            "e_pico": e_pico}


# ---- geometry proof -----------------------------------------------------------------------

def dist2(a, b) -> int:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    dz = a[2] - b[2]
    return dx * dx + dy * dy + dz * dz


def check_geometry(topo, pose, half):
    """Returns (code, detail). Order: atom count, box, bonds, 1-3 pairs, clash floor.
    The first failing check decides the code."""
    n = topo["n_atoms"]
    if len(pose) != n:
        return ERR_ATOM_COUNT, {"expected": n, "got": len(pose)}
    hx, hy, hz = half
    for i, (x, y, z) in enumerate(pose):
        if x < -hx or x > hx or y < -hy or y > hy or z < -hz or z > hz:
            return ERR_BOX, {"atom": i}
    for i, j, ideal in topo["bonds"]:
        r2 = dist2(pose[i], pose[j])
        tol = tolerance_centi(ideal)
        lo = ideal - tol if ideal > tol else 0
        hi = ideal + tol
        if r2 < lo * lo or r2 > hi * hi:
            return ERR_BOND, {"i": i, "j": j, "ideal": ideal, "r2": r2, "lo": lo, "hi": hi}
    for i, j, ideal in topo["pairs13"]:
        r2 = dist2(pose[i], pose[j])
        tol = tolerance_centi(ideal)
        lo = ideal - tol if ideal > tol else 0
        hi = ideal + tol
        if r2 < lo * lo or r2 > hi * hi:
            return ERR_PAIR13, {"i": i, "j": j, "ideal": ideal, "r2": r2, "lo": lo, "hi": hi}
    near = topo["near"]
    for i in range(n):
        mi = near[i]
        for j in range(i + 1, n):
            if (mi >> j) & 1:
                continue
            r2 = dist2(pose[i], pose[j])
            if r2 < CLASH_FLOOR_R2:
                return ERR_CLASH, {"i": i, "j": j, "r2": r2}
    return OK, {}


# ---- intermolecular score -------------------------------------------------------------------

def _accumulate(tables, ta, tb, r2, sums):
    if r2 > CUTOFF_R2:
        return 0
    r = tables.isqrt(r2)
    d = r - (RADIUS_CENTI[ta] + RADIUS_CENTI[tb])
    sums[0] += tables.g1(d)
    sums[1] += tables.g2(d)
    if d < 0:
        sums[2] += d * d * 100
    if ((HYD_MASK >> ta) & 1) and ((HYD_MASK >> tb) & 1):
        sums[3] += hydrophobic_micro(d)
    if (((DON_MASK >> ta) & 1) and ((ACC_MASK >> tb) & 1)) or (((ACC_MASK >> ta) & 1) and ((DON_MASK >> tb) & 1)):
        sums[4] += hbond_micro(d)
    return 1


def score_pose(tables, pocket, topo, pose, use_grid=False):
    """Intermolecular score. pocket/topo are the parsed dicts. Returns a dict with the five
    term sums, e_pico, score_milli and the number of pairs inside the cutoff."""
    types = topo["types"]
    atoms = pocket["atoms"]
    sums = [0, 0, 0, 0, 0]
    pairs = 0
    if not use_grid:
        for a in range(len(pose)):
            xa, ya, za = pose[a]
            ta = types[a]
            for (xp, yp, zp, tp) in atoms:
                dx = xa - xp
                dy = ya - yp
                dz = za - zp
                pairs += _accumulate(tables, ta, tp, dx * dx + dy * dy + dz * dz, sums)
    else:
        hx, hy, hz = pocket["half"]
        nx, ny, nz = pocket["grid"]
        off = pocket["offsets"]
        for a in range(len(pose)):
            xa, ya, za = pose[a]
            ta = types[a]
            cx = (xa + hx + POCKET_REACH_CENTI) // CELL_CENTI
            cy = (ya + hy + POCKET_REACH_CENTI) // CELL_CENTI
            cz = (za + hz + POCKET_REACH_CENTI) // CELL_CENTI
            for ix in range(max(cx - 1, 0), min(cx + 1, nx - 1) + 1):
                for iy in range(max(cy - 1, 0), min(cy + 1, ny - 1) + 1):
                    for iz in range(max(cz - 1, 0), min(cz + 1, nz - 1) + 1):
                        c = (ix * ny + iy) * nz + iz
                        for k in range(off[c], off[c + 1]):
                            xp, yp, zp, tp = atoms[k]
                            dx = xa - xp
                            dy = ya - yp
                            dz = za - zp
                            pairs += _accumulate(tables, ta, tp, dx * dx + dy * dy + dz * dz, sums)
    e_pico = W_G1 * sums[0] + W_G2 * sums[1] + W_REP * sums[2] + W_HYD * sums[3] + W_HB * sums[4]
    nrot = topo["nrot"]
    score_milli = tdiv(e_pico, 100000 * (NROT_DEN + NROT_NUM * nrot))
    return {"sum_g1": sums[0], "sum_g2": sums[1], "sum_rep": sums[2], "sum_hyd": sums[3], "sum_hb": sums[4],
            "e_pico": e_pico, "nrot": nrot, "score_milli": score_milli, "pairs_in_cutoff": pairs}


def evaluate(tables, pocket, topo, pose, use_grid=False):
    """Full on-chain evaluation: geometry proof then score. Returns a dict with 'code',
    'error' (name) and, when code == OK, the score fields."""
    code, detail = check_geometry(topo, pose, pocket["half"])
    out = {"code": code, "error": ERROR_NAMES[code], "detail": detail}
    if code == OK:
        out.update(score_pose(tables, pocket, topo, pose, use_grid))
    return out


# ---- display-only derived numbers ------------------------------------------------------------

def derived(score_milli: int, n_heavy: int):
    import math
    dg = score_milli / 1000.0
    pkd = -dg / 1.36423
    kd_molar = 10.0 ** (-pkd)
    le = -dg / n_heavy if n_heavy else 0.0
    return {"dG_kcal": dg, "pKd": pkd, "Kd_M": kd_molar, "ligand_efficiency": le,
            "note": "display only: pKd = -dG/1.36423 (RT ln10 at 298.15 K), Kd = 10^-pKd, LE = -dG / heavy atoms"}
