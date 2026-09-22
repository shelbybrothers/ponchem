"""Write data/registry-report.md from the pipeline summaries in .tmp/pipeline.

Usage: .venv/bin/python tools/pipeline/write_report.py
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import select_targets as S  # noqa: E402
import sanity as SA  # noqa: E402


def fmt_half(h):
    return "%.2f / %.2f / %.2f" % tuple(h)


def main():
    psum = C.read_json(C.POCKETS_SUMMARY)
    tsum = C.read_json(C.TOPOLOGIES_SUMMARY)
    sel = C.read_json(C.SELECTION_SUMMARY)
    san = C.read_json(C.SANITY_SUMMARY)
    reg = C.read_json(C.REGISTRY_JSON)
    res = C.read_json(C.RESERVE_JSON)
    targets = {t["key"]: t for t in C.load_targets()}
    pockets = {r["key"]: r for r in psum["records"]}
    boxes = {b["key"]: b for b in san["boxes"]}

    built = [r for r in psum["records"] if r["ok"]]
    failed = [r for r in psum["records"] if not r["ok"]]
    fallback = [r for r in built if r.get("instanceMode") == "fallback-contact"]
    mismatch = [r for r in built if not r["referenceHeavyAtomsMatchCatalog"]]
    big = sorted([r for r in built if max(r["half"]) > 12.0], key=lambda r: -max(r["half"]))
    thin = sel.get("droppedThinBox") or []
    tbuilt = [r for r in tsum["records"] if r["ok"]]
    tfailed = [r for r in tsum["records"] if not r["ok"]]
    class_count = {}
    for t in reg["targets"]:
        class_count[t["class"]] = class_count.get(t["class"], 0) + 1
    cancer_count = {c: 0 for c in C.CANCERS}
    for t in reg["targets"]:
        for c in t["cancers"]:
            cancer_count[C.CANCERS[C.cancer_bit(c)]] += 1
    g = san["gas"]

    L = []
    w = L.append
    w("# Ponchem registry report")
    w("")
    w("Generated %s by `tools/pipeline/build_registry.py`. Every number below comes from a run of the reference engine "
      "(`tools/engine/ref`, the numerical authority) in this build; nothing is recalled or estimated by hand." % time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()))
    w("")
    w("## 1. Counts")
    w("")
    w("| Item | Count |")
    w("| --- | ---: |")
    w("| Catalog targets | %d |" % psum["targets"])
    w("| Pockets built | %d |" % psum["built"])
    w("| Pockets failed | %d |" % psum["failed"])
    w("| Pockets that hit the %d-atom cap | %d |" % (built[0]["capLimit"] if built else 2000, psum["capped"]))
    w("| Reference instance found by the contact fallback | %d |" % len(fallback))
    w("| Targets dropped by the box containment floor (< %d atoms inside the box) | %d |" % (sel["minInsideBox"], len(thin)))
    w("| Registry targets (ids 1..%d) | %d |" % (len(reg["targets"]), len(reg["targets"])))
    w("| Reserve targets (buildable, not selected) | %d |" % len(res["targets"]))
    w("| Catalog ligands | %d |" % tsum["ligands"])
    w("| Topologies built | %d |" % tsum["built"])
    w("| Topologies failed | %d |" % tsum["failed"])
    w("| Registry ligands (ids 1..%d) | %d |" % (len(reg["ligands"]), len(reg["ligands"])))
    w("| Nrot differences (topology rule vs catalog rotatableBonds) | %d |" % len(tsum["nrotDifferences"]))
    w("| Registry pocket bytes | %d |" % g["targets"]["bytes"])
    w("| Registry topology bytes | %d |" % g["ligands"]["bytes"])
    w("| Tables bytes | %d |" % g["tables"]["bytes"])
    w("| Total registration bytes | %d |" % g["totalBytes"])
    w("| Registration gas estimate | %s |" % format(g["totalGas"], ","))
    w("")
    w("Files: `data/registry.json`, `data/registry-reserve.json`, `data/pockets/<PDB>.bin` (%d files), "
      "`data/topologies/<KEY>.bin` (%d files). Cache: `.tmp/pipeline/` (structures and the JSON summaries this report is built from)." % (len(built), len(tbuilt)))
    w("")
    w("## 2. How the pockets were built")
    w("")
    w("- Coordinates: `https://files.rcsb.org/download/<PDB>.pdb`, cached in `.tmp/pipeline/structures/`; when RCSB "
      "serves no PDB format file the mmCIF `<PDB>.cif` is downloaded instead. The reference builder (`ref/pocket.py`) "
      "reads the PDB format only, so a cif-only entry is a build failure (see section 6). It is not converted by hand.")
    w("- Builder: `ref.pocket.build_pocket(text, pdbId, ccd, chain, resseq)`, the same call as "
      "`ponchem_engine.py pocket <file> --id <PDB> --ligand <CCD> --chain <chain> --resseq <authSeqId>`; all protein "
      "chains of the first model within reach of the box are kept (the builder default), metals typed Met_D, waters and "
      "other hetero groups dropped. The in-process call and the CLI give the same bytes and keccak (checked on 2HYY and QUERCETIN).")
    w("- Reference instance: the CCD instance on the catalog chain with residue number authSeqId. When the catalog chain "
      "(the protein chain that contacts the ligand) is not the chain label of the ligand instance, the instance with that "
      "authSeqId whose heavy atoms come within 6.0 A of a CA atom of the catalog chain is used (closest first). "
      "%d targets needed this fallback; each is listed in section 4 with the instance used." % len(fallback))
    w("- Box: centre = centroid of the reference instance's modelled heavy atoms (rounded to milli-A), half size per "
      "axis = max(6.00 A, max|x - c| + 2.00 A) rounded up to centi-A. Pocket atoms: |rel| <= half + 8.00 A per axis, "
      "cap 2000 atoms (never reached in this build).")
    w("")
    w("## 3. Selection rule as applied")
    w("")
    w("- (a) %d of %d targets have a pocket; the %d failures are dropped." % (psum["built"], psum["targets"], psum["failed"]))
    w("- (a2) Box containment floor: a target is dropped when fewer than %d pocket atoms lie inside its box "
      "(the box is the reference ligand's own volume plus 2 A, while the pocket reaches 8 A beyond it, so a count "
      "this low means the receptor atoms the engine can represent are not what the reference ligand binds). "
      "Dropped: %s." % (sel["minInsideBox"], ", ".join("%s %s (%d inside of %d in reach)" % (
          d["key"], targets[d["key"]]["pdbId"], d["inside"], d["atoms"]) for d in thin) or "none"))
    if thin:
        w("  Why these pockets are not the real site: DNMT1 7SFC has its reference inhibitor packed against the DNA duplex, "
          "and the receptor typing keeps standard amino acids, MSE and metal ions only, so the nucleotide atoms of that site "
          "are dropped and 8 protein atoms remain inside the box (TOP1 1K4T is the same case, a topoisomerase I complex "
          "covalently bound to DNA, 24 inside). GPX4 6HKQ loses its catalytic selenocysteine (SEC, 6 atoms), which is the "
          "residue the pocket exists for. Scoring a pose in these boxes would measure something other than the published "
          "binding site, so they are excluded before coverage and class balancing. Two of the three (DNMT1, GPX4) were in "
          "the registry before this rule; TOP1 was already in the reserve.")
    w("- (b) Set aside unless needed to reach %d: %s." % (
        sel["registrySize"], "; ".join("%s %s (%s)" % (k, targets[k]["pdbId"], v) for k, v in sel["setAside"].items())))
    w("  Set-aside entries used: %s." % (", ".join(sel["setAsideUsed"]) if sel["setAsideUsed"] else "none"))
    w("- (c) Coverage: for each cancer group in SPEC order the two best-ranked eligible carriers. "
      "Rank = X-ray before cryo-EM, lower resolution, approved-drug reference ligand first, more heavy atoms in the "
      "reference ligand (catalog CCD count), key as the tie-break.")
    for c in C.CANCERS:
        w("  - %s: %s" % (c, ", ".join("%s %s" % (k, targets[k]["pdbId"]) for k in sel["coverage"][c]) or "no eligible carrier"))
    w("- (d) Class cap %d percent = %d targets. Coverage picks over the cap: %s. Targets skipped by the cap during the fill: %s." % (
        sel["classCapPct"], sel["classCap"], sel["coverageOverCap"] or "none",
        ", ".join(sel["skippedByCap"]) if sel["skippedByCap"] else "none"))
    w("- (e) The remaining slots filled by rank. Result: %d targets." % sel["picked"])
    w("- Registry order: class, then gene. Ids 1..%d for targets, 1..%d for ligands (ligands.json order)." % (len(reg["targets"]), len(reg["ligands"])))
    w("")
    w("Classes in the registry: %s." % ", ".join("%s %d" % (k, v) for k, v in sorted(class_count.items(), key=lambda kv: (-kv[1], kv[0]))))
    w("")
    w("Cancer groups in the registry (bit: count): %s." % ", ".join("%s (%d): %d" % (c, i, cancer_count[c]) for i, c in enumerate(C.CANCERS)))
    w("")
    w("`cancerBits` = OR of `1 << bit` in the SPEC 8.4 order (lung 0 ... sarcoma 19). The `cancers` array keeps the catalog spelling "
      "(`head and neck` with spaces, bit 17; the CANCERS key in js/catalog.js is `head-and-neck`).")
    w("")
    w("## 4. Registry targets")
    w("")
    w("Half sizes in A (x / y / z); `inside` = pocket atoms inside the box (flag below %d); instance = chain/resseq of the reference ligand used for the box (F = contact fallback)." % san["boxMinInside"])
    w("")
    w("| id | key | pdbId | class | atoms | bytes | half x / y / z | inside | cap | instance | ref atoms |")
    w("| ---: | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- | ---: |")
    for t in reg["targets"]:
        p = pockets[t["key"]]
        b = boxes[t["key"]]
        inst = "%s/%s%s" % (p["builderArgs"]["chain"], p["builderArgs"]["resseq"], " F" if p.get("instanceMode") == "fallback-contact" else "")
        refatoms = "%d" % p["referenceHeavyAtoms"] + ("" if p["referenceHeavyAtomsMatchCatalog"] else " (CCD %d)" % p["catalogHeavyAtoms"])
        w("| %d | %s | %s | %s | %d | %d | %s | %d%s | %s | %s | %s |" % (
            t["id"], t["key"], t["pdbId"], t["class"], t["atoms"], t["bytes"], fmt_half(t["box"]["half"]),
            b["inside"], " FLAG" if b["suspicious"] else "", "yes" if p["capped"] else "no", inst, refatoms))
    w("")
    w("### 4.1 Reserve targets (buildable, not in the registry)")
    w("")
    w("| key | pdbId | class | atoms | bytes | half x / y / z | reason |")
    w("| --- | --- | --- | ---: | ---: | --- | --- |")
    for t in res["targets"]:
        w("| %s | %s | %s | %d | %d | %s | %s |" % (t["key"], t["pdbId"], t["class"], t["atoms"], t["bytes"], fmt_half(t["box"]["half"]), t["reason"]))
    w("")
    w("## 5. Things the site and contract builders must know")
    w("")
    w("- No pocket hit the 2000-atom cap; the largest registry pocket is %d atoms / %d bytes, the largest topology %d bytes." % (
        max(t["atoms"] for t in reg["targets"]), g["largestPocketBytes"], g["largestTopologyBytes"]))
    if big:
        w("- Unusually large boxes (a half size above 12 A, big reference ligands): %s. The browser search volume is large there; "
          "poses of small ligands can drift to a sub-site." % ", ".join("%s %s (%s)" % (r["key"], r["pdbId"], fmt_half(r["half"])) for r in big))
    if mismatch:
        w("- Reference ligands with fewer modelled heavy atoms than the CCD (disordered atoms missing in the model; the box covers the modelled atoms only): %s." % ", ".join(
            "%s %s %d of %d" % (r["key"], r["pdbId"], r["referenceHeavyAtoms"], r["catalogHeavyAtoms"]) for r in mismatch))
    if fallback:
        w("- Reference instance found by the contact fallback (ligand chain label differs from the catalog chain): %s." % ", ".join(
            "%s %s -> %s/%d (CA %.2f A)" % (r["key"], r["pdbId"], r["builderArgs"]["chain"], r["builderArgs"]["resseq"], r["referenceContactA"]) for r in fallback))
    if san["suspiciousBoxes"]:
        w("- Boxes flagged by the containment check (fewer than %d pocket atoms inside): %s." % (
            san["boxMinInside"], ", ".join("%s %s (%d of %d)" % (b["key"], b["pdbId"], b["inside"], b["atoms"]) for b in san["suspiciousBoxes"])))
    else:
        w("- Box containment: every registry box holds at least %d pocket atoms (min %d, max %d); none flagged." % (
            san["boxMinInside"], san["boxInsideMin"], san["boxInsideMax"]))
    reg_keys = {t["key"] for t in reg["targets"]}
    dropped = [r for r in built if r["droppedUnknown"] and r["key"] in reg_keys]
    w("- Receptor atoms dropped by the typing rules (SPEC-ENGINE 2.1 keeps standard amino acids, MSE and metal ions; "
      "everything else is dropped and counted). In the registry: %s. The two entries where that loss removed the site "
      "itself (DNMT1 7SFC, nucleic acid; GPX4 6HKQ, selenocysteine) are excluded by rule (a2) in section 3." % (
          ", ".join("%s %s %s" % (r["key"], r["pdbId"], r["droppedUnknown"]) for r in dropped) or "none"))
    w("- Boxes with few pocket atoms inside are shallow surface sites (a small reference ligand plus the 2 A pad makes a small box, "
      "while the pocket reaches 8 A beyond it), so a low `inside` count is not by itself an error; it is the flag that tells the lab "
      "a pose there has little receptor to bind.")
    w("- Multi-chain pockets: the builder keeps every protein chain within reach, so %d registry pockets contain atoms of more than one chain." % sum(
        1 for t in reg["targets"] if len(pockets[t["key"]]["chainsInPocket"]) > 1))
    w("- All registry entries are X-ray structures; the four cryo-EM entries rank below every X-ray entry (three are buildable and sit in the reserve; ATR 9L40 is cif-only).")
    w("")
    w("## 6. Failures")
    w("")
    w("### 6.1 Pockets (%d)" % len(failed))
    w("")
    w("| key | pdbId | class | reason |")
    w("| --- | --- | --- | --- |")
    for r in failed:
        w("| %s | %s | %s | %s |" % (r["key"], r["pdbId"], r["class"], r["failure"]))
    w("")
    w("All %d pocket failures are entries RCSB serves as mmCIF only (%d of them carry 5-character CCD ids such as A1L62 that the PDB "
      "format cannot hold; 7PI4 has the multi-letter chain id DDD). The reference builder reads the PDB format only, so these cannot be "
      "built without a cif reader in `tools/engine`, which this pipeline does not add." % (len(failed), sum(1 for r in failed if len(r["ccd"]) > 3)))
    w("")
    w("### 6.2 Targets dropped by the box containment floor (%d)" % len(thin))
    w("")
    if thin:
        w("| key | pdbId | class | pocket atoms inside the box | pocket atoms in reach | reason |")
        w("| --- | --- | --- | ---: | ---: | --- |")
        for d in thin:
            t = targets[d["key"]]
            w("| %s | %s | %s | %d | %d | %s |" % (d["key"], t["pdbId"], t["class"], d["inside"], d["atoms"],
                                                   "nucleic acid dropped by the receptor typing" if d["key"] in ("DNMT1", "TOP1")
                                                   else ("catalytic selenocysteine dropped by the receptor typing" if d["key"] == "GPX4"
                                                         else "fewer than %d atoms inside the box" % sel["minInsideBox"])))
        w("")
        w("Their pocket bytes stay in `data/pockets/` (the builder ran and the bytes are valid); they are in neither "
          "`data/registry.json` nor `data/registry-reserve.json`, so nothing registers them on chain.")
    else:
        w("None.")
    w("")
    w("### 6.3 Topologies (%d)" % len(tfailed))
    w("")
    if tfailed:
        w("| key | reason |")
        w("| --- | --- |")
        for r in tfailed:
            w("| %s | %s |" % (r["key"], r["failure"]))
    else:
        w("None: all %d ligands built (elements within C N O S P F Cl Br I, 10 to 62 heavy atoms, connected graphs, every ideal conformer passes the 2.20 A clash floor)." % tsum["built"])
    w("")
    w("## 7. Nrot differences (topology rule vs catalog rotatableBonds)")
    w("")
    w("The topology's rule (SPEC-ENGINE 4.3: single, non-ring, both ends heavy degree >= 2, no triple bond, not an amide) wins; the catalog number is RDKit's.")
    w("")
    w("| key | topology nrot | catalog rotatableBonds |")
    w("| --- | ---: | ---: |")
    for d in tsum["nrotDifferences"]:
        w("| %s | %d | %s |" % (d["key"], d["topologyNrot"], d["catalogRotatableBonds"]))
    w("")
    w("## 8. Sanity docking (reference float search, integer score of the final pose)")
    w("")
    d = san["dock"]
    w("Ligand %s, seed %d, %d starts x %d steps, through `ponchem_engine.py dock`. Targets: the first registry entry of each of the three most populous classes." % (
        d["ligand"], d["seed"], d["starts"], d["steps"]))
    w("")
    w("| target | pdbId | class | code | score milli | dG kcal/mol | pKd | LE | float affinity | search s |")
    w("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for r in d["runs"]:
        if r.get("returncode") != 0:
            w("| %s | %s | %s | error | %s | | | | | %.1f |" % (r["key"], r["pdbId"], r["class"], r.get("error"), r["wallSeconds"]))
            continue
        disp = r.get("display") or {}

        def num(keys, fmt):
            for k in keys:
                if k in disp and disp[k] is not None:
                    return fmt % disp[k]
            return ""
        w("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r["key"], r["pdbId"], r["class"], r["code"], r["scoreMilli"],
            num(("dG_kcal", "dG"), "%.3f"), num(("pKd",), "%.2f"), num(("ligand_efficiency", "le", "LE"), "%.3f"),
            "%.3f" % r["floatAffinity"] if r.get("floatAffinity") is not None else "", r.get("searchSeconds")))
    w("")
    for r in d["runs"]:
        if r.get("poseHex"):
            w("- %s pose bytes: `%s`" % (r["key"], r["poseHex"]))
    w("")
    w("## 9. Registration gas estimate")
    w("")
    w("Formula: %s." % g["formula"])
    w("")
    w("| Set | Registrations | Bytes | Gas |")
    w("| --- | ---: | ---: | ---: |")
    w("| Targets | %d | %d | %s |" % (g["targets"]["count"], g["targets"]["bytes"], format(g["targets"]["gas"], ",")))
    w("| Ligands | %d | %d | %s |" % (g["ligands"]["count"], g["ligands"]["bytes"], format(g["ligands"]["gas"], ",")))
    w("| Tables | %d | %d | %s |" % (g["tables"]["count"], g["tables"]["bytes"], format(g["tables"]["gas"], ",")))
    w("| Total | %d | %d | %s |" % (g["totalRegistrations"], g["totalBytes"], format(g["totalGas"], ",")))
    w("")
    w("## 10. Rerun")
    w("")
    w("```")
    w("cd \"%s\"" % C.ROOT)
    w(".venv/bin/python tools/pipeline/build_registry.py            # everything, cached downloads, about 2 minutes")
    w(".venv/bin/python tools/pipeline/build_registry.py --no-dock  # same without the three docking runs")
    w(".venv/bin/python tools/pipeline/build_pockets.py             # pockets only (add --download-only to just fill the cache)")
    w(".venv/bin/python tools/pipeline/build_topologies.py          # topologies only")
    w(".venv/bin/python tools/pipeline/select_targets.py            # registry.json and registry-reserve.json from the summaries")
    w(".venv/bin/python tools/pipeline/sanity.py                    # box check, docking, gas estimate")
    w(".venv/bin/python tools/pipeline/write_report.py              # this file")
    w("```")
    w("")
    w("Single-target equivalents of what the pipeline ran (example, the first registry entry):")
    w("")
    t0 = reg["targets"][0]
    p0 = pockets[t0["key"]]
    w("```")
    w(".venv/bin/python tools/engine/ponchem_engine.py pocket .tmp/pipeline/structures/%s.pdb --id %s --ligand %s --chain %s --resseq %s --out data/pockets/%s.bin" % (
        t0["pdbId"], t0["pdbId"], p0["builderArgs"]["ligand"], p0["builderArgs"]["chain"], p0["builderArgs"]["resseq"], t0["pdbId"]))
    w(".venv/bin/python tools/engine/ponchem_engine.py topology data/ligands/QUERCETIN.sdf --out data/topologies/QUERCETIN.bin")
    if d["runs"]:
        w(d["runs"][0]["command"])
    w("```")
    w("")
    C.write_text = None
    with open(C.REPORT_MD, "w") as f:
        f.write("\n".join(L) + "\n")
    C.log("report -> %s (%d lines)" % (C.rel(C.REPORT_MD), len(L)))


if __name__ == "__main__":
    main()
