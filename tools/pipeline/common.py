"""Shared helpers of the Ponchem data pipeline (tools/pipeline).

Run every script with the project venv:
  .venv/bin/python tools/pipeline/<script>.py

Owned paths: tools/pipeline/, data/pockets/, data/topologies/, data/registry.json,
data/registry-reserve.json, data/registry-report.md and the cache .tmp/pipeline/.
The numerical authority is tools/engine (imported, never modified).
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
ENGINE_DIR = os.path.join(ROOT, "tools", "engine")
ENGINE_CLI = os.path.join(ENGINE_DIR, "ponchem_engine.py")
PYTHON = os.path.join(ROOT, ".venv", "bin", "python")

CACHE_DIR = os.path.join(ROOT, ".tmp", "pipeline")
STRUCT_CACHE = os.path.join(CACHE_DIR, "structures")
POCKETS_DIR = os.path.join(ROOT, "data", "pockets")
TOPOLOGIES_DIR = os.path.join(ROOT, "data", "topologies")
LIGANDS_DIR = os.path.join(ROOT, "data", "ligands")
TABLES_BIN = os.path.join(ROOT, "data", "tables", "tables.bin")
TABLES_DIR = os.path.join(ROOT, "data", "tables")
TARGETS_JSON = os.path.join(ROOT, "data", "catalog", "targets.json")
LIGANDS_JSON = os.path.join(ROOT, "data", "catalog", "ligands.json")
REGISTRY_JSON = os.path.join(ROOT, "data", "registry.json")
RESERVE_JSON = os.path.join(ROOT, "data", "registry-reserve.json")
REPORT_MD = os.path.join(ROOT, "data", "registry-report.md")

POCKETS_SUMMARY = os.path.join(CACHE_DIR, "pockets-summary.json")
TOPOLOGIES_SUMMARY = os.path.join(CACHE_DIR, "topologies-summary.json")
SELECTION_SUMMARY = os.path.join(CACHE_DIR, "selection-summary.json")
SANITY_SUMMARY = os.path.join(CACHE_DIR, "sanity-summary.json")

# SPEC.md 8.4 CANCERS order (bit = index). The catalog spells the 18th group "head and neck".
CANCERS = [
    "lung", "colorectal", "liver", "breast", "stomach", "pancreatic", "prostate", "esophageal",
    "cervical", "leukemia", "lymphoma", "brain", "melanoma", "ovarian", "bladder", "kidney",
    "myeloma", "head and neck", "thyroid", "sarcoma",
]
CANCER_KEYS = [c.replace(" ", "-") for c in CANCERS]


def cancer_bit(name: str) -> int:
    n = name.strip().lower().replace("-", " ")
    return CANCERS.index(n)


def cancer_bits(names) -> int:
    bits = 0
    for n in names:
        bits |= 1 << cancer_bit(n)
    return bits


if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)


def rel(path: str) -> str:
    """Path relative to the repo root with forward slashes (what the registry stores)."""
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def read_json(path):
    with open(path, "r") as f:
        return json.load(f)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=1)
        f.write("\n")


def read_text(path):
    with open(path, "r") as f:
        return f.read()


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def load_targets():
    return read_json(TARGETS_JSON)["targets"]


def load_ligands():
    return read_json(LIGANDS_JSON)["ligands"]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def pocket_inside_box(pocket_path):
    """Box containment of one pocket blob: (atoms inside the box, atoms in the blob).
    Inside means |x| <= hx and |y| <= hy and |z| <= hz on the relative centi-A coordinates.
    The pocket reaches 8 A beyond the box on every axis, so `inside` counts the receptor
    atoms that sit in the reference ligand's own volume. Used by the selection rule and by
    the sanity step, so both read the same number."""
    from ref.pocket import parse_pocket
    pk = parse_pocket(read_bytes(os.path.join(ROOT, pocket_path)))
    hx, hy, hz = pk["half"]
    inside = sum(1 for x, y, z, _t in pk["atoms"] if abs(x) <= hx and abs(y) <= hy and abs(z) <= hz)
    return inside, pk["n_atoms"]


# ---- RCSB downloads (cached) ------------------------------------------------------------

RCSB_FILES = "https://files.rcsb.org/download/"


def download(url: str, dest: str, retries: int = 4, timeout: int = 120):
    """GET url into dest (cached: an existing non-empty file is returned as is).
    Returns (status, path_or_None): status is 'cached', 'ok', '404' or 'error:<reason>'."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return "cached", dest
    import requests
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=timeout, stream=True)
            if r.status_code == 404:
                return "404", None
            if r.status_code != 200:
                last = "http %d" % r.status_code
                time.sleep(1.5 * (attempt + 1))
                continue
            tmp = dest + ".part"
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 16):
                    if chunk:
                        f.write(chunk)
            os.replace(tmp, dest)
            return "ok", dest
        except Exception as e:  # network errors: retry with backoff
            last = "%s: %s" % (type(e).__name__, e)
            time.sleep(1.5 * (attempt + 1))
    return "error:" + str(last), None


def fetch_structure(pdb_id: str):
    """PDB format first, mmCIF as the fallback. Returns dict with format, path, status."""
    pdb_id = pdb_id.upper()
    pdb_path = os.path.join(STRUCT_CACHE, pdb_id + ".pdb")
    cif_path = os.path.join(STRUCT_CACHE, pdb_id + ".cif")
    marker = os.path.join(STRUCT_CACHE, pdb_id + ".pdb.404")
    if os.path.exists(pdb_path) and os.path.getsize(pdb_path) > 0:
        return {"format": "pdb", "path": pdb_path, "status": "cached"}
    if os.environ.get("PONCHEM_PIPELINE_NO_FETCH"):
        if os.path.exists(cif_path) and os.path.getsize(cif_path) > 0:
            return {"format": "cif", "path": cif_path, "status": "cached (pdb format not served)"}
        return {"format": None, "path": None, "status": "not in the cache and fetching is disabled"}
    if not os.path.exists(marker):
        st, p = download(RCSB_FILES + pdb_id + ".pdb", pdb_path)
        if p:
            return {"format": "pdb", "path": p, "status": st}
        if st == "404":
            with open(marker, "w") as f:
                f.write("404\n")
        else:
            return {"format": None, "path": None, "status": st}
    st, p = download(RCSB_FILES + pdb_id + ".cif", cif_path)
    if p:
        return {"format": "cif", "path": p, "status": st + " (pdb format not served)"}
    return {"format": None, "path": None, "status": "pdb 404, cif " + st}
