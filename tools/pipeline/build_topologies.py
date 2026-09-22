"""Topologies for every catalog ligand (SPEC-ENGINE.md section 4).

For each ligand in data/catalog/ligands.json: read data/ligands/<KEY>.sdf and run the
reference topology builder (tools/engine/ref/topology.py build_topology, the same call as
the CLI `topology` subcommand). Output data/topologies/<KEY>.bin and
.tmp/pipeline/topologies-summary.json (atoms, bonds, pairs13, nrot, bytes, hash, the
catalog's rotatableBonds for comparison, clash-floor sanity of the ideal conformer, and
the failure reason when the builder rejects a ligand: unsupported element, more than 64
atoms, disconnected graph, ...).

Usage: .venv/bin/python tools/pipeline/build_topologies.py
"""

import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

from ref.topology import build_topology, TopologyError, graph_distances  # noqa: E402


def build_one(lig):
    key = lig["key"]
    sdf_path = os.path.join(C.ROOT, lig["file"])
    rec = {
        "key": key, "name": lig["name"], "file": lig["file"], "ccd": lig.get("ccd"),
        "catalogHeavyAtoms": lig["heavyAtoms"], "catalogRotatableBonds": lig.get("rotatableBonds"),
        "ok": False, "failure": None,
    }
    if not os.path.exists(sdf_path):
        rec["failure"] = "missing SDF " + lig["file"]
        return rec
    try:
        blob, info = build_topology(C.read_text(sdf_path))
    except TopologyError as e:
        rec["failure"] = "TopologyError: " + str(e)
        return rec
    except Exception as e:
        rec["failure"] = "%s: %s" % (type(e).__name__, e)
        rec["traceback"] = traceback.format_exc().splitlines()[-3:]
        return rec
    # connectivity: the builder does not reject a disconnected graph by itself; report it
    n = info["n_atoms"]
    dist = graph_distances(n, [(i, j, o) for i, j, o in info["bonds"]])
    disconnected = any(dist[0][j] == 255 for j in range(n))
    if disconnected:
        rec["failure"] = "disconnected: the heavy-atom bond graph has more than one component"
        return rec
    out = os.path.join(C.TOPOLOGIES_DIR, key + ".bin")
    C.write_bytes(out, blob)
    rec.update({
        "ok": True,
        "topology": C.rel(out),
        "hash": info["keccak256"],
        "atoms": n,
        "bonds": info["n_bonds"],
        "pairs13": info["n_pairs13"],
        "nrot": info["nrot"],
        "bytes": info["bytes"],
        "rotatableBonds": info["rotatable_bonds"],
        "explicitHydrogens": info["explicit_hydrogens"],
        "minDist14Centi": info["min_dist14_centi"],
        "minDist4plusCenti": info["min_dist4plus_centi"],
        "idealPassesClashFloor": info["ideal_passes_clash_floor"],
        "atomsMatchCatalog": n == lig["heavyAtoms"],
        "nrotMatchesCatalog": info["nrot"] == lig.get("rotatableBonds"),
        "types": info["types"],
    })
    return rec


def main():
    ligands = C.load_ligands()
    t0 = time.time()
    records = []
    for i, lig in enumerate(ligands):
        rec = build_one(lig)
        records.append(rec)
        if rec["ok"]:
            C.log("[%3d/%d] %s: %d atoms, %d bonds, %d pairs13, nrot %d (catalog %s), %d bytes%s" % (
                i + 1, len(ligands), rec["key"], rec["atoms"], rec["bonds"], rec["pairs13"], rec["nrot"],
                rec["catalogRotatableBonds"], rec["bytes"], "" if rec["idealPassesClashFloor"] else " CLASH-FLOOR-FAIL"))
        else:
            C.log("[%3d/%d] %s: FAILED %s" % (i + 1, len(ligands), rec["key"], rec["failure"]))
    built = [r for r in records if r["ok"]]
    failed = [r for r in records if not r["ok"]]
    summary = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "builder": "tools/engine/ref/topology.py build_topology (same call as `ponchem_engine.py topology`)",
        "ligands": len(records), "built": len(built), "failed": len(failed),
        "nrotDifferences": [{"key": r["key"], "topologyNrot": r["nrot"], "catalogRotatableBonds": r["catalogRotatableBonds"]}
                            for r in built if not r["nrotMatchesCatalog"]],
        "clashFloorFailures": [r["key"] for r in built if not r["idealPassesClashFloor"]],
        "seconds": time.time() - t0,
        "records": records,
    }
    C.write_json(C.TOPOLOGIES_SUMMARY, summary)
    C.log("built %d, failed %d, nrot differences %d, clash-floor failures %d, %.1f s" % (
        len(built), len(failed), len(summary["nrotDifferences"]), len(summary["clashFloorFailures"]), summary["seconds"]))


if __name__ == "__main__":
    main()
