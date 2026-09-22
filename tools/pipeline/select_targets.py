"""Select the registry targets and write data/registry.json and data/registry-reserve.json.

Inputs: data/catalog/targets.json, data/catalog/ligands.json, .tmp/pipeline/pockets-summary.json,
.tmp/pipeline/topologies-summary.json (from build_pockets.py and build_topologies.py),
data/tables/tables.bin.

Selection rule (SPEC.md section 3 cancer groups, applied in this priority):
  (a) drop every target whose pocket the reference builder could not build;
  (a2) drop every target whose pocket holds fewer than MIN_INSIDE_BOX atoms inside its box
      (common.pocket_inside_box). The box is the reference ligand's own volume, so a count
      this low means the receptor atoms the engine can represent are not what the reference
      ligand binds: DNMT1 7SFC (8 inside) has its inhibitor packed against the DNA duplex
      the receptor typing drops, and GPX4 6HKQ (23 inside) loses its catalytic
      selenocysteine. Applied before coverage and class balancing, so a dropped target
      never takes a coverage slot;
  (b) set aside the cofactor-analog entry (ligand.cofactorAnalog true) and the four entries
      whose reference drug is not the target's canonical inhibitor (USP7 9IJU, NUDT1 9GQL,
      EED 7KXT, PIN1 4TNS); they are used only if needed to reach REGISTRY_SIZE;
  (c) coverage: for every cancer group, in SPEC order, take the two best-ranked eligible
      targets carrying that group (fewer when fewer exist);
      rank = X-ray before cryo-EM, lower resolution first, approved-drug reference ligand
      first (DrugBank group "approved"), more heavy atoms in the reference ligand (catalog
      CCD count), then the key (a stable tie-break);
  (d) class balance: no class may hold more than CLASS_CAP_PCT percent of the registry;
  (e) fill the rest by rank, skipping a target when its class is at the cap; if the
      eligible set runs out, the set-aside targets are taken by rank under the same cap.
Registry order: class, then gene (stable sort); target ids 1..N. Ligands: every built
topology in ligands.json order, ids 1..M.

Usage: .venv/bin/python tools/pipeline/select_targets.py
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

from ref.keccak import keccak256_hex  # noqa: E402

REGISTRY_SIZE = 100
CLASS_CAP_PCT = 45
MIN_INSIDE_BOX = 25
NON_CANONICAL = {"9IJU": "USP7", "9GQL": "NUDT1", "7KXT": "EED", "4TNS": "PIN1"}
NAME_MAX = 64


def rank_key(t):
    lig = t["ligand"]
    approved = "approved" in (lig.get("drugGroups") or [])
    return (
        0 if t["method"] == "X-RAY DIFFRACTION" else 1,
        float(t["resolution"]),
        0 if approved else 1,
        -int(lig["heavyAtoms"]),
        t["key"],
    )


def set_aside_reason(t):
    if t["ligand"].get("cofactorAnalog"):
        return "cofactor analog reference ligand"
    if t["pdbId"].upper() in NON_CANONICAL:
        return "reference drug is not the canonical inhibitor"
    return None


def target_entry(t, p, tid):
    name = t["protein"]
    if len(name) > NAME_MAX:
        name = name[:NAME_MAX].rstrip()
    return {
        "id": tid,
        "key": t["key"],
        "gene": t["gene"],
        "pdbId": t["pdbId"].upper(),
        "name": name,
        "cancerBits": C.cancer_bits(t["cancers"]),
        "cancers": list(t["cancers"]),
        "class": t["class"],
        "pocket": p["pocket"],
        "hash": p["hash"],
        "atoms": p["atoms"],
        "bytes": p["bytes"],
        "box": {"center": p["center"], "half": p["half"]},
        "ligandCcd": t["ligand"]["ccd"],
        "resolution": t["resolution"],
        "method": t["method"],
    }


def ligand_entry(l, r, lid):
    return {
        "id": lid,
        "key": l["key"],
        "name": l["name"][:NAME_MAX],
        "topology": r["topology"],
        "hash": r["hash"],
        "atoms": r["atoms"],
        "nrot": r["nrot"],
        "bonds": r["bonds"],
        "pairs13": r["pairs13"],
        "bytes": r["bytes"],
        "file": l["file"],
    }


def select(targets, pockets):
    """Returns (selected keys in pick order, decisions dict key -> reason, notes)."""
    cap = (REGISTRY_SIZE * CLASS_CAP_PCT) // 100
    built = [t for t in targets if t["key"] in pockets and pockets[t["key"]]["ok"]]
    decisions = {}
    for t in targets:
        if t["key"] not in pockets or not pockets[t["key"]]["ok"]:
            decisions[t["key"]] = "dropped (a): pocket not built: " + (pockets.get(t["key"], {}).get("failure") or "no record")
    inside = {}
    thin = []
    buildable = []
    for t in built:
        n_in, n_total = C.pocket_inside_box(pockets[t["key"]]["pocket"])
        inside[t["key"]] = {"inside": n_in, "atoms": n_total}
        if n_in < MIN_INSIDE_BOX:
            decisions[t["key"]] = "dropped (a2): only %d pocket atoms inside the box (of %d in reach), below the floor of %d" % (
                n_in, n_total, MIN_INSIDE_BOX)
            thin.append(t["key"])
        else:
            buildable.append(t)
    aside = {t["key"]: set_aside_reason(t) for t in buildable if set_aside_reason(t)}
    eligible = [t for t in buildable if t["key"] not in aside]
    ranked = sorted(eligible, key=rank_key)
    ranked_aside = sorted([t for t in buildable if t["key"] in aside], key=rank_key)
    picked = []
    seen = set()
    class_count = {}

    def add(t, reason):
        picked.append(t["key"])
        seen.add(t["key"])
        class_count[t["class"]] = class_count.get(t["class"], 0) + 1
        decisions[t["key"]] = reason

    coverage = {}
    for cancer in C.CANCERS:
        carriers = [t for t in ranked if any(C.cancer_bit(c) == C.cancer_bit(cancer) for c in t["cancers"])]
        coverage[cancer] = [t["key"] for t in carriers[:2]]
        for t in carriers[:2]:
            if t["key"] not in seen:
                add(t, "selected (c): coverage of %s" % cancer)
            else:
                decisions[t["key"]] += "; also covers %s" % cancer
    coverage_over_cap = {k: v for k, v in class_count.items() if v > cap}
    skipped_cap = []
    for t in ranked:
        if len(picked) >= REGISTRY_SIZE:
            break
        if t["key"] in seen:
            continue
        if class_count.get(t["class"], 0) >= cap:
            skipped_cap.append(t["key"])
            decisions[t["key"]] = "reserve (d): class %s at the cap of %d" % (t["class"], cap)
            continue
        add(t, "selected (e): rank")
    for t in ranked:
        if t["key"] not in decisions:
            decisions[t["key"]] = "reserve (e): rank below the cut"
    used_aside = []
    if len(picked) < REGISTRY_SIZE:
        for t in ranked_aside:
            if len(picked) >= REGISTRY_SIZE:
                break
            if class_count.get(t["class"], 0) >= cap:
                decisions[t["key"]] = "reserve (b,d): set aside (%s) and class at the cap" % aside[t["key"]]
                continue
            add(t, "selected (b): set aside (%s) but needed to reach %d" % (aside[t["key"]], REGISTRY_SIZE))
            used_aside.append(t["key"])
    for t in ranked_aside:
        if t["key"] not in decisions:
            decisions[t["key"]] = "reserve (b): set aside: " + aside[t["key"]]
    notes = {
        "registrySize": REGISTRY_SIZE, "classCapPct": CLASS_CAP_PCT, "classCap": cap,
        "minInsideBox": MIN_INSIDE_BOX,
        "pocketsBuilt": len(built),
        "droppedThinBox": [{"key": k, "inside": inside[k]["inside"], "atoms": inside[k]["atoms"]} for k in thin],
        "insideBox": inside,
        "buildable": len(buildable), "setAside": aside, "eligible": len(eligible),
        "coverage": coverage, "coverageOverCap": coverage_over_cap,
        "skippedByCap": skipped_cap, "setAsideUsed": used_aside,
        "classCount": class_count, "picked": len(picked),
        "rankOrder": [t["key"] for t in ranked],
    }
    return picked, decisions, notes


def main():
    targets = C.load_targets()
    ligands = C.load_ligands()
    psum = C.read_json(C.POCKETS_SUMMARY)
    tsum = C.read_json(C.TOPOLOGIES_SUMMARY)
    pockets = {r["key"]: r for r in psum["records"]}
    topos = {r["key"]: r for r in tsum["records"]}
    tmap = {t["key"]: t for t in targets}

    picked, decisions, notes = select(targets, pockets)
    notes_thin = notes["droppedThinBox"]
    ordered = sorted(picked, key=lambda k: (tmap[k]["class"], tmap[k]["gene"]))
    reg_targets = [target_entry(tmap[k], pockets[k], i + 1) for i, k in enumerate(ordered)]
    thin_keys = {d["key"] for d in notes["droppedThinBox"]}
    reserve_keys = sorted([t["key"] for t in targets if pockets.get(t["key"], {}).get("ok")
                           and t["key"] not in picked and t["key"] not in thin_keys],
                          key=lambda k: (tmap[k]["class"], tmap[k]["gene"]))
    reserve = []
    for k in reserve_keys:
        e = target_entry(tmap[k], pockets[k], None)
        e["reason"] = decisions[k]
        reserve.append(e)

    reg_ligands = []
    lid = 0
    ligand_failures = []
    for l in ligands:
        r = topos.get(l["key"])
        if not r or not r["ok"]:
            ligand_failures.append({"key": l["key"], "failure": (r or {}).get("failure", "no record")})
            continue
        lid += 1
        reg_ligands.append(ligand_entry(l, r, lid))

    tables_blob = C.read_bytes(C.TABLES_BIN)
    registry = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "targets": reg_targets,
        "ligands": reg_ligands,
        "tables": {"file": C.rel(C.TABLES_BIN), "hash": keccak256_hex(tables_blob), "bytes": len(tables_blob)},
    }
    C.write_json(C.REGISTRY_JSON, registry)
    C.write_json(C.RESERVE_JSON, {"generated": registry["generated"], "targets": reserve})
    notes["decisions"] = decisions
    notes["registryOrder"] = ordered
    notes["ligandFailures"] = ligand_failures
    notes["registryTargets"] = len(reg_targets)
    notes["registryLigands"] = len(reg_ligands)
    notes["reserveTargets"] = len(reserve)
    C.write_json(C.SELECTION_SUMMARY, notes)
    C.log("dropped for a thin box (< %d atoms inside): %s" % (
        notes["minInsideBox"], ", ".join("%s %d" % (d["key"], d["inside"]) for d in notes_thin) or "none"))
    C.log("registry: %d targets, %d ligands, reserve %d; class counts %s; set aside used %s" % (
        len(reg_targets), len(reg_ligands), len(reserve), notes["classCount"], notes["setAsideUsed"]))


if __name__ == "__main__":
    main()
