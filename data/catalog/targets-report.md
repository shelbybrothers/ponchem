# Target catalog report

Generated 2026-09-22 by `tools/catalog/targets.py` against the RCSB Protein Data Bank.
Output: `data/catalog/targets.json`, **188 targets**, 187 distinct genes, 188 distinct PDB entries.

Every field in the JSON comes from a live RCSB response received during the build. Nothing is
recalled from memory: the script starts from a wishlist of gene symbols and accessions, and an
entry only survives if RCSB itself confirms the protein, the method, the resolution, the ligand
chemistry and the ligand's position in the coordinates.

## 1. How each field was obtained

| Field | Source |
| --- | --- |
| `pdbId` | `search.rcsb.org/rcsbsearch/v2/query`, attribute query on `rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession` plus method, resolution and `nonpolymer_entity_count` filters, sorted by resolution |
| `title`, `method`, `resolution` | `data.rcsb.org/graphql`: `struct.title`, `exptl.method`, `rcsb_entry_info.resolution_combined` |
| `doi`, `pubmed`, `citation` | GraphQL `rcsb_primary_citation` |
| `gene`, `uniprot`, `uniprotName` | GraphQL `polymer_entities.uniprots.rcsb_uniprot_protein`, including the gene name list used to prove the accession really carries the claimed gene symbol |
| `protein`, `cancers`, `why`, `class` | Written for this catalog, not from the API. The cancer groups are the ones in SPEC.md section 3 |
| `entityDescription` | GraphQL `rcsb_polymer_entity.pdbx_description` |
| `chain` | Proved in the coordinates: the chain of the pocket entity whose CA atoms come within 6 A of the reference ligand |
| `ligand.ccd`, `name`, `formula`, `formulaWeight`, `heavyAtoms`, `smiles`, `inchiKey`, `drugGroups` | GraphQL `nonpolymer_comp`: `chem_comp`, `rcsb_chem_comp_info.atom_count_heavy`, `rcsb_chem_comp_descriptor.SMILES_stereo` and `InChIKey`, `rcsb_chem_comp_synonyms`, `drugbank.drugbank_info` |
| `ligand.authSeqId` | GraphQL `rcsb_nonpolymer_entity_instance_container_identifiers.auth_seq_id`, confirmed against the coordinate file |
| `ligand.contactDistanceA` | Computed here from the downloaded coordinates: shortest distance between the ligand heavy atoms and the chain's CA atoms |
| `assembly` | GraphQL `assemblies.rcsb_assembly_info.assembly_id` |
| `image` | `https://cdn.rcsb.org/images/structures/<lowercase id>_assembly-1.jpeg`, HEAD checked |

Coordinates were downloaded from `https://files.rcsb.org/download/<ID>.pdb`, with
`<ID>.cif` as the fallback for entries with no PDB format file. HETATM records were parsed per
residue name, chain and residue number, hydrogens excluded, and the ligand was accepted only when
it sits within 6 A of a CA atom of a chain belonging to the human entity that carries the target
accession. That check is what makes the `chain` field a measurement rather than an assumption.

### Image URL pattern

The pattern `https://cdn.rcsb.org/images/structures/<lowercase pdb id>_assembly-1.jpeg` was HEAD
checked for **all 188 entries** and every one returned HTTP 200, so no entry carries a null image.

## 2. Counts per class

| Class | Targets |
| --- | --- |
| kinase | 79 |
| epigenetic | 27 |
| metabolism | 23 |
| dna-damage | 17 |
| immuno-oncology | 8 |
| apoptosis | 7 |
| hormone-receptor | 7 |
| protein-homeostasis | 6 |
| other | 5 |
| transcription | 4 |
| phosphatase | 2 |
| protease | 2 |
| structural | 1 |

## 3. Counts per cancer group

All 20 top-threat groups in SPEC.md section 3 are covered. Each target carries one to three
groups, as SPEC requires.

| Cancer group | Targets | | Cancer group | Targets |
| --- | --- | --- | --- | --- |
| leukemia | 69 | | melanoma | 17 |
| breast | 50 | | pancreatic | 16 |
| lung | 47 | | liver | 13 |
| lymphoma | 46 | | kidney | 13 |
| colorectal | 34 | | stomach | 7 |
| ovarian | 24 | | thyroid | 4 |
| brain | 20 | | bladder | 2 |
| prostate | 19 | | cervical | 2 |
| sarcoma | 18 | | head and neck | 1 |
| myeloma | 18 | | esophageal | 1 |

The thin groups are thin for a structural reason, not an oversight. Esophageal, head and neck,
cervical and bladder tumours are driven mostly by targets that already appear under other groups
(EGFR, ERBB2, FGFR3, PIK3CA), so adding more rows would repeat the same pockets.

## 4. Structure quality

- Method: 184 X-ray entries, 4 cryo-EM entries.
- Resolution: best 1.08 A, median 1.98 A, worst 3.00 A.
- Reference ligand size: 15 to 70 heavy atoms, median 35.
- 51 of the 188 reference ligands are DrugBank approved drugs.

Cryo-EM was allowed only where no X-ray entry qualified, and each is inside the 3.2 A cryo-EM
limit: ATM `7NI4` 3.00 A, ATR `9L40` 2.87 A, PRKDC `7OTY` 2.96 A, XPO1 `9OGD` 2.49 A. These four
are very large proteins with no small-molecule X-ray structure at 2.8 A or better.

## 5. Entries where the reference ligand is a cofactor analog

One, and it is flagged `cofactorAnalog: true` in the JSON:

| Target | Entry | Ligand | Note |
| --- | --- | --- | --- |
| EIF4A3 | `2HYI` | `ANP` (AMP-PNP) | No X-ray entry of human eIF4A3 at 2.8 A or better carries a non-cofactor ligand of drug size. The published rocaglate complexes are eIF4A1, a different accession. The pocket recorded here is the nucleotide site. |

Every other target reached a genuine inhibitor, activator or natural-ligand complex. Cofactor
rejection is enforced by an rdkit substructure test rather than a hand-kept list of component
ids: any component carrying a whole adenosine (6-aminopurine plus the ribose diol) or a flavin
ring is treated as a cofactor or cofactor adduct and pushed to last resort. The test was validated
against 17 known cofactors (ATP, ADP, ANP, AMP, NAD, FAD, SAH, SAM, carba-NAD, the FAD adducts of
LSD1 inhibitors and others) and 19 known inhibitors (imatinib, sotorasib, JQ1, erlotinib,
gefitinib, tamoxifen and others), with no mistake in either direction. It is what moved KDM1A,
DNMT1, CSNK1D and SIRT2 off cofactor complexes and onto real inhibitors.

Reduced folates, nucleotide substrate fragments, sugar phosphates, inositol phosphates, bile
acids, buffers, polyethers and amino acid residues are rejected too, the last two by component
type (`D-saccharide`, `L-peptide linking`) rather than by name spelling. Antifolate drugs are
deliberately untouched by the folate rule, which is why DHFR keeps methotrexate, TYMS keeps
raltitrexed and SHMT2 keeps its pyrrolopyrimidine polyglutamate inhibitor.

## 6. Reference ligands worth a second look before publication

These pass every selection rule and are real co-crystals, but the ligand is an approved drug that
is not the canonical inhibitor of that target. The pocket is still the real pocket. If the final
registry prefers a canonical tool compound, swap these first:

| Target | Entry | Ligand | Comment |
| --- | --- | --- | --- |
| USP7 | `9IJU` | Sertraline (20 heavy atoms) | An antidepressant co-crystallised with USP7. Canonical USP7 inhibitors such as the FT series are larger. |
| NUDT1 | `9GQL` | Stanozolol (24) | A steroid in the MTH1 nucleotide pocket rather than a classic MTH1 inhibitor. |
| EED | `7KXT` | Astemizole (34) | A withdrawn antihistamine reported as an EED binder, co-crystallised in the PRC2 regulatory pocket. |
| AR | `2AM9` | Testosterone (21) | The natural androgen. For androgen receptor this is arguably the best pocket definition, and the drugs are steroid analogs. |
| CYP19A1 | `3S79` | Androstenedione (21) | The natural aromatase substrate, same reasoning. |
| PIN1 | `4TNS` | Tretinoin (22) | Approved drug, reported PIN1 binder. |

The smallest reference ligand in the catalog is APEX1 `7TC2` with a 15 heavy atom nitroindole
carboxylic acid. Three targets sit below 20 heavy atoms: APEX1 (15), CDK8 (19, a quinazolinamine)
and HDAC2 (19, vorinostat, an approved drug). All are above the 12 heavy atom floor.

Five entries have a ligand-to-CA distance between 5 and 6 A (CARM1 5.71, NAMPT 5.31, TOP1 5.13,
KDM4A 5.09, EGLN1 5.09). The measurement is to backbone CA atoms only, so a deep pocket lined by
long side chains reads farther than the true contact distance. All five are inside the 6 A rule.

## 7. Targets wanted but not verified

Twelve wishlist targets were dropped. Each reason below is the machine verdict, not a guess.

| Target | Accession | Why it was dropped |
| --- | --- | --- |
| HDAC1 | Q13547 | Only one X-ray entry qualifies and it holds no ligand of drug size. The cryo-EM fallback `9R4I` carries inositol hexakisphosphate, which is the corepressor glue, not a drug. HDAC2, HDAC6 and HDAC8 cover the family. |
| RRM2 | P31350 | The five qualifying entries hold no non-cofactor ligand of drug size. |
| HIF1A | Q16665 | 17 candidates, none with a ligand of drug size in the PAS domain at this resolution. HIF2A (EPAS1) is in the catalog and is the drugged isoform. |
| UBA3 | Q8TBC4 | The qualifying entries hold no drug-size ligand, and in `5JJM` no ligand lies within 6 A of the UBA3 chains. |
| CTPS1 | P17812 | One candidate, no ligand of drug size. |
| AXL | P30530 | One candidate, no ligand of drug size. |
| MAP2K2 | P36507 | `1S9J` has no human polymer entity carrying the accession; in `4H3Q` no ligand sits within 6 A of the MEK2 chain. MAP2K1 (MEK1) is in the catalog. |
| MKNK1 | Q9BUB5 | `2HW6` has no drug-size ligand; in `2Y9Q` no ligand lies within 6 A of the chain. |
| PARP7 | Q7Z3E1 | No entry matches the filters at all: no human X-ray structure at 2.8 A or better with a non-polymer component. |
| USP1 | O94782 | Same, no qualifying entry. The published USP1 complexes are cryo-EM of the USP1-UAF1 assembly. |
| ACLY | Q9NR19 | Same, no qualifying X-ray entry. |
| TDO2 | Q16680 | Same. IDO1 is in the catalog and carries the tryptophan pathway. |

Two more were removed from the wishlist on purpose:

- **TUBB (beta tubulin).** Dropped by hand, and this is the one gap worth knowing about. Every RCSB
  tubulin complex with a taxane or colchicine site plant compound is sheep or cow tubulin, so none
  passes the Homo sapiens rule. The human entries that do pass carry only GTP at the nucleotide
  site, which is not where those plant compounds bind, so keeping one would have implied a pocket
  that does not exist. KIF11 (kinesin spindle protein, entry `3ZCW`) is in the catalog as the
  mitotic alternative. If the product needs a taxane pocket, it has to come from a non-human
  tubulin entry and the organism must be stated on the page.
- **EED.** First tried with accession Q15022, which UniProt reports as SUZ12. Re-run with the
  correct accession O75530 and it verified as `7KXT`. Listed here only to record that the gene
  guard caught it.

## 8. Wishlist accessions corrected by the gene guard

The script refuses an entry whose UniProt record does not list the claimed gene symbol. That guard
caught three wrong accessions in the wishlist, which were corrected and re-verified:

| Target | Wrong accession | UniProt said | Correct accession |
| --- | --- | --- | --- |
| EED | Q15022 | SUZ12 | O75530 |
| MTAP | P50583 | NUDT2, APAH1 | Q13126 |
| WRN | placeholder text | not an accession | Q14191, verified as `9OG8` |

## 9. Citation coverage

170 entries carry a DOI and 171 a PubMed id; 17 older entries carry neither in
`rcsb_primary_citation` (ACVR1, AURKA, DYRK1A, EGFR, MAPK14, PDGFRA, ROCK1, ATAD2, CREBBP, KDM5B,
PRMT5, TRIM24, BIRC2, GART, PKM, BCL6, PIN1). For those the PDB id itself is the citation, and the
`citation` field holds the paper title where RCSB provides one.

## 10. Reproducing this

```
.venv/bin/python tools/catalog/targets.py
```

The script is rerunnable and caches every response outside the repository (default
`<tmp>/ponchem-rcsb-cache`, override with `PONCHEM_CACHE`). `PONCHEM_FRESH=1` ignores the cache and
refetches, `PONCHEM_ONLY=EGFR,BRAF` runs a few targets, `PONCHEM_LIMIT=n` runs the first n. Requests
sleep 0.2 s, retry with backoff on 429 and 5xx, and the full build is about 1,100 requests: one
search per target, batched GraphQL for 20 entries at a time, and roughly one coordinate download
per target because candidates are ranked on metadata before any file is opened.
