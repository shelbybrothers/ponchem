# Target candidates, working notes

Notes from building `targets.json`. The wishlist lives in `tools/catalog/targets.py` as the
`WISHLIST` table: 200 rows of gene symbol, UniProt accession, class, cancer groups, a one line
reason and optional preferred PDB entries. 188 rows verified, 12 did not (see
`targets-report.md` section 7).

## How a row becomes a catalog entry

1. Search RCSB for entries carrying that accession, X-ray, resolution 2.8 A or better, at least
   one non-polymer component, sorted by resolution, first 50.
2. Add any preferred entry ids by hand so a classic structure can compete even when it is not
   among the 50 sharpest. Hints get a large ranking bonus but no exemption from any check.
3. Batched GraphQL for metadata on all candidates, 20 entries per request.
4. Reject candidates on: method, resolution, non-human pocket entity, gene symbol that the
   accession's own UniProt record does not list, missing mutation where one is demanded
   (KRAS G12C and G12D), no ligand of drug size.
5. Rank survivors: real inhibitor far above cofactor, small bonus for a marketed drug, more heavy
   atoms better, sharper resolution better, single protein entity slightly better, fragment sized
   ligand penalised.
6. Open the coordinates of the best ranked candidates, up to six, and keep the first where a
   qualifying ligand sits within 6 A of a CA atom of a chain of the pocket entity. This fixes the
   `chain` and `authSeqId` fields.
7. If nothing survives, or the winner is a cofactor, search again 200 deep and repeat. Cryo-EM at
   3.2 A or better is tried last, and only for rows marked `allow_em`.

## Things that went wrong, and the fix

- **Organism case.** Older entries write `HOMO SAPIENS`, newer ones `Homo sapiens`. A
  case-sensitive comparison silently dropped AURKB and CHEK2. Now compared case-insensitively.
- **Empty search responses.** The search service answers HTTP 204 with an empty body when nothing
  matches, which crashed the JSON parse on the first target with no qualifying entry (ATR). Empty
  bodies are now treated as no result.
- **DrugBank status beat chemistry.** ATP, AMP, SAM and FAD all carry DrugBank `approved`, so the
  marketed drug bonus was lifting cofactor complexes above real inhibitor complexes. CSNK1D landed
  on AMP, DNMT1 on SAM, KDM1A on FAD. A cofactor is now pushed to last resort before any bonus
  applies, and the drug bonus is small and limited to approved drugs.
- **Endogenous molecules.** DrugBank marks serotonin, caffeine and testosterone as investigational
  or nutraceutical. With a large bonus for any drug status, WDR5 picked serotonin over a real WIN
  site inhibitor. The bonus now applies only to approved drugs and is small enough that a larger
  inhibitor wins on pocket footprint.
- **Cofactor adducts.** Tranylcypromine class LSD1 inhibitors are covalent FAD adducts, 53 to 68
  heavy atoms, with systematic names that mention neither FAD nor flavin. A component id
  blacklist cannot catch them. Replaced with an rdkit substructure test for a whole adenosine or a
  flavin ring, validated on 17 known cofactors and 19 known inhibitors with no mistake either way.
- **Buffers and substrates that look drug sized.** Bis-tris propane (`B3P`, 19 atoms) was chosen
  for CREBBP and MMP2, a PEG (`P3G`) for MAT2A, glucose-6-phosphate for HK2, phenylalanine for
  PKM, folinic acid for SHMT2, inositol hexakisphosphate for HDAC1, deoxycholic acid for SHMT2,
  GTP for tubulin. Fixed with: component type rejection (`D-saccharide`, `L-peptide linking`,
  DNA and RNA linking), name rules for polyethers, bile acids, phosphate analogs, inositol
  phosphates, nucleotide esters named as guanylate or adenylate, and reduced folates detected by a
  reduced pteridine ring plus a glutamate tail. That last rule is written so antifolate drugs are
  untouched: DHFR keeps methotrexate, TYMS keeps raltitrexed, GART keeps its antifolate, and
  SHMT2 ended on a 52 atom pyrrolopyrimidine polyglutamate inhibitor.
- **Three wrong accessions in my own wishlist.** Q15022 is SUZ12 and not EED, P50583 is NUDT2 and
  not MTAP, and the WRN row was written with placeholder text instead of an accession. All three
  were caught by the gene symbol guard rather than by eye, then corrected to O75530, Q13126 and
  Q14191 and re-verified.

## Kept on purpose, with a caveat

- **EIF4A3 `2HYI`** holds AMP-PNP. It is the only cofactor analog in the catalog and it is flagged
  in the JSON. Rocaglate complexes are eIF4A1, a different accession.
- **USP7, NUDT1, EED, PIN1** rest on approved drugs that are not that target's canonical
  inhibitor (sertraline, stanozolol, astemizole, tretinoin). Real co-crystals, real pockets, but
  the first to swap if the registry wants canonical tool compounds.
- **AR and CYP19A1** rest on the natural steroid ligand. For these two that is arguably the better
  pocket definition, since the drugs are steroid analogs.

## Dropped on purpose

**TUBB.** Left out by hand and the one gap worth knowing. Every RCSB tubulin complex with a taxane
or colchicine site plant compound is sheep or cow tubulin, so none passes the human rule, and the
human entries that pass hold only GTP at the nucleotide site, which is not where those compounds
bind. Shipping one would imply a pocket that is not there. KIF11 `3ZCW` stands in as the mitotic
target. A taxane pocket would have to come from a non-human entry with the organism stated on the
page.

## Coverage

79 kinases, 27 epigenetic, 23 metabolism, 17 DNA damage, 8 immuno-oncology, 7 apoptosis, 7 hormone
receptor, 6 protein homeostasis, 4 transcription, 2 phosphatase, 2 protease, 1 structural, 5 other.
All 20 top-threat cancer groups from SPEC.md section 3 are represented. 188 entries is well past
the 100 the registry needs, so downstream filtering has room to drop the weaker rows above.
