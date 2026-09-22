"""Test vector generation (SPEC-ENGINE.md, section 8).

Every vector file is flat JSON: bytes as 0x-hex strings, integers as JSON
integers, so that a forge test can read it with vm.readFile + vm.parseJson*
and a node test with JSON.parse (BigInt the e_pico field if you care).
"""

import json
import math
import os
import time

import numpy as np

from . import constants as C
from .keccak import keccak256_hex
from .pocket import build_pocket, parse_pocket, encode_pocket
from .pose import apply_torsions, torsion_sides, to_centi, from_centi
from .score import (pair_terms, evaluate, check_geometry, score_pose, encode_pose, derived)
from .search import LigandModel, fit_to_reference, refine, dock, FloatScorer
from .tables import Tables
from .topology import build_topology, parse_topology

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "fixtures"))


def hexb(b: bytes) -> str:
    return "0x" + b.hex()


# ---- synthetic SDF blocks -------------------------------------------------------------------

def sdf_block(name, atoms, bonds):
    """atoms: [(x, y, z, element)], bonds: [(i, j, order)] 1-based -> V2000 text."""
    lines = [name, "  ponchem-synthetic", ""]
    lines.append("%3d%3d  0  0  0  0  0  0  0  0999 V2000" % (len(atoms), len(bonds)))
    for x, y, z, el in atoms:
        lines.append("%10.4f%10.4f%10.4f %-3s 0  0  0  0  0  0  0  0  0  0  0  0" % (x, y, z, el))
    for i, j, o in bonds:
        lines.append("%3d%3d%3d  0  0  0  0" % (i, j, o))
    lines.append("M  END")
    lines.append("$$$$")
    return "\n".join(lines) + "\n"


def synthetic_ligands():
    out = {}
    # A: methanol  C-O, heavy: C_P, O_DA
    out["methanol"] = sdf_block("methanol", [
        (0.0000, 0.0000, 0.0000, "C"), (1.4300, 0.0000, 0.0000, "O"),
        (-0.36, 0.94, 0.0, "H"), (-0.36, -0.47, 0.82, "H"), (-0.36, -0.47, -0.82, "H"), (1.75, 0.90, 0.0, "H"),
    ], [(1, 2, 1), (1, 3, 1), (1, 4, 1), (1, 5, 1), (2, 6, 1)])
    # B: ethanolamine  N-C-C-O, heavy: N_D, C_P, C_P, O_DA, nrot 1 (C-C)
    out["ethanolamine"] = sdf_block("ethanolamine", [
        (0.0000, 0.0000, 0.0000, "N"), (1.4700, 0.0000, 0.0000, "C"), (1.9900, 1.4400, 0.0000, "C"),
        (3.4200, 1.4400, 0.0000, "O"),
        (-0.35, 0.95, 0.0, "H"), (-0.35, -0.48, 0.82, "H"),
        (1.83, -0.51, 0.89, "H"), (1.83, -0.51, -0.89, "H"),
        (1.63, 1.95, 0.89, "H"), (1.63, 1.95, -0.89, "H"),
        (3.74, 2.33, 0.0, "H"),
    ], [(1, 2, 1), (2, 3, 1), (3, 4, 1), (1, 5, 1), (1, 6, 1), (2, 7, 1), (2, 8, 1), (3, 9, 1), (3, 10, 1), (4, 11, 1)])
    # C: propane  C-C-C, heavy: 3 x C_H, nrot 0
    out["propane"] = sdf_block("propane", [
        (0.0000, 0.0000, 0.0000, "C"), (1.5300, 0.0000, 0.0000, "C"), (2.0400, 1.4400, 0.0000, "C"),
        (-0.36, 1.02, 0.0, "H"), (-0.36, -0.51, 0.88, "H"), (-0.36, -0.51, -0.88, "H"),
        (1.89, -0.51, 0.88, "H"), (1.89, -0.51, -0.88, "H"),
        (3.13, 1.44, 0.0, "H"), (1.68, 1.95, 0.88, "H"), (1.68, 1.95, -0.88, "H"),
    ], [(1, 2, 1), (2, 3, 1), (1, 4, 1), (1, 5, 1), (1, 6, 1), (2, 7, 1), (2, 8, 1), (3, 9, 1), (3, 10, 1), (3, 11, 1)])
    # D: pyridine ring, N at index 1; heavy: N_A, 2 x C_P (ortho), 3 x C_H
    ring = []
    for k in range(6):
        th = math.radians(90 + 60 * k)
        ring.append((round(1.39 * math.cos(th), 4), round(1.39 * math.sin(th), 4), 0.0, "N" if k == 0 else "C"))
    hs = []
    for k in range(1, 6):
        th = math.radians(90 + 60 * k)
        hs.append((round(2.47 * math.cos(th), 4), round(2.47 * math.sin(th), 4), 0.0, "H"))
    bonds = [(1, 2, 2), (2, 3, 1), (3, 4, 2), (4, 5, 1), (5, 6, 2), (6, 1, 1)]
    bonds += [(k + 1, 7 + (k - 1), 1) for k in range(1, 6)]
    out["pyridine"] = sdf_block("pyridine", ring + hs, bonds)
    # E: 1,3-propanediol  O-C-C-C-O, heavy: O_DA, C_P, C_H, C_P, O_DA, nrot 2; all-anti zig-zag
    a = math.radians(110.0)
    p = [np.array([0.0, 0.0, 0.0])]
    dirs = [np.array([1.0, 0.0, 0.0])]
    lengths = [1.43, 1.53, 1.53, 1.43]
    pts = [np.array([0.0, 0.0, 0.0]), np.array([1.43, 0.0, 0.0])]
    ang_dir = 1
    for L in lengths[1:]:
        prev = pts[-1] - pts[-2]
        prev /= np.linalg.norm(prev)
        # rotate prev by (180 - 110) degrees alternately up and down in the xy plane
        phi = ang_dir * (math.pi - a)
        rot = np.array([[math.cos(phi), -math.sin(phi), 0], [math.sin(phi), math.cos(phi), 0], [0, 0, 1]])
        nd = rot @ prev
        pts.append(pts[-1] + L * nd)
        ang_dir = -ang_dir
    els = ["O", "C", "C", "C", "O"]
    atoms = [(round(float(q[0]), 4), round(float(q[1]), 4), round(float(q[2]), 4), e) for q, e in zip(pts, els)]
    hs = [(round(float(pts[0][0]) - 0.3, 4), 0.9, 0.0, "H"),
          (round(float(pts[1][0]), 4), round(float(pts[1][1]) - 0.5, 4), 0.89, "H"), (round(float(pts[1][0]), 4), round(float(pts[1][1]) - 0.5, 4), -0.89, "H"),
          (round(float(pts[2][0]), 4), round(float(pts[2][1]) + 0.5, 4), 0.89, "H"), (round(float(pts[2][0]), 4), round(float(pts[2][1]) + 0.5, 4), -0.89, "H"),
          (round(float(pts[3][0]), 4), round(float(pts[3][1]) - 0.5, 4), 0.89, "H"), (round(float(pts[3][0]), 4), round(float(pts[3][1]) - 0.5, 4), -0.89, "H"),
          (round(float(pts[4][0]) + 0.3, 4), round(float(pts[4][1]) + 0.9, 4), 0.0, "H")]
    bonds = [(1, 2, 1), (2, 3, 1), (3, 4, 1), (4, 5, 1), (1, 6, 1), (2, 7, 1), (2, 8, 1), (3, 9, 1), (3, 10, 1),
             (4, 11, 1), (4, 12, 1), (5, 13, 1)]
    out["propanediol"] = sdf_block("propanediol", atoms + hs, bonds)
    return out


# ---- helpers -------------------------------------------------------------------------------

def case_dict(name, kind, description, pocket_blob, topo_blob, pose, tables, expect=None, extra=None):
    pk = parse_pocket(pocket_blob)
    tp = parse_topology(topo_blob)
    res = evaluate(tables, pk, tp, pose)
    pose_bytes = encode_pose(pose)
    d = {
        "name": name, "kind": kind, "description": description,
        "pocket_hex": hexb(pocket_blob), "pocket_keccak": keccak256_hex(pocket_blob),
        "pocket_atoms": pk["n_atoms"], "half": list(pk["half"]), "grid": list(pk["grid"]),
        "topology_hex": hexb(topo_blob), "topology_keccak": keccak256_hex(topo_blob),
        "ligand_atoms": tp["n_atoms"], "nrot": tp["nrot"],
        "pose_hex": hexb(pose_bytes), "pose_flat": [v for xyz in pose for v in xyz],
        "expect_code": res["code"], "expect_error": res["error"],
    }
    if res["code"] == C.OK:
        d.update({
            "expect_sum_g1": res["sum_g1"], "expect_sum_g2": res["sum_g2"], "expect_sum_rep": res["sum_rep"],
            "expect_sum_hyd": res["sum_hyd"], "expect_sum_hb": res["sum_hb"], "expect_e_pico": res["e_pico"],
            "expect_score_milli": res["score_milli"], "expect_pairs_in_cutoff": res["pairs_in_cutoff"],
            "display": derived(res["score_milli"], tp["n_atoms"]),
        })
        grid = score_pose(tables, pk, tp, pose, use_grid=True)
        assert grid["e_pico"] == res["e_pico"] and grid["pairs_in_cutoff"] == res["pairs_in_cutoff"], name
    else:
        d["expect_detail"] = {k: int(v) for k, v in res["detail"].items()}
    if expect is not None:
        assert res["code"] == expect, "%s: expected %s got %s" % (name, C.ERROR_NAMES[expect], res["error"])
    if extra:
        d.update(extra)
    return d


def write_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)


# ---- term vectors ----------------------------------------------------------------------------

TERM_CASES = [
    (C.C_H, C.C_H, 160000), (C.C_H, C.C_H, 159999), (C.O_DA, C.N_D, 90000), (C.O_A, C.O_A, 90000),
    (C.MET_D, C.O_A, 40000), (C.C_H, C.C_H, 640000), (C.C_H, C.C_H, 640001), (C.N_DA, C.N_DA, 129600),
    (C.N_DA, C.O_A, 129599), (C.C_H, C.F_H, 202500), (C.I_H, C.I_H, 0), (C.C_P, C.C_H, 302500),
    (C.C_H, C.C_H, 250000), (C.C_H, C.C_H, 40000), (C.S_P, C.MET_D, 102400), (C.N_A, C.MET_D, 44100),
    (C.O_DA, C.O_DA, 122500), (C.O_DA, C.O_DA, 108900), (C.C_H, C.C_H, 342225), (C.CL_H, C.BR_H, 156025),
    (C.C_H, C.C_H, 1), (C.P_P, C.O_DA, 250000), (C.N_D, C.N_A, 122500), (C.O_D, C.O_A, 108900),
    (C.C_H, C.C_H, 640000 - 1), (C.MET_D, C.MET_D, 57600), (C.N_P, C.O_A, 90000), (C.C_H, C.I_H, 168100),
    (C.O_A, C.MET_D, 84100), (C.N_D, C.O_A, 16384), (C.N_D, C.O_A, 16383), (C.C_H, C.C_H, 47961),
]


def terms_vector(tables):
    cols = {k: [] for k in ("type_a", "type_b", "r2", "skipped", "r_centi", "d_centi", "g1", "g2", "rep", "hyd", "hb", "e_pico")}
    for ta, tb, r2 in TERM_CASES:
        t = pair_terms(tables, ta, tb, r2)
        cols["type_a"].append(ta)
        cols["type_b"].append(tb)
        cols["r2"].append(r2)
        if t is None:
            cols["skipped"].append(1)
            for k in ("r_centi", "d_centi", "g1", "g2", "rep", "hyd", "hb", "e_pico"):
                cols[k].append(0)
        else:
            cols["skipped"].append(0)
            for k in ("r_centi", "d_centi", "g1", "g2", "rep", "hyd", "hb", "e_pico"):
                cols[k].append(t[k])
    return {
        "name": "terms", "kind": "terms",
        "description": "Per-pair intermediates. r_centi = isqrt(r2); d_centi = r_centi - Ri - Rj; g1/g2 from the tables; "
                       "rep = d*d*100 for d<0; hyd only when both types are hydrophobic; hb only for a donor/acceptor pair; "
                       "e_pico = W_G1*g1 + W_G2*g2 + W_REP*rep + W_HYD*hyd + W_HB*hb. skipped=1 means r2 > 640000 and the pair contributes nothing.",
        "count": len(TERM_CASES), "weights": {"W_G1": C.W_G1, "W_G2": C.W_G2, "W_REP": C.W_REP, "W_HYD": C.W_HYD, "W_HB": C.W_HB},
        "radius_centi": C.RADIUS_CENTI, "hyd_mask": C.HYD_MASK, "don_mask": C.DON_MASK, "acc_mask": C.ACC_MASK,
        **cols,
    }


# ---- main generator -----------------------------------------------------------------------------

def generate_all(out_dir, tables_dir, log=print, dock_steps=1000, dock_starts=6):
    os.makedirs(out_dir, exist_ok=True)
    tables = Tables.load(tables_dir)
    index = []
    timings = {}

    def emit(fname, obj):
        write_json(os.path.join(out_dir, fname), obj)
        index.append({"file": fname, "kind": obj.get("kind"), "name": obj.get("name"),
                      "expect_code": obj.get("expect_code"), "expect_score_milli": obj.get("expect_score_milli")})
        log("wrote %s" % fname)

    # (a) tables checksums
    with open(os.path.join(tables_dir, "tables.json")) as f:
        tdesc = json.load(f)
    emit("tables.json", {
        "name": "tables", "kind": "tables",
        "description": "keccak256 of the frozen table bytes plus spot values; ports must load data/tables/tables.bin and check tables_keccak.",
        "gauss1_keccak": tdesc["gauss1"]["keccak256"], "gauss2_keccak": tdesc["gauss2"]["keccak256"],
        "sqrt_keccak": tdesc["sqrt"]["keccak256"], "tables_keccak": tdesc["tables"]["keccak256"],
        "gauss1_bytes": tdesc["gauss1"]["bytes"], "gauss2_bytes": tdesc["gauss2"]["bytes"],
        "sqrt_bytes": tdesc["sqrt"]["bytes"], "tables_bytes": tdesc["tables"]["bytes"],
        "d_min": C.D_MIN, "d_max": C.D_MAX,
        "spot_d": [-440, -200, -100, -50, -1, 0, 1, 20, 50, 100, 150, 190, 200, 300, 420, 560],
        "spot_g1": [tables.g1(d) for d in [-440, -200, -100, -50, -1, 0, 1, 20, 50, 100, 150, 190, 200, 300, 420, 560]],
        "spot_g2": [tables.g2(d) for d in [-440, -200, -100, -50, -1, 0, 1, 20, 50, 100, 150, 190, 200, 300, 420, 560]],
        "spot_r2": [0, 1, 255, 256, 16383, 16384, 159999, 160000, 640000],
        "spot_isqrt": [tables.isqrt(v) for v in [0, 1, 255, 256, 16383, 16384, 159999, 160000, 640000]],
    })

    # (b) term vectors
    emit("terms.json", terms_vector(tables))

    # (c) synthetic cases
    sdfs = synthetic_ligands()
    topos = {}
    for k, text in sdfs.items():
        blob, info = build_topology(text)
        topos[k] = (blob, info, parse_topology(blob))
        with open(os.path.join(out_dir, "synthetic_%s.sdf" % k), "w") as f:
            f.write(text)
    half = (600, 600, 600)
    centre = (0, 0, 0)

    def ideal_pose(info, shift=(0, 0, 0)):
        c = np.array(info["ideal_coords_tenmilli"], dtype=float) / 100.0
        return [(int(round(x)) + shift[0], int(round(y)) + shift[1], int(round(z)) + shift[2]) for x, y, z in c]

    # syn 01: methanol, one pocket atom -> two pairs, fully hand-checkable
    p1 = encode_pocket("SYN1", centre, half, [(-400, 0, 0, C.C_H)])
    blob, info, tp = topos["methanol"]
    pose = ideal_pose(info)
    emit("syn_01_methanol_one_pocket_atom.json", case_dict(
        "syn_01", "synthetic",
        "Methanol heavy atoms C(0,0,0) O(143,0,0) against one C_H pocket atom at (-400,0,0). Pair C..P: r2=160000, r=400, "
        "d=400-380=20: g1=852144 g2=140858 rep=0 hyd=1000000 (C_P is not hydrophobic, so hyd applies only if both are; here the ligand C is C_P: hyd=0). "
        "See expect_* for the exact sums; nrot=0 so score_milli = tdiv(e_pico, 1e9).",
        p1, blob, pose, tables, expect=C.OK,
        extra={"types": info["types"], "type_names": [C.TYPE_NAMES[t] for t in info["types"]]}))

    # syn 02: ethanolamine, pocket of 4 atoms, nrot 1
    p2 = encode_pocket("SYN2", centre, half, [
        (-100, 280, 0, C.O_A),      # acceptor 2.97 A from N (0,0,0)
        (199, 144, 360, C.C_H),     # above C2
        (342, 144, -290, C.MET_D),  # metal 2.90 A below O
        (500, -300, 100, C.C_H),
    ])
    blob, info, tp = topos["ethanolamine"]
    pose = ideal_pose(info)
    emit("syn_02_ethanolamine_four_pocket_atoms.json", case_dict(
        "syn_02", "synthetic",
        "Ethanolamine N-C-C-O (N_D, C_P, C_P, O_DA), nrot=1 so the final division uses 10000+585=10585. Pocket: an O_A acceptor near N, "
        "a C_H above the chain, a Met_D below the hydroxyl, a far C_H. Exercises hbond in both directions and the metal donor.",
        p2, blob, pose, tables, expect=C.OK,
        extra={"types": info["types"], "type_names": [C.TYPE_NAMES[t] for t in info["types"]]}))

    # syn 03: propane, hydrophobic wall
    p3 = encode_pocket("SYN3", centre, half, [(0, -380, 0, C.C_H), (153, -380, 0, C.C_H), (204, -380, 150, C.C_H), (100, 0, 390, C.C_H)])
    blob, info, tp = topos["propane"]
    pose = ideal_pose(info)
    emit("syn_03_propane_hydrophobic_wall.json", case_dict(
        "syn_03", "synthetic",
        "Propane (3 x C_H) over four C_H atoms at ~3.8 A: hydrophobic term saturates (d <= 50) on the close pairs, gauss1 near 1.",
        p3, blob, pose, tables, expect=C.OK,
        extra={"types": info["types"], "type_names": [C.TYPE_NAMES[t] for t in info["types"]]}))

    # syn 04: pyridine with a donor on the N lone pair and two stacking carbons
    p4 = encode_pocket("SYN4", centre, half, [(0, 429, 0, C.N_D), (0, 0, 360, C.C_H), (120, 0, -360, C.C_H)])
    blob, info, tp = topos["pyridine"]
    pose = ideal_pose(info)
    emit("syn_04_pyridine_donor_and_stack.json", case_dict(
        "syn_04", "synthetic",
        "Pyridine ring (N_A, 2 x C_P, 3 x C_H), nrot=0, three para pairs at graph distance 3 (clash floor checked). "
        "Pocket: N_D donor 2.90 A from the ring N along the lone pair, two C_H at 3.6 A above and below the ring.",
        p4, blob, pose, tables, expect=C.OK,
        extra={"types": info["types"], "type_names": [C.TYPE_NAMES[t] for t in info["types"]]}))

    # syn 05: propanediol all-anti, small pocket
    p5 = encode_pocket("SYN5", centre, half, [(150, -300, 0, C.O_DA), (300, 300, 100, C.N_D), (0, 0, -400, C.C_H)])
    blob, info, tp = topos["propanediol"]
    pose = ideal_pose(info)
    emit("syn_05_propanediol_anti.json", case_dict(
        "syn_05", "synthetic",
        "1,3-propanediol O-C-C-C-O all-anti (O_DA, C_P, C_H, C_P, O_DA), nrot=2 (denominator 10000+1170). Pocket: O_DA, N_D, C_H.",
        p5, blob, pose, tables, expect=C.OK,
        extra={"types": info["types"], "type_names": [C.TYPE_NAMES[t] for t in info["types"]]}))

    # (e) reject cases
    blob, info, tp = topos["ethanolamine"]
    base = ideal_pose(info)
    emit("rej_01_box.json", case_dict(
        "rej_01_box", "reject", "Ethanolamine shifted so the hydroxyl O sits at x=601 > hx=600: BOX (code 2).",
        p2, blob, [(x + 259, y, z) for x, y, z in base], tables, expect=C.ERR_BOX))
    bent = list(base)
    bent[2] = (base[2][0] + 40, base[2][1], base[2][2])
    bent[3] = (base[3][0] + 40, base[3][1], base[3][2])
    emit("rej_02_bond.json", case_dict(
        "rej_02_bond", "reject", "C2 and O moved +0.40 A in x: the C1-C2 bond becomes 1.71 A against ideal 1.53 A, tolerance 6+3=9 centi: BOND (code 3).",
        p2, blob, bent, tables, expect=C.ERR_BOND))
    # pair13: rotate O about C2 in the plane so C2-O keeps 1.43 A but the C1-C2-O angle collapses to ~50 degrees
    c2 = np.array(base[2], dtype=float)
    c1 = np.array(base[1], dtype=float)
    v = (c1 - c2) / np.linalg.norm(c1 - c2)
    ang = math.radians(50.0)
    rot = np.array([[math.cos(ang), -math.sin(ang), 0], [math.sin(ang), math.cos(ang), 0], [0, 0, 1]])
    o_new = c2 + 143.0 * (rot @ v)
    p13 = list(base)
    p13[3] = (int(round(o_new[0])), int(round(o_new[1])), int(round(o_new[2])))
    emit("rej_03_pair13.json", case_dict(
        "rej_03_pair13", "reject", "Hydroxyl O rotated to a C1-C2-O angle of 50 degrees with the C2-O bond length kept: the C1..O 1-3 distance is off: PAIR13 (code 4).",
        p2, blob, p13, tables, expect=C.ERR_PAIR13))
    # clash: propanediol cis-cis conformer (both torsions rotated by 180 degrees): O..O at graph distance 4 comes to ~1.7 A
    blob5, info5, tp5 = topos["propanediol"]
    X0 = np.array(info5["ideal_coords_tenmilli"], dtype=float) / 10000.0
    sides = torsion_sides(tp5["n_atoms"], [(i, j) for i, j, _d in tp5["bonds"]], [tuple(b) for b in info5["rotatable_bonds"]])
    Xc = apply_torsions(X0, sides, [math.pi, math.pi])
    clash_pose = to_centi(Xc)
    emit("rej_04_clash.json", case_dict(
        "rej_04_clash", "reject", "Propanediol with both torsions turned by 180 degrees (cis-cis): bonds and 1-3 distances are intact, the terminal O..O pair (graph distance 4) is below 2.20 A: CLASH (code 5).",
        p5, blob5, clash_pose, tables, expect=C.ERR_CLASH))
    emit("rej_05_atom_count.json", case_dict(
        "rej_05_atom_count", "reject", "Ethanolamine pose with three atoms instead of four: ATOM_COUNT (code 1).",
        p2, blob, base[:3], tables, expect=C.ERR_ATOM_COUNT))

    # (d) real cases: 1M17 + AQ4 / QUE / TA1
    with open(os.path.join(FIXTURES, "1M17.pdb")) as f:
        pdb_text = f.read()
    pblob, pinfo, lig = build_pocket(pdb_text, "1M17", "AQ4")
    pk = parse_pocket(pblob)
    prov = {
        "pdb_id": "1M17", "reference_ligand": "AQ4",
        "pdb_source": "https://files.rcsb.org/download/1M17.pdb",
        "entry_title": "Epidermal Growth Factor Receptor tyrosine kinase domain with 4-anilinoquinazoline inhibitor erlotinib",
        "method": "X-RAY DIFFRACTION", "resolution_angstrom": 2.6, "organism": "Homo sapiens",
        "metadata_source": "https://data.rcsb.org/rest/v1/core/entry/1M17 and /core/polymer_entity/1M17/1 (fetched 2026-09-22)",
        "pocket_info": {k: v for k, v in pinfo.items() if k != "reference_atom_names"},
    }
    tblob, tinfo = build_topology(open(os.path.join(FIXTURES, "AQ4_ideal.sdf")).read())
    tp = parse_topology(tblob)
    names = _cif_heavy_atom_names(os.path.join(FIXTURES, "AQ4.cif"))
    cry = {a["name"]: (a["x"], a["y"], a["z"]) for a in lig}
    centre_m = pinfo["centre_milli"]
    target = np.array([[(cry[n][k] - centre_m[k]) / 1000.0 for k in range(3)] for n in names])
    ideal = np.array(tinfo["ideal_coords_tenmilli"]) / 10000.0
    lm = LigandModel(tp, ideal, tinfo)
    t0 = time.time()
    Xfit, r_fit, state = fit_to_reference(lm, target, seed=7, n_iter=4000, log=log)
    timings["fit_AQ4_s"] = time.time() - t0
    pose_fit = to_centi(Xfit)
    fs = FloatScorer(pk, tp)
    aq4_prov = dict(prov)
    aq4_prov.update({"ligand_sdf_source": "https://files.rcsb.org/ligands/download/AQ4_ideal.sdf",
                     "ligand_cif_source": "https://files.rcsb.org/ligands/download/AQ4.cif",
                     "ligand_name": "[6,7-BIS(2-METHOXY-ETHOXY)QUINAZOLINE-4-YL]-(3-ETHYNYLPHENYL)AMINE (erlotinib)",
                     "ligand_formula": "C22 H23 N3 O4", "pubchem_cid": 176870,
                     "ligand_metadata_source": "https://data.rcsb.org/rest/v1/core/chemcomp/AQ4"})
    t0 = time.time()
    emit("real_01_1M17_AQ4_crystal_fit.json", case_dict(
        "real_01_1M17_AQ4_crystal_fit", "real",
        "EGFR kinase (1M17) pocket with erlotinib (AQ4): the CCD ideal geometry fitted onto the crystal ligand coordinates by torsion "
        "search plus superposition (rmsd_to_crystal_angstrom). Passes the geometry proof; the raw crystal geometry does not (see rej_06).",
        pblob, tblob, pose_fit, tables, expect=C.OK,
        extra={"provenance": aq4_prov, "rmsd_to_crystal_angstrom": r_fit,
               "float_inter_kcal": fs.inter(Xfit), "float_affinity_kcal": fs.affinity(Xfit),
               "crystal_pose_flat": [v for xyz in to_centi(target) for v in xyz]}))
    timings["score_AQ4_fit_s"] = time.time() - t0
    # refined
    t0 = time.time()
    pose_ref, e_ref, rinfo = refine(pk, tp, lm, state, seed=11, n_steps=800, log=log)
    timings["refine_AQ4_s"] = time.time() - t0
    Xref = from_centi(pose_ref)
    emit("real_02_1M17_AQ4_refined.json", case_dict(
        "real_02_1M17_AQ4_refined", "real",
        "Same pocket and ligand; the fitted crystal pose locally optimised (small-move Monte Carlo on the float objective). "
        "Shows the score a search reaches from the crystal pose.",
        pblob, tblob, pose_ref, tables, expect=C.OK,
        extra={"provenance": aq4_prov, "rmsd_to_crystal_angstrom": float(np.sqrt(((Xref - target) ** 2).sum(axis=1).mean())),
               "float_inter_kcal": rinfo["float_inter"], "float_affinity_kcal": rinfo["float_affinity"]}))
    # crystal geometry reject
    emit("rej_06_1M17_AQ4_crystal_geometry.json", case_dict(
        "rej_06_1M17_AQ4_crystal_geometry", "reject",
        "The raw crystal coordinates of AQ4 from 1M17 (2.6 A) in topology order: bond lengths differ from the CCD ideal by up to 0.16 A, "
        "so the pose fails the BOND check (code 3). Informational: shows why poses must carry the ideal geometry.",
        pblob, tblob, to_centi(target), tables, expect=C.ERR_BOND,
        extra={"provenance": aq4_prov, "score_if_geometry_were_ignored_milli": score_pose(tables, pk, tp, to_centi(target))["score_milli"]}))

    # docked quercetin and paclitaxel
    for ccd, fname, desc, meta in (
        ("QUE", "real_03_1M17_QUE_docked.json",
         "Quercetin (QUE) docked into the 1M17 pocket by the reference Monte Carlo search (seeded). Numerical vector; the pose is what the search found.",
         {"ligand_name": "3,5,7,3',4'-PENTAHYDROXYFLAVONE (quercetin)", "ligand_formula": "C15 H10 O7", "pubchem_cid": 5280343}),
        ("TA1", "real_04_1M17_TA1_docked.json",
         "Paclitaxel (TA1, 62 heavy atoms, 14 rotatable bonds) docked into the 1M17 pocket by the reference search. Numerical vector only: "
         "a large flexible ligand on a real pocket; no biological claim (paclitaxel is a tubulin binder).",
         {"ligand_name": "TAXOL (paclitaxel)", "ligand_formula": "C47 H51 N O14", "pubchem_cid": 36314}),
    ):
        tb, ti = build_topology(open(os.path.join(FIXTURES, "%s_ideal.sdf" % ccd)).read())
        tpp = parse_topology(tb)
        ideal = np.array(ti["ideal_coords_tenmilli"]) / 10000.0
        lmm = LigandModel(tpp, ideal, ti)
        t0 = time.time()
        pose_d, e_d, dinfo = dock(pk, tpp, lmm, seed=3, n_starts=dock_starts, n_steps=dock_steps, log=log)
        timings["dock_%s_s" % ccd] = time.time() - t0
        p = dict(prov)
        p.update(meta)
        p.update({"ligand_sdf_source": "https://files.rcsb.org/ligands/download/%s_ideal.sdf" % ccd,
                  "ligand_metadata_source": "https://data.rcsb.org/rest/v1/core/chemcomp/%s" % ccd})
        t0 = time.time()
        emit(fname, case_dict(fname[:-5], "real", desc, pblob, tb, pose_d, tables, expect=C.OK,
                              extra={"provenance": p, "float_inter_kcal": dinfo["float_inter"],
                                     "float_affinity_kcal": dinfo["float_affinity"], "search": {"seed": 3, "starts": dock_starts, "steps": dock_steps}}))
        timings["score_%s_s" % ccd] = time.time() - t0

    write_json(os.path.join(out_dir, "index.json"), {
        "format": "ponchem-vectors-v1",
        "description": "Each file is one case. Bytes are 0x-hex. expect_code 0 means the pose passes the geometry proof and expect_* carry the score; "
                       "otherwise expect_error names the first failing check in the order ATOM_COUNT, BOX, BOND, PAIR13, CLASH.",
        "codes": {str(i): n for i, n in enumerate(C.ERROR_NAMES)},
        "files": index, "timings_s": timings,
    })
    return index, timings


def _cif_heavy_atom_names(path):
    names = []
    inloop = False
    with open(path) as f:
        for l in f:
            l = l.rstrip("\n")
            if l.startswith("_chem_comp_atom."):
                inloop = True
                continue
            if inloop:
                if l.startswith("#") or l.startswith("_") or l.startswith("loop_"):
                    if names:
                        inloop = False
                    continue
                t = l.split()
                if len(t) >= 17 and t[3].upper() not in ("H", "D", "T"):
                    names.append(t[1].strip('"'))
    return names


def verify_all(vec_dir, tables_dir, log=print):
    """Re-evaluate every case file with the integer scorer; returns (passed, failed)."""
    tables = Tables.load(tables_dir)
    with open(os.path.join(vec_dir, "index.json")) as f:
        index = json.load(f)
    passed = failed = 0
    for entry in index["files"]:
        with open(os.path.join(vec_dir, entry["file"])) as f:
            case = json.load(f)
        kind = case.get("kind")
        if kind == "tables":
            with open(os.path.join(tables_dir, "tables.bin"), "rb") as f:
                ok = keccak256_hex(f.read()) == case["tables_keccak"]
        elif kind == "terms":
            ok = True
            for k in range(case["count"]):
                t = pair_terms(tables, case["type_a"][k], case["type_b"][k], case["r2"][k])
                if t is None:
                    ok = ok and case["skipped"][k] == 1
                else:
                    ok = ok and all(t[f] == case[f][k] for f in ("r_centi", "d_centi", "g1", "g2", "rep", "hyd", "hb", "e_pico"))
        else:
            pk = parse_pocket(bytes.fromhex(case["pocket_hex"][2:]))
            tp = parse_topology(bytes.fromhex(case["topology_hex"][2:]))
            pose = [tuple(case["pose_flat"][i:i + 3]) for i in range(0, len(case["pose_flat"]), 3)]
            res = evaluate(tables, pk, tp, pose, use_grid=True)
            ok = res["code"] == case["expect_code"]
            if ok and res["code"] == C.OK:
                ok = all(res[f] == case["expect_" + f] for f in ("sum_g1", "sum_g2", "sum_rep", "sum_hyd", "sum_hb", "e_pico", "score_milli", "pairs_in_cutoff"))
            ok = ok and keccak256_hex(bytes.fromhex(case["pocket_hex"][2:])) == case["pocket_keccak"]
            ok = ok and keccak256_hex(bytes.fromhex(case["topology_hex"][2:])) == case["topology_keccak"]
        log("%s %s" % ("PASS" if ok else "FAIL", entry["file"]))
        if ok:
            passed += 1
        else:
            failed += 1
    return passed, failed
