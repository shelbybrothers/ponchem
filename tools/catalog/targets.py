#!/usr/bin/env python
"""Curate the PONCHEM target catalog (cancer receptors) from the RCSB Protein Data Bank.

Every field written to data/catalog/targets.json comes from a live RCSB response:

  search.rcsb.org/rcsbsearch/v2/query   finds candidate entries for a UniProt accession
  data.rcsb.org/graphql                 entry title, method, resolution, DOI, organism,
                                        chains, UniProt gene names, ligand chemistry
  files.rcsb.org/download/<ID>.pdb      atom coordinates, used to prove the reference
                                        ligand really sits on the recorded chain
  cdn.rcsb.org/images/structures/...    HEAD check that the image URL resolves

Nothing in the wishlist below is trusted: a target only reaches the JSON if the accession's
own UniProt record carries the gene symbol claimed for it, the pocket entity is human, the
method and resolution pass, and a ligand of drug size is found within CONTACT_A of the
chain's CA atoms.

Usage:
  .venv/bin/python tools/catalog/targets.py            # full run, uses the response cache
  PONCHEM_FRESH=1 ... targets.py                       # ignore the cache
  PONCHEM_ONLY=EGFR,BRAF ... targets.py                # a few targets, for debugging
  PONCHEM_LIMIT=5 ... targets.py                       # first N targets of the wishlist
Env:
  PONCHEM_CACHE   response cache directory (default: <tmp>/ponchem-rcsb-cache)
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

import requests
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")

# A cofactor test that does not depend on knowing every component id. Anything carrying a
# whole adenosine (6-aminopurine plus the ribose diol) or a flavin ring is a cofactor or a
# cofactor adduct: ATP, ADP, NAD, FAD, SAH, SAM, carba-NAD and the covalent FAD adducts of
# LSD1 inhibitors all match, while inhibitors with bare purine cores do not. Checked
# against 17 known cofactors and 19 known inhibitors, no misses either way.
_ADENINE = Chem.MolFromSmarts("[NX3]c1ncnc2c1nc[nX3]2")
_RIBOSE = Chem.MolFromSmarts("[CX4]1[OX2][CX4][CX4]([OX2H1])[CX4]1[OX2H1]")
_FLAVIN = Chem.MolFromSmarts("c1ccc2nc3c(nc2c1)[#6](=O)[#7][#6](=O)[#7]3")
_SMILES_CACHE = {}


def cofactor_fragment(ccd: str, smiles: str):
    """-> reason string when the SMILES carries a cofactor scaffold, else empty."""
    if not smiles:
        return ""
    if ccd in _SMILES_CACHE:
        return _SMILES_CACHE[ccd]
    mol = Chem.MolFromSmiles(smiles)
    verdict = ""
    if mol is not None:
        if mol.HasSubstructMatch(_ADENINE) and mol.HasSubstructMatch(_RIBOSE):
            verdict = "carries an adenosine cofactor fragment"
        elif mol.HasSubstructMatch(_FLAVIN):
            verdict = "carries a flavin cofactor ring"
    _SMILES_CACHE[ccd] = verdict
    return verdict

ROOT = Path(__file__).resolve().parents[2]
OUT_JSON = ROOT / "data" / "catalog" / "targets.json"

GRAPHQL = "https://data.rcsb.org/graphql"
SEARCH = "https://search.rcsb.org/rcsbsearch/v2/query"
FILES = "https://files.rcsb.org/download"
IMAGE = "https://cdn.rcsb.org/images/structures/{lower}_assembly-1.jpeg"

XRAY_MAX_RES = 2.8       # SPEC selection rule for X-ray entries
EM_MAX_RES = 3.2         # cryo-EM fallback, only when no X-ray entry qualifies
LIG_MIN_HEAVY = 12       # heavy atoms
LIG_MIN_FW = 150.0
LIG_MAX_FW = 1000.0
CONTACT_A = 6.0          # ligand must come within this of a CA atom of the chosen chain
SEARCH_ROWS = 50         # candidate entries pulled per target
DEEP_ROWS = 200          # second pass, for targets whose sharpest entries are all apo
GRAPHQL_BATCH = 20
POLITE = 0.2

# --------------------------------------------------------------------------------------
# Chemical components that can never be the reference ligand: ions, buffers, cryo salts,
# detergents, polyols, sugars, lipids and crystallisation junk.
# --------------------------------------------------------------------------------------
REJECT_CCD = {
    # buffers and crystallisation agents
    "MES", "EPE", "TRS", "HEPES", "BTB", "MPD", "GOL", "EDO", "PEG", "PGE", "PG4", "PG0",
    "1PE", "2PE", "7PE", "12P", "15P", "P6G", "PE3", "PE4", "PE5", "PE8", "XPE", "P33",
    "DIO", "DOX", "MRD", "IPA", "IOH", "ACT", "ACY", "FMT", "EEE", "TFA", "DMS", "DMF",
    "CIT", "FLC", "TLA", "MLA", "MLI", "SIN", "SUC", "GLC", "BGC", "MAN", "BMA", "NAG",
    "NDG", "GAL", "FUC", "XYS", "SGN", "GLA", "RIP", "SOR", "XYP", "TRE", "MAL", "LAT",
    "IMD", "IMZ", "BME", "DTT", "DTU", "DTV", "MPO", "NHE", "CAC", "PIN", "POP", "PPV",
    "URE", "GAI", "GVE", "BEN", "BEZ", "PHQ", "TAM", "TAR", "SRT", "AZI", "SCN", "NO3",
    "SO4", "SO3", "PO4", "2PO", "3PO", "IPS", "MSE", "OXL", "FUM", "AKG", "PYR", "LAC",
    "SPD", "SPM", "SPK", "PUT", "CRY", "ETX", "ETE", "BU1", "BU2", "BU3", "PDO", "PGR",
    "PGO", "PGQ", "MOH", "EOH", "ACN", "ACE", "NH4", "CYN", "CO3", "BCT", "HCO",
    # detergents, lipids, sterols
    "LDA", "LMT", "LMU", "DDQ", "C8E", "OCT", "OCE", "D10", "D12", "SDS", "TRT", "BOG",
    "HTG", "HTO", "F09", "P15", "P33", "PLM", "MYR", "STE", "OLA", "OLC", "OLB", "DAO",
    "CHD", "CPS", "CHS", "CLR", "Y01", "PC1", "PEE", "PEF", "PGT", "PGV", "PSC", "LHG",
    "HEX", "HEZ", "DEP", "MC3", "9PE", "POV", "3PE", "6PL", "LPP", "PX4", "L2P", "L3P",
    "D9G", "D10", "LI1", "JEF", "2NV",
    # metals and simple ions
    "ZN", "MG", "MN", "CA", "NA", "K", "CL", "BR", "IOD", "F", "FE", "FE2", "FES", "CU",
    "CU1", "NI", "CO", "CD", "HG", "AU", "AG", "PT", "PB", "CS", "RB", "SR", "BA", "LI",
    "IHP", "INS", "I3P", "4IP", "2IP", "B3P", "P3G", "P4G", "P6G", "PG6", "3PG", "DXC",
    "AL", "GA", "IN", "TL", "MO", "W", "V", "CR", "SE", "AS", "SB", "TE", "YB", "EU",
    "GD", "SM", "LU", "HO", "TB", "ER", "PR", "ND", "CE", "LA", "Y", "ZR", "NB", "RU",
    "RH", "PD", "OS", "IR", "RE", "TA", "HF", "BEF", "ALF", "AF3", "VO4", "WO4", "MOO",
    "4MO", "6MO", "OS4", "IUM", "UNX", "UNL", "UNK",
}

# Cofactors and their nucleotide analogs. Allowed only when a target has no inhibitor
# entry at all; every such pick is flagged cofactorAnalog in the JSON and in the report.
COFACTOR_CCD = {
    "ATP", "ADP", "AMP", "ANP", "ACP", "AGS", "APC", "ADX", "A2P", "AP5",
    "GTP", "GDP", "GNP", "GSP", "GCP", "G3P",
    "UTP", "UDP", "UMP", "UPG", "CTP", "CDP", "CMP", "TTP", "TMP", "5GP", "2GP",
    "NAD", "NAI", "NAP", "NDP", "NAX", "FAD", "FMN", "FDA", "COA", "ACO", "SAH", "SAM",
    "SFG", "TPP", "TDP", "PLP", "BTN", "H4B", "HBI", "THF", "B12", "COB", "HEM",
    "ADN", "AR6", "APR", "3AM", "PRX", "NMN", "NCN", "DND", "ADE", "GUN", "HPA",
    "HEC", "HEA", "HDD", "SRM", "F43", "MQ7", "UQ1", "PQQ", "LPA", "GSH", "GDS", "GTT",
}

CLASS_ORDER = [
    "kinase", "epigenetic", "apoptosis", "dna-damage", "hormone-receptor", "metabolism",
    "immuno-oncology", "transcription", "phosphatase", "protease", "protein-homeostasis",
    "structural", "other",
]

# --------------------------------------------------------------------------------------
# Wishlist. key, gene symbol, UniProt accession, label, class, cancer groups, why it
# matters, and optional preferred PDB entries (hints only; they are verified like any
# other candidate and dropped when they fail).
# --------------------------------------------------------------------------------------
def T(key, gene, uniprot, protein, cls, cancers, why, prefer=(), mutation=None, allow_em=False):
    return dict(key=key, gene=gene, uniprot=uniprot, protein=protein, cls=cls,
                cancers=list(cancers), why=why, prefer=list(prefer), mutation=mutation,
                allow_em=allow_em)


WISHLIST = [
    # ---------------------------------------------------------------- kinases
    T("EGFR", "EGFR", "P00533", "Epidermal growth factor receptor kinase domain", "kinase",
      ["lung", "colorectal", "head and neck"],
      "Driver of lung and head and neck tumours and the target of the first anilinoquinazoline drugs.",
      prefer=["1M17", "4WKQ", "2ITY"]),
    T("ERBB2", "ERBB2", "P04626", "HER2 receptor tyrosine kinase domain", "kinase",
      ["breast", "stomach", "esophageal"],
      "Amplified in breast and gastric tumours, the classic HER2 positive disease.",
      prefer=["3PP0", "3RCD"]),
    T("ERBB4", "ERBB4", "Q15303", "HER4 receptor tyrosine kinase domain", "kinase",
      ["breast", "lung"], "Fourth HER family kinase, mutated in melanoma and lung tumours.",
      prefer=["3BBT"]),
    T("ALK", "ALK", "Q9UM73", "Anaplastic lymphoma kinase domain", "kinase",
      ["lung", "lymphoma", "brain"],
      "Fusion driver in a subset of lung tumours and in anaplastic large cell lymphoma.",
      prefer=["2XP2", "4MKC"]),
    T("ROS1", "ROS1", "P08922", "ROS1 receptor tyrosine kinase domain", "kinase",
      ["lung", "brain"], "Rearranged in lung tumours and answers to crizotinib class drugs.",
      prefer=["3ZBF"]),
    T("MET", "MET", "P08581", "MET hepatocyte growth factor receptor kinase", "kinase",
      ["lung", "stomach", "kidney"],
      "Amplified or exon 14 skipped in lung and gastric tumours, drives invasion.",
      prefer=["3LQ8", "3DKC"]),
    T("RET", "RET", "P07949", "RET receptor tyrosine kinase domain", "kinase",
      ["thyroid", "lung"], "Fusions and point mutations drive thyroid and lung tumours.",
      prefer=["6NEC"]),
    T("BRAF", "BRAF", "P15056", "B-Raf serine threonine kinase domain", "kinase",
      ["melanoma", "colorectal", "thyroid"],
      "The V600E mutation is the best known melanoma driver.", prefer=["1UWH", "3OG7"]),
    T("RAF1", "RAF1", "P04049", "C-Raf serine threonine kinase domain", "kinase",
      ["lung", "pancreatic"], "Partner of BRAF in the MAPK cascade and a resistance route.",
      prefer=["3OMV"]),
    T("MAP2K1", "MAP2K1", "Q02750", "MEK1 dual specificity kinase", "kinase",
      ["melanoma", "lung", "colorectal"],
      "Relay below RAF, drugged with allosteric binders next to the nucleotide site.",
      prefer=["3EQC", "3DV3"]),
    T("MAP2K2", "MAP2K2", "P36507", "MEK2 dual specificity kinase", "kinase",
      ["melanoma", "colorectal"], "Second MEK isoform, shares the allosteric pocket.",
      prefer=["1S9J"]),
    T("MAPK1", "MAPK1", "P28482", "ERK2 mitogen activated kinase", "kinase",
      ["colorectal", "melanoma", "pancreatic"],
      "Final kinase of the MAPK cascade, hit when tumours escape RAF and MEK drugs.",
      prefer=["4QTE", "4QP2"]),
    T("MAPK14", "MAPK14", "Q16539", "p38 alpha mitogen activated kinase", "kinase",
      ["leukemia", "myeloma"], "Stress kinase feeding the inflammatory support of tumours.",
      prefer=["3FLN", "1A9U"]),
    T("MAPK7", "MAPK7", "Q13164", "ERK5 mitogen activated kinase", "kinase",
      ["breast", "leukemia"], "Parallel MAPK branch that sustains proliferation.", prefer=["4B99"]),
    T("KRAS", "KRAS", "P01116", "KRAS GTPase, switch II pocket", "kinase",
      ["pancreatic", "lung", "colorectal"],
      "The most common oncogene, reached through the switch II pocket of the G12C mutant.",
      prefer=["6OIM", "6USZ"], mutation="G12C"),
    T("KRASG12D", "KRAS", "P01116", "KRAS GTPase, G12D switch II pocket", "kinase",
      ["pancreatic", "colorectal"],
      "The G12D mutant dominates pancreatic tumours and needs its own chemistry.",
      prefer=["7RPZ", "8AZV"], mutation="G12D"),
    T("PIK3CA", "PIK3CA", "P42336", "PI3K alpha catalytic subunit", "kinase",
      ["breast", "cervical", "colorectal"],
      "Most mutated lipid kinase in breast tumours, upstream of AKT.", prefer=["4JPS", "8EXL"]),
    T("PIK3CD", "PIK3CD", "O00329", "PI3K delta catalytic subunit", "kinase",
      ["lymphoma", "leukemia"], "Lymphoid restricted PI3K, drugged in indolent lymphoma.",
      prefer=["4XE0"]),
    T("PIK3CG", "PIK3CG", "P48736", "PI3K gamma catalytic subunit", "kinase",
      ["lymphoma", "melanoma"], "Myeloid PI3K that shapes the tumour microenvironment.",
      prefer=["3DBS"]),
    T("AKT1", "AKT1", "P31749", "AKT1 serine threonine kinase", "kinase",
      ["breast", "prostate", "ovarian"],
      "Central survival kinase below PI3K, mutated in breast and prostate tumours.",
      prefer=["4EKL", "3O96"]),
    T("MTOR", "MTOR", "P42345", "mTOR kinase domain", "kinase",
      ["kidney", "breast", "lymphoma"],
      "Growth control hub, already drugged in kidney tumours.", prefer=["4JT6"], allow_em=True),
    T("CDK2", "CDK2", "P24941", "Cyclin dependent kinase 2", "kinase",
      ["ovarian", "breast", "leukemia"],
      "Cell cycle engine and the best studied ATP pocket in the kinome.", prefer=["1H00", "2R3I"]),
    T("CDK4", "CDK4", "P11802", "Cyclin dependent kinase 4", "kinase",
      ["breast", "sarcoma", "brain"],
      "Restriction point kinase, target of the palbociclib class.", prefer=["2W9Z"]),
    T("CDK6", "CDK6", "Q00534", "Cyclin dependent kinase 6", "kinase",
      ["breast", "leukemia", "lymphoma"],
      "Partner of CDK4 in the restriction point, drugged in breast tumours.",
      prefer=["2EUF", "5L2T"]),
    T("CDK1", "CDK1", "P06493", "Cyclin dependent kinase 1", "kinase",
      ["ovarian", "sarcoma"], "Mitotic entry kinase, essential in fast dividing tumours."),
    T("CDK7", "CDK7", "P50613", "Cyclin dependent kinase 7", "kinase",
      ["breast", "ovarian", "leukemia"],
      "Couples transcription to the cell cycle, hit in triple negative breast tumours."),
    T("CDK8", "CDK8", "P49336", "Cyclin dependent kinase 8", "kinase",
      ["colorectal", "leukemia"], "Mediator kinase that amplifies Wnt driven transcription.",
      prefer=["4F7S"]),
    T("CDK9", "CDK9", "P50750", "Cyclin dependent kinase 9", "kinase",
      ["leukemia", "lymphoma", "myeloma"],
      "Transcriptional kinase that keeps MCL1 and MYC levels high.", prefer=["4BCG", "3BLR"]),
    T("CDK12", "CDK12", "Q9NYV4", "Cyclin dependent kinase 12", "kinase",
      ["ovarian", "prostate"], "Loss creates a DNA repair defect in ovarian and prostate tumours."),
    T("AURKA", "AURKA", "O14965", "Aurora kinase A", "kinase",
      ["leukemia", "brain", "lung"], "Spindle pole kinase amplified in many solid tumours.",
      prefer=["3W2C", "2W1G"]),
    T("AURKB", "AURKB", "Q96GD4", "Aurora kinase B", "kinase",
      ["leukemia", "lymphoma"], "Chromosome segregation kinase, target of pan Aurora drugs."),
    T("PLK1", "PLK1", "P53350", "Polo like kinase 1", "kinase",
      ["leukemia", "lung", "sarcoma"], "Mitotic master kinase with a druggable polo box too.",
      prefer=["2RKU", "3FC2"]),
    T("WEE1", "WEE1", "P30291", "WEE1 G2 checkpoint kinase", "kinase",
      ["ovarian", "stomach", "sarcoma"],
      "Guards the G2 checkpoint, so blocking it pushes damaged tumour cells into mitosis.",
      prefer=["5TX1"]),
    T("CHEK1", "CHEK1", "O14757", "Checkpoint kinase 1", "kinase",
      ["ovarian", "lung", "leukemia"],
      "Replication stress checkpoint, a classic synthetic lethal partner.", prefer=["2E9N"]),
    T("CHEK2", "CHEK2", "O96017", "Checkpoint kinase 2", "kinase",
      ["breast", "prostate"], "Damage checkpoint kinase, germline mutated in breast tumours."),
    T("ATR", "ATR", "Q13535", "ATR checkpoint kinase", "dna-damage",
      ["ovarian", "lung", "leukemia"],
      "Senses replication stress and is drugged in tumours that already carry DNA repair defects.",
      allow_em=True),
    T("ATM", "ATM", "Q13315", "ATM damage response kinase", "dna-damage",
      ["leukemia", "lymphoma", "breast"],
      "Apex kinase of the double strand break response.", allow_em=True),
    T("PRKDC", "PRKDC", "P78527", "DNA dependent protein kinase catalytic subunit", "dna-damage",
      ["lung", "leukemia"], "Joins broken DNA ends, so inhibitors sensitise tumours to radiation.",
      allow_em=True),
    T("BTK", "BTK", "Q06187", "Bruton tyrosine kinase", "kinase",
      ["lymphoma", "leukemia"], "B cell receptor kinase, the ibrutinib target.",
      prefer=["5P9J", "3GEN"]),
    T("JAK1", "JAK1", "P23458", "Janus kinase 1", "kinase",
      ["leukemia", "lymphoma"], "Cytokine signal kinase used by lymphoid tumours.", prefer=["4E4N"]),
    T("JAK2", "JAK2", "O60674", "Janus kinase 2", "kinase",
      ["leukemia", "lymphoma", "myeloma"],
      "The V617F mutation drives myeloproliferative disease.", prefer=["3KRR", "4BBE"]),
    T("JAK3", "JAK3", "P52333", "Janus kinase 3", "kinase",
      ["leukemia", "lymphoma"], "Lymphoid cytokine kinase with a targetable cysteine."),
    T("TYK2", "TYK2", "P29597", "Tyrosine kinase 2", "kinase",
      ["leukemia", "lymphoma"], "JAK family kinase with a drugged pseudokinase pocket."),
    T("ABL1", "ABL1", "P00519", "ABL1 tyrosine kinase domain", "kinase",
      ["leukemia"], "The BCR ABL fusion started targeted cancer therapy with imatinib.",
      prefer=["2HYY", "1IEP", "3QRI"]),
    T("KIT", "KIT", "P10721", "KIT receptor tyrosine kinase domain", "kinase",
      ["sarcoma", "leukemia", "melanoma"],
      "Driver of gastrointestinal stromal tumours and some melanomas.", prefer=["1T46"]),
    T("FLT3", "FLT3", "P36888", "FLT3 receptor tyrosine kinase domain", "kinase",
      ["leukemia"], "Internal tandem duplications make it the main acute myeloid leukemia driver.",
      prefer=["4XUF", "4RT7"]),
    T("FGFR1", "FGFR1", "P11362", "FGFR1 kinase domain", "kinase",
      ["lung", "breast", "myeloma"], "Amplified in squamous lung and breast tumours.",
      prefer=["4V04", "4ZSA"]),
    T("FGFR2", "FGFR2", "P21802", "FGFR2 kinase domain", "kinase",
      ["stomach", "breast", "liver"], "Fused or amplified in gastric and bile duct tumours.",
      prefer=["3RI1"]),
    T("FGFR3", "FGFR3", "P22607", "FGFR3 kinase domain", "kinase",
      ["bladder", "myeloma"], "Mutated in bladder tumours and translocated in myeloma.",
      prefer=["4K33"]),
    T("FGFR4", "FGFR4", "P22455", "FGFR4 kinase domain", "kinase",
      ["liver"], "FGF19 driven liver tumours depend on it, and it has a unique cysteine.",
      prefer=["4XCU", "5JKG"]),
    T("KDR", "KDR", "P35968", "VEGFR2 kinase domain", "kinase",
      ["kidney", "liver", "colorectal"],
      "Main angiogenesis receptor, the target of sorafenib and its relatives.",
      prefer=["3VHE", "4ASD"]),
    T("PDGFRA", "PDGFRA", "P16234", "PDGFR alpha kinase domain", "kinase",
      ["sarcoma", "brain"], "Mutated in gastrointestinal stromal tumours and in glioma."),
    T("IGF1R", "IGF1R", "P08069", "IGF1 receptor kinase domain", "kinase",
      ["breast", "sarcoma", "prostate"],
      "Growth factor receptor that feeds resistance to other targeted drugs.", prefer=["3O23"]),
    T("SRC", "SRC", "P12931", "SRC tyrosine kinase", "kinase",
      ["colorectal", "breast", "pancreatic"],
      "The first oncogene product, still a hub for invasion signals.", prefer=["3G5D", "2SRC"]),
    T("LCK", "LCK", "P06239", "LCK tyrosine kinase", "kinase",
      ["leukemia", "lymphoma"], "T cell receptor kinase, drugged in T cell leukemia.",
      prefer=["2OF2"]),
    T("SYK", "SYK", "P43405", "Spleen tyrosine kinase", "kinase",
      ["lymphoma", "leukemia"], "B cell receptor kinase upstream of BTK.", prefer=["4FL2"]),
    T("ITK", "ITK", "Q08881", "Interleukin 2 inducible T cell kinase", "kinase",
      ["lymphoma"], "T cell kinase drugged in T cell lymphoma."),
    T("PTK2", "PTK2", "Q05397", "Focal adhesion kinase", "kinase",
      ["ovarian", "pancreatic", "melanoma"],
      "Connects the matrix to survival signals and supports metastasis."),
    T("PIM1", "PIM1", "P11309", "PIM1 kinase", "kinase",
      ["myeloma", "lymphoma", "prostate"],
      "Survival kinase with an unusual hinge, high in myeloma.", prefer=["2OBJ", "3BGQ"]),
    T("ROCK1", "ROCK1", "Q13464", "Rho associated kinase 1", "kinase",
      ["breast", "melanoma"], "Drives the cytoskeletal changes behind invasion."),
    T("GSK3B", "GSK3B", "P49841", "Glycogen synthase kinase 3 beta", "kinase",
      ["colorectal", "leukemia"], "Wnt pathway kinase with a dense chemistry record.",
      prefer=["1Q41"]),
    T("CSNK2A1", "CSNK2A1", "P68400", "Casein kinase 2 alpha", "kinase",
      ["leukemia", "liver"], "Constitutive kinase that props up many survival pathways.",
      prefer=["3NGA"]),
    T("CSNK1D", "CSNK1D", "P48730", "Casein kinase 1 delta", "kinase",
      ["leukemia", "brain"], "Circadian kinase that also stabilises beta catenin."),
    T("DDR1", "DDR1", "Q08345", "Discoidin domain receptor 1", "kinase",
      ["lung", "colorectal"], "Collagen receptor kinase linked to fibrotic tumour stroma.",
      prefer=["4BKJ"]),
    T("NTRK1", "NTRK1", "P04629", "TRKA kinase domain", "kinase",
      ["thyroid", "lung", "sarcoma"],
      "NTRK fusions are tumour agnostic drivers with approved drugs.", prefer=["4AOJ", "6D20"]),
    T("NTRK3", "NTRK3", "Q16288", "TRKC kinase domain", "kinase",
      ["sarcoma", "thyroid"], "Third TRK family kinase, also fused in rare tumours."),
    T("AXL", "AXL", "P30530", "AXL receptor tyrosine kinase", "kinase",
      ["lung", "leukemia", "pancreatic"],
      "Drives the mesenchymal escape from targeted therapy."),
    T("MERTK", "MERTK", "Q12866", "MERTK receptor tyrosine kinase", "kinase",
      ["leukemia", "melanoma"], "Macrophage clearance kinase, also a leukemia driver.",
      prefer=["3BPR"]),
    T("PDPK1", "PDPK1", "O15530", "PDK1 kinase domain", "kinase",
      ["breast", "prostate"], "Activates AKT and its relatives, a node below PI3K.",
      prefer=["3QD0"]),
    T("MAPKAPK2", "MAPKAPK2", "P49137", "MK2 kinase", "kinase",
      ["colorectal", "pancreatic"], "Downstream of p38, controls inflammatory support of tumours."),
    T("RIPK2", "RIPK2", "O43353", "Receptor interacting kinase 2", "kinase",
      ["colorectal", "lymphoma"], "Innate immune kinase that shapes inflamed tumour tissue."),
    T("TBK1", "TBK1", "Q9UHD2", "TANK binding kinase 1", "kinase",
      ["lung", "kidney"], "Links innate immunity to KRAS driven survival.", prefer=["4EUT"]),
    T("CSF1R", "CSF1R", "P07333", "CSF1 receptor kinase domain", "kinase",
      ["sarcoma", "brain", "breast"],
      "Controls tumour associated macrophages, drugged in tenosynovial tumours.", prefer=["4R7H"]),
    T("TEK", "TEK", "Q02763", "TIE2 receptor kinase domain", "kinase",
      ["kidney", "liver"], "Vessel stability receptor, a second angiogenesis route."),
    T("EPHA2", "EPHA2", "P29317", "EPHA2 receptor kinase domain", "kinase",
      ["brain", "breast", "prostate"], "Guides cell positioning and is high in aggressive tumours."),
    T("MKNK1", "MKNK1", "Q9BUB5", "MNK1 kinase", "kinase",
      ["leukemia", "lymphoma"], "Phosphorylates eIF4E and raises translation of oncogenes."),
    T("PRKCQ", "PRKCQ", "Q04759", "Protein kinase C theta", "kinase",
      ["lymphoma", "leukemia"], "T cell PKC isoform, a lymphoid signalling node."),
    T("MELK", "MELK", "Q14680", "Maternal embryonic leucine zipper kinase", "kinase",
      ["breast", "brain"], "Mitotic kinase high in basal breast tumours and glioma."),
    T("NEK2", "NEK2", "P51955", "NIMA related kinase 2", "kinase",
      ["breast", "myeloma"], "Centrosome kinase whose excess causes chromosome instability."),
    T("TTK", "TTK", "P33981", "MPS1 spindle checkpoint kinase", "kinase",
      ["breast", "lung"], "Spindle assembly checkpoint kinase, high in unstable tumours."),
    T("PAK1", "PAK1", "Q13153", "p21 activated kinase 1", "kinase",
      ["breast", "ovarian"], "Amplified with the 11q13 region and drives motility."),
    T("DYRK1A", "DYRK1A", "Q13627", "DYRK1A kinase", "kinase",
      ["leukemia", "brain"], "Dual specificity kinase tied to megakaryoblastic leukemia."),
    T("ACVR1", "ACVR1", "Q04771", "ALK2 activin receptor kinase", "kinase",
      ["brain"], "Mutated in diffuse midline glioma of children."),
    T("TGFBR1", "TGFBR1", "P36897", "TGF beta receptor 1 kinase", "kinase",
      ["pancreatic", "liver", "colorectal"],
      "Carries the immune suppressing TGF beta signal in stiff tumour stroma.", prefer=["3HMM"]),
    T("MAP4K1", "MAP4K1", "Q92918", "HPK1 kinase domain", "immuno-oncology",
      ["lung", "melanoma"], "Brake on T cell activation, so blocking it releases the immune attack."),
    T("SPHK1", "SPHK1", "Q9NYA1", "Sphingosine kinase 1", "metabolism",
      ["breast", "colorectal"], "Makes the survival lipid sphingosine 1 phosphate."),
    T("HASPIN", "GSG2", "Q8TF76", "Haspin histone kinase", "kinase",
      ["leukemia", "lung"], "Mitotic histone kinase that positions Aurora B."),

    # ---------------------------------------------------------------- epigenetic
    T("BRD4", "BRD4", "O60885", "BRD4 first bromodomain", "epigenetic",
      ["leukemia", "lymphoma", "myeloma"],
      "Reads acetylated histones and keeps MYC transcription running.", prefer=["3MXF", "4LYI"]),
    T("BRD2", "BRD2", "P25440", "BRD2 bromodomain", "epigenetic",
      ["leukemia", "lymphoma"], "BET family reader next to BRD4 in the same programme."),
    T("BRD9", "BRD9", "Q9H8M2", "BRD9 bromodomain", "epigenetic",
      ["sarcoma", "leukemia"], "Subunit of a remodelling complex that synovial sarcoma depends on."),
    T("ATAD2", "ATAD2", "Q6PL18", "ATAD2 bromodomain", "epigenetic",
      ["breast", "lung"], "Reader amplified in breast tumours and tied to poor outcome."),
    T("BRPF1", "BRPF1", "P55201", "BRPF1 bromodomain", "epigenetic",
      ["leukemia"], "Scaffold of a histone acetyltransferase complex in leukemia."),
    T("TRIM24", "TRIM24", "O15164", "TRIM24 bromodomain", "epigenetic",
      ["breast", "prostate"], "Reader that co-activates estrogen and androgen signals."),
    T("EZH2", "EZH2", "Q15910", "EZH2 methyltransferase, PRC2", "epigenetic",
      ["lymphoma", "sarcoma", "prostate"],
      "Silences tumour suppressors, mutated in follicular lymphoma.", prefer=["5IJ7", "5LS6"]),
    T("EED", "EED", "O75530", "EED, PRC2 regulatory subunit", "epigenetic",
      ["lymphoma", "sarcoma"], "Allosteric entry into PRC2 that works when EZH2 drugs fail."),
    T("DOT1L", "DOT1L", "Q8TEK3", "DOT1L histone methyltransferase", "epigenetic",
      ["leukemia"], "Required by MLL rearranged leukemia.", prefer=["4HRA"]),
    T("HDAC1", "HDAC1", "Q13547", "Histone deacetylase 1", "epigenetic",
      ["lymphoma", "leukemia", "myeloma"], "Core eraser in repressive complexes.",
      allow_em=True),
    T("HDAC2", "HDAC2", "Q92769", "Histone deacetylase 2", "epigenetic",
      ["colorectal", "lymphoma"], "Partner of HDAC1 in transcriptional silencing.", prefer=["4LXZ"]),
    T("HDAC6", "HDAC6", "Q9UBN7", "Histone deacetylase 6", "epigenetic",
      ["myeloma", "lymphoma"], "Cytoplasmic deacetylase that clears misfolded protein loads.",
      prefer=["5EDU"]),
    T("HDAC8", "HDAC8", "Q9BY41", "Histone deacetylase 8", "epigenetic",
      ["leukemia", "sarcoma"], "Deacetylase with the clearest crystal chemistry of the family.",
      prefer=["1T64"]),
    T("SIRT2", "SIRT2", "Q8IXJ6", "Sirtuin 2", "epigenetic",
      ["leukemia", "breast"], "NAD dependent deacetylase that stabilises MYC."),
    T("DNMT1", "DNMT1", "P26358", "DNA methyltransferase 1", "epigenetic",
      ["leukemia", "colorectal"], "Copies DNA methylation and locks silenced tumour suppressors."),
    T("KDM1A", "KDM1A", "O60341", "LSD1 histone demethylase", "epigenetic",
      ["leukemia", "lung"], "Demethylase that keeps leukemia cells immature.", prefer=["5LGT"]),
    T("KDM4A", "KDM4A", "O75164", "KDM4A histone demethylase", "epigenetic",
      ["prostate", "breast"], "Erases repressive marks and is amplified in prostate tumours."),
    T("KDM5B", "KDM5B", "Q9UGL1", "KDM5B histone demethylase", "epigenetic",
      ["breast", "melanoma"], "Demethylase tied to drug tolerant persister cells."),
    T("PRMT5", "PRMT5", "O14744", "PRMT5 arginine methyltransferase", "epigenetic",
      ["lymphoma", "brain", "pancreatic"],
      "Synthetic lethal in tumours that lost the MTAP gene.", prefer=["6RLQ"]),
    T("CARM1", "CARM1", "Q86X55", "CARM1 arginine methyltransferase", "epigenetic",
      ["breast", "leukemia"], "Co-activator methyltransferase in hormone driven tumours."),
    T("PRMT1", "PRMT1", "Q99873", "PRMT1 arginine methyltransferase", "epigenetic",
      ["leukemia", "liver"], "Main asymmetric arginine methyltransferase in blood tumours."),
    T("MEN1", "MEN1", "O00255", "Menin, MLL binding pocket", "epigenetic",
      ["leukemia"], "Blocking the menin MLL contact forces leukemia cells to mature.",
      prefer=["4GQ4", "6E1A"]),
    T("WDR5", "WDR5", "P61964", "WDR5 WIN site", "epigenetic",
      ["leukemia", "lymphoma"], "Adaptor that docks MLL and MYC onto chromatin."),
    T("CREBBP", "CREBBP", "Q92793", "CREB binding protein bromodomain", "epigenetic",
      ["lymphoma", "leukemia"], "Acetyltransferase mutated across lymphoma."),
    T("EP300", "EP300", "Q09472", "p300 acetyltransferase", "epigenetic",
      ["prostate", "lymphoma"], "Writes the acetyl marks that BET proteins read."),
    T("SMARCA2", "SMARCA2", "P51531", "BRM bromodomain", "epigenetic",
      ["lung", "kidney"], "Synthetic lethal partner in tumours that lost BRG1."),
    T("METTL3", "METTL3", "Q86U44", "METTL3 RNA methyltransferase", "epigenetic",
      ["leukemia"], "Writes m6A on RNA and supports acute myeloid leukemia."),
    T("KAT6A", "KAT6A", "Q92794", "KAT6A histone acetyltransferase", "epigenetic",
      ["breast", "leukemia"], "Acetyltransferase amplified in breast tumours."),
    T("PIN1", "PIN1", "Q13526", "PIN1 peptidyl prolyl isomerase", "other",
      ["breast", "prostate"], "Reshapes phosphorylated oncoproteins after they are marked."),

    # ---------------------------------------------------------------- apoptosis
    T("BCL2", "BCL2", "P10415", "BCL2 apoptosis regulator", "apoptosis",
      ["leukemia", "lymphoma", "myeloma"],
      "Keeps leukemia cells alive, and venetoclax proved the pocket is drugged.",
      prefer=["6O0K", "4MAN"]),
    T("BCL2L1", "BCL2L1", "Q07817", "BCL-xL apoptosis regulator", "apoptosis",
      ["lung", "colorectal", "lymphoma"],
      "Second survival protein of the family, common escape route from BCL2 drugs.",
      prefer=["3ZLR", "2YXJ"]),
    T("MCL1", "MCL1", "Q07820", "MCL1 apoptosis regulator", "apoptosis",
      ["myeloma", "leukemia", "lung"],
      "Amplified in myeloma and the main reason BCL2 drugs stop working.", prefer=["5FDR", "6QYO"]),
    T("XIAP", "XIAP", "P98170", "XIAP BIR3 domain", "apoptosis",
      ["ovarian", "leukemia"], "Blocks caspases, and small molecules mimic its natural antagonist."),
    T("MDM2", "MDM2", "Q00987", "MDM2 p53 binding domain", "apoptosis",
      ["sarcoma", "leukemia", "melanoma"],
      "Degrades p53, so blocking the contact restores the guardian in p53 normal tumours.",
      prefer=["4HG7", "4JRG"]),
    T("MDM4", "MDM4", "O15151", "MDMX p53 binding domain", "apoptosis",
      ["sarcoma", "brain"], "Partner of MDM2 that must be hit too in some tumours."),
    T("BIRC2", "BIRC2", "Q13490", "cIAP1 BIR3 domain", "apoptosis",
      ["lung", "lymphoma"], "Ubiquitin ligase that suppresses cell death signalling."),

    # ---------------------------------------------------------------- DNA damage
    T("PARP1", "PARP1", "P09874", "PARP1 catalytic domain", "dna-damage",
      ["ovarian", "breast", "prostate"],
      "Synthetic lethal with BRCA loss, the textbook case of targeted DNA repair.",
      prefer=["7KK4", "4UND"]),
    T("PARP2", "PARP2", "Q9UGN5", "PARP2 catalytic domain", "dna-damage",
      ["ovarian", "breast"], "Sister enzyme of PARP1 and part of the same drug response."),
    T("PARP7", "PARP7", "Q7Z3E1", "PARP7 catalytic domain", "dna-damage",
      ["lung"], "Mono ADP ribosyl transferase that dampens the interferon alarm."),
    T("PARG", "PARG", "Q86W56", "Poly ADP ribose glycohydrolase", "dna-damage",
      ["ovarian"], "Removes the PARP signal, so inhibiting it traps repair complexes."),
    T("TOP1", "TOP1", "P11387", "Topoisomerase I", "dna-damage",
      ["colorectal", "lung", "ovarian"],
      "Relaxes DNA and is poisoned by camptothecin from the happy tree.", prefer=["1T8I"]),
    T("TOP2A", "TOP2A", "P11388", "Topoisomerase II alpha", "dna-damage",
      ["breast", "lymphoma", "leukemia"],
      "Target of etoposide, which comes from mayapple resin.", prefer=["5GWK"]),
    T("DHFR", "DHFR", "P00374", "Dihydrofolate reductase", "dna-damage",
      ["leukemia", "lymphoma", "sarcoma"],
      "Folate enzyme blocked by methotrexate since the first chemotherapy era.",
      prefer=["1U72", "4M6J"]),
    T("TYMS", "TYMS", "P04818", "Thymidylate synthase", "dna-damage",
      ["colorectal", "stomach", "lung"],
      "Makes the DNA base thymidine and is the fluorouracil target.", prefer=["1HVY"]),
    T("RRM2", "RRM2", "P31350", "Ribonucleotide reductase subunit M2", "dna-damage",
      ["leukemia", "ovarian"], "Supplies the deoxynucleotides that replication needs."),
    T("NUDT1", "NUDT1", "P36639", "MTH1 nucleotide sanitiser", "dna-damage",
      ["colorectal", "lung"], "Clears oxidised nucleotides that tumours make in excess."),
    T("APEX1", "APEX1", "P27695", "APE1 base excision endonuclease", "dna-damage",
      ["colorectal", "ovarian"], "Cuts damaged bases out of DNA and is high in resistant tumours."),
    T("USP7", "USP7", "Q93009", "USP7 deubiquitinase", "dna-damage",
      ["leukemia", "myeloma", "brain"], "Stabilises MDM2, so blocking it lifts p53."),
    T("USP1", "USP1", "O94782", "USP1 deubiquitinase", "dna-damage",
      ["ovarian", "breast"], "Trims ubiquitin in the repair pathway BRCA tumours lean on."),
    T("POLQ", "POLQ", "O75417", "DNA polymerase theta helicase domain", "dna-damage",
      ["ovarian", "breast"], "Backup repair polymerase that BRCA tumours cannot live without."),
    T("FEN1", "FEN1", "P39748", "Flap endonuclease 1", "dna-damage",
      ["colorectal", "lung"], "Processes DNA flaps during replication and repair."),
    T("WRN", "WRN", "Q14191", "Werner syndrome helicase", "dna-damage",
      ["colorectal", "stomach"],
      "Essential in tumours with unstable short repeats.", allow_em=True),
    T("TNKS2", "TNKS2", "Q9H2K2", "Tankyrase 2 catalytic domain", "dna-damage",
      ["colorectal"], "PARP family enzyme that keeps Wnt signalling on in colon tumours.",
      prefer=["3KSB"]),

    # ---------------------------------------------------------------- hormone receptors
    T("ESR1", "ESR1", "P03372", "Estrogen receptor alpha ligand domain", "hormone-receptor",
      ["breast", "ovarian", "cervical"],
      "Drives most breast tumours and answers to tamoxifen and its successors.",
      prefer=["3ERT", "6B0F"]),
    T("AR", "AR", "P10275", "Androgen receptor ligand domain", "hormone-receptor",
      ["prostate"], "Central driver of prostate tumours at every stage.", prefer=["2AM9", "3L3X"]),
    T("PGR", "PGR", "P06401", "Progesterone receptor ligand domain", "hormone-receptor",
      ["breast", "ovarian"], "Shapes how breast tumours respond to hormone therapy."),
    T("NR3C1", "NR3C1", "P04150", "Glucocorticoid receptor ligand domain", "hormone-receptor",
      ["leukemia", "lymphoma", "myeloma"],
      "Steroid receptor used to kill lymphoid tumour cells."),
    T("CYP17A1", "CYP17A1", "P05093", "Steroid 17 alpha hydroxylase", "hormone-receptor",
      ["prostate"], "Cuts off androgen supply, the abiraterone target.", prefer=["3RUK"]),
    T("CYP19A1", "CYP19A1", "P11511", "Aromatase", "hormone-receptor",
      ["breast"], "Makes estrogen, blocked by the aromatase inhibitors.", prefer=["3EQM"]),
    T("AKR1C3", "AKR1C3", "P42330", "Aldo keto reductase 1C3", "hormone-receptor",
      ["prostate", "leukemia"], "Local androgen supply route in resistant prostate tumours."),

    # ---------------------------------------------------------------- metabolism
    T("IDH1", "IDH1", "O75874", "Isocitrate dehydrogenase 1", "metabolism",
      ["brain", "leukemia", "liver"],
      "The R132H mutant makes an oncometabolite that blocks cell maturation.",
      prefer=["5DE1", "6B0Z"]),
    T("IDH2", "IDH2", "P48735", "Isocitrate dehydrogenase 2, mitochondrial", "metabolism",
      ["leukemia", "brain"], "Mitochondrial partner of IDH1 with the same oncometabolite."),
    T("GLS", "GLS", "O94925", "Glutaminase, kidney type", "metabolism",
      ["breast", "kidney", "lung"], "Tumours addicted to glutamine depend on it."),
    T("LDHA", "LDHA", "P00338", "Lactate dehydrogenase A", "metabolism",
      ["lung", "pancreatic", "leukemia"], "Turns the Warburg sugar habit into lactate."),
    T("FASN", "FASN", "P49327", "Fatty acid synthase thioesterase domain", "metabolism",
      ["breast", "prostate", "liver"], "Builds the lipids that fast growing tumours need."),
    T("DHODH", "DHODH", "Q02127", "Dihydroorotate dehydrogenase", "metabolism",
      ["leukemia"], "Pyrimidine supply enzyme whose block forces leukemia cells to mature.",
      prefer=["6QU7"]),
    T("PKM", "PKM", "P14618", "Pyruvate kinase M2", "metabolism",
      ["lung", "liver", "colorectal"], "The tumour form of pyruvate kinase, tuned allosterically."),
    T("EGLN1", "EGLN1", "Q9GZT9", "Prolyl hydroxylase 2", "metabolism",
      ["kidney"], "Oxygen sensor that marks HIF for destruction."),
    T("EPAS1", "EPAS1", "Q99814", "HIF2 alpha PAS B domain", "metabolism",
      ["kidney"], "Transcription factor behind VHL mutant kidney tumours.", prefer=["4ZPK"]),
    T("VHL", "VHL", "P40337", "VHL substrate receptor", "metabolism",
      ["kidney"], "Lost in kidney tumours, and its pocket anchors degrader chemistry."),
    T("CA9", "CA9", "Q16790", "Carbonic anhydrase IX", "metabolism",
      ["kidney", "breast"], "Lets tumours survive their own acid, and sits on the cell surface."),
    T("NAMPT", "NAMPT", "P43490", "Nicotinamide phosphoribosyltransferase", "metabolism",
      ["leukemia", "lymphoma"], "Recycles NAD, which tumours consume quickly.", prefer=["2GVJ"]),
    T("NNMT", "NNMT", "P40261", "Nicotinamide N methyltransferase", "metabolism",
      ["pancreatic", "ovarian"], "Reprograms methyl supply in tumour stroma."),
    T("PHGDH", "PHGDH", "O43175", "Phosphoglycerate dehydrogenase", "metabolism",
      ["breast", "melanoma"], "First step of serine synthesis, amplified in breast tumours."),
    T("SHMT2", "SHMT2", "P34897", "Serine hydroxymethyltransferase 2", "metabolism",
      ["lymphoma", "brain"], "Feeds one carbon units to nucleotide synthesis."),
    T("MAT2A", "MAT2A", "P31153", "Methionine adenosyltransferase 2A", "metabolism",
      ["lymphoma", "pancreatic"], "Makes the universal methyl donor, synthetic lethal with MTAP loss."),
    T("MTAP", "MTAP", "Q13126", "Methylthioadenosine phosphorylase", "metabolism",
      ["pancreatic", "brain"], "Deleted with CDKN2A, which opens the PRMT5 weakness."),
    T("ALDH1A1", "ALDH1A1", "P00352", "Aldehyde dehydrogenase 1A1", "metabolism",
      ["ovarian", "lung"], "Marks the tumour cells that survive chemotherapy."),
    T("GPX4", "GPX4", "P36969", "Glutathione peroxidase 4", "metabolism",
      ["sarcoma", "kidney"], "Shields cells from iron driven death, a weakness of mesenchymal tumours."),
    T("HK2", "HK2", "P52789", "Hexokinase 2", "metabolism",
      ["liver", "lung"], "First step of the sugar habit that tumours rely on."),
    T("ACLY", "ACLY", "Q9NR19", "ATP citrate lyase", "metabolism",
      ["liver", "prostate"], "Turns citrate into the building block for tumour lipids."),
    T("GART", "GART", "P22102", "Trifunctional purine biosynthetic enzyme", "metabolism",
      ["lung", "lymphoma"], "Purine supply enzyme hit by pemetrexed class drugs."),
    T("CTPS1", "CTPS1", "P17812", "CTP synthase 1", "metabolism",
      ["lymphoma", "leukemia"], "Nucleotide enzyme that activated lymphocytes and lymphoma need."),
    T("NT5E", "NT5E", "P21589", "CD73 ecto 5 prime nucleotidase", "immuno-oncology",
      ["lung", "breast", "ovarian"], "Makes adenosine that shuts down T cells around the tumour."),
    T("DCK", "DCK", "P27707", "Deoxycytidine kinase", "metabolism",
      ["leukemia", "pancreatic"], "Activates gemcitabine and cytarabine inside the cell."),

    # ---------------------------------------------------------------- immuno-oncology
    T("IDO1", "IDO1", "P14902", "Indoleamine 2,3 dioxygenase 1", "immuno-oncology",
      ["melanoma", "lung", "ovarian"],
      "Burns tryptophan around the tumour and starves T cells.", prefer=["6AZV", "5XE1"]),
    T("TDO2", "TDO2", "Q16680", "Tryptophan 2,3 dioxygenase", "immuno-oncology",
      ["brain", "liver"], "Second tryptophan route that tumours use to suppress immunity."),
    T("CD274", "CD274", "Q9NZQ7", "PD-L1 immunoglobulin domains", "immuno-oncology",
      ["lung", "melanoma", "bladder"],
      "Checkpoint ligand, and small molecules can lock two copies together.", prefer=["5NIU"]),
    T("STING1", "STING1", "Q86WV6", "STING cyclic dinucleotide domain", "immuno-oncology",
      ["melanoma", "colorectal"], "Innate alarm that pulls immune cells into cold tumours."),
    T("ADORA2A", "ADORA2A", "P29274", "Adenosine A2A receptor", "immuno-oncology",
      ["lung", "kidney"], "Adenosine brake on T cells inside the tumour."),
    T("CXCR4", "CXCR4", "P61073", "CXCR4 chemokine receptor", "immuno-oncology",
      ["leukemia", "myeloma", "pancreatic"],
      "Holds tumour cells in the protective marrow niche.", prefer=["3ODU"]),
    T("PTPN11", "PTPN11", "Q06124", "SHP2 phosphatase, allosteric site", "phosphatase",
      ["lung", "leukemia", "pancreatic"],
      "Relays receptor signals into RAS and has a clean allosteric pocket.", prefer=["5EHR"]),
    T("PTPN2", "PTPN2", "P17706", "TC-PTP phosphatase", "phosphatase",
      ["melanoma", "colorectal"], "Removing it makes tumours visible to the immune system."),
    T("ARG1", "ARG1", "P05089", "Arginase 1", "immuno-oncology",
      ["lung", "colorectal"], "Strips arginine from the tumour area and disables T cells."),

    # ---------------------------------------------------------------- transcription and other
    T("STAT3", "STAT3", "P40763", "STAT3 transcription factor", "transcription",
      ["liver", "breast", "lymphoma"],
      "Carries inflammation into a survival programme in many tumours."),
    T("BCL6", "BCL6", "P41182", "BCL6 BTB domain", "transcription",
      ["lymphoma"], "Master regulator of diffuse large B cell lymphoma."),
    T("CTNNB1", "CTNNB1", "P35222", "Beta catenin armadillo domain", "transcription",
      ["colorectal", "liver"], "Wnt effector that turns on when colon tumours start."),
    T("KEAP1", "KEAP1", "Q14145", "KEAP1 Kelch domain", "transcription",
      ["lung"], "Mutated in lung tumours, which then overload their antioxidant defence."),
    T("HIF1A", "HIF1A", "Q16665", "HIF1 alpha PAS domain", "transcription",
      ["kidney", "breast"], "Master switch of the low oxygen response in tumour cores."),
    T("CRBN", "CRBN", "Q96SW2", "Cereblon substrate receptor", "protein-homeostasis",
      ["myeloma", "lymphoma"],
      "Thalidomide class drugs use it to destroy transcription factors myeloma needs."),
    T("XPO1", "XPO1", "O14980", "Exportin 1", "protein-homeostasis",
      ["myeloma", "lymphoma", "leukemia"],
      "Exports tumour suppressors out of the nucleus, blocked by selinexor.", allow_em=True),
    T("PSMB5", "PSMB5", "P28074", "Proteasome beta 5 subunit", "protein-homeostasis",
      ["myeloma", "lymphoma"],
      "The bortezomib site, and myeloma cells are unusually dependent on it.", allow_em=True),
    T("UBA3", "UBA3", "Q8TBC4", "NEDD8 activating enzyme catalytic subunit", "protein-homeostasis",
      ["leukemia", "lymphoma"], "Starts the NEDD8 pathway that controls many ubiquitin ligases."),
    T("HSP90AA1", "HSP90AA1", "P07900", "HSP90 alpha N terminal domain", "protein-homeostasis",
      ["breast", "lung", "myeloma"],
      "Folds the mutated kinases tumours depend on.", prefer=["3HZ5", "2XJX"]),
    T("TRAP1", "TRAP1", "Q12931", "TRAP1 mitochondrial chaperone", "protein-homeostasis",
      ["prostate", "colorectal"], "Mitochondrial HSP90 relative that tunes tumour metabolism."),
    T("HSPA8", "HSPA8", "P11142", "HSC70 nucleotide binding domain", "protein-homeostasis",
      ["breast", "leukemia"], "Chaperone partner of HSP90 in the same client cycle."),
    T("KIF11", "KIF11", "P52732", "Kinesin spindle protein Eg5", "structural",
      ["breast", "leukemia", "lung"],
      "Separates the spindle poles, an alternative to attacking tubulin.", prefer=["3KEN", "2Q2Z"]),
    T("SMO", "SMO", "Q99835", "Smoothened receptor", "other",
      ["brain", "melanoma"], "Hedgehog pathway receptor drugged in basal skin and brain tumours.",
      allow_em=True),
    T("MMP9", "MMP9", "P14780", "Matrix metalloproteinase 9", "protease",
      ["breast", "colorectal", "lung"], "Cuts the matrix open ahead of invading tumour cells."),
    T("MMP2", "MMP2", "P08253", "Matrix metalloproteinase 2", "protease",
      ["ovarian", "brain"], "Second gelatinase in the invasion programme."),
    T("PTGS2", "PTGS2", "P35354", "Cyclooxygenase 2", "other",
      ["colorectal", "stomach"], "Inflammatory enzyme whose block lowers colon tumour risk.",
      prefer=["5F19", "5IKQ"]),
    T("EIF4E", "EIF4E", "P06730", "Eukaryotic translation initiation factor 4E", "other",
      ["lymphoma", "prostate"], "Cap binding protein that sets how much oncoprotein is made."),
    T("EIF4A3", "EIF4A3", "P38919", "eIF4A3 RNA helicase", "other",
      ["leukemia", "lymphoma"],
      "RNA helicase blocked by rocaglates from the mahogany plant family."),
]


# --------------------------------------------------------------------------------------
# HTTP with a small on-disk cache
# --------------------------------------------------------------------------------------
CACHE = Path(os.environ.get("PONCHEM_CACHE") or (Path(tempfile.gettempdir()) / "ponchem-rcsb-cache"))
FRESH = bool(os.environ.get("PONCHEM_FRESH"))
CACHE.mkdir(parents=True, exist_ok=True)

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "ponchem-catalog/1.0 (RCSB curation script)"})

STATS = {"http": 0, "cache": 0}


def _cache_path(tag: str, key: str) -> Path:
    return CACHE / f"{tag}-{hashlib.sha1(key.encode()).hexdigest()[:20]}.cache"


def _request(tag: str, key: str, fn, text=False):
    path = _cache_path(tag, key)
    if path.exists() and not FRESH:
        STATS["cache"] += 1
        raw = path.read_text()
        if not raw.strip():
            return None
        return raw if text else json.loads(raw)
    delay = POLITE
    last = None
    for attempt in range(5):
        time.sleep(delay)
        try:
            resp = fn()
        except requests.RequestException as exc:
            last = exc
            delay = min(delay * 3, 8.0)
            continue
        STATS["http"] += 1
        if resp.status_code == 429:
            delay = min(max(delay * 3, 2.0), 20.0)
            last = "429"
            continue
        if resp.status_code == 404:
            return None
        if resp.status_code >= 500:
            delay = min(delay * 3, 8.0)
            last = resp.status_code
            continue
        resp.raise_for_status()
        raw = resp.text
        path.write_text(raw)
        # the search service answers 204 with an empty body when nothing matches
        if not raw.strip():
            return None
        return raw if text else json.loads(raw)
    print(f"  ! {tag} failed after retries ({last})", file=sys.stderr)
    return None


def graphql(query: str):
    body = json.dumps({"query": query})
    return _request("gql", body, lambda: SESSION.post(
        GRAPHQL, data=body, headers={"Content-Type": "application/json"}, timeout=90))


def search(payload: dict):
    body = json.dumps(payload, sort_keys=True)
    return _request("search", body, lambda: SESSION.post(
        SEARCH, data=body, headers={"Content-Type": "application/json"}, timeout=60))


def structure_text(pdb_id: str):
    """Coordinates for one entry: PDB format, falling back to mmCIF."""
    lower = pdb_id.lower()
    txt = _request("pdb", lower, lambda: SESSION.get(f"{FILES}/{pdb_id}.pdb", timeout=120), text=True)
    if txt and "ATOM" in txt:
        return ("pdb", txt)
    txt = _request("cif", lower, lambda: SESSION.get(f"{FILES}/{pdb_id}.cif", timeout=180), text=True)
    if txt:
        return ("cif", txt)
    return (None, None)


def image_ok(pdb_id: str) -> bool:
    url = IMAGE.format(lower=pdb_id.lower())
    key = "HEAD " + url
    path = _cache_path("img", key)
    if path.exists() and not FRESH:
        STATS["cache"] += 1
        return path.read_text().strip() == "200"
    time.sleep(POLITE)
    try:
        code = SESSION.head(url, timeout=30).status_code
    except requests.RequestException:
        return False
    STATS["http"] += 1
    path.write_text(str(code))
    return code == 200


# --------------------------------------------------------------------------------------
# Search: candidate entries for one accession
# --------------------------------------------------------------------------------------
def candidate_entries(uniprot: str, method: str, max_res: float, rows: int = SEARCH_ROWS):
    payload = {
        "query": {"type": "group", "logical_operator": "and", "nodes": [
            {"type": "terminal", "service": "text", "parameters": {
                "attribute": "rcsb_polymer_entity_container_identifiers."
                             "reference_sequence_identifiers.database_accession",
                "operator": "exact_match", "value": uniprot}},
            {"type": "terminal", "service": "text", "parameters": {
                "attribute": "rcsb_polymer_entity_container_identifiers."
                             "reference_sequence_identifiers.database_name",
                "operator": "exact_match", "value": "UniProt"}},
            {"type": "terminal", "service": "text", "parameters": {
                "attribute": "rcsb_entry_info.resolution_combined",
                "operator": "less_or_equal", "value": max_res}},
            {"type": "terminal", "service": "text", "parameters": {
                "attribute": "exptl.method", "operator": "exact_match", "value": method}},
            {"type": "terminal", "service": "text", "parameters": {
                "attribute": "rcsb_entry_info.nonpolymer_entity_count",
                "operator": "greater_or_equal", "value": 1}},
        ]},
        "return_type": "entry",
        "request_options": {
            "paginate": {"start": 0, "rows": rows},
            "sort": [{"sort_by": "rcsb_entry_info.resolution_combined", "direction": "asc"}],
            "results_content_type": ["experimental"],
        },
    }
    res = search(payload)
    if not res:
        return []
    return [r["identifier"] for r in res.get("result_set", [])]


ENTRY_QUERY = """{ entries(entry_ids:[%s]) {
  rcsb_id
  struct { title }
  rcsb_entry_info { resolution_combined }
  exptl { method }
  rcsb_primary_citation { pdbx_database_id_DOI pdbx_database_id_PubMed title journal_abbrev year }
  assemblies { rcsb_id rcsb_assembly_info { assembly_id } }
  polymer_entities {
    rcsb_id
    rcsb_entity_source_organism { scientific_name }
    rcsb_polymer_entity { pdbx_description pdbx_mutation }
    rcsb_polymer_entity_container_identifiers { auth_asym_ids uniprot_ids entity_id }
    uniprots { rcsb_id rcsb_uniprot_protein { name { value } gene { name { value } } } }
  }
  nonpolymer_entities {
    nonpolymer_comp {
      chem_comp { id name formula formula_weight type }
      rcsb_chem_comp_info { atom_count_heavy }
      rcsb_chem_comp_descriptor { SMILES_stereo InChIKey }
      rcsb_chem_comp_synonyms { name provenance_source type }
      drugbank { drugbank_info { name drug_groups } }
    }
    rcsb_nonpolymer_entity_container_identifiers { auth_asym_ids entity_id }
    nonpolymer_entity_instances {
      rcsb_nonpolymer_entity_instance_container_identifiers { auth_asym_id auth_seq_id }
    }
  } } }"""


def fetch_entries(ids):
    out = {}
    for i in range(0, len(ids), GRAPHQL_BATCH):
        chunk = ids[i:i + GRAPHQL_BATCH]
        q = ENTRY_QUERY % ",".join('"%s"' % c for c in chunk)
        res = graphql(q)
        if not res or not res.get("data") or res["data"].get("entries") is None:
            print(f"  ! graphql batch failed for {chunk[:3]}...", file=sys.stderr)
            continue
        for entry in res["data"]["entries"]:
            if entry:
                out[entry["rcsb_id"].upper()] = entry
    return out


# --------------------------------------------------------------------------------------
# Structure parsing: prove the ligand sits on the chain we record
# --------------------------------------------------------------------------------------
def parse_pdb(text: str):
    """-> (ca[chain] = [(x,y,z)], het[(chain, resname, resseq)] = [(x,y,z)])"""
    ca, het = {}, {}
    for line in text.splitlines():
        rec = line[:6]
        if rec == "ATOM  " or rec == "HETATM":
            element = line[76:78].strip().upper()
            if element == "H" or element == "D":
                continue
            try:
                xyz = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
            except ValueError:
                continue
            chain = line[21].strip()
            if rec == "ATOM  ":
                if line[12:16].strip() == "CA":
                    ca.setdefault(chain, []).append(xyz)
            else:
                resname = line[17:20].strip().upper()
                resseq = line[22:27].strip()
                het.setdefault((chain, resname, resseq), []).append(xyz)
    return ca, het


def parse_cif(text: str):
    ca, het = {}, {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].strip() == "loop_":
            j, cols = i + 1, []
            while j < len(lines) and lines[j].lstrip().startswith("_"):
                cols.append(lines[j].strip())
                j += 1
            if cols and cols[0].startswith("_atom_site."):
                idx = {c.split(".", 1)[1]: n for n, c in enumerate(cols)}
                need = ("group_PDB", "label_atom_id", "auth_asym_id", "auth_comp_id",
                        "auth_seq_id", "Cartn_x", "Cartn_y", "Cartn_z", "type_symbol")
                if not all(k in idx for k in need):
                    need_alt = {"auth_comp_id": "label_comp_id", "auth_asym_id": "label_asym_id",
                                "auth_seq_id": "label_seq_id"}
                    for k, alt in need_alt.items():
                        if k not in idx and alt in idx:
                            idx[k] = idx[alt]
                if all(k in idx for k in need):
                    k = j
                    while k < len(lines):
                        row = lines[k]
                        if row.startswith("#") or row.strip() == "loop_" or row.startswith("_"):
                            break
                        parts = row.split()
                        if len(parts) < len(cols):
                            k += 1
                            continue
                        if parts[idx["type_symbol"]].upper() in ("H", "D"):
                            k += 1
                            continue
                        try:
                            xyz = (float(parts[idx["Cartn_x"]]), float(parts[idx["Cartn_y"]]),
                                   float(parts[idx["Cartn_z"]]))
                        except ValueError:
                            k += 1
                            continue
                        chain = parts[idx["auth_asym_id"]]
                        if parts[idx["group_PDB"]] == "ATOM":
                            if parts[idx["label_atom_id"]].strip('"') == "CA":
                                ca.setdefault(chain, []).append(xyz)
                        else:
                            key = (chain, parts[idx["auth_comp_id"]].upper(),
                                   parts[idx["auth_seq_id"]])
                            het.setdefault(key, []).append(xyz)
                        k += 1
                    i = k
                    continue
            i = j
            continue
        i += 1
    return ca, het


def min_distance(a_list, b_list) -> float:
    best = 1e9
    for ax, ay, az in a_list:
        for bx, by, bz in b_list:
            d = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2
            if d < best:
                best = d
    return math.sqrt(best)


# --------------------------------------------------------------------------------------
# Ligand choice
# --------------------------------------------------------------------------------------
def ligand_name(comp) -> str:
    chem = comp["chem_comp"]
    db = (comp.get("drugbank") or {}).get("drugbank_info") or {}
    groups = [g.lower() for g in (db.get("drug_groups") or [])]
    if db.get("name") and ("approved" in groups or "investigational" in groups):
        return db["name"]
    syns = comp.get("rcsb_chem_comp_synonyms") or []
    short = [s["name"] for s in syns
             if s.get("provenance_source") == "PDB Reference Data"
             and s.get("type") == "Synonym" and len(s["name"]) <= 40]
    if short:
        return short[0].title() if short[0].isupper() else short[0]
    if db.get("name"):
        return db["name"]
    return chem["name"]


def drug_rank(comp) -> int:
    db = (comp.get("drugbank") or {}).get("drugbank_info") or {}
    groups = [g.lower() for g in (db.get("drug_groups") or [])]
    if "approved" in groups:
        return 3
    if "investigational" in groups or "experimental" in groups:
        return 2
    return 0


def classify(comp):
    chem = comp["chem_comp"]
    ccd = chem["id"].upper()
    if ccd in REJECT_CCD:
        return "reject", "buffer, ion or crystallisation agent"
    heavy = (comp.get("rcsb_chem_comp_info") or {}).get("atom_count_heavy")
    fw = chem.get("formula_weight")
    if heavy is None or heavy < LIG_MIN_HEAVY:
        return "reject", f"only {heavy} heavy atoms"
    if fw is None or fw < LIG_MIN_FW or fw > LIG_MAX_FW:
        return "reject", f"formula weight {fw}"
    ctype = (chem.get("type") or "").lower()
    if "saccharide" in ctype:
        return "reject", f"sugar, component type {chem.get('type')}"
    if "peptide linking" in ctype:
        return "reject", f"amino acid residue, component type {chem.get('type')}"
    if "dna linking" in ctype or "rna linking" in ctype:
        return "reject", f"nucleotide residue, component type {chem.get('type')}"
    if ccd in COFACTOR_CCD:
        return "cofactor", "cofactor or nucleotide analog of a cofactor"
    # obvious polyethylene glycol / polyol families not caught by the id list
    nm = (chem.get("name") or "").lower()
    if "polyethylene glycol" in nm or nm.startswith("peg ") or "detergent" in nm:
        return "reject", "polymer or detergent"
    if re.search(r"(tri|tetra|penta|hexa|hepta|octa|nona)oxa", nm) or "propane-1,3-diol" in nm:
        return "reject", "polyether or buffer"
    if "aminophosphonic" in nm or "diphosphono" in nm or "pyrophosphate" in nm:
        return "reject", "phosphate or pyrophosphate analog"
    if any(k in nm for k in ("cholic acid", "cholate", "deoxycholic", "cholan")):
        return "reject", "bile acid detergent"
    if "inositol" in nm and "phosphate" in nm:
        return "reject", "inositol phosphate, a structural cofactor"
    # nucleotide substrate fragments, for example 2'-deoxyguanosine-5'-monophosphate in a
    # nuclease active site: a substrate piece, not an inhibitor
    # reduced folates are cofactors; antifolate drugs such as methotrexate are not named
    # after the cofactor and stay eligible
    if any(k in nm for k in ("folinic", "tetrahydrofolate", "folic acid", "dihydrofolate",
                             "formyl-tetrahydro", "pteroylglutam")):
        return "cofactor", "reduced folate cofactor"
    # folinic acid and its relatives carry a reduced pteridine ring plus a glutamate tail
    # under a systematic name. Antifolate drugs such as methotrexate keep the oxidised
    # ring, so they are untouched by this test.
    if ("hexahydropteridin" in nm or "tetrahydropteridin" in nm) and "glutam" in nm:
        return "cofactor", "reduced folate cofactor"
    # sugar phosphates in a sugar kinase site are substrates
    if "phosphate" in nm and any(b in nm for b in ("glucose", "fructose", "mannose",
                                                   "galactose", "glucosamine", "ribulose")):
        return "cofactor", "sugar phosphate substrate"
    if any(k in nm for k in ("monophosphate", "diphosphate", "triphosphate")) and \
       any(b in nm for b in ("deoxy", "guanosine", "adenosine", "cytidine", "uridine",
                             "thymidine", "inosine", "ribose")):
        return "cofactor", "nucleotide substrate or cofactor fragment"
    if any(b in nm for b in ("guanylate", "adenylate", "cytidylate", "uridylate",
                             "thymidylate")):
        return "cofactor", "nucleotide substrate or cofactor fragment"
    frag = cofactor_fragment(ccd, (comp.get("rcsb_chem_comp_descriptor") or {}).get("SMILES_stereo"))
    if frag:
        return "cofactor", frag
    return "ok", ""


COORD_CHECKS = 6  # coordinate downloads per target, spent on the best ranked candidates


def pick_entry(target, entries, used_ids, log):
    """Rank candidates on metadata, then prove placement in the coordinates.

    Metadata comes from one batched GraphQL call per 20 entries. Coordinates cost a file
    download each, so only the best ranked candidates are opened, best first, and the
    first one whose ligand really touches the chain wins.
    """
    prefer = [p.upper() for p in target["prefer"]]
    scored = []
    for pdb_id, entry in entries.items():
        if pdb_id in used_ids:
            continue
        verdict = verify_metadata(target, pdb_id, entry, log)
        if verdict is None:
            continue
        score = 0.0
        # A cofactor complex is always the last resort: ATP, SAM, FAD and their relatives
        # carry DrugBank "approved" status, so the drug bonus must not lift them above a
        # real inhibitor complex. A hint cannot promote one either.
        if verdict["cofactor"]:
            score -= 5000
        else:
            # Only a marketed drug earns a bonus, and a small one: DrugBank also marks
            # endogenous molecules such as serotonin and caffeine as investigational, and
            # that must not outrank a real inhibitor with a larger pocket footprint.
            score += 260 + (60 if drug_rank(verdict["comp"]) == 3 else 0)
            score += 1000 if pdb_id in prefer else 0
        score += min(verdict["heavy"], 45)
        score -= 80 if verdict["heavy"] < 20 else 0   # fragment sized, still legal

        score += (XRAY_MAX_RES - verdict["resolution"]) * 8
        score += 12 if verdict["single_protein_entity"] else 0
        scored.append((score, pdb_id, verdict))
    if not scored:
        return None
    scored.sort(key=lambda s: (-s[0], s[1]))
    for score, pdb_id, verdict in scored[:COORD_CHECKS]:
        if verify_placement(verdict, log):
            return verdict
    return None


def verify_metadata(target, pdb_id, entry, log):
    """Selection rules that need no coordinates. Returns a dict or None with a reason."""
    def no(reason):
        log.append(f"{pdb_id}: {reason}")
        return None

    methods = [m["method"] for m in (entry.get("exptl") or []) if m.get("method")]
    res_list = (entry.get("rcsb_entry_info") or {}).get("resolution_combined") or []
    if not res_list:
        return no("no resolution")
    resolution = float(res_list[0])
    if "X-RAY DIFFRACTION" in methods:
        method = "X-RAY DIFFRACTION"
        if resolution > XRAY_MAX_RES:
            return no(f"X-ray resolution {resolution}")
    elif "ELECTRON MICROSCOPY" in methods and target["allow_em"]:
        method = "ELECTRON MICROSCOPY"
        if resolution > EM_MAX_RES:
            return no(f"cryo-EM resolution {resolution}")
    else:
        return no(f"method {methods}")

    # the polymer entity that holds the pocket: human, right accession, gene symbol proven
    pocket_entity = None
    protein_entities = 0
    for pe in entry.get("polymer_entities") or []:
        ids = (pe.get("rcsb_polymer_entity_container_identifiers") or {})
        organisms = [o.get("scientific_name") for o in (pe.get("rcsb_entity_source_organism") or [])]
        # RCSB records the organism with varying case, for example HOMO SAPIENS in older entries
        human = any((o or "").strip().lower() == "homo sapiens" for o in organisms)
        if human:
            protein_entities += 1
        if target["uniprot"] not in (ids.get("uniprot_ids") or []):
            continue
        if not human:
            return no(f"entity organism {organisms}")
        genes = []
        for up in pe.get("uniprots") or []:
            prot = up.get("rcsb_uniprot_protein") or {}
            for g in prot.get("gene") or []:
                for nm in g.get("name") or []:
                    if nm.get("value"):
                        genes.append(nm["value"].upper())
        if genes and target["gene"].upper() not in genes:
            return no(f"gene symbol mismatch, UniProt says {sorted(set(genes))[:4]}")
        pocket_entity = pe
        pocket_genes = genes
        break
    if pocket_entity is None:
        return no("no human polymer entity with that accession")

    if target["mutation"]:
        mut = ((pocket_entity.get("rcsb_polymer_entity") or {}).get("pdbx_mutation") or "").upper()
        title = ((entry.get("struct") or {}).get("title") or "").upper()
        if target["mutation"] not in mut and target["mutation"] not in title:
            return no(f"mutation {target['mutation']} not stated")

    chains = (pocket_entity.get("rcsb_polymer_entity_container_identifiers") or {}).get("auth_asym_ids") or []
    if not chains:
        return no("no auth chain ids")

    # ligand candidates
    cands = []
    for ne in entry.get("nonpolymer_entities") or []:
        comp = ne.get("nonpolymer_comp") or {}
        chem = comp.get("chem_comp") or {}
        if not chem.get("id"):
            continue
        kind, why = classify(comp)
        if kind == "reject":
            continue
        instances = []
        for inst in ne.get("nonpolymer_entity_instances") or []:
            ids = inst.get("rcsb_nonpolymer_entity_instance_container_identifiers") or {}
            if ids.get("auth_asym_id"):
                instances.append((ids["auth_asym_id"], str(ids.get("auth_seq_id") or "")))
        if not instances:
            for ch in ((ne.get("rcsb_nonpolymer_entity_container_identifiers") or {})
                       .get("auth_asym_ids") or []):
                instances.append((ch, ""))
        cands.append({"comp": comp, "ccd": chem["id"].upper(), "kind": kind,
                      "heavy": (comp.get("rcsb_chem_comp_info") or {}).get("atom_count_heavy"),
                      "fw": chem.get("formula_weight"), "instances": instances})
    if not cands:
        return no("no ligand of drug size")

    cands.sort(key=lambda c: (0 if c["kind"] == "ok" else 1, -drug_rank(c["comp"]), -c["heavy"]))
    best = cands[0]
    assemblies = [(a.get("rcsb_assembly_info") or {}).get("assembly_id")
                  for a in entry.get("assemblies") or []]
    return {
        "pdbId": pdb_id, "comp": best["comp"], "ccd": best["ccd"], "heavy": best["heavy"],
        "fw": best["fw"], "kind": best["kind"], "cofactor": best["kind"] == "cofactor",
        "candidates": cands, "chains": chains,
        "chain": None, "ligandSeq": None, "contact": None, "coordFormat": None,
        "resolution": resolution, "method": method,
        "title": (entry.get("struct") or {}).get("title") or "",
        "doi": (entry.get("rcsb_primary_citation") or {}).get("pdbx_database_id_DOI"),
        "pubmed": (entry.get("rcsb_primary_citation") or {}).get("pdbx_database_id_PubMed"),
        "citation": (entry.get("rcsb_primary_citation") or {}).get("title"),
        "description": (pocket_entity.get("rcsb_polymer_entity") or {}).get("pdbx_description"),
        "uniprotName": next((((up.get("rcsb_uniprot_protein") or {}).get("name") or {}).get("value")
                             for up in pocket_entity.get("uniprots") or []), None),
        "assembly": 1 if "1" in assemblies else (int(assemblies[0]) if assemblies and
                                                 str(assemblies[0]).isdigit() else 1),
        "single_protein_entity": protein_entities == 1,
        "genes": pocket_genes, "log": log,
    }


def verify_placement(v, log) -> bool:
    """Open the coordinates and prove a ligand of drug size sits on one of the chains.

    Fills chain, ligandSeq, contact, and rewrites the ligand choice to the one actually
    found in the pocket. Returns False (with a reason logged) when nothing qualifies.
    """
    pdb_id = v["pdbId"]
    fmt, text = structure_text(pdb_id)
    if not text:
        log.append(f"{pdb_id}: coordinates not downloadable")
        return False
    ca, het = parse_pdb(text) if fmt == "pdb" else parse_cif(text)
    if not ca:
        log.append(f"{pdb_id}: no CA atoms parsed")
        return False
    placement = None
    for cand in v["candidates"]:          # already ordered: inhibitors before cofactors
        for ch, seq in cand["instances"]:
            atoms = het.get((ch, cand["ccd"], seq))
            if atoms is None:
                hits = [val for (c2, r2, _s), val in het.items()
                        if r2 == cand["ccd"] and c2 == ch]
                atoms = hits[0] if hits else None
            if atoms is None:
                continue
            for chain in v["chains"]:
                if chain not in ca:
                    continue
                d = min_distance(ca[chain], atoms)
                if d <= CONTACT_A:
                    placement = {"cand": cand, "chain": chain, "seq": seq,
                                 "dist": round(d, 2), "atoms": len(atoms)}
                    break
            if placement:
                break
        if placement:
            break
    if placement is None:
        log.append(f"{pdb_id}: no ligand within {CONTACT_A} A of chains {v['chains']}")
        return False
    cand = placement["cand"]
    v.update(comp=cand["comp"], ccd=cand["ccd"], heavy=cand["heavy"], fw=cand["fw"],
             kind=cand["kind"], cofactor=cand["kind"] == "cofactor",
             chain=placement["chain"], ligandSeq=placement["seq"],
             contact=placement["dist"], coordAtoms=placement["atoms"], coordFormat=fmt)
    return True


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------
def main() -> int:
    only = {s.strip().upper() for s in (os.environ.get("PONCHEM_ONLY") or "").split(",") if s.strip()}
    limit = int(os.environ.get("PONCHEM_LIMIT") or 0)
    wishlist = [t for t in WISHLIST if not only or t["key"].upper() in only]
    if limit:
        wishlist = wishlist[:limit]

    keys = [t["key"] for t in wishlist]
    assert len(keys) == len(set(keys)), "duplicate target keys in the wishlist"

    results, failures, used_ids = [], [], set()
    for n, target in enumerate(wishlist, 1):
        log = []
        print(f"[{n}/{len(wishlist)}] {target['key']} ({target['uniprot']})", flush=True)
        ids = candidate_entries(target["uniprot"], "X-RAY DIFFRACTION", XRAY_MAX_RES)
        # preferred entries are hints: fetch them by id so they can be ranked even when the
        # search page (50 best resolutions) does not reach them. They pass the same checks.
        for pid in target["prefer"]:
            if pid.upper() not in {i.upper() for i in ids}:
                ids.append(pid.upper())
        entries = fetch_entries(ids) if ids else {}
        chosen = pick_entry(target, entries, used_ids, log) if entries else None
        # Second chance: the first page holds the 50 sharpest structures, which for some
        # targets are all apo, fragment or cofactor complexes. Look deeper before giving up
        # or settling for a cofactor.
        if chosen is None or chosen["cofactor"]:
            deep_ids = candidate_entries(target["uniprot"], "X-RAY DIFFRACTION",
                                         XRAY_MAX_RES, rows=DEEP_ROWS)
            extra = [i for i in deep_ids if i.upper() not in {k.upper() for k in entries}]
            if extra:
                deeper = fetch_entries(extra)
                better = pick_entry(target, deeper, used_ids, log) if deeper else None
                if better is not None and (chosen is None or not better["cofactor"]):
                    chosen = better
        if chosen is None and target["allow_em"]:
            em_ids = candidate_entries(target["uniprot"], "ELECTRON MICROSCOPY", EM_MAX_RES)
            em = fetch_entries(em_ids) if em_ids else {}
            chosen = pick_entry(target, em, used_ids, log) if em else None
        if chosen is None:
            reason = "; ".join(log[:4]) if log else "no entry matched the search filters"
            failures.append({"key": target["key"], "gene": target["gene"],
                             "uniprot": target["uniprot"], "candidates": len(entries),
                             "reason": reason})
            print(f"    dropped: {reason}", flush=True)
            continue
        used_ids.add(chosen["pdbId"])
        img = IMAGE.format(lower=chosen["pdbId"].lower())
        rec = {
            "key": target["key"], "gene": target["gene"], "uniprot": target["uniprot"],
            "protein": target["protein"], "pdbId": chosen["pdbId"], "title": chosen["title"],
            "method": chosen["method"], "resolution": round(chosen["resolution"], 2),
            "chain": chosen["chain"],
            "ligand": {
                "ccd": chosen["ccd"], "name": ligand_name(chosen["comp"]),
                "heavyAtoms": chosen["heavy"],
                "formulaWeight": round(float(chosen["fw"]), 2),
                "formula": (chosen["comp"]["chem_comp"] or {}).get("formula"),
                "smiles": ((chosen["comp"].get("rcsb_chem_comp_descriptor") or {})
                           .get("SMILES_stereo")),
                "inchiKey": ((chosen["comp"].get("rcsb_chem_comp_descriptor") or {})
                             .get("InChIKey")),
                "authSeqId": chosen["ligandSeq"] or None,
                "drugGroups": (((chosen["comp"].get("drugbank") or {}).get("drugbank_info") or {})
                               .get("drug_groups") or []),
                "cofactorAnalog": chosen["cofactor"],
                "contactDistanceA": chosen["contact"],
            },
            "cancers": target["cancers"], "why": target["why"], "class": target["cls"],
            "doi": chosen["doi"], "pubmed": chosen["pubmed"],
            "citation": chosen["citation"],
            "assembly": chosen["assembly"], "image": img,
            "entityDescription": chosen["description"],
            "uniprotName": chosen["uniprotName"],
        }
        results.append(rec)
        print(f"    {chosen['pdbId']} {chosen['resolution']} A chain {chosen['chain']} "
              f"ligand {chosen['ccd']} ({chosen['heavy']} heavy, {chosen['contact']} A)"
              f"{' COFACTOR' if chosen['cofactor'] else ''}", flush=True)

    # image URLs: HEAD check every chosen entry
    bad_images = []
    for rec in results:
        if not image_ok(rec["pdbId"]):
            bad_images.append(rec["pdbId"])
            rec["image"] = None
    if bad_images:
        print(f"image URL missing for: {', '.join(bad_images)}", file=sys.stderr)

    order = {c: i for i, c in enumerate(CLASS_ORDER)}
    results.sort(key=lambda r: (order.get(r["class"], 99), r["gene"], r["key"]))

    payload = {"generated": date.today().isoformat(), "source": "RCSB PDB",
               "targets": results}
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=1) + "\n")
    tmp.replace(OUT_JSON)

    side = CACHE / "targets-failures.json"
    side.write_text(json.dumps({"failures": failures, "badImages": bad_images}, indent=1))

    print(f"\nwrote {len(results)} targets to {OUT_JSON}")
    print(f"dropped {len(failures)}; http {STATS['http']} cache {STATS['cache']}")
    print(f"failure notes: {side}")
    cof = [r["key"] for r in results if r["ligand"]["cofactorAnalog"]]
    if cof:
        print(f"cofactor analog ligands: {', '.join(cof)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
