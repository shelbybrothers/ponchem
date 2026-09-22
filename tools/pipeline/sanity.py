"""Sanity checks on the registry (task 4 of the pipeline brief).

1. Box check: for every registry target, count the pocket atoms whose relative
   coordinates lie inside the box (|x| <= hx, |y| <= hy, |z| <= hz) against the pocket
   total (common.pocket_inside_box, the same count the selection rule uses); a box with
   fewer than BOX_MIN_INSIDE atoms inside is flagged as suspicious.
2. Docking: quercetin (data/ligands/QUERCETIN.sdf) into three registry targets of
   different classes (the first registry entry of each of the three most populous
   classes) with the reference float search through the CLI
   (`ponchem_engine.py dock --starts DOCK_STARTS --steps DOCK_STEPS --seed DOCK_SEED`),
   reporting the integer score of the final pose.
3. Registration bytes and a gas estimate: per registration
   32,000 (create) + 200 per code byte + 16 per calldata byte + 60,000 overhead, with the
   blob counted once as code and once as calldata; summed over targets, ligands, tables.

Output: .tmp/pipeline/sanity-summary.json.
Usage: .venv/bin/python tools/pipeline/sanity.py [--no-dock]
"""

import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

BOX_MIN_INSIDE = 60
DOCK_SEED = 1
DOCK_STARTS = 4
DOCK_STEPS = 1000
DOCK_LIGAND = "QUERCETIN"
GAS_CREATE = 32000
GAS_PER_CODE_BYTE = 200
GAS_PER_CALLDATA_BYTE = 16
GAS_OVERHEAD = 60000


def box_check(entry):
    inside, total = C.pocket_inside_box(entry["pocket"])
    return {"key": entry["key"], "pdbId": entry["pdbId"], "atoms": total, "inside": inside,
            "fraction": round(inside / total, 3) if total else 0.0,
            "suspicious": inside < BOX_MIN_INSIDE}


def dock_command(entry, ligand_key):
    return [C.PYTHON, C.ENGINE_CLI, "dock",
            "--pocket", os.path.join(C.ROOT, entry["pocket"]),
            "--sdf", os.path.join(C.LIGANDS_DIR, ligand_key + ".sdf"),
            "--tables", C.TABLES_DIR,
            "--seed", str(DOCK_SEED), "--starts", str(DOCK_STARTS), "--steps", str(DOCK_STEPS)]


def dock_one(entry, ligand_key):
    cmd = dock_command(entry, ligand_key)
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    wall = time.time() - t0
    rec = {"key": entry["key"], "pdbId": entry["pdbId"], "class": entry["class"], "ligand": ligand_key,
           "command": " ".join(os.path.relpath(c, C.ROOT) if c.startswith(C.ROOT) else c for c in cmd),
           "wallSeconds": round(wall, 1), "returncode": proc.returncode}
    if proc.returncode != 0:
        rec["error"] = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "no stderr"
        return rec
    d = json.loads(proc.stdout)
    integer = d["integer"]
    rec.update({
        "searchSeconds": round(d["search_seconds"], 1),
        "code": integer["code"], "codeName": integer.get("code_name"),
        "scoreMilli": integer.get("score_milli"),
        "display": integer.get("display"),
        "floatAffinity": d["float"].get("float_affinity") if isinstance(d.get("float"), dict) else None,
        "pairsInCutoff": integer.get("pairs_in_cutoff", integer.get("pairs")),
        "poseHex": d["pose_hex"],
        "pocketKeccak": d["pocket_keccak"], "topologyKeccak": d["topology_keccak"],
    })
    return rec


def pick_dock_targets(registry):
    counts = {}
    for t in registry["targets"]:
        counts[t["class"]] = counts.get(t["class"], 0) + 1
    top = sorted(counts, key=lambda c: (-counts[c], c))[:3]
    out = []
    for cls in top:
        out.append(next(t for t in registry["targets"] if t["class"] == cls))
    return out


def gas(nbytes):
    return GAS_CREATE + GAS_PER_CODE_BYTE * nbytes + GAS_PER_CALLDATA_BYTE * nbytes + GAS_OVERHEAD


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-dock", action="store_true", help="skip the three docking runs")
    a = ap.parse_args(argv)
    registry = C.read_json(C.REGISTRY_JSON)

    boxes = [box_check(t) for t in registry["targets"]]
    suspicious = [b for b in boxes if b["suspicious"]]
    C.log("box check: %d targets, %d suspicious (< %d atoms inside)" % (len(boxes), len(suspicious), BOX_MIN_INSIDE))

    t_bytes = sum(t["bytes"] for t in registry["targets"])
    l_bytes = sum(l["bytes"] for l in registry["ligands"])
    tb = registry["tables"]["bytes"]
    g_targets = sum(gas(t["bytes"]) for t in registry["targets"])
    g_ligands = sum(gas(l["bytes"]) for l in registry["ligands"])
    g_tables = gas(tb)
    gas_est = {
        "formula": "per registration: %d create + %d per code byte + %d per calldata byte + %d overhead; the blob counted once as code and once as calldata" % (
            GAS_CREATE, GAS_PER_CODE_BYTE, GAS_PER_CALLDATA_BYTE, GAS_OVERHEAD),
        "targets": {"count": len(registry["targets"]), "bytes": t_bytes, "gas": g_targets},
        "ligands": {"count": len(registry["ligands"]), "bytes": l_bytes, "gas": g_ligands},
        "tables": {"count": 1, "bytes": tb, "gas": g_tables},
        "totalBytes": t_bytes + l_bytes + tb,
        "totalRegistrations": len(registry["targets"]) + len(registry["ligands"]) + 1,
        "totalGas": g_targets + g_ligands + g_tables,
        "largestPocketBytes": max(t["bytes"] for t in registry["targets"]),
        "largestTopologyBytes": max(l["bytes"] for l in registry["ligands"]),
    }
    C.log("registration: %d bytes, gas estimate %d" % (gas_est["totalBytes"], gas_est["totalGas"]))

    docks = []
    if not a.no_dock:
        for t in pick_dock_targets(registry):
            C.log("docking %s into %s %s (%s) ..." % (DOCK_LIGAND, t["key"], t["pdbId"], t["class"]))
            r = dock_one(t, DOCK_LIGAND)
            docks.append(r)
            C.log("  -> code %s score_milli %s in %.1f s" % (r.get("code"), r.get("scoreMilli"), r["wallSeconds"]))

    summary = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "boxMinInside": BOX_MIN_INSIDE,
        "boxes": boxes, "suspiciousBoxes": suspicious,
        "boxInsideMin": min(b["inside"] for b in boxes), "boxInsideMax": max(b["inside"] for b in boxes),
        "gas": gas_est,
        "dock": {"ligand": DOCK_LIGAND, "seed": DOCK_SEED, "starts": DOCK_STARTS, "steps": DOCK_STEPS, "runs": docks},
    }
    C.write_json(C.SANITY_SUMMARY, summary)
    C.log("summary -> %s" % C.rel(C.SANITY_SUMMARY))


if __name__ == "__main__":
    main()
