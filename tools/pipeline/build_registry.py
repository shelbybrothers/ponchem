"""Run the whole Ponchem data pipeline, end to end, deterministically.

Steps, in order:
  1. build_pockets.py     download (cached) + reference pocket builder for every catalog target
  2. build_topologies.py  reference topology builder for every catalog ligand
  3. select_targets.py     the selection rule -> data/registry.json, data/registry-reserve.json
  4. sanity.py             box containment check, three quercetin docks, registration gas estimate
  5. write_report.py       data/registry-report.md

Rerunnable: the structure downloads are cached in .tmp/pipeline/structures, every builder is
a pure function of its inputs, and the only non-deterministic input to the docking step is
the seed, which is fixed in sanity.py. Rerunning overwrites the same files with the same
bytes (apart from the `generated` timestamps and the wall-clock seconds in the summaries).

Usage:
  .venv/bin/python tools/pipeline/build_registry.py [--no-dock] [--download-only] [--skip-downloads]
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

import build_pockets  # noqa: E402
import build_topologies  # noqa: E402
import select_targets  # noqa: E402
import sanity  # noqa: E402
import write_report  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-dock", action="store_true", help="skip the three docking runs of the sanity step")
    ap.add_argument("--download-only", action="store_true", help="fill the structure cache and stop")
    ap.add_argument("--skip-downloads", action="store_true", help="fail a target instead of fetching a missing structure")
    a = ap.parse_args(argv)

    t0 = time.time()
    C.log("=== 1/5 pockets ===")
    if a.download_only:
        build_pockets.main(["--download-only"])
        C.log("downloads only, stopping (%.1f s)" % (time.time() - t0))
        return
    if a.skip_downloads:
        os.environ["PONCHEM_PIPELINE_NO_FETCH"] = "1"
    build_pockets.main([])
    C.log("=== 2/5 topologies ===")
    build_topologies.main()
    C.log("=== 3/5 selection ===")
    select_targets.main()
    C.log("=== 4/5 sanity ===")
    sanity.main(["--no-dock"] if a.no_dock else [])
    C.log("=== 5/5 report ===")
    write_report.main()
    C.log("pipeline done in %.1f s" % (time.time() - t0))
    for p in (C.REGISTRY_JSON, C.RESERVE_JSON, C.REPORT_MD):
        C.log("  %s (%d bytes)" % (C.rel(p), os.path.getsize(p)))


if __name__ == "__main__":
    main()
