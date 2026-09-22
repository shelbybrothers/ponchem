#!/usr/bin/env python
"""Ponchem engine CLI (reference implementation of SPEC-ENGINE.md).

Run with the project venv:
  .venv/bin/python tools/engine/ponchem_engine.py <subcommand> ...

Subcommands
  tables      generate and freeze the lookup tables into data/tables
  topology    SDF -> topology bytes (+ JSON summary)
  pocket      PDB -> pocket bytes (+ JSON summary)
  score       evaluate a pose (geometry proof + integer score)
  fit         fit the ideal ligand geometry onto its crystal coordinates and score it
  dock        Monte Carlo search (float) then integer evaluation of the final pose
  vectors     generate every test vector into data/vectors
  verify      re-evaluate every vector file with the integer scorer
  viewer-json pocket + pose as absolute coordinates for the 3D viewer
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
DEFAULT_TABLES = os.path.join(ROOT, "data", "tables")
DEFAULT_VECTORS = os.path.join(ROOT, "data", "vectors")

from ref import constants as C  # noqa: E402
from ref.keccak import keccak256_hex  # noqa: E402
from ref.tables import write_tables, Tables  # noqa: E402
from ref.topology import build_topology, parse_topology  # noqa: E402
from ref.pocket import build_pocket, parse_pocket  # noqa: E402
from ref.score import evaluate, decode_pose, encode_pose, derived  # noqa: E402


def _read(path, binary=False):
    with open(path, "rb" if binary else "r") as f:
        return f.read()


def _write(path, data, binary=False):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "wb" if binary else "w") as f:
        f.write(data)


def _load_pose(arg):
    """Pose from: a JSON file with pose_flat or pose_hex, a .bin file, or an inline 0x hex string."""
    if arg.startswith("0x"):
        return decode_pose(bytes.fromhex(arg[2:]))
    if arg.endswith(".json"):
        d = json.loads(_read(arg))
        if "pose_flat" in d:
            f = d["pose_flat"]
            return [tuple(f[i:i + 3]) for i in range(0, len(f), 3)]
        return decode_pose(bytes.fromhex(d["pose_hex"][2:]))
    return decode_pose(_read(arg, binary=True))


def cmd_tables(a):
    desc = write_tables(a.out)
    print(json.dumps({k: desc[k] for k in ("gauss1", "gauss2", "sqrt", "tables")}, indent=1))


def cmd_topology(a):
    blob, info = build_topology(_read(a.sdf))
    if a.out:
        _write(a.out, blob, binary=True)
    if a.json:
        _write(a.json, json.dumps(info, indent=1))
    summary = {k: info[k] for k in ("n_atoms", "n_bonds", "n_pairs13", "nrot", "bytes", "keccak256",
                                    "min_dist14_centi", "min_dist4plus_centi", "ideal_passes_clash_floor")}
    summary["types"] = [C.TYPE_NAMES[t] for t in info["types"]]
    summary["hex"] = "0x" + blob.hex()
    print(json.dumps(summary, indent=1))


def cmd_pocket(a):
    chains = a.chains.split(",") if a.chains else None
    blob, info, _lig = build_pocket(_read(a.pdb), a.id, a.ligand, a.chain, a.resseq, chains)
    if a.out:
        _write(a.out, blob, binary=True)
    if a.json:
        _write(a.json, json.dumps(info, indent=1))
    print(json.dumps({k: v for k, v in info.items() if k != "reference_atom_names"}, indent=1))


def cmd_score(a):
    tables = Tables.load(a.tables)
    pk = parse_pocket(_read(a.pocket, binary=True))
    tp = parse_topology(_read(a.topology, binary=True))
    pose = _load_pose(a.pose)
    t0 = time.time()
    res = evaluate(tables, pk, tp, pose, use_grid=a.grid)
    res["seconds"] = time.time() - t0
    if res["code"] == C.OK:
        res["display"] = derived(res["score_milli"], tp["n_atoms"])
    print(json.dumps(res, indent=1))


def _ligand_model(sdf_path):
    import numpy as np
    from ref.search import LigandModel
    tblob, tinfo = build_topology(_read(sdf_path))
    tp = parse_topology(tblob)
    ideal = np.array(tinfo["ideal_coords_tenmilli"]) / 10000.0
    return tblob, tinfo, tp, LigandModel(tp, ideal, tinfo)


def cmd_fit(a):
    import numpy as np
    from ref.search import fit_to_reference, refine, FloatScorer
    from ref.pose import to_centi
    from ref.vectors import _cif_heavy_atom_names
    tables = Tables.load(a.tables)
    pblob, pinfo, lig = build_pocket(_read(a.pdb), a.id, a.ligand, a.chain, a.resseq)
    pk = parse_pocket(pblob)
    tblob, tinfo, tp, lm = _ligand_model(a.sdf)
    names = _cif_heavy_atom_names(a.cif)
    cry = {x["name"]: (x["x"], x["y"], x["z"]) for x in lig}
    missing = [n for n in names if n not in cry]
    if missing:
        raise SystemExit("crystal ligand lacks atoms: %s" % missing)
    cm = pinfo["centre_milli"]
    target = np.array([[(cry[n][k] - cm[k]) / 1000.0 for k in range(3)] for n in names])
    X, r, state = fit_to_reference(lm, target, seed=a.seed, n_iter=a.iters, log=lambda s: print(s, file=sys.stderr))
    pose = to_centi(X)
    res = evaluate(tables, pk, tp, pose)
    out = {"rmsd_to_crystal_angstrom": r, "fit": res, "pose_hex": "0x" + encode_pose(pose).hex()}
    if a.refine:
        pose2, e2, info2 = refine(pk, tp, lm, state, seed=a.seed, n_steps=a.refine, log=lambda s: print(s, file=sys.stderr))
        out["refined"] = evaluate(tables, pk, tp, pose2)
        out["refined_pose_hex"] = "0x" + encode_pose(pose2).hex()
        out["refined_float"] = info2
    fs = FloatScorer(pk, tp)
    out["float_inter_fitted"] = fs.inter(X)
    out["float_inter_crystal"] = fs.inter(target)
    print(json.dumps(out, indent=1))


def cmd_dock(a):
    from ref.search import dock
    tables = Tables.load(a.tables)
    pk = parse_pocket(_read(a.pocket, binary=True))
    tblob, tinfo, tp, lm = _ligand_model(a.sdf)
    t0 = time.time()
    pose, e, info = dock(pk, tp, lm, seed=a.seed, n_starts=a.starts, n_steps=a.steps, log=lambda s: print(s, file=sys.stderr))
    dt = time.time() - t0
    res = evaluate(tables, pk, tp, pose)
    res["display"] = derived(res["score_milli"], tp["n_atoms"]) if res["code"] == C.OK else None
    out = {"search_seconds": dt, "float": info, "integer": res, "pose_hex": "0x" + encode_pose(pose).hex(),
           "pose_flat": [v for xyz in pose for v in xyz], "topology_keccak": tinfo["keccak256"], "pocket_keccak": keccak256_hex(_read(a.pocket, binary=True))}
    if a.out:
        _write(a.out, json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


def cmd_vectors(a):
    from ref.vectors import generate_all
    if not os.path.exists(os.path.join(a.tables, "tables.bin")):
        write_tables(a.tables)
    t0 = time.time()
    index, timings = generate_all(a.out, a.tables, log=lambda s: print(s, file=sys.stderr), dock_steps=a.steps, dock_starts=a.starts)
    print(json.dumps({"files": len(index), "timings_s": timings, "total_s": time.time() - t0}, indent=1))


def cmd_verify(a):
    from ref.vectors import verify_all
    passed, failed = verify_all(a.vectors, a.tables)
    print(json.dumps({"passed": passed, "failed": failed}))
    if failed:
        sys.exit(1)


def cmd_viewer_json(a):
    pk = parse_pocket(_read(a.pocket, binary=True))
    cx, cy, cz = pk["centre_milli"]
    out = {
        "pdb_id": pk["pdb_id"],
        "centre_angstrom": [cx / 1000.0, cy / 1000.0, cz / 1000.0],
        "half_angstrom": [h / 100.0 for h in pk["half"]],
        "pocket_atoms": [{"x": cx / 1000.0 + x / 100.0, "y": cy / 1000.0 + y / 100.0, "z": cz / 1000.0 + z / 100.0,
                          "type": C.TYPE_NAMES[t]} for x, y, z, t in pk["atoms"]],
    }
    if a.topology and a.pose:
        tp = parse_topology(_read(a.topology, binary=True))
        pose = _load_pose(a.pose)
        out["pose_atoms"] = [{"x": cx / 1000.0 + x / 100.0, "y": cy / 1000.0 + y / 100.0, "z": cz / 1000.0 + z / 100.0,
                              "type": C.TYPE_NAMES[tp["types"][i]]} for i, (x, y, z) in enumerate(pose)]
        # minimal SDF (heavy atoms, single bonds) for 3D viewers
        elem = {C.C_H: "C", C.C_P: "C", C.N_P: "N", C.N_D: "N", C.N_A: "N", C.N_DA: "N", C.O_A: "O", C.O_D: "O",
                C.O_DA: "O", C.S_P: "S", C.P_P: "P", C.F_H: "F", C.CL_H: "Cl", C.BR_H: "Br", C.I_H: "I", C.MET_D: "Zn"}
        lines = ["ponchem pose", "  ponchem", "", "%3d%3d  0  0  0  0  0  0  0  0999 V2000" % (len(pose), len(tp["bonds"]))]
        for i, (x, y, z) in enumerate(pose):
            lines.append("%10.4f%10.4f%10.4f %-3s 0  0  0  0  0  0  0  0  0  0  0  0" % (
                cx / 1000.0 + x / 100.0, cy / 1000.0 + y / 100.0, cz / 1000.0 + z / 100.0, elem[tp["types"][i]]))
        for i, j, _d in tp["bonds"]:
            lines.append("%3d%3d  1  0  0  0  0" % (i + 1, j + 1))
        lines += ["M  END", "$$$$"]
        out["pose_sdf"] = "\n".join(lines) + "\n"
    if a.out:
        _write(a.out, json.dumps(out, indent=1))
    else:
        print(json.dumps(out, indent=1))


def main(argv=None):
    p = argparse.ArgumentParser(prog="ponchem_engine", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("tables", help="generate the lookup tables")
    s.add_argument("--out", default=DEFAULT_TABLES)
    s.set_defaults(fn=cmd_tables)

    s = sub.add_parser("topology", help="SDF -> topology bytes")
    s.add_argument("sdf")
    s.add_argument("--out", help="write topology bytes here")
    s.add_argument("--json", help="write the full info JSON here")
    s.set_defaults(fn=cmd_topology)

    s = sub.add_parser("pocket", help="PDB -> pocket bytes")
    s.add_argument("pdb")
    s.add_argument("--id", required=True, help="4-character PDB id")
    s.add_argument("--ligand", required=True, help="CCD id of the reference ligand")
    s.add_argument("--chain", help="chain of the reference ligand instance")
    s.add_argument("--resseq", type=int, help="residue number of the reference ligand instance")
    s.add_argument("--chains", help="comma separated protein chains to keep (default: all)")
    s.add_argument("--out")
    s.add_argument("--json")
    s.set_defaults(fn=cmd_pocket)

    s = sub.add_parser("score", help="evaluate a pose")
    s.add_argument("--pocket", required=True)
    s.add_argument("--topology", required=True)
    s.add_argument("--pose", required=True, help="pose .bin, vector .json, or inline 0x hex")
    s.add_argument("--tables", default=DEFAULT_TABLES)
    s.add_argument("--grid", action="store_true", help="scan through the cell grid instead of all atoms")
    s.set_defaults(fn=cmd_score)

    s = sub.add_parser("fit", help="fit ideal geometry onto crystal coordinates and score")
    s.add_argument("--pdb", required=True)
    s.add_argument("--id", required=True)
    s.add_argument("--ligand", required=True)
    s.add_argument("--chain")
    s.add_argument("--resseq", type=int)
    s.add_argument("--sdf", required=True, help="CCD ideal SDF of the ligand")
    s.add_argument("--cif", required=True, help="CCD cif of the ligand (atom names)")
    s.add_argument("--tables", default=DEFAULT_TABLES)
    s.add_argument("--seed", type=int, default=7)
    s.add_argument("--iters", type=int, default=4000)
    s.add_argument("--refine", type=int, default=0, help="steps of local refinement after the fit")
    s.set_defaults(fn=cmd_fit)

    s = sub.add_parser("dock", help="Monte Carlo search then integer evaluation")
    s.add_argument("--pocket", required=True)
    s.add_argument("--sdf", required=True)
    s.add_argument("--tables", default=DEFAULT_TABLES)
    s.add_argument("--seed", type=int, default=1)
    s.add_argument("--starts", type=int, default=6)
    s.add_argument("--steps", type=int, default=1000)
    s.add_argument("--out")
    s.set_defaults(fn=cmd_dock)

    s = sub.add_parser("vectors", help="generate all test vectors")
    s.add_argument("--out", default=DEFAULT_VECTORS)
    s.add_argument("--tables", default=DEFAULT_TABLES)
    s.add_argument("--steps", type=int, default=1000)
    s.add_argument("--starts", type=int, default=6)
    s.set_defaults(fn=cmd_vectors)

    s = sub.add_parser("verify", help="re-check every vector with the integer scorer")
    s.add_argument("--vectors", default=DEFAULT_VECTORS)
    s.add_argument("--tables", default=DEFAULT_TABLES)
    s.set_defaults(fn=cmd_verify)

    s = sub.add_parser("viewer-json", help="absolute coordinates for the 3D viewer")
    s.add_argument("--pocket", required=True)
    s.add_argument("--topology")
    s.add_argument("--pose")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_viewer_json)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
