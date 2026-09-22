"""Pockets for every catalog target (SPEC-ENGINE.md sections 2 and 5).

For each target in data/catalog/targets.json: download the RCSB coordinate file into the
cache (.tmp/pipeline/structures/<PDB>.pdb, mmCIF fallback when the PDB format is not
served), then run the reference pocket builder (tools/engine/ref/pocket.py, the same
function the CLI `pocket` subcommand calls) with the catalog's chain, reference ligand CCD
id and authSeqId. The instance on that chain / residue number defines the box.

Output: data/pockets/<PDB>.bin and .tmp/pipeline/pockets-summary.json (one record per
target: atoms, bytes, box, hash, capped, chains, failure reason).

Usage:
  .venv/bin/python tools/pipeline/build_pockets.py [--download-only] [--only KEY,KEY] [--limit N]
The reference builder reads the PDB format only; a target whose entry is served as mmCIF
only is recorded as a failure with that reason (nothing is converted by hand).

Reference instance rule (mechanical, the same for every target):
  1. primary: the CCD instance on the catalog chain with residue number authSeqId
     (the builder's own selection with --chain and --resseq);
  2. fallback: the catalog chain is the protein chain that contacts the ligand, and the
     ligand instance in the file may carry another chain label; then the instance with
     residue number authSeqId whose heavy atoms come within 6.0 A of a CA atom of the
     catalog chain is used (the closest one when several qualify, file order on ties),
     passed to the builder explicitly as --chain <its chain> --resseq authSeqId;
  3. otherwise the target fails with the list of instances found.
Every record stores the instance used and its closest CA distance to the catalog chain.
"""

import argparse
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

from ref.pocket import build_pocket, PocketError  # noqa: E402
from ref.constants import MAX_POCKET_ATOMS  # noqa: E402


CONTACT_A = 6.0


def ligand_instances(text, ccd, catalog_chain):
    """Instances of the CCD in the first model (heavy atoms) and their closest distance
    to a CA atom of the catalog chain. Returns a list of dicts in file order."""
    import math
    inst = {}
    order = []
    ca = []
    for line in text.splitlines():
        rec = line[0:6]
        if rec == "ENDMDL":
            break
        if rec not in ("ATOM  ", "HETATM") or len(line) < 54:
            continue
        element = line[76:78].strip().upper() if len(line) >= 78 else ""
        if element in ("H", "D", "T"):
            continue
        xyz = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
        if rec == "ATOM  " and line[12:16].strip() == "CA" and line[21] == catalog_chain and element != "CA":
            ca.append(xyz)
        if rec == "HETATM" and line[17:20].strip() == ccd.upper():
            k = (line[21], int(line[22:26]), line[26].strip())
            if k not in inst:
                inst[k] = []
                order.append(k)
            inst[k].append(xyz)
    out = []
    for k in order:
        d = None
        for x in inst[k]:
            for c in ca:
                dd = math.sqrt((x[0] - c[0]) ** 2 + (x[1] - c[1]) ** 2 + (x[2] - c[2]) ** 2)
                if d is None or dd < d:
                    d = dd
        out.append({"chain": k[0], "resseq": k[1], "icode": k[2], "atoms": len(inst[k]),
                    "minCaDistA": None if d is None else round(d, 2)})
    return out, len(ca)


def resolve_instance(text, ccd, catalog_chain, auth_seq_id):
    """Apply the reference instance rule. Returns (chain, resseq, mode, instances, chosen)."""
    instances, n_ca = ligand_instances(text, ccd, catalog_chain)
    if not instances:
        return None, None, "not-found", instances, None
    for ins in instances:
        if ins["chain"] == catalog_chain and ins["resseq"] == auth_seq_id:
            return catalog_chain, auth_seq_id, "primary", instances, ins
    cands = [ins for ins in instances if ins["resseq"] == auth_seq_id
             and ins["minCaDistA"] is not None and ins["minCaDistA"] <= CONTACT_A]
    if cands:
        best = min(cands, key=lambda i: i["minCaDistA"])  # min keeps the first on ties
        return best["chain"], best["resseq"], "fallback-contact", instances, best
    return None, None, "no-contact", instances, None


def build_one(t, struct):
    """Run the reference builder for one target. Returns the summary record."""
    pdb = t["pdbId"].upper()
    lig = t["ligand"]
    rec = {
        "key": t["key"], "gene": t["gene"], "pdbId": pdb, "class": t["class"],
        "chain": t["chain"], "ccd": lig["ccd"], "authSeqId": lig["authSeqId"],
        "catalogHeavyAtoms": lig["heavyAtoms"],
        "source": struct["format"], "sourceStatus": struct["status"], "sourceFile": C.rel(struct["path"]) if struct["path"] else None,
        "ok": False, "failure": None,
    }
    if struct["format"] != "pdb":
        if struct["format"] == "cif":
            rec["failure"] = "cif-only: RCSB serves no PDB format file for %s and the reference builder (ref/pocket.py) reads the PDB format only" % pdb
        else:
            rec["failure"] = "download: " + struct["status"]
        return rec
    text = C.read_text(struct["path"])
    chain, resseq, mode, instances, chosen = resolve_instance(text, lig["ccd"], t["chain"], int(lig["authSeqId"]))
    rec["instanceMode"] = mode
    rec["instancesInFile"] = instances
    if chain is None:
        if mode == "not-found":
            rec["failure"] = "reference ligand %s not found in the PDB-format file" % lig["ccd"]
        else:
            rec["failure"] = "reference instance: no %s instance with authSeqId %s contacts chain %s within %.1f A (instances: %s)" % (
                lig["ccd"], lig["authSeqId"], t["chain"], CONTACT_A,
                ", ".join("%s/%d%s %.2f A" % (i["chain"], i["resseq"], i["icode"], i["minCaDistA"] if i["minCaDistA"] is not None else -1)
                          for i in instances))
        return rec
    rec["builderArgs"] = {"id": pdb, "ligand": lig["ccd"], "chain": chain, "resseq": resseq}
    rec["referenceContactA"] = chosen["minCaDistA"]
    try:
        blob, info, ligatoms = build_pocket(text, pdb, lig["ccd"], chain, resseq)
    except PocketError as e:
        rec["failure"] = "PocketError: " + str(e)
        return rec
    except Exception as e:  # anything else the builder raises
        rec["failure"] = "%s: %s" % (type(e).__name__, e)
        rec["traceback"] = traceback.format_exc().splitlines()[-3:]
        return rec
    out = os.path.join(C.POCKETS_DIR, pdb + ".bin")
    C.write_bytes(out, blob)
    rec.update({
        "ok": True,
        "pocket": C.rel(out),
        "hash": info["keccak256"],
        "atoms": info["pocket_atoms"],
        "atomsBeforeCap": info["pocket_atoms_before_cap"],
        "capped": bool(info["capped"]),
        "capLimit": MAX_POCKET_ATOMS,
        "bytes": info["bytes"],
        "center": info["centre_angstrom"],
        "centerMilli": info["centre_milli"],
        "half": info["half_angstrom"],
        "halfCenti": info["half_centi"],
        "grid": info["grid"],
        "referenceInstance": info["reference_instance"],
        "referenceHeavyAtoms": info["reference_heavy_atoms"],
        "referenceHeavyAtomsMatchCatalog": info["reference_heavy_atoms"] == lig["heavyAtoms"],
        "receptorAtomsTotal": info["receptor_atoms_total"],
        "chainsInPocket": info["chains_in_pocket"],
        "typeHistogram": info["type_histogram"],
        "droppedUnknown": info["dropped_unknown"],
    })
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download-only", action="store_true")
    ap.add_argument("--only", help="comma separated target keys")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args(argv)

    targets = C.load_targets()
    if a.only:
        keep = set(a.only.split(","))
        targets = [t for t in targets if t["key"] in keep]
    if a.limit:
        targets = targets[:a.limit]

    t0 = time.time()
    structs = {}
    for i, t in enumerate(targets):
        s = C.fetch_structure(t["pdbId"])
        structs[t["key"]] = s
        C.log("[%3d/%d] %s %s: %s %s" % (i + 1, len(targets), t["key"], t["pdbId"], s["format"], s["status"]))
    C.log("downloads done in %.1f s" % (time.time() - t0))
    if a.download_only:
        return

    records = []
    t1 = time.time()
    for i, t in enumerate(targets):
        rec = build_one(t, structs[t["key"]])
        records.append(rec)
        if rec["ok"]:
            C.log("[%3d/%d] %s %s: %d atoms%s, half %s A, %d bytes, instance %s/%d (%s, CA %.2f A)" % (
                i + 1, len(targets), t["key"], t["pdbId"], rec["atoms"], " (CAPPED)" if rec["capped"] else "",
                rec["half"], rec["bytes"], rec["builderArgs"]["chain"], rec["builderArgs"]["resseq"], rec["instanceMode"],
                rec["referenceContactA"]))
        else:
            C.log("[%3d/%d] %s %s: FAILED %s" % (i + 1, len(targets), t["key"], t["pdbId"], rec["failure"]))
    built = [r for r in records if r["ok"]]
    failed = [r for r in records if not r["ok"]]
    summary = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "builder": "tools/engine/ref/pocket.py build_pocket (same call as `ponchem_engine.py pocket`)",
        "targets": len(records), "built": len(built), "failed": len(failed),
        "capped": sum(1 for r in built if r["capped"]),
        "fallbackInstances": sum(1 for r in built if r.get("instanceMode") == "fallback-contact"),
        "seconds": time.time() - t1,
        "records": records,
    }
    if not a.only and not a.limit:
        C.write_json(C.POCKETS_SUMMARY, summary)
        C.log("summary -> %s" % C.rel(C.POCKETS_SUMMARY))
    C.log("built %d, failed %d, capped %d, %.1f s" % (len(built), len(failed), summary["capped"], summary["seconds"]))


if __name__ == "__main__":
    main()
