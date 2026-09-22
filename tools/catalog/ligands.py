#!/usr/bin/env python
"""Ponchem ligand catalog builder.

Curates bioactive plant compounds (and a few other natural products) with real 3D
coordinates, and writes:

  data/ligands/<KEY>.sdf              one heavy-atom SDF per ligand
  data/catalog/ligands.json           the catalog
  data/catalog/ligands-report.md      counts, drops, API calls
  data/catalog/candidates-ligands.md  every candidate and its outcome

Every id, formula, weight, SMILES and coordinate set comes from a live API response
(PubChem PUG REST, RCSB search API, RCSB data API, RCSB CCD ideal SDF). Nothing is
typed in by hand except the candidate names, the source organisms, the class and the
hedged one-line mechanism. The expected formula in the candidate table is only a
guard: when PubChem disagrees with it the compound is flagged and skipped, never
silently accepted.

Coordinate priority:
  1. rcsb-ccd:<ID>     RCSB Chemical Component Dictionary ideal coordinates, when the
                       component is the same molecule (graph match through the RCSB
                       search API, confirmed by RDKit canonical SMILES and, for the
                       defined stereo centres of the reference, by the stereo read
                       from the 3D coordinates).
  2. pubchem-3d:<CID>  PubChem 3D conformer.
  3. rdkit-etkdg:<CID> RDKit ETKDGv3 + MMFF94 from the PubChem isomeric SMILES, when
                       PubChem has no 3D record (large or very flexible molecules).

Usage:
  .venv/bin/python tools/catalog/ligands.py [--cache DIR] [--only KEY,KEY] [--offline]

Rerunnable: HTTP responses are cached on disk (default: a ponchem-ligand-cache folder
in the system temp dir), so a rerun after a network hiccup only fetches what is
missing. Output files are written atomically (temp file then rename).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
from collections import Counter, OrderedDict

import requests
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, Descriptors, rdMolDescriptors

RDLogger.DisableLog("rdApp.*")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIG_DIR = os.path.join(ROOT, "data", "ligands")
CAT_DIR = os.path.join(ROOT, "data", "catalog")

PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
RCSB_SEARCH = "https://search.rcsb.org/rcsbsearch/v2/query"
RCSB_DATA = "https://data.rcsb.org/rest/v1/core/chemcomp/"
RCSB_CCD_SDF = "https://files.rcsb.org/ligands/download/"

HEAVY_MIN, HEAVY_MAX = 10, 64
UA = {"User-Agent": "ponchem-catalog/1.0 (ligand curation; contact via ponchem.ai)"}

# ----------------------------------------------------------------------------
# Candidate table
# (key, display name, PubChem name query, expected formula guard, source plain,
#  source latin, class, hedged mechanism, approved drug flag, origin kingdom)
# ----------------------------------------------------------------------------
C = []


def cand(key, name, query, formula, plant, latin, cls, mech, drug=False, origin="plant"):
    C.append(dict(key=key, name=name, query=query, expect=formula, plant=plant, latin=latin,
                  cls=cls, mech=mech, drug=drug, origin=origin))


# flavonols
cand("QUERCETIN", "Quercetin", "quercetin", "C15H10O7", "onion, apple, capers",
     "Allium cepa, Malus domestica, Capparis spinosa", "flavonol",
     "reported to trigger apoptosis and cell cycle arrest in many tumour lines and to inhibit PI3K and other kinases")
cand("KAEMPFEROL", "Kaempferol", "kaempferol", "C15H10O6", "kale, broccoli, tea",
     "Brassica oleracea, Camellia sinensis", "flavonol",
     "reported to induce apoptosis and to inhibit angiogenesis and metastasis signalling")
cand("MYRICETIN", "Myricetin", "myricetin", "C15H10O8", "bayberry, walnut, grape",
     "Myrica rubra, Juglans regia, Vitis vinifera", "flavonol",
     "reported to inhibit PI3K and MEK1 and to promote apoptosis")
cand("FISETIN", "Fisetin", "fisetin", "C15H10O6", "strawberry, apple, persimmon",
     "Fragaria ananassa, Malus domestica, Diospyros kaki", "flavonol",
     "reported to inhibit CDK6 and to induce apoptosis in tumour cells")
cand("MORIN", "Morin", "morin", "C15H10O7", "Osage orange, guava, old fustic",
     "Maclura pomifera, Psidium guajava, Maclura tinctoria", "flavonol",
     "reported to suppress NF kappa B and STAT3 signalling in tumour cells")
# flavanonols
cand("TAXIFOLIN", "Taxifolin", "taxifolin", "C15H12O7", "Siberian larch, milk thistle",
     "Larix sibirica, Silybum marianum", "flavanonol",
     "reported to inhibit Wnt and beta catenin signalling in colorectal cancer cells")
cand("DIHYDROMYRICETIN", "Dihydromyricetin", "dihydromyricetin", "C15H12O8", "vine tea, oriental raisin tree",
     "Ampelopsis grossedentata, Hovenia dulcis", "flavanonol",
     "reported to induce apoptosis and autophagy and to sensitize tumour cells to chemotherapy")
# flavones
cand("APIGENIN", "Apigenin", "apigenin", "C15H10O5", "parsley, celery, chamomile",
     "Petroselinum crispum, Apium graveolens, Matricaria chamomilla", "flavone",
     "reported to arrest the cell cycle and to inhibit PI3K, Akt and STAT3 signalling")
cand("LUTEOLIN", "Luteolin", "luteolin", "C15H10O6", "celery, thyme, sweet pepper",
     "Apium graveolens, Thymus vulgaris, Capsicum annuum", "flavone",
     "reported to inhibit kinases and topoisomerases and to promote apoptosis")
cand("BAICALEIN", "Baicalein", "baicalein", "C15H10O5", "Baikal skullcap",
     "Scutellaria baicalensis", "flavone",
     "reported to inhibit 12 lipoxygenase and to block proliferation and invasion")
cand("WOGONIN", "Wogonin", "wogonin", "C16H12O5", "Baikal skullcap",
     "Scutellaria baicalensis", "flavone",
     "reported to inhibit CDK9 and to induce apoptosis in leukemia cells")
cand("CHRYSIN", "Chrysin", "chrysin", "C15H10O4", "passionflower, honey, propolis",
     "Passiflora caerulea", "flavone",
     "reported to inhibit aromatase and to promote apoptosis")
cand("NOBILETIN", "Nobiletin", "nobiletin", "C21H22O8", "citrus peel",
     "Citrus reticulata", "flavone",
     "reported to inhibit metastasis and to block MMP and Src signalling")
cand("TANGERETIN", "Tangeretin", "tangeretin", "C20H20O7", "tangerine peel",
     "Citrus reticulata", "flavone",
     "reported to arrest the cell cycle and to inhibit invasion")
cand("VITEXIN", "Vitexin", "vitexin", "C21H20O10", "hawthorn, mung bean, passionflower",
     "Crataegus monogyna, Vigna radiata, Passiflora incarnata", "flavone",
     "reported to induce apoptosis and autophagy in liver and colon cancer cells")
cand("ORIENTIN", "Orientin", "orientin", "C21H20O11", "holy basil, passion fruit, millet",
     "Ocimum tenuiflorum, Passiflora edulis, Eleusine coracana", "flavone",
     "reported to induce apoptosis and to reduce metastasis markers")
# flavanones
cand("NARINGENIN", "Naringenin", "naringenin", "C15H12O5", "grapefruit, orange",
     "Citrus paradisi, Citrus sinensis", "flavanone",
     "reported to arrest the cell cycle and to reduce migration")
cand("HESPERETIN", "Hesperetin", "hesperetin", "C16H14O6", "orange, lemon",
     "Citrus sinensis, Citrus limon", "flavanone",
     "reported to induce apoptosis and to inhibit Notch and PI3K signalling")
# isoflavones
cand("GENISTEIN", "Genistein", "genistein", "C15H10O5", "soybean",
     "Glycine max", "isoflavone",
     "reported to inhibit tyrosine kinases and topoisomerase II and to promote apoptosis")
cand("GLABRIDIN", "Glabridin", "glabridin", "C20H20O4", "licorice root",
     "Glycyrrhiza glabra", "isoflavan",
     "reported to inhibit migration and invasion and to promote apoptosis")
# flavanols and derived
cand("EGCG", "Epigallocatechin gallate", "epigallocatechin gallate", "C22H18O11", "green tea",
     "Camellia sinensis", "flavanol",
     "reported to inhibit growth factor receptors, the proteasome and DNMT and to promote apoptosis")
cand("PROCYANIDIN_B2", "Procyanidin B2", "procyanidin B2", "C30H26O12", "cocoa, apple, grape seed",
     "Theobroma cacao, Malus domestica, Vitis vinifera", "flavanol",
     "reported to induce apoptosis and to inhibit proliferation in prostate and colon lines")
cand("THEAFLAVIN", "Theaflavin", "theaflavin", "C29H24O12", "black tea",
     "Camellia sinensis", "flavanol",
     "reported to inhibit the proteasome and to induce apoptosis")
cand("SILIBININ", "Silibinin", "silibinin", "C25H22O10", "milk thistle",
     "Silybum marianum", "flavonolignan",
     "reported to inhibit EGFR and STAT3 signalling and to arrest the cell cycle")
# chalcones
cand("CARDAMONIN", "Cardamonin", "cardamonin", "C16H14O4", "cardamom, alpinia seed",
     "Alpinia katsumadai, Elettaria cardamomum", "chalcone",
     "reported to inhibit mTOR and NF kappa B signalling and to induce apoptosis")
cand("ISOLIQUIRITIGENIN", "Isoliquiritigenin", "isoliquiritigenin", "C15H12O4", "licorice root",
     "Glycyrrhiza glabra", "chalcone",
     "reported to arrest the cell cycle and to inhibit angiogenesis")
cand("LICOCHALCONE_A", "Licochalcone A", "licochalcone A", "C21H22O4", "licorice root",
     "Glycyrrhiza inflata", "chalcone",
     "reported to induce apoptosis and to inhibit PI3K and Akt signalling")
cand("PHLORETIN", "Phloretin", "phloretin", "C15H14O5", "apple, pear",
     "Malus domestica, Pyrus communis", "chalcone",
     "reported to inhibit glucose transporters and to induce apoptosis")
cand("XANTHOHUMOL", "Xanthohumol", "xanthohumol", "C21H22O5", "hops",
     "Humulus lupulus", "chalcone",
     "reported to inhibit NF kappa B and to induce apoptosis")
# anthocyanidins
cand("DELPHINIDIN", "Delphinidin", "delphinidin", "C15H11O7+", "blueberry, pomegranate, eggplant",
     "Vaccinium corymbosum, Punica granatum, Solanum melongena", "anthocyanidin",
     "reported to inhibit EGFR and HER2 signalling and to induce apoptosis")
cand("CYANIDIN", "Cyanidin", "cyanidin", "C15H11O6+", "black rice, cherry, blackberry",
     "Oryza sativa, Prunus avium, Rubus fruticosus", "anthocyanidin",
     "reported to inhibit inflammatory signalling and proliferation")
# stilbenes
cand("RESVERATROL", "Resveratrol", "resveratrol", "C14H12O3", "grape, Japanese knotweed",
     "Vitis vinifera, Reynoutria japonica", "stilbene",
     "reported to activate SIRT1, to inhibit COX2 and to induce apoptosis")
cand("PTEROSTILBENE", "Pterostilbene", "pterostilbene", "C16H16O3", "blueberry",
     "Vaccinium corymbosum", "stilbene",
     "reported to induce apoptosis and autophagy with better uptake than resveratrol")
cand("PICEATANNOL", "Piceatannol", "piceatannol", "C14H12O4", "passion fruit seed, grape",
     "Passiflora edulis, Vitis vinifera", "stilbene",
     "reported to inhibit Syk kinase and to induce apoptosis")
cand("COMBRETASTATIN_A4", "Combretastatin A4", "combretastatin A4", "C18H20O5", "African bushwillow",
     "Combretum caffrum", "stilbene",
     "reported to bind the colchicine site of tubulin and to collapse tumour blood vessels")
# curcuminoids
cand("CURCUMIN", "Curcumin", "curcumin", "C21H20O6", "turmeric",
     "Curcuma longa", "curcuminoid",
     "reported to inhibit NF kappa B, STAT3 and COX2 and to induce apoptosis")
# diterpenoids
cand("ANDROGRAPHOLIDE", "Andrographolide", "andrographolide", "C20H30O5", "king of bitters",
     "Andrographis paniculata", "diterpenoid",
     "reported to inhibit NF kappa B and to arrest the cell cycle")
cand("ORIDONIN", "Oridonin", "oridonin", "C20H28O6", "rabdosia",
     "Isodon rubescens", "diterpenoid",
     "reported to induce apoptosis and to degrade the AML1 ETO fusion protein in leukemia cells")
cand("TRIPTOLIDE", "Triptolide", "triptolide", "C20H24O6", "thunder god vine",
     "Tripterygium wilfordii", "diterpenoid",
     "reported to inhibit the XPB subunit of TFIIH and to shut down transcription")
cand("TANSHINONE_IIA", "Tanshinone IIA", "tanshinone IIA", "C19H18O3", "danshen, red sage",
     "Salvia miltiorrhiza", "diterpenoid quinone",
     "reported to induce apoptosis and to inhibit proliferation and angiogenesis")
cand("CRYPTOTANSHINONE", "Cryptotanshinone", "cryptotanshinone", "C19H20O3", "danshen, red sage",
     "Salvia miltiorrhiza", "diterpenoid quinone",
     "reported to inhibit STAT3 and to induce apoptosis")
cand("INGENOL_MEBUTATE", "Ingenol mebutate", "ingenol mebutate", "C25H34O6", "petty spurge",
     "Euphorbia peplus", "diterpenoid",
     "approved topical drug for actinic keratosis, reported to activate PKC and to cause rapid cell death", drug=True)
cand("PACLITAXEL", "Paclitaxel", "paclitaxel", "C47H51NO14", "Pacific yew bark",
     "Taxus brevifolia", "taxane",
     "approved chemotherapy, stabilizes microtubules and arrests mitosis", drug=True)
# triterpenoids
cand("BETULINIC_ACID", "Betulinic acid", "betulinic acid", "C30H48O3", "white birch bark",
     "Betula pendula", "triterpenoid",
     "reported to trigger mitochondrial apoptosis, notably in melanoma cells")
cand("BETULIN", "Betulin", "betulin", "C30H50O2", "birch bark",
     "Betula pendula", "triterpenoid",
     "reported to induce apoptosis and to inhibit proliferation")
cand("URSOLIC_ACID", "Ursolic acid", "ursolic acid", "C30H48O3", "apple peel, rosemary, holy basil",
     "Malus domestica, Rosmarinus officinalis, Ocimum tenuiflorum", "triterpenoid",
     "reported to inhibit NF kappa B and STAT3 and to induce apoptosis")
cand("OLEANOLIC_ACID", "Oleanolic acid", "oleanolic acid", "C30H48O3", "olive, clove",
     "Olea europaea, Syzygium aromaticum", "triterpenoid",
     "reported to inhibit proliferation and to induce apoptosis")
cand("COROSOLIC_ACID", "Corosolic acid", "corosolic acid", "C30H48O4", "banaba leaf",
     "Lagerstroemia speciosa", "triterpenoid",
     "reported to induce apoptosis and to suppress tumour associated macrophage signalling")
cand("ASIATIC_ACID", "Asiatic acid", "asiatic acid", "C30H48O5", "gotu kola",
     "Centella asiatica", "triterpenoid",
     "reported to induce apoptosis and to inhibit proliferation")
cand("GLYCYRRHETINIC_ACID", "Glycyrrhetinic acid", "glycyrrhetinic acid", "C30H46O4", "licorice root",
     "Glycyrrhiza glabra", "triterpenoid",
     "reported to inhibit 11 beta HSD and to induce apoptosis")
cand("LUPEOL", "Lupeol", "lupeol", "C30H50O", "mango, olive",
     "Mangifera indica, Olea europaea", "triterpenoid",
     "reported to inhibit Wnt and NF kappa B signalling")
cand("CELASTROL", "Celastrol", "celastrol", "C29H38O4", "thunder god vine",
     "Tripterygium wilfordii", "triterpenoid",
     "reported to inhibit HSP90, the proteasome and NF kappa B")
cand("CUCURBITACIN_B", "Cucurbitacin B", "cucurbitacin B", "C32H46O8", "bitter melon, cucumber family",
     "Momordica charantia, Cucumis sativus", "triterpenoid",
     "reported to inhibit STAT3 and to disrupt the actin cytoskeleton")
cand("GINSENOSIDE_RG3", "Ginsenoside Rg3", "ginsenoside Rg3", "C42H72O13", "Korean red ginseng",
     "Panax ginseng", "triterpenoid saponin",
     "reported to inhibit angiogenesis and metastasis")
cand("GINSENOSIDE_RH2", "Ginsenoside Rh2", "ginsenoside Rh2", "C36H62O8", "ginseng",
     "Panax ginseng", "triterpenoid saponin",
     "reported to induce apoptosis and to inhibit proliferation")
cand("LIMONIN", "Limonin", "limonin", "C26H30O8", "citrus seed",
     "Citrus limon", "limonoid",
     "reported to induce apoptosis and to inhibit proliferation in colon and breast lines")
cand("NOMILIN", "Nomilin", "nomilin", "C28H34O9", "citrus seed",
     "Citrus sinensis", "limonoid",
     "reported to induce glutathione S transferase and to inhibit proliferation")
cand("OBACUNONE", "Obacunone", "obacunone", "C26H30O7", "citrus seed",
     "Citrus sinensis", "limonoid",
     "reported to inhibit aromatase and proliferation")
# sesquiterpene lactones and sesquiterpenoids
cand("PARTHENOLIDE", "Parthenolide", "parthenolide", "C15H20O3", "feverfew",
     "Tanacetum parthenium", "sesquiterpene lactone",
     "reported to inhibit NF kappa B and to target leukemia stem cells")
cand("COSTUNOLIDE", "Costunolide", "costunolide", "C15H20O2", "costus root, bay laurel",
     "Saussurea costus, Laurus nobilis", "sesquiterpene lactone",
     "reported to induce apoptosis and to inhibit NF kappa B")
cand("ALANTOLACTONE", "Alantolactone", "alantolactone", "C15H20O2", "elecampane",
     "Inula helenium", "sesquiterpene lactone",
     "reported to inhibit STAT3 and to induce ROS driven apoptosis")
cand("HELENALIN", "Helenalin", "helenalin", "C15H18O4", "arnica",
     "Arnica montana", "sesquiterpene lactone",
     "reported to inhibit NF kappa B and telomerase")
cand("ARTEMISININ", "Artemisinin", "artemisinin", "C15H22O5", "sweet wormwood",
     "Artemisia annua", "sesquiterpene lactone",
     "endoperoxide reported to generate iron dependent radicals and to kill tumour cells")
cand("ZERUMBONE", "Zerumbone", "zerumbone", "C15H22O", "shampoo ginger",
     "Zingiber zerumbet", "sesquiterpenoid",
     "reported to inhibit NF kappa B and to induce apoptosis")
cand("BETA_ELEMENE", "beta-Elemene", "beta-elemene", "C15H24", "wenyujin rhizome",
     "Curcuma wenyujin", "sesquiterpenoid",
     "reported to arrest the cell cycle, used in China as an anticancer injection")
cand("ALPHA_HUMULENE", "alpha-Humulene", "alpha-humulene", "C15H24", "hops, balsam fir",
     "Humulus lupulus, Abies balsamea", "sesquiterpenoid",
     "reported to be cytotoxic to tumour lines through glutathione depletion")
cand("CARYOPHYLLENE_OXIDE", "Caryophyllene oxide", "caryophyllene oxide", "C15H24O", "clove, black pepper",
     "Syzygium aromaticum, Piper nigrum", "sesquiterpenoid",
     "reported to inhibit PI3K, Akt and mTOR signalling and to induce apoptosis")
cand("NEROLIDOL", "Nerolidol", "nerolidol", "C15H26O", "neroli, ginger",
     "Citrus aurantium, Zingiber officinale", "sesquiterpenoid",
     "reported to induce apoptosis and to raise drug uptake in tumour cells")
cand("FARNESOL", "Farnesol", "farnesol", "C15H26O", "citronella, lemongrass",
     "Cymbopogon nardus, Cymbopogon citratus", "sesquiterpenoid",
     "reported to induce apoptosis and to inhibit proliferation")
cand("GOSSYPOL", "Gossypol", "gossypol", "C30H30O8", "cotton seed",
     "Gossypium hirsutum", "sesquiterpenoid",
     "reported to inhibit Bcl 2 family proteins and to induce apoptosis")
# monoterpenoids and simple phenylpropanoids
cand("PERILLYL_ALCOHOL", "Perillyl alcohol", "cid:369312", "C10H16O", "perilla, lavender, cherry",
     "Perilla frutescens, Lavandula angustifolia, Prunus avium", "monoterpenoid",
     "reported to inhibit Ras farnesylation and to induce apoptosis")
cand("GERANIOL", "Geraniol", "geraniol", "C10H18O", "rose, palmarosa, lemongrass",
     "Rosa damascena, Cymbopogon martinii", "monoterpenoid",
     "reported to inhibit HMG CoA reductase and to induce apoptosis")
cand("CARVACROL", "Carvacrol", "carvacrol", "C10H14O", "oregano, thyme",
     "Origanum vulgare, Thymus vulgaris", "monoterpenoid",
     "reported to induce apoptosis and to inhibit proliferation")
cand("THYMOL", "Thymol", "thymol", "C10H14O", "thyme",
     "Thymus vulgaris", "monoterpenoid",
     "reported to induce apoptosis and ROS in tumour cells")
cand("THYMOQUINONE", "Thymoquinone", "thymoquinone", "C10H12O2", "black seed",
     "Nigella sativa", "benzoquinone",
     "reported to inhibit NF kappa B and STAT3 and to induce apoptosis")
cand("CINNAMALDEHYDE", "Cinnamaldehyde", "cinnamaldehyde", "C9H8O", "cinnamon bark",
     "Cinnamomum verum", "phenylpropanoid",
     "reported to induce apoptosis and to inhibit NF kappa B")
cand("EUGENOL", "Eugenol", "eugenol", "C10H12O2", "clove",
     "Syzygium aromaticum", "phenylpropanoid",
     "reported to induce apoptosis and to inhibit proliferation")
cand("FERULIC_ACID", "Ferulic acid", "ferulic acid", "C10H10O4", "rice bran, wheat",
     "Oryza sativa, Triticum aestivum", "phenolic acid",
     "reported to reduce proliferation and to protect against oxidative DNA damage")
cand("CAPE", "Caffeic acid phenethyl ester", "caffeic acid phenethyl ester", "C17H16O4",
     "propolis, poplar bud resin", "Populus nigra", "phenylpropanoid",
     "reported to inhibit NF kappa B and to induce apoptosis")
cand("ROSMARINIC_ACID", "Rosmarinic acid", "rosmarinic acid", "C18H16O8", "rosemary, lemon balm",
     "Rosmarinus officinalis, Melissa officinalis", "phenolic acid",
     "reported to inhibit proliferation, angiogenesis and inflammatory signalling")
cand("CHLOROGENIC_ACID", "Chlorogenic acid", "chlorogenic acid", "C16H18O9", "coffee, artichoke",
     "Coffea arabica, Cynara scolymus", "phenolic acid",
     "reported to inhibit proliferation and to induce differentiation")
cand("SALVIANOLIC_ACID_A", "Salvianolic acid A", "salvianolic acid A", "C26H22O10", "danshen, red sage",
     "Salvia miltiorrhiza", "phenolic acid",
     "reported to reverse multidrug resistance and to inhibit proliferation")
cand("ELLAGIC_ACID", "Ellagic acid", "ellagic acid", "C14H6O8", "pomegranate, raspberry, walnut",
     "Punica granatum, Rubus idaeus, Juglans regia", "polyphenol",
     "reported to inhibit proliferation and angiogenesis and to arrest the cell cycle")
# vanilloids
cand("CAPSAICIN", "Capsaicin", "capsaicin", "C18H27NO3", "chili pepper",
     "Capsicum annuum", "vanilloid",
     "reported to trigger mitochondrial apoptosis and to inhibit STAT3")
cand("GINGEROL", "6-Gingerol", "6-gingerol", "C17H26O4", "ginger",
     "Zingiber officinale", "vanilloid",
     "reported to induce apoptosis and to inhibit proliferation and angiogenesis")
cand("PIPERINE", "Piperine", "piperine", "C17H19NO3", "black pepper",
     "Piper nigrum", "alkaloid",
     "reported to inhibit P glycoprotein and to induce apoptosis")
# alkaloids
cand("BERBERINE", "Berberine", "berberine", "C20H18NO4+", "barberry, goldenseal",
     "Berberis vulgaris, Hydrastis canadensis", "alkaloid",
     "reported to arrest the cell cycle, to bind DNA and to inhibit topoisomerases")
cand("EVODIAMINE", "Evodiamine", "evodiamine", "C19H17N3O", "evodia fruit",
     "Tetradium ruticarpum", "alkaloid",
     "reported to inhibit topoisomerase I and to arrest mitosis")
cand("RUTAECARPINE", "Rutaecarpine", "rutaecarpine", "C18H13N3O", "evodia fruit",
     "Tetradium ruticarpum", "alkaloid",
     "reported to inhibit COX2 and to induce apoptosis")
cand("TETRANDRINE", "Tetrandrine", "tetrandrine", "C38H42N2O6", "stephania root",
     "Stephania tetrandra", "alkaloid",
     "reported to induce autophagy and apoptosis and to block calcium channels")
cand("SANGUINARINE", "Sanguinarine", "sanguinarine", "C20H14NO4+", "bloodroot",
     "Sanguinaria canadensis", "alkaloid",
     "reported to induce apoptosis and to inhibit NF kappa B")
cand("CHELERYTHRINE", "Chelerythrine", "chelerythrine", "C21H18NO4+", "greater celandine",
     "Chelidonium majus", "alkaloid",
     "reported to inhibit PKC and Bcl xL")
cand("MATRINE", "Matrine", "matrine", "C15H24N2O", "sophora root",
     "Sophora flavescens", "alkaloid",
     "reported to inhibit proliferation and to induce apoptosis")
cand("HARMINE", "Harmine", "harmine", "C13H12N2O", "Syrian rue",
     "Peganum harmala", "alkaloid",
     "reported to inhibit DYRK1A and to intercalate DNA")
cand("INDIRUBIN", "Indirubin", "cid:5318433", "C16H10N2O2", "indigo plant, woad",
     "Indigofera tinctoria, Isatis tinctoria", "alkaloid",
     "reported to inhibit CDKs and GSK3 beta")
cand("LYCORINE", "Lycorine", "lycorine", "C16H17NO4", "daffodil, red spider lily",
     "Narcissus pseudonarcissus, Lycoris radiata", "alkaloid",
     "reported to inhibit protein synthesis and to induce apoptosis")
cand("NOSCAPINE", "Noscapine", "noscapine", "C22H23NO7", "opium poppy",
     "Papaver somniferum", "alkaloid",
     "reported to bind tubulin and to arrest mitosis")
cand("CAMPTOTHECIN", "Camptothecin", "camptothecin", "C20H16N2O4", "happy tree",
     "Camptotheca acuminata", "alkaloid",
     "reported to trap topoisomerase I on DNA, parent of irinotecan and topotecan")
cand("COLCHICINE", "Colchicine", "colchicine", "C22H25NO6", "autumn crocus",
     "Colchicum autumnale", "alkaloid",
     "reported to bind tubulin and to block microtubule assembly")
cand("HOMOHARRINGTONINE", "Homoharringtonine", "homoharringtonine", "C29H39NO9", "plum yew",
     "Cephalotaxus harringtonii", "alkaloid",
     "approved drug for chronic myeloid leukemia, inhibits protein synthesis at the ribosome", drug=True)
cand("VINCRISTINE", "Vincristine", "vincristine", "C46H56N4O10", "Madagascar periwinkle",
     "Catharanthus roseus", "alkaloid",
     "approved chemotherapy, binds tubulin and blocks mitosis", drug=True)
cand("VINBLASTINE", "Vinblastine", "vinblastine", "C46H58N4O9", "Madagascar periwinkle",
     "Catharanthus roseus", "alkaloid",
     "approved chemotherapy, binds tubulin and blocks mitosis", drug=True)
# lignans
cand("PODOPHYLLOTOXIN", "Podophyllotoxin", "podophyllotoxin", "C22H22O8", "mayapple",
     "Podophyllum peltatum", "lignan",
     "reported to bind tubulin, parent of etoposide and teniposide")
cand("SESAMIN", "Sesamin", "sesamin", "C20H18O6", "sesame seed",
     "Sesamum indicum", "lignan",
     "reported to inhibit NF kappa B and STAT3")
cand("ARCTIGENIN", "Arctigenin", "arctigenin", "C21H24O6", "greater burdock",
     "Arctium lappa", "lignan",
     "reported to kill tumour cells under nutrient starvation and to inhibit STAT3")
cand("MATAIRESINOL", "Matairesinol", "matairesinol", "C20H22O6", "flax, sesame",
     "Linum usitatissimum, Sesamum indicum", "lignan",
     "reported to induce apoptosis and to modulate estrogen signalling")
cand("SECOISOLARICIRESINOL", "Secoisolariciresinol", "secoisolariciresinol", "C20H26O6", "flaxseed",
     "Linum usitatissimum", "lignan",
     "reported to reduce proliferation of hormone dependent tumour cells")
cand("HONOKIOL", "Honokiol", "honokiol", "C18H18O2", "magnolia bark",
     "Magnolia officinalis", "neolignan",
     "reported to inhibit NF kappa B and EGFR and to induce apoptosis")
cand("MAGNOLOL", "Magnolol", "magnolol", "C18H18O2", "magnolia bark",
     "Magnolia officinalis", "neolignan",
     "reported to induce apoptosis and to inhibit invasion")
# quinones
cand("EMODIN", "Emodin", "emodin", "C15H10O5", "rhubarb, Japanese knotweed",
     "Rheum palmatum, Reynoutria japonica", "anthraquinone",
     "reported to inhibit CK2 and to induce apoptosis")
cand("ALOE_EMODIN", "Aloe-emodin", "aloe-emodin", "C15H10O5", "aloe, rhubarb",
     "Aloe vera, Rheum palmatum", "anthraquinone",
     "reported to arrest the cell cycle and to induce apoptosis")
cand("CHRYSOPHANOL", "Chrysophanol", "chrysophanol", "C15H10O4", "rhubarb",
     "Rheum palmatum", "anthraquinone",
     "reported to induce necrosis through ATP depletion")
cand("PHYSCION", "Physcion", "physcion", "C16H12O5", "rhubarb",
     "Rheum palmatum", "anthraquinone",
     "reported to inhibit proliferation and migration")
cand("RHEIN", "Rhein", "rhein", "C15H8O6", "rhubarb",
     "Rheum palmatum", "anthraquinone",
     "reported to induce apoptosis and to inhibit glucose uptake")
cand("SENNIDIN_A", "Sennidin A", "sennidin A", "C30H18O10", "senna",
     "Senna alexandrina", "dianthrone",
     "aglycone of sennoside A, reported to be cytotoxic to tumour cells")
cand("HYPERICIN", "Hypericin", "hypericin", "C30H16O8", "St John's wort",
     "Hypericum perforatum", "naphthodianthrone",
     "reported as a photosensitizer for photodynamic therapy and a PKC inhibitor")
cand("PLUMBAGIN", "Plumbagin", "plumbagin", "C11H8O3", "Ceylon leadwort",
     "Plumbago zeylanica", "naphthoquinone",
     "reported to generate ROS and to inhibit NF kappa B and STAT3")
cand("SHIKONIN", "Shikonin", "shikonin", "C16H16O5", "purple gromwell",
     "Lithospermum erythrorhizon", "naphthoquinone",
     "reported to inhibit PKM2 and to trigger necroptosis")
cand("JUGLONE", "Juglone", "juglone", "C10H6O3", "black walnut",
     "Juglans nigra", "naphthoquinone",
     "reported to inhibit Pin1 and to induce apoptosis")
cand("LAWSONE", "Lawsone", "lawsone", "C10H6O3", "henna",
     "Lawsonia inermis", "naphthoquinone",
     "reported to inhibit proliferation and to induce oxidative stress")
cand("LAPACHOL", "Lapachol", "lapachol", "C15H14O3", "pink trumpet tree",
     "Handroanthus impetiginosus", "naphthoquinone",
     "reported to inhibit proliferation and topoisomerases")
cand("BETA_LAPACHONE", "beta-Lapachone", "beta-lapachone", "C15H14O3", "pink trumpet tree",
     "Handroanthus impetiginosus", "naphthoquinone",
     "reported to be activated by NQO1 in tumour cells and to cause ROS driven death")
cand("EMBELIN", "Embelin", "embelin", "C17H26O4", "false black pepper",
     "Embelia ribes", "benzoquinone",
     "reported to inhibit XIAP and NF kappa B")
# coumarins
cand("ESCULETIN", "Esculetin", "esculetin", "C9H6O4", "horse chestnut, chicory",
     "Aesculus hippocastanum, Cichorium intybus", "coumarin",
     "reported to inhibit lipoxygenase and to induce apoptosis")
cand("UMBELLIFERONE", "Umbelliferone", "umbelliferone", "C9H6O3", "carrot family, giant fennel",
     "Ferula communis, Daucus carota", "coumarin",
     "reported to inhibit proliferation and to induce apoptosis")
cand("SCOPOLETIN", "Scopoletin", "scopoletin", "C10H8O4", "chicory, noni",
     "Cichorium intybus, Morinda citrifolia", "coumarin",
     "reported to inhibit proliferation and to induce apoptosis")
cand("DAPHNETIN", "Daphnetin", "daphnetin", "C9H6O4", "winter daphne",
     "Daphne odora", "coumarin",
     "reported to inhibit kinases and proliferation")
cand("OSTHOLE", "Osthole", "osthole", "C15H16O3", "cnidium fruit",
     "Cnidium monnieri", "coumarin",
     "reported to inhibit proliferation, migration and invasion")
cand("WEDELOLACTONE", "Wedelolactone", "wedelolactone", "C16H10O7", "false daisy",
     "Eclipta prostrata", "coumestan",
     "reported to inhibit IKK and NF kappa B and to induce apoptosis")
cand("PSORALEN", "Psoralen", "psoralen", "C11H6O3", "babchi seed",
     "Cullen corylifolium", "furanocoumarin",
     "reported to induce apoptosis and, with UVA light, DNA crosslinks")
cand("BERGAPTEN", "Bergapten", "bergapten", "C12H8O4", "bergamot",
     "Citrus bergamia", "furanocoumarin",
     "reported to induce apoptosis and autophagy in breast cancer cells")
cand("IMPERATORIN", "Imperatorin", "imperatorin", "C16H14O4", "angelica root",
     "Angelica dahurica", "furanocoumarin",
     "reported to induce apoptosis and to inhibit proliferation")
# xanthones and related
cand("ALPHA_MANGOSTIN", "alpha-Mangostin", "alpha-mangostin", "C24H26O6", "mangosteen pericarp",
     "Garcinia mangostana", "xanthone",
     "reported to induce apoptosis and to inhibit proliferation and metastasis")
cand("MANGIFERIN", "Mangiferin", "mangiferin", "C19H18O11", "mango leaf",
     "Mangifera indica", "xanthone",
     "reported to inhibit NF kappa B and to induce apoptosis")
cand("GAMBOGIC_ACID", "Gambogic acid", "gambogic acid", "C38H44O8", "gamboge resin",
     "Garcinia hanburyi", "xanthone",
     "reported to inhibit the transferrin receptor and the proteasome and to induce apoptosis")
cand("GARCINOL", "Garcinol", "garcinol", "C38H50O6", "kokum",
     "Garcinia indica", "benzophenone",
     "reported to inhibit histone acetyltransferases and NF kappa B")
# carotenoids
cand("LYCOPENE", "Lycopene", "lycopene", "C40H56", "tomato",
     "Solanum lycopersicum", "carotenoid",
     "reported to inhibit proliferation and to lower prostate cancer risk in cohort studies")
# steroids and sapogenins
cand("DIOSGENIN", "Diosgenin", "diosgenin", "C27H42O3", "wild yam, fenugreek",
     "Dioscorea villosa, Trigonella foenum-graecum", "steroidal sapogenin",
     "reported to inhibit STAT3 and to induce apoptosis")
cand("WITHAFERIN_A", "Withaferin A", "withaferin A", "C28H38O6", "ashwagandha",
     "Withania somnifera", "withanolide",
     "reported to bind vimentin and to inhibit NF kappa B and HSP90")
cand("BUFALIN", "Bufalin", "bufalin", "C24H34O4", "Asiatic toad venom (chan su)",
     "Bufo gargarizans", "bufadienolide",
     "reported to inhibit the sodium potassium pump and to induce apoptosis", origin="animal")
# other scaffolds
cand("BRUSATOL", "Brusatol", "brusatol", "C26H32O11", "Java brucea fruit",
     "Brucea javanica", "quassinoid",
     "reported to inhibit NRF2 and protein synthesis")
cand("PLUMERICIN", "Plumericin", "plumericin", "C15H14O6", "frangipani",
     "Plumeria rubra", "iridoid",
     "reported to inhibit NF kappa B and to induce apoptosis")
cand("BETANIN", "Betanin", "betanin", "C24H26N2O13", "beetroot",
     "Beta vulgaris", "betalain",
     "reported to induce apoptosis and to reduce oxidative stress")
cand("DEGUELIN", "Deguelin", "deguelin", "C23H22O6", "derris, mundulea",
     "Derris trifoliata, Mundulea sericea", "rotenoid",
     "reported to inhibit HSP90 and PI3K and Akt signalling")
cand("ROTENONE", "Rotenone", "rotenone", "C23H22O6", "derris root",
     "Derris elliptica", "rotenoid",
     "reported to inhibit mitochondrial complex I and tubulin assembly")
cand("HYPERFORIN", "Hyperforin", "hyperforin", "C35H52O4", "St John's wort",
     "Hypericum perforatum", "phloroglucinol",
     "reported to inhibit MMPs and to induce apoptosis")
cand("SULFORAPHANE", "Sulforaphane", "cid:9577379", "C6H11NOS2", "broccoli sprout",
     "Brassica oleracea", "isothiocyanate",
     "reported to activate NRF2 and to inhibit HDAC")
cand("PHENETHYL_ISOTHIOCYANATE", "Phenethyl isothiocyanate", "phenethyl isothiocyanate", "C9H9NS", "watercress",
     "Nasturtium officinale", "isothiocyanate",
     "reported to raise ROS in tumour cells and to inhibit HDAC")
cand("BENZYL_ISOTHIOCYANATE", "Benzyl isothiocyanate", "benzyl isothiocyanate", "C8H7NS", "garden cress, papaya seed",
     "Lepidium sativum, Carica papaya", "isothiocyanate",
     "reported to induce apoptosis and to inhibit STAT3")
cand("AJOENE", "Ajoene", "ajoene", "C9H14OS3", "garlic",
     "Allium sativum", "organosulfur",
     "reported to induce apoptosis and to inhibit proliferation")
cand("INDOLE_3_CARBINOL", "Indole-3-carbinol", "indole-3-carbinol", "C9H9NO", "broccoli, cabbage",
     "Brassica oleracea", "indole",
     "reported to modulate estrogen metabolism and to inhibit Akt")
cand("DIINDOLYLMETHANE", "3,3'-Diindolylmethane", "3,3'-diindolylmethane", "C17H14N2", "cabbage, broccoli (formed from indole-3-carbinol)",
     "Brassica oleracea", "indole",
     "reported to inhibit NF kappa B and to induce apoptosis")

# ----------------------------------------------------------------------------
# HTTP with a disk cache
# ----------------------------------------------------------------------------
class Http:
    def __init__(self, cache_dir, offline=False):
        self.cache_dir = cache_dir
        self.offline = offline
        os.makedirs(cache_dir, exist_ok=True)
        self.calls = []  # (method, url, status, cached)
        self.fetched = []  # UTC timestamps of the live fetches behind every response used

    def _key(self, method, url, body):
        h = hashlib.sha1((method + "\n" + url + "\n" + (body or "")).encode("utf-8")).hexdigest()
        return os.path.join(self.cache_dir, h + ".json")

    def fetch(self, method, url, body=None, pause=0.25):
        path = self._key(method, url, body)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                rec = json.load(f)
            self.calls.append((method, url, rec["status"], True))
            self.fetched.append(rec.get("fetched", ""))
            return rec["status"], rec["text"]
        if self.offline:
            raise RuntimeError("offline and not cached: " + url)
        last = None
        for attempt in range(4):
            try:
                if method == "GET":
                    r = requests.get(url, timeout=90, headers=UA)
                else:
                    r = requests.post(url, data=body, timeout=90,
                                      headers=dict(UA, **{"Content-Type": "application/json"}))
                last = r
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(2.0 * (attempt + 1))
                    continue
                break
            except requests.RequestException as e:  # network hiccup
                last = e
                time.sleep(2.0 * (attempt + 1))
        if isinstance(last, Exception) or last is None:
            raise RuntimeError("network failure for %s: %s" % (url, last))
        time.sleep(pause)
        rec = {"status": last.status_code, "text": last.text, "url": url, "method": method,
               "fetched": dt.datetime.now(dt.timezone.utc).isoformat()}
        # do not cache transient failures
        if last.status_code in (200, 204, 404):
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(rec, f)
            os.replace(tmp, path)
        self.calls.append((method, url, last.status_code, False))
        self.fetched.append(rec["fetched"])
        return last.status_code, last.text


# ----------------------------------------------------------------------------
# PubChem
# ----------------------------------------------------------------------------
def pubchem_props(http, name):
    """Name lookup, or an explicit record when the query is 'cid:<number>'."""
    if name.startswith("cid:"):
        ident = "cid/%d" % int(name[4:])
    else:
        ident = "name/%s" % urllib.parse.quote(name)
    url = PUBCHEM + "/compound/%s/property/MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,InChIKey,IUPACName/JSON" % ident
    st, txt = http.fetch("GET", url)
    if st != 200:
        return None, "PubChem name lookup HTTP %d" % st
    props = json.loads(txt)["PropertyTable"]["Properties"]
    if not props:
        return None, "PubChem returned no properties"
    return props[0], None


def pubchem_3d(http, cid):
    url = PUBCHEM + "/compound/cid/%d/SDF?record_type=3d" % cid
    st, txt = http.fetch("GET", url)
    if st != 200:
        return None
    return txt


# ----------------------------------------------------------------------------
# RCSB
# ----------------------------------------------------------------------------
def rcsb_chem_search(http, smiles, match_type):
    q = {"query": {"type": "terminal", "service": "chemical",
                   "parameters": {"value": smiles, "type": "descriptor",
                                  "descriptor_type": "SMILES", "match_type": match_type}},
         "return_type": "mol_definition",
         "request_options": {"paginate": {"start": 0, "rows": 25}}}
    body = json.dumps(q, separators=(",", ":"))
    st, txt = http.fetch("POST", RCSB_SEARCH, body, pause=0.2)
    if st == 204:
        return []
    if st != 200:
        return []
    j = json.loads(txt)
    return [(r["identifier"], float(r.get("score", 0))) for r in j.get("result_set", [])]


def rcsb_chemcomp(http, ccd):
    st, txt = http.fetch("GET", RCSB_DATA + ccd, pause=0.2)
    if st != 200:
        return None
    return json.loads(txt)


def rcsb_ideal_sdf(http, ccd):
    st, txt = http.fetch("GET", RCSB_CCD_SDF + ccd + "_ideal.sdf", pause=0.2)
    if st != 200:
        return None
    return txt


# ----------------------------------------------------------------------------
# RDKit helpers
# ----------------------------------------------------------------------------
def ref_from_smiles(smiles):
    m = Chem.MolFromSmiles(smiles)
    if m is None:
        return None
    return m


def inchikey_block(m):
    try:
        k = Chem.MolToInchiKey(m)
        return k[:14] if k else ""
    except Exception:
        return ""


def is_planar_coords(m):
    conf = m.GetConformer()
    return max(abs(conf.GetAtomPosition(i).z) for i in range(m.GetNumAtoms())) < 0.05


def heavy_mol_from_molblock(block):
    """Parse an SDF/mol block with explicit H, assign stereo from the coordinates, strip H.

    Files whose coordinates all lie in z = 0 (some CCD ideal sets and PubChem 3D
    conformers of flat molecules, which PubChem aligns to the principal axes) keep the
    double bond stereo the parser perceived from the in-plane geometry; the 3D stereo
    assignment would erase it.
    """
    m = Chem.MolFromMolBlock(block, sanitize=True, removeHs=False)
    if m is None:
        return None, "RDKit could not parse or sanitize the mol block"
    if m.GetNumConformers() == 0:
        return None, "no conformer"
    if not is_planar_coords(m):
        Chem.AssignStereochemistryFrom3D(m, replaceExistingTags=True)
    h = Chem.RemoveHs(m, sanitize=True)
    return h, None


def is_intrinsically_planar(ref):
    """True when nothing in the molecule needs an out-of-plane heavy atom: no sp3 atom
    with three or more heavy neighbours, no atom with four heavy neighbours, no
    stereocentre. Flat aromatics, coumarins, quinones and all-trans polyenes qualify."""
    if Chem.FindMolChiralCenters(ref, includeUnassigned=True, useLegacyImplementation=False):
        return False
    for a in ref.GetAtoms():
        if a.GetDegree() >= 4:
            return False
        if a.GetHybridization() == Chem.HybridizationType.SP3 and a.GetDegree() >= 3:
            return False
    return True


def rotate_frame(m):
    """Fixed rigid rotation (35 deg about x, then 25 deg about y). Internal geometry is
    unchanged; it only stops a flat molecule's coordinates from being identically z = 0."""
    import math
    ax, ay = math.radians(35.0), math.radians(25.0)
    cx, sx, cy, sy = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay)
    conf = m.GetConformer()
    for i in range(m.GetNumAtoms()):
        p = conf.GetAtomPosition(i)
        x, y, z = p.x, p.y, p.z
        y, z = cx * y - sx * z, sx * y + cx * z
        x, z = cy * x + sy * z, -sy * x + cy * z
        conf.SetAtomPosition(i, (x, y, z))
    conf.Set3D(True)


def check_geometry(m):
    conf = m.GetConformer()
    pos = [conf.GetAtomPosition(i) for i in range(m.GetNumAtoms())]
    spread = max(max(abs(p.x), abs(p.y), abs(p.z)) for p in pos)
    if spread < 0.05:
        return "coordinates are all zero (no coordinate set)"
    zs = [abs(p.z) for p in pos]
    if max(zs) < 0.05:
        return "coordinates are planar (all z near 0)"
    n = m.GetNumAtoms()
    if n < HEAVY_MIN or n > HEAVY_MAX:
        return "heavy atoms %d outside %d..%d" % (n, HEAVY_MIN, HEAVY_MAX)
    if len(Chem.GetMolFrags(m)) != 1:
        return "more than one fragment"
    return None


def stereo_compare(ref, m):
    """Return 'exact', 'connectivity', 'tautomer' or None.

    exact: same graph and every stereo element that is defined in the reference
           (PubChem isomeric SMILES) is the same in the 3D structure.
    connectivity: same graph, but a defined stereo element differs.
    tautomer: different bond graph but the same standard InChI skeleton.
    """
    flat_ref = Chem.MolToSmiles(ref, isomericSmiles=False)
    flat_m = Chem.MolToSmiles(m, isomericSmiles=False)
    if flat_ref != flat_m:
        if inchikey_block(ref) and inchikey_block(ref) == inchikey_block(m):
            return "tautomer"
        return None
    match = m.GetSubstructMatch(ref, useChirality=False)
    if not match:
        return "connectivity"
    mm = Chem.Mol(m)
    for ra in ref.GetAtoms():
        if ra.GetChiralTag() == Chem.ChiralType.CHI_UNSPECIFIED:
            mm.GetAtomWithIdx(match[ra.GetIdx()]).SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    for rb in ref.GetBonds():
        if rb.GetBondType() == Chem.BondType.DOUBLE and rb.GetStereo() in (Chem.BondStereo.STEREONONE, Chem.BondStereo.STEREOANY):
            b = mm.GetBondBetweenAtoms(match[rb.GetBeginAtomIdx()], match[rb.GetEndAtomIdx()])
            if b is not None:
                b.SetStereo(Chem.BondStereo.STEREONONE)
    if Chem.MolToSmiles(mm) == Chem.MolToSmiles(ref):
        return "exact"
    return "connectivity"


def etkdg_from_smiles(smiles, seed=20260922):
    m = Chem.MolFromSmiles(smiles)
    if m is None:
        return None
    mh = Chem.AddHs(m)
    ps = AllChem.ETKDGv3()
    ps.randomSeed = seed
    ps.useRandomCoords = False
    cid = AllChem.EmbedMolecule(mh, ps)
    if cid < 0:
        ps.useRandomCoords = True
        cid = AllChem.EmbedMolecule(mh, ps)
        if cid < 0:
            return None
    try:
        AllChem.MMFFOptimizeMolecule(mh, maxIters=2000)
    except Exception:
        pass
    Chem.AssignStereochemistryFrom3D(mh, replaceExistingTags=True)
    return Chem.RemoveHs(mh)


def write_sdf(m, path, props):
    mol = Chem.Mol(m)
    mol.SetProp("_Name", props["KEY"])
    block = Chem.MolToMolBlock(mol, kekulize=True)   # title line, RDKit 3D header, atoms, bonds, M CHG, M END
    if not block.endswith("\n"):
        block += "\n"
    out = [block]
    for k, v in props.items():                        # plain SDF data items: ">  <NAME>" then the value
        out.append(">  <%s>\n%s\n\n" % (k, v))
    out.append("$$$$\n")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("".join(out))
    os.replace(tmp, path)


def reread_ok(path, expect_smiles, expect_n):
    m = Chem.MolFromMolFile(path, sanitize=True, removeHs=True)
    if m is None:
        return "re-read failed"
    if m.GetNumAtoms() != expect_n:
        return "re-read atom count %d != %d" % (m.GetNumAtoms(), expect_n)
    Chem.AssignStereochemistryFrom3D(m, replaceExistingTags=True)
    if Chem.MolToSmiles(m) != expect_smiles:
        return "re-read SMILES differs"
    err = check_geometry(m)
    return err


BAD_CHARS = re.compile("[\u2012-\u2015]")


def copy_gate(s):
    if BAD_CHARS.search(s):
        raise ValueError("dash in copy: " + s)
    for ch in s:
        o = ord(ch)
        if o > 127 and ch not in "\u00b7":
            raise ValueError("non ascii char %r in copy: %s" % (ch, s))
    return s


# ----------------------------------------------------------------------------
# main pipeline
# ----------------------------------------------------------------------------
def process(http, c, log):
    """Return (record, drop_reason)."""
    key = c["key"]
    props, err = pubchem_props(http, c["query"])
    if props is None:
        return None, "PubChem: " + err
    cid = int(props["CID"])
    formula_pc = props["MolecularFormula"]
    mw_pc = float(props["MolecularWeight"])
    smiles_pc = props.get("SMILES") or props.get("IsomericSMILES")
    inchikey_pc = props.get("InChIKey", "")
    if "." in smiles_pc:
        return None, "PubChem record is a salt or multi component (CID %d)" % cid
    if formula_pc != c["expect"]:
        return None, "formula guard: PubChem CID %d gives %s, expected %s (query not resolved to the intended compound)" % (cid, formula_pc, c["expect"])
    ref = ref_from_smiles(smiles_pc)
    if ref is None:
        return None, "RDKit could not parse PubChem SMILES"
    n_heavy = ref.GetNumHeavyAtoms()
    if n_heavy < HEAVY_MIN or n_heavy > HEAVY_MAX:
        return None, "heavy atoms %d outside %d..%d" % (n_heavy, HEAVY_MIN, HEAVY_MAX)

    notes = []
    undefined = [a for a, lab in Chem.FindMolChiralCenters(ref, includeUnassigned=True, useLegacyImplementation=False) if lab == "?"]
    if undefined:
        notes.append("%d stereocentre(s) undefined in the PubChem record" % len(undefined))

    # 1. RCSB CCD: a component is "the same molecule" when the RCSB graph search returns it,
    #    its InChIKey skeleton equals PubChem's, RDKit's flat SMILES agree and every stereo
    #    element defined in the PubChem record is reproduced by its ideal 3D coordinates.
    flat_ok = is_intrinsically_planar(ref)

    def accept_coords(m, label):
        """Geometry gate shared by the CCD and PubChem branches. Returns (mol, error)."""
        if is_planar_coords(m):
            e = check_geometry(m)
            if e and e.startswith("coordinates are all zero"):
                return None, e
            if not flat_ok:
                return None, "coordinates are planar (all z near 0) for a molecule that cannot be flat"
            rotate_frame(m)
            notes.append("flat molecule, %s coordinates lie in one plane and were rotated by a fixed rigid rotation so z is not identically zero" % label)
        e = check_geometry(m)
        if e:
            return None, e
        return m, None

    ccd_id, ccd_name, ccd_mol = None, None, None      # accepted component (same molecule)
    ccd_planar = None                                  # same molecule, but planar coords for a non flat molecule
    near_miss = []                                     # same skeleton, stereo or tautomer differs
    hits = rcsb_chem_search(http, smiles_pc, "graph-exact")
    if not hits:
        hits = [h for h in rcsb_chem_search(http, smiles_pc, "graph-relaxed") if h[1] >= 0.999]
    for ident, score in hits[:8]:
        info = rcsb_chemcomp(http, ident)
        if not info:
            continue
        desc = info.get("rcsb_chem_comp_descriptor", {}) or {}
        ik = desc.get("InChIKey", "") or ""
        cname = (info.get("chem_comp", {}) or {}).get("name") or ""
        if inchikey_pc and ik and ik[:14] != inchikey_pc[:14]:
            continue
        sdf = rcsb_ideal_sdf(http, ident)
        if not sdf:
            continue
        m, e = heavy_mol_from_molblock(sdf)
        if m is None:
            log.append("%s: CCD %s ideal SDF rejected: %s" % (key, ident, e))
            continue
        n_notes = len(notes)
        m, e = accept_coords(m, "CCD %s ideal" % ident)
        if m is None:
            del notes[n_notes:]
            log.append("%s: CCD %s ideal SDF rejected: %s" % (key, ident, e))
            if e.startswith("coordinates are planar") or e.startswith("coordinates are all zero"):
                ccd_planar = (ident, cname, e)
            continue
        kind = stereo_compare(ref, m)
        if kind != "exact":
            del notes[n_notes:]
            log.append("%s: CCD %s (%s, InChIKey %s) does not reproduce the PubChem stereo or tautomer (%s)" % (key, ident, cname, ik, kind))
            near_miss.append((ident, cname, ik))
            continue
        if inchikey_pc and ik and ik != inchikey_pc:
            notes.append("CCD %s defines stereo that the PubChem record leaves open (CCD InChIKey %s)" % (ident, ik))
        ccd_id, ccd_name, ccd_mol = ident, cname, m
        break

    chosen, coords = None, None
    if ccd_mol is not None:
        chosen, coords = ccd_mol, "rcsb-ccd:" + ccd_id
    else:
        if ccd_planar:
            ccd_id, ccd_name, why = ccd_planar
            if why.startswith("coordinates are all zero"):
                notes.append("CCD %s is the same molecule but its ideal coordinate set is empty (all zero), so it was not used" % ccd_id)
            else:
                notes.append("CCD %s is the same molecule but its ideal coordinates are planar for a molecule that cannot be flat, so they were not used" % ccd_id)
        for ident, cname, ik in near_miss[:1]:
            notes.append("CCD %s (%s) has the same skeleton but a different stereo or tautomer form (InChIKey %s), not used" % (ident, cname, ik))
        # 2. PubChem 3D conformer
        sdf = pubchem_3d(http, cid)
        pc_mol = None
        if sdf:
            m, e = heavy_mol_from_molblock(sdf)
            if m is not None:
                n_notes = len(notes)
                m, e = accept_coords(m, "PubChem 3D")
                if m is None:
                    del notes[n_notes:]
                    log.append("%s: PubChem 3D conformer for CID %d rejected: %s" % (key, cid, e))
                elif stereo_compare(ref, m) == "exact":
                    pc_mol = m
                else:
                    del notes[n_notes:]
                    log.append("%s: PubChem 3D conformer for CID %d does not reproduce the record's stereo" % (key, cid))
        if pc_mol is not None:
            chosen, coords = pc_mol, "pubchem-3d:%d" % cid
        else:
            # 3. RDKit ETKDGv3 + MMFF94 from the PubChem isomeric SMILES
            m = etkdg_from_smiles(smiles_pc)
            if m is None:
                return None, "no CCD match, no PubChem 3D record, RDKit embedding failed"
            e = check_geometry(m)
            if e:
                return None, "RDKit conformer rejected: " + e
            if stereo_compare(ref, m) != "exact":
                return None, "RDKit conformer does not reproduce the reference stereo"
            chosen, coords = m, "rdkit-etkdg:%d" % cid
            notes.append("no usable CCD coordinates and no PubChem 3D record, coordinates generated with RDKit ETKDGv3 and MMFF94")

    m = chosen
    smiles_final = Chem.MolToSmiles(m)
    formula_rd = rdMolDescriptors.CalcMolFormula(m)
    mw_rd = round(Descriptors.MolWt(m), 2)
    if formula_rd != formula_pc:
        return None, "formula after processing %s != PubChem %s" % (formula_rd, formula_pc)
    if abs(mw_rd - mw_pc) > 0.6:
        return None, "MW after processing %.2f != PubChem %.2f" % (mw_rd, mw_pc)
    nrot = rdMolDescriptors.CalcNumRotatableBonds(m, rdMolDescriptors.NumRotatableBondsOptions.Strict)
    rel = "data/ligands/%s.sdf" % key
    path = os.path.join(ROOT, rel)
    props_out = OrderedDict([
        ("KEY", key), ("NAME", c["name"]), ("SOURCE", coords), ("SMILES", smiles_final),
        ("FORMULA", formula_rd), ("MW", "%.2f" % mw_rd), ("HEAVY_ATOMS", m.GetNumAtoms()),
        ("ROTATABLE_BONDS", nrot),
    ])
    write_sdf(m, path, props_out)
    e = reread_ok(path, smiles_final, m.GetNumAtoms())
    if e:
        os.remove(path)
        return None, "written SDF failed re-read: " + e
    rec = OrderedDict([
        ("key", key), ("name", copy_gate(c["name"])), ("plant", copy_gate(c["plant"])),
        ("latin", copy_gate(c["latin"])), ("class", copy_gate(c["cls"])),
        ("mechanism", copy_gate(c["mech"])), ("origin", c["origin"]),
        ("heavyAtoms", m.GetNumAtoms()), ("formula", formula_rd), ("mw", mw_rd),
        ("smiles", smiles_final), ("inchiKey", inchikey_pc), ("pubchemCid", cid),
        ("ccd", ccd_id), ("ccdName", ccd_name), ("coords", coords), ("rotatableBonds", nrot),
        ("undefinedStereo", len(undefined)), ("drug", bool(c["drug"])), ("file", rel),
    ])
    if notes:
        rec["note"] = copy_gate("; ".join(notes))
    return rec, None


def atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def md_table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join([" --- "] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(x) for x in r) + " |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "ponchem-ligand-cache"))
    ap.add_argument("--only", default="", help="comma separated keys to (re)process")
    ap.add_argument("--range", default="", help="slice i:j of the candidate table to (re)process, merged into the catalog")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    os.makedirs(LIG_DIR, exist_ok=True)
    os.makedirs(CAT_DIR, exist_ok=True)
    keys = [c["key"] for c in C]
    assert len(keys) == len(set(keys)), "duplicate keys"
    for c in C:
        assert re.fullmatch(r"[A-Z0-9_]+", c["key"]), c["key"]

    http = Http(args.cache, offline=args.offline)
    only = set(k for k in args.only.split(",") if k)
    if args.range:
        a, b = args.range.split(":")
        only = set(c["key"] for c in C[int(a or 0):int(b or len(C))])
    partial = bool(only)
    records, drops, log = [], [], []
    t0 = time.time()
    for i, c in enumerate(C):
        if only and c["key"] not in only:
            continue
        try:
            rec, why = process(http, c, log)
        except Exception as e:  # keep going, report at the end
            rec, why = None, "exception: %s" % e
        if rec:
            records.append(rec)
            print("[%3d/%d] %-26s ok   %-22s %2d heavy  %s" % (i + 1, len(C), c["key"], rec["coords"], rec["heavyAtoms"], rec.get("note", "")), flush=True)
        else:
            drops.append((c["key"], c["name"], why))
            print("[%3d/%d] %-26s DROP %s" % (i + 1, len(C), c["key"], why), flush=True)

    if partial:
        # partial run: merge into the existing catalog
        cat_path = os.path.join(CAT_DIR, "ligands.json")
        if os.path.exists(cat_path):
            with open(cat_path, "r", encoding="utf-8") as f:
                old = json.load(f)["ligands"]
            by = {r["key"]: r for r in old}
            for r in records:
                by[r["key"]] = r
            records = list(by.values())

    records.sort(key=lambda r: (r["class"], r["name"].lower()))
    generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    catalog = OrderedDict([("generated", generated), ("count", len(records)), ("ligands", records)])
    atomic_write(os.path.join(CAT_DIR, "ligands.json"), json.dumps(catalog, indent=1, ensure_ascii=True) + "\n")

    # remove SDFs of ligands that are no longer in the catalog (full runs only)
    if not partial:
        keep = set(os.path.basename(r["file"]) for r in records)
        for fn in os.listdir(LIG_DIR):
            if fn.endswith(".sdf") and fn not in keep:
                os.remove(os.path.join(LIG_DIR, fn))

    # ---- candidates table
    outcome = {r["key"]: "kept, " + r["coords"] for r in records}
    for k, _, why in drops:
        outcome[k] = "dropped: " + why
    rows = [(c["key"], c["name"], c["cls"], c["query"], outcome.get(c["key"], "not processed")) for c in C]
    cand_md = "\n".join([
        "# Ligand candidates \u00b7 Ponchem",
        "",
        "Generated %s by tools/catalog/ligands.py. %d candidates, %d kept, %d dropped." % (generated, len(C), len(records), len(drops)),
        "The candidate names, source organisms, class and the hedged mechanism line are the curator's input; every",
        "identifier, formula, weight, SMILES and coordinate set is taken from a live API response (see ligands-report.md).",
        "",
        md_table(rows, ["key", "name", "class", "PubChem query", "outcome"]),
        "",
    ])
    atomic_write(os.path.join(CAT_DIR, "candidates-ligands.md"), cand_md)

    # ---- report
    by_class = Counter(r["class"] for r in records)
    by_src = Counter(r["coords"].split(":")[0] for r in records)
    by_origin = Counter(r["origin"] for r in records)
    drugs = [r["name"] for r in records if r["drug"]]
    noted = [(r["key"], r["note"]) for r in records if r.get("note")]
    heavy = [r["heavyAtoms"] for r in records]
    n_calls = len(http.calls)
    n_live = sum(1 for x in http.calls if not x[3])
    status = Counter((x[0], x[1].split("/rest/")[0].split("/rcsbsearch")[0].split("/ligands/")[0], x[2]) for x in http.calls)
    status_rows = sorted(((m, host, st, n) for (m, host, st), n in status.items()), key=lambda x: (x[1], x[0], x[2]))
    report = []
    report.append("# Ligand catalog report \u00b7 Ponchem")
    report.append("")
    report.append("Generated %s by `tools/catalog/ligands.py` (rerunnable; HTTP responses cached in `%s`)." % (generated, args.cache))
    report.append("")
    report.append("## Result")
    report.append("")
    report.append("- Candidates: %d. Kept: %d. Dropped: %d." % (len(C), len(records), len(drops)))
    report.append("- Heavy atoms: min %d, max %d (allowed %d..%d)." % (min(heavy), max(heavy), HEAVY_MIN, HEAVY_MAX))
    report.append("- Approved drugs in the set (flag `drug`): %s." % ", ".join(drugs))
    report.append("- Origin: %s." % ", ".join("%s %d" % (k, v) for k, v in sorted(by_origin.items())))
    report.append("- Files: `data/ligands/<KEY>.sdf` (%d files), `data/catalog/ligands.json`, `data/catalog/candidates-ligands.md`." % len(records))
    report.append("")
    report.append("## Counts by coordinate source")
    report.append("")
    report.append(md_table(sorted(by_src.items()), ["source", "ligands"]))
    report.append("")
    report.append("## Counts by class")
    report.append("")
    report.append(md_table(sorted(by_class.items()), ["class", "ligands"]))
    report.append("")
    report.append("## Dropped candidates")
    report.append("")
    if drops:
        report.append(md_table(drops, ["key", "name", "reason"]))
    else:
        report.append("None.")
    report.append("")
    report.append("Skipped before the run, by instruction: allicin (unstable), ursodeoxycholic acid (animal bile acid).")
    report.append("")
    report.append("## Ligands with a provenance note")
    report.append("")
    if noted:
        report.append(md_table(noted, ["key", "note"]))
    else:
        report.append("None.")
    report.append("")
    report.append("## Method, and how each field was obtained")
    report.append("")
    report.append("1. `pubchemCid`, `formula`, `mw`, `inchiKey` and the reference isomeric SMILES: PubChem PUG REST name lookup,")
    report.append("   `GET https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/<name>/property/MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,InChIKey,IUPACName/JSON`.")
    report.append("   The first CID returned is used. A guard compares the returned formula with the formula expected for the")
    report.append("   named compound; on a mismatch the candidate is dropped, not corrected by hand. Salts (a `.` in the SMILES) are dropped.")
    report.append("2. `ccd`, `ccdName`: RCSB search API, chemical service, `POST https://search.rcsb.org/rcsbsearch/v2/query` with")
    report.append("   `{\"query\":{\"type\":\"terminal\",\"service\":\"chemical\",\"parameters\":{\"value\":<PubChem SMILES>,\"type\":\"descriptor\",\"descriptor_type\":\"SMILES\",\"match_type\":\"graph-exact\"}},\"return_type\":\"mol_definition\"}`,")
    report.append("   falling back to `match_type: graph-relaxed` (score 1.0 hits only). Each hit is checked against")
    report.append("   `GET https://data.rcsb.org/rest/v1/core/chemcomp/<ID>` (InChIKey skeleton must equal PubChem's; `chem_comp.name` is recorded as `ccdName`).")
    report.append("3. Coordinates, in priority order:")
    report.append("   - `rcsb-ccd:<ID>`: `GET https://files.rcsb.org/ligands/download/<ID>_ideal.sdf`, accepted when RDKit's canonical SMILES")
    report.append("     of the component equals the PubChem SMILES and every stereo element defined in the PubChem record agrees with the")
    report.append("     stereo perceived from the ideal 3D coordinates (`AssignStereochemistryFrom3D`).")
    report.append("   - `pubchem-3d:<CID>`: `GET https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/<CID>/SDF?record_type=3d`, same checks.")
    report.append("     Used when the CCD component matches the skeleton but not the stereo or tautomer form (the note says so).")
    report.append("   - `rdkit-etkdg:<CID>`: RDKit ETKDGv3 (seed 20260922) plus MMFF94 minimization from the PubChem isomeric SMILES, when")
    report.append("     PubChem has no 3D record (404) and no CCD component fits.")
    report.append("4. Every SDF: parsed with RDKit (sanitized, explicit H kept for stereo perception), 3D check (z spread, not all zero),")
    report.append("   heavy atoms %d..%d, exactly one fragment, then written back through RDKit with explicit hydrogens removed, kekulized" % (HEAVY_MIN, HEAVY_MAX))
    report.append("   Flat molecules (no stereocentre, no sp3 atom with three or more heavy neighbours: flat aromatics, quinones, coumarins,")
    report.append("   all trans polyenes) legitimately come with coordinates in one plane from both sources; those coordinate sets are kept and")
    report.append("   rotated by one fixed rigid rotation (35 deg about x, 25 deg about y) so no file has z identically zero. Internal geometry is")
    report.append("   untouched. A planar coordinate set for a molecule that cannot be flat is rejected as a 2D drawing.")
    report.append("   bond block, title line = KEY, property block KEY, NAME, SOURCE, SMILES, FORMULA, MW, HEAVY_ATOMS, ROTATABLE_BONDS")
    report.append("   (RDKit strict count). The written file is re-read and must give the same canonical SMILES and atom count.")
    report.append("   Atom order is the source file's heavy-atom order, so a rerun reproduces the same topology.")
    report.append("5. `formula` and `mw` in the JSON are RDKit's values for the saved molecule; the script drops the ligand if the formula")
    report.append("   differs from PubChem's or the weight differs by more than 0.6.")
    report.append("6. `plant`, `latin`, `class`, `mechanism`, `drug`, `origin` are curator input (hedged wording, no dashes, ASCII only, gated in code).")
    report.append("")
    report.append("## API calls in this run")
    report.append("")
    stamps = sorted(s for s in http.fetched if s)
    report.append("%d HTTP lookups in this run (%d live, %d served from the cache). Every response used was fetched live from the" % (n_calls, n_live, n_calls - n_live))
    report.append("API between %s and %s (UTC, cache record timestamps); nothing was typed in by hand." % (stamps[0][:19] if stamps else "n/a", stamps[-1][:19] if stamps else "n/a"))
    report.append("")
    report.append(md_table(status_rows, ["method", "host", "status", "count"]))
    report.append("")
    report.append("## Processing log")
    report.append("")
    if log:
        report.extend("- " + x for x in log)
    else:
        report.append("Nothing to report.")
    report.append("")
    report.append("Run time %.0f s." % (time.time() - t0))
    report.append("")
    atomic_write(os.path.join(CAT_DIR, "ligands-report.md"), "\n".join(report))
    print("\nkept %d, dropped %d, %.0f s" % (len(records), len(drops), time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
