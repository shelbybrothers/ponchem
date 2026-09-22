# Ponchem registry report

Generated 2026-09-22 03:04 UTC by `tools/pipeline/build_registry.py`. Every number below comes from a run of the reference engine (`tools/engine/ref`, the numerical authority) in this build; nothing is recalled or estimated by hand.

## 1. Counts

| Item | Count |
| --- | ---: |
| Catalog targets | 188 |
| Pockets built | 173 |
| Pockets failed | 15 |
| Pockets that hit the 2000-atom cap | 0 |
| Reference instance found by the contact fallback | 12 |
| Targets dropped by the box containment floor (< 25 atoms inside the box) | 3 |
| Registry targets (ids 1..100) | 100 |
| Reserve targets (buildable, not selected) | 70 |
| Catalog ligands | 152 |
| Topologies built | 152 |
| Topologies failed | 0 |
| Registry ligands (ids 1..152) | 152 |
| Nrot differences (topology rule vs catalog rotatableBonds) | 14 |
| Registry pocket bytes | 653883 |
| Registry topology bytes | 76798 |
| Tables bytes | 13010 |
| Total registration bytes | 743691 |
| Registration gas estimate | 183,913,256 |

Files: `data/registry.json`, `data/registry-reserve.json`, `data/pockets/<PDB>.bin` (173 files), `data/topologies/<KEY>.bin` (152 files). Cache: `.tmp/pipeline/` (structures and the JSON summaries this report is built from).

## 2. How the pockets were built

- Coordinates: `https://files.rcsb.org/download/<PDB>.pdb`, cached in `.tmp/pipeline/structures/`; when RCSB serves no PDB format file the mmCIF `<PDB>.cif` is downloaded instead. The reference builder (`ref/pocket.py`) reads the PDB format only, so a cif-only entry is a build failure (see section 6). It is not converted by hand.
- Builder: `ref.pocket.build_pocket(text, pdbId, ccd, chain, resseq)`, the same call as `ponchem_engine.py pocket <file> --id <PDB> --ligand <CCD> --chain <chain> --resseq <authSeqId>`; all protein chains of the first model within reach of the box are kept (the builder default), metals typed Met_D, waters and other hetero groups dropped. The in-process call and the CLI give the same bytes and keccak (checked on 2HYY and QUERCETIN).
- Reference instance: the CCD instance on the catalog chain with residue number authSeqId. When the catalog chain (the protein chain that contacts the ligand) is not the chain label of the ligand instance, the instance with that authSeqId whose heavy atoms come within 6.0 A of a CA atom of the catalog chain is used (closest first). 12 targets needed this fallback; each is listed in section 4 with the instance used.
- Box: centre = centroid of the reference instance's modelled heavy atoms (rounded to milli-A), half size per axis = max(6.00 A, max|x - c| + 2.00 A) rounded up to centi-A. Pocket atoms: |rel| <= half + 8.00 A per axis, cap 2000 atoms (never reached in this build).

## 3. Selection rule as applied

- (a) 173 of 188 targets have a pocket; the 15 failures are dropped.
- (a2) Box containment floor: a target is dropped when fewer than 25 pocket atoms lie inside its box (the box is the reference ligand's own volume plus 2 A, while the pocket reaches 8 A beyond it, so a count this low means the receptor atoms the engine can represent are not what the reference ligand binds). Dropped: DNMT1 7SFC (8 inside of 586 in reach), TOP1 1K4T (24 inside of 748 in reach), GPX4 6HKQ (23 inside of 314 in reach).
  Why these pockets are not the real site: DNMT1 7SFC has its reference inhibitor packed against the DNA duplex, and the receptor typing keeps standard amino acids, MSE and metal ions only, so the nucleotide atoms of that site are dropped and 8 protein atoms remain inside the box (TOP1 1K4T is the same case, a topoisomerase I complex covalently bound to DNA, 24 inside). GPX4 6HKQ loses its catalytic selenocysteine (SEC, 6 atoms), which is the residue the pocket exists for. Scoring a pose in these boxes would measure something other than the published binding site, so they are excluded before coverage and class balancing. Two of the three (DNMT1, GPX4) were in the registry before this rule; TOP1 was already in the reserve.
- (b) Set aside unless needed to reach 100: EED 7KXT (reference drug is not the canonical inhibitor); USP7 9IJU (reference drug is not the canonical inhibitor); EIF4A3 2HYI (cofactor analog reference ligand); PIN1 4TNS (reference drug is not the canonical inhibitor).
  Set-aside entries used: none.
- (c) Coverage: for each cancer group in SPEC order the two best-ranked eligible carriers. Rank = X-ray before cryo-EM, lower resolution, approved-drug reference ligand first, more heavy atoms in the reference ligand (catalog CCD count), key as the tie-break.
  - lung: HASPIN 4QTC, NT5E 7QGL
  - colorectal: KRASG12D 7RPZ, APEX1 7TC2
  - liver: PKM 3GR4, TGFBR1 3HMM
  - breast: EPHA2 5I9X, MTOR 4DRI
  - stomach: TYMS 1HVY, WEE1 5VC3
  - pancreatic: MAT2A 8XAM, KRASG12D 7RPZ
  - prostate: EPHA2 5I9X, TRAP1 7U8X
  - esophageal: ERBB2 3PP0
  - cervical: ESR1 3ERT, PIK3CA 4JPS
  - leukemia: BTK 5P9J, BRPF1 5MWZ
  - lymphoma: BTK 5P9J, BCL6 7RV8
  - brain: ACVR1 6SRH, EPHA2 5I9X
  - melanoma: MAPK1 4QTE, KIT 1T46
  - ovarian: APEX1 7TC2, PGR 1SR7
  - bladder: CD274 5NIU, FGFR3 6LVM
  - kidney: MTOR 4DRI, EPAS1 4XT2
  - myeloma: BRD4 3MXF, BCL2 6O0K
  - head and neck: EGFR 4WKQ
  - thyroid: NTRK3 6KZD, RET 6NEC
  - sarcoma: BRD9 6V0X, MDM4 3LBJ
- (d) Class cap 45 percent = 45 targets. Coverage picks over the cap: none. Targets skipped by the cap during the fill: none.
- (e) The remaining slots filled by rank. Result: 100 targets.
- Registry order: class, then gene. Ids 1..100 for targets, 1..152 for ligands (ligands.json order).

Classes in the registry: kinase 44, epigenetic 14, metabolism 13, apoptosis 5, dna-damage 5, hormone-receptor 5, immuno-oncology 5, other 2, phosphatase 2, protein-homeostasis 2, protease 1, structural 1, transcription 1.

Cancer groups in the registry (bit: count): lung (0): 25, colorectal (1): 20, liver (2): 4, breast (3): 24, stomach (4): 5, pancreatic (5): 10, prostate (6): 10, esophageal (7): 1, cervical (8): 2, leukemia (9): 34, lymphoma (10): 24, brain (11): 9, melanoma (12): 8, ovarian (13): 12, bladder (14): 2, kidney (15): 7, myeloma (16): 9, head and neck (17): 1, thyroid (18): 3, sarcoma (19): 11.

`cancerBits` = OR of `1 << bit` in the SPEC 8.4 order (lung 0 ... sarcoma 19). The `cancers` array keeps the catalog spelling (`head and neck` with spaces, bit 17; the CANCERS key in js/catalog.js is `head-and-neck`).

## 4. Registry targets

Half sizes in A (x / y / z); `inside` = pocket atoms inside the box (flag below 60); instance = chain/resseq of the reference ligand used for the box (F = contact fallback).

| id | key | pdbId | class | atoms | bytes | half x / y / z | inside | cap | instance | ref atoms |
| ---: | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- | ---: |
| 1 | BCL2 | 6O0K | apoptosis | 765 | 5625 | 7.74 / 9.06 / 12.69 | 219 | no | A/301 | 61 |
| 2 | BIRC2 | 4KMN | apoptosis | 538 | 4046 | 11.26 / 8.52 / 9.78 | 101 | no | A/502 | 58 |
| 3 | MDM2 | 4HG7 | apoptosis | 552 | 4054 | 7.03 / 8.83 / 6.68 | 77 | no | A/201 | 40 |
| 4 | MDM4 | 3LBJ | apoptosis | 446 | 3352 | 6.79 / 11.20 / 8.93 | 90 | no | E/112 | 44 |
| 5 | XIAP | 6GJW | apoptosis | 712 | 5206 | 13.95 / 6.24 / 6.29 | 82 | no | D/102 F | 58 |
| 6 | APEX1 | 7TC2 | dna-damage | 572 | 4162 | 6.00 / 6.26 / 6.00 | 62 | no | A/401 | 15 |
| 7 | DHFR | 1U72 | dna-damage | 805 | 5825 | 6.63 / 8.75 / 6.08 | 88 | no | A/188 | 33 |
| 8 | PARP1 | 7KK4 | dna-damage | 1104 | 7918 | 6.00 / 9.88 / 6.00 | 102 | no | A/9001 | 32 |
| 9 | TNKS2 | 8B6M | dna-damage | 1058 | 7636 | 10.79 / 6.00 / 9.87 | 193 | no | C/1202 F | 40 |
| 10 | TYMS | 1HVY | dna-damage | 982 | 7064 | 7.66 / 9.37 / 6.08 | 112 | no | D/417 | 32 |
| 11 | ATAD2 | 5EPB | epigenetic | 488 | 3606 | 9.02 / 6.00 / 6.00 | 41 FLAG | no | A/1201 | 24 |
| 12 | BRD2 | 6WWB | epigenetic | 459 | 3371 | 6.11 / 7.06 / 6.90 | 54 FLAG | no | A/504 | 37 (CCD 61) |
| 13 | BRD4 | 3MXF | epigenetic | 502 | 3672 | 6.00 / 6.71 / 6.44 | 44 FLAG | no | A/1 | 31 |
| 14 | BRD9 | 6V0X | epigenetic | 437 | 3249 | 6.67 / 8.33 / 7.36 | 97 | no | A/301 | 29 |
| 15 | BRPF1 | 5MWZ | epigenetic | 441 | 3245 | 6.00 / 6.99 / 7.05 | 43 FLAG | no | A/801 | 33 |
| 16 | CARM1 | 6ARJ | epigenetic | 1311 | 9367 | 9.71 / 7.92 / 6.96 | 124 | no | C/502 | 41 |
| 17 | CREBBP | 6SQE | epigenetic | 635 | 4675 | 7.98 / 11.09 / 8.56 | 151 | no | A/1201 | 43 |
| 18 | EP300 | 3BIY | epigenetic | 1019 | 7443 | 8.20 / 16.92 / 6.00 | 166 | no | A/700 | 64 |
| 19 | HDAC2 | 4LXZ | epigenetic | 779 | 5643 | 8.08 / 6.16 / 6.42 | 81 | no | A/407 | 19 |
| 20 | HDAC8 | 1T64 | epigenetic | 746 | 5412 | 8.41 / 6.33 / 6.00 | 73 | no | A/387 | 22 |
| 21 | KAT6A | 9DZN | epigenetic | 935 | 6775 | 10.55 / 10.02 / 6.00 | 140 | no | C/101 F | 51 (CCD 52) |
| 22 | MEN1 | 4GQ4 | epigenetic | 1191 | 8567 | 8.22 / 8.81 / 6.00 | 112 | no | A/601 | 27 |
| 23 | METTL3 | 7O0L | epigenetic | 952 | 6894 | 11.62 / 8.35 / 6.00 | 148 | no | A/601 | 41 |
| 24 | WDR5 | 8E9F | epigenetic | 1096 | 7902 | 8.38 / 7.89 / 8.48 | 145 | no | A/402 | 43 |
| 25 | AKR1C3 | 1RY8 | hormone-receptor | 1103 | 7951 | 7.33 / 9.62 / 8.16 | 170 | no | B/3325 | 43 |
| 26 | AR | 2AM9 | hormone-receptor | 940 | 6738 | 6.00 / 7.07 / 6.00 | 77 | no | A/1000 | 21 |
| 27 | ESR1 | 3ERT | hormone-receptor | 920 | 6670 | 8.52 / 6.00 / 8.74 | 139 | no | A/600 | 29 |
| 28 | NR3C1 | 4P6W | hormone-receptor | 926 | 6640 | 6.00 / 6.98 / 7.49 | 89 | no | A/801 | 35 |
| 29 | PGR | 1SR7 | hormone-receptor | 984 | 7078 | 6.50 / 6.25 / 8.17 | 114 | no | B/302 | 35 |
| 30 | ADORA2A | 8RW0 | immuno-oncology | 960 | 6910 | 6.00 / 9.66 / 6.00 | 78 | no | A/1201 | 28 |
| 31 | ARG1 | 8E5M | immuno-oncology | 1094 | 7888 | 7.91 / 8.73 / 9.35 | 111 | no | F/1003 | 40 |
| 32 | CD274 | 5NIU | immuno-oncology | 1099 | 7963 | 12.06 / 9.87 / 6.31 | 199 | no | D/201 F | 44 |
| 33 | MAP4K1 | 6NG0 | immuno-oncology | 768 | 5606 | 8.09 / 6.00 / 8.75 | 104 | no | A/9000 | 29 |
| 34 | NT5E | 7QGL | immuno-oncology | 860 | 6210 | 7.61 / 6.94 / 10.53 | 96 | no | A/604 | 38 |
| 35 | ACVR1 | 6SRH | kinase | 814 | 5888 | 10.62 / 6.06 / 6.00 | 98 | no | A/501 | 32 |
| 36 | ALK | 4MKC | kinase | 850 | 6180 | 8.58 / 8.65 / 6.17 | 113 | no | A/1503 | 38 |
| 37 | BTK | 5P9J | kinase | 947 | 6819 | 7.28 / 6.76 / 9.18 | 140 | no | A/701 | 33 |
| 38 | CDK1 | 6GU2 | kinase | 818 | 5884 | 6.00 / 6.98 / 6.76 | 70 | no | A/301 | 28 |
| 39 | CDK2 | 1H00 | kinase | 760 | 5510 | 7.77 / 9.42 / 6.00 | 110 | no | A/1400 | 30 |
| 40 | CHEK2 | 2YCF | kinase | 974 | 7048 | 6.00 / 10.52 / 11.62 | 200 | no | A/600 | 32 |
| 41 | CSNK1D | 6F26 | kinase | 857 | 6229 | 6.00 / 11.32 / 10.11 | 128 | no | B/307 | 46 |
| 42 | DDR1 | 4BKJ | kinase | 1315 | 9475 | 9.39 / 12.09 / 6.00 | 220 | no | B/1000 | 37 |
| 43 | EGFR | 4WKQ | kinase | 917 | 6609 | 7.68 / 7.71 / 9.73 | 158 | no | A/1101 | 31 |
| 44 | EPHA2 | 5I9X | kinase | 895 | 6487 | 12.07 / 6.61 / 6.78 | 130 | no | A/1001 | 36 |
| 45 | ERBB2 | 3PP0 | kinase | 995 | 7155 | 9.86 / 6.64 / 6.00 | 127 | no | B/2 | 34 |
| 46 | FGFR3 | 6LVM | kinase | 1160 | 8400 | 9.22 / 11.38 / 9.43 | 280 | no | A/801 | 53 |
| 47 | FGFR4 | 4XCU | kinase | 927 | 6679 | 7.72 / 6.00 / 9.01 | 105 | no | A/1002 | 35 |
| 48 | HASPIN | 4QTC | kinase | 1183 | 8611 | 12.19 / 10.41 / 8.09 | 249 | no | A/804 | 44 |
| 49 | ITK | 3MIY | kinase | 713 | 5181 | 10.32 / 6.00 / 6.00 | 89 | no | B/2 | 29 |
| 50 | JAK1 | 4E4N | kinase | 837 | 6049 | 6.00 / 8.72 / 6.00 | 91 | no | B/1201 | 25 |
| 51 | JAK2 | 3KRR | kinase | 823 | 5951 | 6.25 / 10.09 / 6.00 | 102 | no | A/1 | 36 |
| 52 | JAK3 | 7C3N | kinase | 773 | 5569 | 6.00 / 6.33 / 6.72 | 80 | no | A/9000 | 23 |
| 53 | KDR | 4ASD | kinase | 1264 | 9078 | 9.95 / 6.63 / 8.68 | 199 | no | A/1500 | 32 |
| 54 | KIT | 1T46 | kinase | 1325 | 9505 | 8.52 / 6.38 / 11.64 | 218 | no | A/3 | 37 |
| 55 | KRASG12D | 7RPZ | kinase | 662 | 4864 | 9.03 / 8.86 / 6.83 | 143 | no | A/202 | 44 |
| 56 | KRAS | 6OIM | kinase | 634 | 4668 | 9.24 / 8.10 / 6.00 | 110 | no | A/303 | 41 |
| 57 | LCK | 2OF2 | kinase | 761 | 5485 | 7.95 / 7.15 / 6.00 | 85 | no | A/201 | 30 |
| 58 | MAP2K1 | 3EQC | kinase | 945 | 6805 | 9.58 / 6.84 / 6.00 | 91 | no | A/1 | 26 |
| 59 | MAPK1 | 4QTE | kinase | 989 | 7113 | 6.49 / 11.37 / 7.18 | 151 | no | A/430 | 34 |
| 60 | MAPK14 | 3FLN | kinase | 870 | 6280 | 9.70 / 6.00 / 6.00 | 88 | no | C/361 | 28 |
| 61 | MELK | 5MAH | kinase | 753 | 5461 | 6.00 / 6.00 / 8.97 | 81 | no | A/401 | 35 |
| 62 | MET | 3LQ8 | kinase | 1262 | 9104 | 14.64 / 6.00 / 9.58 | 272 | no | A/1 | 46 |
| 63 | MTOR | 4DRI | kinase | 1070 | 7720 | 9.04 / 10.21 / 6.66 | 159 | no | A/201 F | 65 |
| 64 | NEK2 | 2XNM | kinase | 779 | 5611 | 6.89 / 7.30 / 7.00 | 83 | no | A/1280 | 38 |
| 65 | NTRK1 | 6D20 | kinase | 1086 | 7832 | 8.49 / 8.73 / 6.00 | 131 | no | A/802 | 36 |
| 66 | NTRK3 | 6KZD | kinase | 1123 | 8091 | 10.57 / 7.46 / 8.16 | 192 | no | A/901 | 44 |
| 67 | PAK1 | 3FXZ | kinase | 847 | 6119 | 8.61 / 6.52 / 7.88 | 91 | no | A/1 | 42 |
| 68 | PDGFRA | 6JOL | kinase | 1170 | 8420 | 6.67 / 11.33 / 9.73 | 233 | no | A/1001 | 37 |
| 69 | PDPK1 | 3QD0 | kinase | 983 | 7111 | 9.30 / 8.49 / 6.00 | 116 | no | A/370 | 33 |
| 70 | PIK3CA | 4JPS | kinase | 864 | 6238 | 6.00 / 6.31 / 8.59 | 80 | no | A/1102 | 30 |
| 71 | PIM1 | 3BGQ | kinase | 751 | 5415 | 6.00 / 6.00 / 6.69 | 55 FLAG | no | A/314 | 26 |
| 72 | PRKCQ | 1XJD | kinase | 802 | 5772 | 7.10 / 6.77 / 6.00 | 76 | no | A/200 | 35 |
| 73 | RAF1 | 8A68 | kinase | 825 | 5965 | 6.88 / 7.57 / 8.01 | 78 | no | A/304 F | 28 (CCD 34) |
| 74 | RET | 6NEC | kinase | 907 | 6539 | 11.30 / 7.70 / 6.27 | 135 | no | C/1102 | 40 |
| 75 | SYK | 1XBB | kinase | 880 | 6350 | 9.66 / 7.49 / 6.77 | 107 | no | A/1 | 37 |
| 76 | TGFBR1 | 3HMM | kinase | 852 | 6122 | 7.06 / 6.00 / 6.81 | 87 | no | A/857 | 24 |
| 77 | TTK | 7LQD | kinase | 1107 | 8029 | 8.37 / 8.75 / 10.32 | 205 | no | A/901 | 45 |
| 78 | WEE1 | 5VC3 | kinase | 994 | 7188 | 10.08 / 9.57 / 6.00 | 175 | no | A/601 | 36 |
| 79 | ALDH1A1 | 8T0T | metabolism | 1034 | 7396 | 7.92 / 6.00 / 7.27 | 79 | no | A/602 | 34 |
| 80 | CA9 | 6G9U | metabolism | 936 | 6742 | 7.27 / 6.00 / 8.03 | 77 | no | A/302 | 34 |
| 81 | DCK | 7ZI3 | metabolism | 981 | 7057 | 7.29 / 10.85 / 7.39 | 154 | no | A/301 | 44 |
| 82 | DHODH | 6QU7 | metabolism | 828 | 5986 | 6.00 / 9.55 / 6.00 | 105 | no | A/403 | 35 |
| 83 | EGLN1 | 7UMP | metabolism | 861 | 6217 | 8.38 / 6.00 / 6.00 | 65 | no | A/1002 | 21 |
| 84 | EPAS1 | 4XT2 | metabolism | 832 | 5982 | 7.54 / 6.00 / 6.00 | 92 | no | C/401 | 23 |
| 85 | IDH2 | 5I96 | metabolism | 1199 | 8583 | 6.00 / 8.83 / 7.53 | 140 | no | B/502 F | 33 |
| 86 | MAT2A | 8XAM | metabolism | 1449 | 10373 | 8.98 / 9.21 / 6.64 | 177 | no | B/401 F | 47 |
| 87 | MTAP | 6DZ2 | metabolism | 1136 | 8182 | 7.19 / 8.28 / 8.02 | 124 | no | C/308 | 34 |
| 88 | NNMT | 7WMT | metabolism | 852 | 6154 | 6.00 / 9.11 / 7.10 | 132 | no | A/501 | 41 |
| 89 | PHGDH | 7VA1 | metabolism | 598 | 4416 | 8.63 / 6.67 / 10.98 | 122 | no | B/401 | 34 |
| 90 | PKM | 3GR4 | metabolism | 1128 | 8086 | 8.73 / 6.00 / 6.00 | 88 | no | A/550 | 30 |
| 91 | SPHK1 | 4V24 | metabolism | 1178 | 8476 | 6.00 / 8.45 / 8.44 | 138 | no | A/1450 | 33 |
| 92 | EIF4E | 5EI3 | other | 578 | 4204 | 6.00 / 6.28 / 6.00 | 30 FLAG | no | A/301 | 34 |
| 93 | PTGS2 | 5F19 | other | 1226 | 8812 | 6.80 / 8.00 / 8.35 | 109 | no | B/601 | 43 |
| 94 | PTPN11 | 5EHR | phosphatase | 937 | 6717 | 7.13 / 6.00 / 7.28 | 107 | no | B/601 | 23 |
| 95 | PTPN2 | 8U0H | phosphatase | 1301 | 9457 | 9.09 / 20.13 / 6.07 | 183 | no | B/801 | 67 |
| 96 | MMP9 | 5I12 | protease | 763 | 5571 | 7.24 / 10.82 / 8.10 | 122 | no | A/306 | 52 |
| 97 | HSP90AA1 | 2XJX | protein-homeostasis | 793 | 5741 | 6.00 / 6.00 / 8.75 | 60 | no | A/1232 | 30 |
| 98 | TRAP1 | 7U8X | protein-homeostasis | 1020 | 7330 | 9.22 / 7.41 / 6.78 | 135 | no | A/601 | 32 |
| 99 | KIF11 | 3ZCW | structural | 870 | 6280 | 7.91 / 7.07 / 8.15 | 118 | no | A/1366 | 33 |
| 100 | BCL6 | 7RV8 | transcription | 697 | 5149 | 11.06 / 6.47 / 12.41 | 133 | no | A/201 | 46 |

### 4.1 Reserve targets (buildable, not in the registry)

| key | pdbId | class | atoms | bytes | half x / y / z | reason |
| --- | --- | --- | ---: | ---: | --- | --- |
| BCL2L1 | 2YXJ | apoptosis | 709 | 5193 | 9.90 / 11.97 / 6.00 | reserve (e): rank below the cut |
| MCL1 | 6QYO | apoptosis | 563 | 4131 | 7.11 / 9.05 / 6.71 | reserve (e): rank below the cut |
| ATM | 7NI4 | dna-damage | 874 | 6276 | 7.01 / 6.00 / 7.08 | reserve (e): rank below the cut |
| PARG | 6HML | dna-damage | 779 | 5643 | 8.48 / 6.00 / 7.25 | reserve (e): rank below the cut |
| PARP2 | 4TVJ | dna-damage | 1073 | 7701 | 7.65 / 8.10 / 6.00 | reserve (e): rank below the cut |
| PRKDC | 7OTY | dna-damage | 858 | 6164 | 7.43 / 6.00 / 6.92 | reserve (e): rank below the cut |
| USP7 | 9IJU | dna-damage | 683 | 4939 | 6.00 / 6.00 / 7.06 | reserve (b): set aside: reference drug is not the canonical inhibitor |
| DOT1L | 5MW4 | epigenetic | 1145 | 8245 | 6.00 / 11.35 / 9.00 | reserve (e): rank below the cut |
| EED | 7KXT | epigenetic | 1153 | 8351 | 9.60 / 8.40 / 9.26 | reserve (b): set aside: reference drug is not the canonical inhibitor |
| EZH2 | 5IJ7 | epigenetic | 983 | 7071 | 6.00 / 11.26 / 6.22 | reserve (e): rank below the cut |
| HDAC6 | 5EDU | epigenetic | 800 | 5790 | 6.00 / 8.16 / 6.71 | reserve (e): rank below the cut |
| KDM1A | 5L3E | epigenetic | 1132 | 8154 | 9.52 / 8.35 / 6.23 | reserve (e): rank below the cut |
| KDM4A | 6H4R | epigenetic | 1105 | 7925 | 6.90 / 6.00 / 9.22 | reserve (e): rank below the cut |
| KDM5B | 5LW9 | epigenetic | 1352 | 9694 | 9.92 / 10.27 / 6.00 | reserve (e): rank below the cut |
| PRMT1 | 6NT2 | epigenetic | 1026 | 7340 | 6.87 / 7.37 / 6.32 | reserve (e): rank below the cut |
| PRMT5 | 6RLQ | epigenetic | 1205 | 8665 | 8.37 / 8.43 / 7.45 | reserve (e): rank below the cut |
| CYP17A1 | 3RUK | hormone-receptor | 1159 | 8271 | 7.46 / 6.00 / 7.07 | reserve (e): rank below the cut |
| CYP19A1 | 3S79 | hormone-receptor | 1059 | 7571 | 6.00 / 6.53 / 6.00 | reserve (e): rank below the cut |
| CXCR4 | 3ODU | immuno-oncology | 899 | 6451 | 6.35 / 6.00 / 7.41 | reserve (e): rank below the cut |
| IDO1 | 6AZV | immuno-oncology | 1175 | 8415 | 9.34 / 6.00 / 7.16 | reserve (e): rank below the cut |
| ABL1 | 2HYY | kinase | 1168 | 8406 | 10.58 / 10.34 / 6.79 | reserve (e): rank below the cut |
| AKT1 | 3O96 | kinase | 1428 | 10226 | 7.14 / 10.82 / 10.19 | reserve (e): rank below the cut |
| AURKA | 3W2C | kinase | 902 | 6504 | 7.62 / 7.06 / 11.08 | reserve (e): rank below the cut |
| AURKB | 4AF3 | kinase | 886 | 6392 | 8.62 / 6.00 / 7.79 | reserve (e): rank below the cut |
| BRAF | 3OG7 | kinase | 952 | 6854 | 10.93 / 6.00 / 6.00 | reserve (e): rank below the cut |
| CDK12 | 5ACB | kinase | 867 | 6259 | 11.94 / 7.85 / 6.20 | reserve (e): rank below the cut |
| CDK4 | 7SJ3 | kinase | 830 | 6000 | 9.87 / 6.37 / 6.83 | reserve (e): rank below the cut |
| CDK6 | 5L2T | kinase | 789 | 5713 | 7.07 / 6.45 / 8.27 | reserve (e): rank below the cut |
| CDK7 | 8R9O | kinase | 978 | 7076 | 11.42 / 7.89 / 8.27 | reserve (e): rank below the cut |
| CDK8 | 4F7S | kinase | 792 | 5702 | 6.00 / 6.90 / 6.19 | reserve (e): rank below the cut |
| CDK9 | 3BLR | kinase | 841 | 6045 | 7.25 / 6.73 / 6.00 | reserve (e): rank below the cut |
| CHEK1 | 2E9N | kinase | 856 | 6214 | 13.11 / 6.41 / 6.00 | reserve (e): rank below the cut |
| CSF1R | 4R7I | kinase | 1145 | 8245 | 11.64 / 6.00 / 8.51 | reserve (e): rank below the cut |
| CSNK2A1 | 3NGA | kinase | 787 | 5667 | 6.60 / 6.00 / 7.41 | reserve (e): rank below the cut |
| DYRK1A | 8C3Q | kinase | 1053 | 7561 | 6.45 / 7.18 / 9.14 | reserve (e): rank below the cut |
| ERBB4 | 3BBT | kinase | 934 | 6728 | 10.00 / 6.00 / 6.00 | reserve (e): rank below the cut |
| FGFR1 | 4V04 | kinase | 918 | 6616 | 6.00 / 6.00 / 11.87 | reserve (e): rank below the cut |
| FGFR2 | 3RI1 | kinase | 730 | 5268 | 6.18 / 6.00 / 6.00 | reserve (e): rank below the cut |
| FLT3 | 6JQR | kinase | 823 | 5983 | 6.00 / 12.46 / 7.61 | reserve (e): rank below the cut |
| GSK3B | 1Q41 | kinase | 743 | 5359 | 6.00 / 6.70 / 6.00 | reserve (e): rank below the cut |
| IGF1R | 3O23 | kinase | 914 | 6588 | 6.00 / 9.97 / 6.00 | reserve (e): rank below the cut |
| MAPK7 | 4B99 | kinase | 682 | 4964 | 6.00 / 9.04 / 6.92 | reserve (e): rank below the cut |
| MAPKAPK2 | 1NXK | kinase | 710 | 5128 | 6.51 / 7.36 / 6.00 | reserve (e): rank below the cut |
| MERTK | 3BPR | kinase | 803 | 5779 | 7.14 / 6.42 / 6.00 | reserve (e): rank below the cut |
| PIK3CG | 3DBS | kinase | 1013 | 7249 | 7.89 / 7.85 / 7.21 | reserve (e): rank below the cut |
| PLK1 | 3FC2 | kinase | 845 | 6185 | 8.81 / 14.58 / 6.58 | reserve (e): rank below the cut |
| RIPK2 | 4C8B | kinase | 1024 | 7390 | 6.00 / 12.65 / 6.63 | reserve (e): rank below the cut |
| ROCK1 | 5WNF | kinase | 1213 | 8721 | 10.58 / 9.64 / 6.00 | reserve (e): rank below the cut |
| ROS1 | 3ZBF | kinase | 764 | 5506 | 7.15 / 6.00 / 7.32 | reserve (e): rank below the cut |
| SRC | 4MXO | kinase | 1009 | 7293 | 10.63 / 6.36 / 8.71 | reserve (e): rank below the cut |
| TBK1 | 4EUT | kinase | 811 | 5867 | 6.00 / 6.44 / 10.75 | reserve (e): rank below the cut |
| TEK | 6MWE | kinase | 1057 | 7669 | 7.82 / 8.15 / 13.15 | reserve (e): rank below the cut |
| TYK2 | 3LXN | kinase | 689 | 4981 | 6.79 / 6.00 / 6.00 | reserve (e): rank below the cut |
| FASN | 2PX6 | metabolism | 788 | 5706 | 6.06 / 6.99 / 10.48 | reserve (e): rank below the cut |
| GART | 1RC1 | metabolism | 816 | 5902 | 6.86 / 7.83 / 8.92 | reserve (e): rank below the cut |
| GLS | 5JYO | metabolism | 882 | 6364 | 7.44 / 6.78 / 8.85 | reserve (e): rank below the cut |
| HK2 | 5HG1 | metabolism | 947 | 6819 | 6.00 / 9.68 / 6.00 | reserve (e): rank below the cut |
| IDH1 | 5DE1 | metabolism | 931 | 6707 | 8.18 / 7.57 / 6.79 | reserve (e): rank below the cut |
| LDHA | 4OKN | metabolism | 554 | 4068 | 8.70 / 6.00 / 6.31 | reserve (e): rank below the cut |
| NAMPT | 2GVJ | metabolism | 1357 | 9689 | 7.65 / 6.57 / 10.79 | reserve (e): rank below the cut |
| SHMT2 | 8TLC | metabolism | 1135 | 8215 | 8.22 / 15.29 / 6.00 | reserve (e): rank below the cut |
| EIF4A3 | 2HYI | other | 1112 | 8014 | 8.58 / 8.21 / 6.00 | reserve (b): set aside: cofactor analog reference ligand |
| PIN1 | 4TNS | other | 593 | 4341 | 6.00 / 8.70 / 6.04 | reserve (b): set aside: reference drug is not the canonical inhibitor |
| SMO | 4JKV | other | 1130 | 8100 | 10.49 / 6.00 / 6.00 | reserve (e): rank below the cut |
| MMP2 | 8H78 | protease | 1080 | 7940 | 9.51 / 16.49 / 8.83 | reserve (e): rank below the cut |
| HSPA8 | 5AQG | protein-homeostasis | 739 | 5331 | 6.00 / 6.00 / 6.00 | reserve (e): rank below the cut |
| PSMB5 | 5LF3 | protein-homeostasis | 903 | 6479 | 6.00 / 7.56 / 6.32 | reserve (e): rank below the cut |
| XPO1 | 9OGD | protein-homeostasis | 970 | 6948 | 6.25 / 6.00 / 7.99 | reserve (e): rank below the cut |
| CTNNB1 | 6M90 | transcription | 504 | 3718 | 6.00 / 6.00 / 8.61 | reserve (e): rank below the cut |
| STAT3 | 6NJS | transcription | 716 | 5282 | 7.45 / 13.85 / 8.16 | reserve (e): rank below the cut |

## 5. Things the site and contract builders must know

- No pocket hit the 2000-atom cap; the largest registry pocket is 1449 atoms / 10373 bytes, the largest topology 1256 bytes.
- Unusually large boxes (a half size above 12 A, big reference ligands): PTPN2 8U0H (9.09 / 20.13 / 6.07), EP300 3BIY (8.20 / 16.92 / 6.00), MMP2 8H78 (9.51 / 16.49 / 8.83), SHMT2 8TLC (8.22 / 15.29 / 6.00), MET 3LQ8 (14.64 / 6.00 / 9.58), PLK1 3FC2 (8.81 / 14.58 / 6.58), XIAP 6GJW (13.95 / 6.24 / 6.29), STAT3 6NJS (7.45 / 13.85 / 8.16), TEK 6MWE (7.82 / 8.15 / 13.15), CHEK1 2E9N (13.11 / 6.41 / 6.00), BCL2 6O0K (7.74 / 9.06 / 12.69), RIPK2 4C8B (6.00 / 12.65 / 6.63), FLT3 6JQR (6.00 / 12.46 / 7.61), BCL6 7RV8 (11.06 / 6.47 / 12.41), HASPIN 4QTC (12.19 / 10.41 / 8.09), DDR1 4BKJ (9.39 / 12.09 / 6.00), EPHA2 5I9X (12.07 / 6.61 / 6.78), CD274 5NIU (12.06 / 9.87 / 6.31). The browser search volume is large there; poses of small ligands can drift to a sub-site.
- Reference ligands with fewer modelled heavy atoms than the CCD (disordered atoms missing in the model; the box covers the modelled atoms only): ERBB4 3BBT 27 of 40, RAF1 8A68 28 of 34, BRD2 6WWB 37 of 61, KAT6A 9DZN 51 of 52, KDM4A 6H4R 25 of 35, GART 1RC1 38 of 56, GPX4 6HKQ 30 of 31.
- Reference instance found by the contact fallback (ligand chain label differs from the catalog chain): MTOR 4DRI -> A/201 (CA 4.01 A), RAF1 8A68 -> A/304 (CA 3.68 A), DNMT1 7SFC -> C/101 (CA 3.67 A), KAT6A 9DZN -> C/101 (CA 3.24 A), XIAP 6GJW -> D/102 (CA 3.45 A), TNKS2 8B6M -> C/1202 (CA 4.67 A), TOP1 1K4T -> D/990 (CA 5.13 A), IDH2 5I96 -> B/502 (CA 3.18 A), MAT2A 8XAM -> B/401 (CA 3.50 A), NAMPT 2GVJ -> B/501 (CA 5.31 A), CD274 5NIU -> D/201 (CA 3.50 A), CTNNB1 6M90 -> A/601 (CA 3.79 A).
- Boxes flagged by the containment check (fewer than 60 pocket atoms inside): ATAD2 5EPB (41 of 488), BRD2 6WWB (54 of 459), BRD4 3MXF (44 of 502), BRPF1 5MWZ (43 of 441), PIM1 3BGQ (55 of 751), EIF4E 5EI3 (30 of 578).
- Receptor atoms dropped by the typing rules (SPEC-ENGINE 2.1 keeps standard amino acids, MSE and metal ions; everything else is dropped and counted). In the registry: none. The two entries where that loss removed the site itself (DNMT1 7SFC, nucleic acid; GPX4 6HKQ, selenocysteine) are excluded by rule (a2) in section 3.
- Boxes with few pocket atoms inside are shallow surface sites (a small reference ligand plus the 2 A pad makes a small box, while the pocket reaches 8 A beyond it), so a low `inside` count is not by itself an error; it is the flag that tells the lab a pose there has little receptor to bind.
- Multi-chain pockets: the builder keeps every protein chain within reach, so 25 registry pockets contain atoms of more than one chain.
- All registry entries are X-ray structures; the four cryo-EM entries rank below every X-ray entry (three are buildable and sit in the reserve; ATR 9L40 is cif-only).

## 6. Failures

### 6.1 Pockets (15)

| key | pdbId | class | reason |
| --- | --- | --- | --- |
| PIK3CD | 9L3R | kinase | cif-only: RCSB serves no PDB format file for 9L3R and the reference builder (ref/pocket.py) reads the PDB format only |
| PTK2 | 7PI4 | kinase | cif-only: RCSB serves no PDB format file for 7PI4 and the reference builder (ref/pocket.py) reads the PDB format only |
| SIRT2 | 9S20 | epigenetic | cif-only: RCSB serves no PDB format file for 9S20 and the reference builder (ref/pocket.py) reads the PDB format only |
| SMARCA2 | 9HYN | epigenetic | cif-only: RCSB serves no PDB format file for 9HYN and the reference builder (ref/pocket.py) reads the PDB format only |
| TRIM24 | 9GDG | epigenetic | cif-only: RCSB serves no PDB format file for 9GDG and the reference builder (ref/pocket.py) reads the PDB format only |
| ATR | 9L40 | dna-damage | cif-only: RCSB serves no PDB format file for 9L40 and the reference builder (ref/pocket.py) reads the PDB format only |
| FEN1 | 9RCI | dna-damage | cif-only: RCSB serves no PDB format file for 9RCI and the reference builder (ref/pocket.py) reads the PDB format only |
| NUDT1 | 9GQL | dna-damage | cif-only: RCSB serves no PDB format file for 9GQL and the reference builder (ref/pocket.py) reads the PDB format only |
| POLQ | 9YSI | dna-damage | cif-only: RCSB serves no PDB format file for 9YSI and the reference builder (ref/pocket.py) reads the PDB format only |
| TOP2A | 9BQB | dna-damage | cif-only: RCSB serves no PDB format file for 9BQB and the reference builder (ref/pocket.py) reads the PDB format only |
| WRN | 9OG8 | dna-damage | cif-only: RCSB serves no PDB format file for 9OG8 and the reference builder (ref/pocket.py) reads the PDB format only |
| VHL | 9EQJ | metabolism | cif-only: RCSB serves no PDB format file for 9EQJ and the reference builder (ref/pocket.py) reads the PDB format only |
| STING1 | 9CUD | immuno-oncology | cif-only: RCSB serves no PDB format file for 9CUD and the reference builder (ref/pocket.py) reads the PDB format only |
| KEAP1 | 9KVW | transcription | cif-only: RCSB serves no PDB format file for 9KVW and the reference builder (ref/pocket.py) reads the PDB format only |
| CRBN | 9GY3 | protein-homeostasis | cif-only: RCSB serves no PDB format file for 9GY3 and the reference builder (ref/pocket.py) reads the PDB format only |

All 15 pocket failures are entries RCSB serves as mmCIF only (14 of them carry 5-character CCD ids such as A1L62 that the PDB format cannot hold; 7PI4 has the multi-letter chain id DDD). The reference builder reads the PDB format only, so these cannot be built without a cif reader in `tools/engine`, which this pipeline does not add.

### 6.2 Targets dropped by the box containment floor (3)

| key | pdbId | class | pocket atoms inside the box | pocket atoms in reach | reason |
| --- | --- | --- | ---: | ---: | --- |
| DNMT1 | 7SFC | epigenetic | 8 | 586 | nucleic acid dropped by the receptor typing |
| TOP1 | 1K4T | dna-damage | 24 | 748 | nucleic acid dropped by the receptor typing |
| GPX4 | 6HKQ | metabolism | 23 | 314 | catalytic selenocysteine dropped by the receptor typing |

Their pocket bytes stay in `data/pockets/` (the builder ran and the bytes are valid); they are in neither `data/registry.json` nor `data/registry-reserve.json`, so nothing registers them on chain.

### 6.3 Topologies (0)

None: all 152 ligands built (elements within C N O S P F Cl Br I, 10 to 62 heavy atoms, connected graphs, every ideal conformer passes the 2.20 A clash floor).

## 7. Nrot differences (topology rule vs catalog rotatableBonds)

The topology's rule (SPEC-ENGINE 4.3: single, non-ring, both ends heavy degree >= 2, no triple bond, not an amide) wins; the catalog number is RDKit's.

| key | topology nrot | catalog rotatableBonds |
| --- | ---: | ---: |
| HOMOHARRINGTONINE | 11 | 9 |
| VINBLASTINE | 10 | 7 |
| VINCRISTINE | 10 | 8 |
| INGENOL_MEBUTATE | 4 | 3 |
| EGCG | 4 | 3 |
| PLUMERICIN | 2 | 1 |
| NOMILIN | 3 | 2 |
| CHLOROGENIC_ACID | 5 | 4 |
| ROSMARINIC_ACID | 7 | 6 |
| SALVIANOLIC_ACID_A | 9 | 8 |
| CAPE | 6 | 5 |
| BRUSATOL | 5 | 3 |
| PACLITAXEL | 14 | 10 |
| CUCURBITACIN_B | 6 | 5 |

## 8. Sanity docking (reference float search, integer score of the final pose)

Ligand QUERCETIN, seed 1, 4 starts x 1000 steps, through `ponchem_engine.py dock`. Targets: the first registry entry of each of the three most populous classes.

| target | pdbId | class | code | score milli | dG kcal/mol | pKd | LE | float affinity | search s |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ACVR1 | 6SRH | kinase | 0 | -9502 | -9.502 | 6.97 | 0.432 | -9.505 | 29.2 |
| ATAD2 | 5EPB | epigenetic | 0 | -6282 | -6.282 | 4.60 | 0.286 | -6.301 | 17.8 |
| ALDH1A1 | 8T0T | metabolism | 0 | -9094 | -9.094 | 6.67 | 0.413 | -9.097 | 32.9 |

- ACVR1 pose bytes: `0xff28003b0002ff96007fffd300140042ffd70022ffc0000cffb3ff7e003bff36ffba0036008c0087ffa501080042ffae010bffc4ffe2018cff7dffea01f4ffb30036026dff71003d027ffef9fffa0217fec3ffae019dff04ffa7009cff86000f008600f8ff770229fe4dff6d02f6feb80001017a007cff81fec9ff780065ff8800fcffa0`
- ATAD2 pose bytes: `0x02efffbf00780278ffa200b8020bfff800a90216006b005a028e0087001a02fa00310029018bffdd00ed0121003a00d8013700a6008900c80106007500cc018400b2006501dd009ffff801ba004ffff4013d0012005b00e3002401ac00be004c017cff7a0133ff8a011bffc4ff930212003d00a900260113036f004dffea026eff330105`
- ALDH1A1 pose bytes: `0xfff1fef2ffd1ffbcff670004000affb80057008eff92007700c1ff1d00430073fecefff0ffd500350090002b008000e400aa005300fc010200a301530144011301200197015d017101a9013901f6016700c9022a0114007f01d900d8ffe100c7ff63005a0079017900a602ac01fa01830246000000f5011b00a7fe5bffbdff3cff8bffe6`

## 9. Registration gas estimate

Formula: per registration: 32000 create + 200 per code byte + 16 per calldata byte + 60000 overhead; the blob counted once as code and once as calldata.

| Set | Registrations | Bytes | Gas |
| --- | ---: | ---: | ---: |
| Targets | 100 | 653883 | 150,438,728 |
| Ligands | 152 | 76798 | 30,572,368 |
| Tables | 1 | 13010 | 2,902,160 |
| Total | 253 | 743691 | 183,913,256 |

## 10. Rerun

```
cd "/Users/medikamedika/USELESS JOURNEY/ponchem"
.venv/bin/python tools/pipeline/build_registry.py            # everything, cached downloads, about 2 minutes
.venv/bin/python tools/pipeline/build_registry.py --no-dock  # same without the three docking runs
.venv/bin/python tools/pipeline/build_pockets.py             # pockets only (add --download-only to just fill the cache)
.venv/bin/python tools/pipeline/build_topologies.py          # topologies only
.venv/bin/python tools/pipeline/select_targets.py            # registry.json and registry-reserve.json from the summaries
.venv/bin/python tools/pipeline/sanity.py                    # box check, docking, gas estimate
.venv/bin/python tools/pipeline/write_report.py              # this file
```

Single-target equivalents of what the pipeline ran (example, the first registry entry):

```
.venv/bin/python tools/engine/ponchem_engine.py pocket .tmp/pipeline/structures/6O0K.pdb --id 6O0K --ligand LBM --chain A --resseq 301 --out data/pockets/6O0K.bin
.venv/bin/python tools/engine/ponchem_engine.py topology data/ligands/QUERCETIN.sdf --out data/topologies/QUERCETIN.bin
.venv/bin/python tools/engine/ponchem_engine.py dock --pocket data/pockets/6SRH.bin --sdf data/ligands/QUERCETIN.sdf --tables data/tables --seed 1 --starts 4 --steps 1000
```

