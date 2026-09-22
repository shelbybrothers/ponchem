# PONCHEM engine specification (SPEC-ENGINE.md, v1, 2026-09-22)

This document is the numerical contract of the Ponchem scorer. The Python reference
(`tools/engine/ref/`), the Solidity scorer, the JS scorer and the data pipeline all
implement THIS document, and the vectors in `data/vectors/` prove that they agree bit
for bit. Wherever SPEC.md section 4 summarises the engine and this document differs,
this document wins (the differences are listed in section 11).

Reference implementation: `tools/engine/ponchem_engine.py` (CLI) over the package
`tools/engine/ref/` (`constants.py`, `typing.py`, `tables.py`, `topology.py`,
`pocket.py`, `score.py`, `pose.py`, `search.py`, `vectors.py`, `keccak.py`).
Run it with the project venv: `.venv/bin/python tools/engine/ponchem_engine.py <cmd>`.

Vocabulary: "centi-A" is 0.01 angstrom, "milli-A" is 0.001 angstrom, "micro" is a
dimensionless term value times 1e6, "pico-kcal" is 1e-12 kcal/mol. All integers are
big-endian in every byte layout. `tdiv(a, b)` is integer division truncating toward
zero (Solidity `/`, JS BigInt `/`; in Python use `ref.constants.tdiv`). `isqrt(n)` is
floor(sqrt(n)), exact.

## 0. Invariants a port must keep

1. The integer path uses only integers. No float anywhere between the pose bytes and
   `score_milli`.
2. All sums are order independent (exact integer addition), so a port may enumerate
   pocket atoms in any order or through the cell grid; the five term sums, `e_pico` and
   `score_milli` are identical.
3. Tables are loaded from the frozen bytes in `data/tables/tables.bin` (never recomputed
   at run time) and checked against `keccak256 = 0x0ecc4dd8e9494c3eb87f910dec144d463f5dc8e285fbbbbeaded5061d0365e93`.
4. Pocket bytes and topology bytes are opaque blobs whose keccak256 is what the chain
   registers. Any change to a layout bumps the version byte and regenerates the vectors.

## 1. Atom types and radii

Sixteen X-Score / Vina heavy-atom types with a stable uint8 code. Hydrogens are never
represented.

| code | name  | radius centi-A | hydrophobic | donor | acceptor | meaning |
|-----:|-------|---------------:|:-----------:|:-----:|:--------:|---------|
| 0 | C_H   | 190 | yes | | | carbon, no heteroatom neighbour |
| 1 | C_P   | 190 | | | | carbon bonded to at least one non-carbon heavy atom |
| 2 | N_P   | 180 | | | | nitrogen, neither donor nor acceptor |
| 3 | N_D   | 180 | | yes | | nitrogen carrying at least one H |
| 4 | N_A   | 180 | | | yes | nitrogen with an available lone pair, no H |
| 5 | N_DA  | 180 | | yes | yes | both |
| 6 | O_A   | 170 | | | yes | oxygen (every oxygen accepts) |
| 7 | O_D   | 170 | | yes | | reserved, never produced by the typing rules |
| 8 | O_DA  | 170 | | yes | yes | hydroxyl oxygen |
| 9 | S_P   | 200 | | | | sulfur (and selenium of MSE) |
| 10 | P_P  | 210 | | | | phosphorus |
| 11 | F_H  | 150 | yes | | | fluorine |
| 12 | Cl_H | 180 | yes | | | chlorine |
| 13 | Br_H | 200 | yes | | | bromine |
| 14 | I_H  | 220 | yes | | | iodine |
| 15 | Met_D | 120 | | yes | | metal ion (Zn, Mg, Mn, Ca, Fe, Na, K, Co, Ni, Cu) |

Bit masks (bit t set iff type t has the property): `HYD_MASK = 0x7801`,
`DON_MASK = 0x8128`, `ACC_MASK = 0x0170`. Radius array indexed by code:
`[190,190,180,180,180,180,170,170,170,200,210,150,180,200,220,120]`.

Carbon rule (Vina's, used for receptor and ligand alike): a carbon whose heavy
neighbours include any non-carbon element (N, O, S, P, halogen, Se) is C_P, otherwise
C_H. This is why CYS CB, MET CG and MET CE are C_P.

## 2. Receptor typing, box and pocket (build time, Python)

### 2.1 PDB parsing
- Read `ATOM` and `HETATM` records of the FIRST model only (stop at `ENDMDL`).
- Element from columns 77-78; if blank, from the atom name (columns 13-14 when they
  spell a two-letter element such as ZN, else the first letter). Hydrogens (H, D, T)
  are dropped.
- Coordinates are parsed as exact integers in milli-A (`Decimal(text) * 1000`).
- Alternate locations: for each key (chain, resseq, icode, resname, atom name) keep the
  first record whose altloc is blank or `A`; if the key never appears with blank/`A`,
  keep its first record. Record order is preserved.
- Waters (HOH, WAT, DOD, H2O) and every hetero group are dropped, except metal ions
  (HETATM whose element is one of ZN MG MN CA FE NA K CO NI CU, typed Met_D, taken from
  any chain) and MSE (selenomethionine, typed like MET with SE as S_P).
- Chains: all protein chains of the first model are candidates (SPEC.md's "chain set"
  is therefore "every chain that has atoms inside the reach cube"). The builder accepts
  `--chains A,B` to restrict; the default was used for every pocket in the vectors.
- Protein atoms are typed by the table (residue name, atom name) in `ref/typing.py`:
  backbone N is N_D (PRO N is N_P), CA and C are C_P, O and OXT are O_A; side chains:
  ARG CD C_P, NE N_D, CZ C_P, NH1 N_D, NH2 N_D; ASN CG C_P, OD1 O_A, ND2 N_D; ASP CG C_P,
  OD1 O_A, OD2 O_A; CYS CB C_P, SG S_P; GLN CD C_P, OE1 O_A, NE2 N_D; GLU CD C_P, OE1 O_A,
  OE2 O_A; HIS CG C_P, ND1 N_DA, CD2 C_P, CE1 C_P, NE2 N_DA; LYS CE C_P, NZ N_D; MET CG
  C_P, SD S_P, CE C_P; PRO CD C_P; SER CB C_P, OG O_DA; THR CB C_P, OG1 O_DA, CG2 C_H;
  TRP CD1 C_P, NE1 N_D, CE2 C_P; TYR CZ C_P, OH O_DA; every other side-chain carbon is
  C_H (ALA, ILE, LEU, VAL, PHE ring, TRP ring carbons, ARG CB CG, LYS CB CG CD, GLN and
  GLU CB CG, ASN and ASP CB, HIS CB, MET CB, PRO CB CG, TYR ring). Aliases HID HIE HIP
  HSD HSE HSP CYX CYM ASH GLH LYN ARN map to their parent tables. Atoms of any other
  residue (modified residues, ligands) are dropped and counted in the build report.

### 2.2 Reference ligand and box
- The reference ligand is the first HETATM group (file order) whose residue name is the
  given CCD id, optionally restricted to a chain and residue number. Its heavy atoms
  define the box.
- Centre (per axis): `c_milli = round_half_even(sum(x_milli) / n)` (rounding applied to
  the magnitude, so it is symmetric). Stored as int32 milli-A, absolute PDB frame.
- Half size (per axis): `h_milli = max(6000, max_i |x_i_milli - c_milli| + 2000)`,
  `h_centi = ceil(h_milli / 10) = (h_milli + 9) // 10`. This contains the ligand's
  bounding box padded by 2.00 A on both sides and is at least 6.00 A. (SPEC.md said
  "half of the extent plus 2 A"; with the centre at the centroid that would not always
  contain the padded bounding box, so the guaranteed-containment form is used.)

### 2.3 Pocket atoms
- Relative coordinate: `rel_centi = round_half_even((x_milli - c_milli) / 10)`.
- Keep a typed receptor atom iff `|rel| <= h + 800` on every axis (reach = cutoff 8 A).
- Reject the build if any relative coordinate does not fit int16.
- Cap: if more than 2000 atoms qualify, keep the 2000 with the smallest r2 to the centre
  (ties by record order). 1M17 needed no cap (796 atoms).
- Grid: cell edge 800 centi-A. `nx = (2*hx + 1600) // 800 + 1` (same for y, z), cell of
  an atom `cx = (x + hx + 800) // 800`, linear cell `c = (cx*ny + cy)*nz + cz`. Atoms
  are stably sorted by `c` (record order inside a cell) and an offset table is appended
  (section 5). Because a ligand atom that passed the box check has `x in [-hx, hx]`,
  its cell satisfies `1 <= cx <= nx - 2`, so the 27 neighbouring cells always exist.

## 3. Fixed point, tables, terms and the score

### 3.1 Units
- Coordinates: int16 centi-A relative to the box centre (pocket atoms and pose atoms).
- Box half sizes: uint16 centi-A.
- Squared distance `r2 = dx*dx + dy*dy + dz*dz` in 0.0001 A^2. With int16 inputs
  `r2 < 2^34`, so it fits int64 (Python int, Solidity uint256, JS Number exactly).
- Cutoff: a pair contributes iff `r2 <= 640000` (8.00 A). `r2 = 640001` is skipped.
- `r_centi = isqrt(r2)` (floor, truncated toward zero; e.g. r2 = 159999 gives 399).
- `d_centi = r_centi - (R[ta] + R[tb])`, range [-440, 560].

### 3.2 Exact square root (recommended method)
`SQ[k] = isqrt(256*k)` for k = 0..2500 (table in `tables.bin`). Then
```
r = SQ[r2 >> 8]
while (r + 1) * (r + 1) <= r2: r += 1
```
For r2 >= 16384 the loop runs at most once (proof: sqrt(256k + 255) - sqrt(256k) <
255 / (2*128) < 1 for k >= 64). For smaller r2 (deep clashes, r < 1.28 A) it runs at
most 15 times. Any other exact floor square root is acceptable; the result is what
matters.

### 3.3 Per-pair terms (all integers)
```
g1  = GAUSS1[d + 440]                      (0 outside [-440, 560])
g2  = GAUSS2[d + 440]
rep = d < 0 ? d*d*100 : 0                  (micro-A^2, max 19,360,000)
hyd = both types hydrophobic ? (d <= 50 ? 1e6 : d >= 150 ? 0 : (150 - d) * 10000) : 0
hb  = (donor(ta) and acceptor(tb)) or (acceptor(ta) and donor(tb))
      ? (d <= -70 ? 1e6 : d >= 0 ? 0 : ((-d) * 100000) // 7) : 0     (floor, operands positive)
```
Term values are in micro units (1e6 = 1.0). Breakpoints in words: hydrophobic is 1 up
to a surface distance of 0.5 A and falls linearly to 0 at 1.5 A; hydrogen bond is 1 up
to -0.7 A and falls linearly to 0 at 0 A; repulsion is d^2 for d < 0; gauss1 is
exp(-(d/0.5)^2); gauss2 is exp(-((d-3)/2)^2).

### 3.4 Tables (`data/tables/`)
```
GAUSS1[i] = round_half_even(1e6 * exp(-((i-440)/100 / 0.5)^2))   i = 0..1000  (d = i - 440)
GAUSS2[i] = round_half_even(1e6 * exp(-(((i-440)/100 - 3.0) / 2.0)^2))
SQ[k]     = isqrt(256*k)                                           k = 0..2500
```
Generated with Python `decimal` (correctly rounded exp, ROUND_HALF_EVEN), frozen:
- `gauss1.bin`: 1001 x uint32 BE, 4004 bytes, keccak256
  `0x2d78d458de239d3fd5208a3c5d79bf69414dbd8fb51984a6ed436bb7a2b8e44d`
- `gauss2.bin`: 1001 x uint32 BE, 4004 bytes, keccak256
  `0xbdf14b4cc7cef153bd7471694f84bb518260944b351c42da0abd743b99532e54`
- `sqrt.bin`: 2501 x uint16 BE, 5002 bytes, keccak256
  `0xa74503d512f76f4912e777c490ea0dcbc94a1f40ac68928470d63cdca39c10d0`
- `tables.bin` = gauss1 || gauss2 || sqrt, 13010 bytes, offsets 0 / 4004 / 8008, keccak256
  `0x0ecc4dd8e9494c3eb87f910dec144d463f5dc8e285fbbbbeaded5061d0365e93`
- `tables.json` carries the descriptor plus the full value arrays for the JS engine.
Spot values: g1(0) = 1000000, g1(20) = 852144, g1(190) = 1, g1(200) = 0,
g2(300) = 1000000, g2(-440) = 1, g2(560) = 184520. On chain `tables.bin` is one data
contract; a run does one EXTCODECOPY of it (13010 bytes, about 1.3k gas plus memory).

### 3.5 Weights and the score
Weights in micro-kcal/mol per unit term (Trott and Olson 2010, the values SPEC.md
quotes): `W_G1 = -35600`, `W_G2 = -5160`, `W_REP = 840000`, `W_HYD = -35100`,
`W_HB = -587000`; rotor penalty `1 + 0.0585 * Nrot = (10000 + 585*Nrot) / 10000`.

Accumulate five sums over all pairs inside the cutoff (uint64 each; worst case 128000
pairs gives `S_rep <= 2.48e12 < 2^53`, so JS Numbers are exact here):
```
S1 += g1;  S2 += g2;  SR += rep;  SH += hyd;  SB += hb
E_pico      = W_G1*S1 + W_G2*S2 + W_REP*SR + W_HYD*SH + W_HB*SB      (int256 / BigInt / int)
score_milli = tdiv(E_pico, 100000 * (10000 + 585 * Nrot))            (milli-kcal/mol, negative is good)
```
`|E_pico| <= 2.1e18 < 2^63` in the theoretical worst case; JS must do the five products
and the division in BigInt. The contract stores `score_milli` as int32 and reverts if it
does not fit (it always fits for a pose that passes the geometry proof on a real pocket;
the check only guards the type). Truncation is toward zero: `-355240267400 /
1058500000 = -335` (not -336), `7995158054040 / 1117000000 = 7157`.

### 3.6 Display-only numbers (float, never on chain)
`dG = score_milli / 1000` kcal/mol; `pKd = -dG / 1.36423` (RT ln 10 at 298.15 K);
`Kd = 10^(-pKd)` mol/L; ligand efficiency `LE = -dG / n_heavy_atoms` kcal/mol per heavy
atom. Show at most three decimals of dG, two of pKd, Kd in scientific notation.

## 4. Ligand topology (from the CCD ideal SDF)

### 4.1 Reading the SDF
- V2000 only (RCSB `*_ideal.sdf` are V2000). Coordinates parsed as exact integers in
  0.0001 A (`Decimal(text) * 10000`). `M  CHG` lines give formal charges.
- Hydrogens (H, D, T) are stripped; heavy atoms keep SDF order; bonds between heavy atoms
  are kept with their order (1, 2, 3, 4).
- H count per heavy atom: number of explicit H neighbours when the file contains any
  hydrogen atom; otherwise RDKit's total H count (sanitised molecule). All RCSB ideal
  files have explicit hydrogens.
- Elements other than C N O S P F Cl Br I reject the ligand (`UnsupportedElement`).
- 1 <= N <= 64 heavy atoms, <= 255 bonds, <= 255 rotatable bonds.

### 4.2 Typing
Carbon: section 1 rule. N: donor iff H count >= 1; acceptor iff formal charge <= 0 and
(heavy degree + H count) <= 2 (pyridine, imine, nitrile, azo N); N_DA if both, N_D,
N_A, else N_P (amide N-H is N_D, amines with 3 substituents are N_P, nitro N is N_P).
O: O_DA iff H count >= 1 else O_A. S is S_P, P is P_P, halogens F_H Cl_H Br_H I_H.

### 4.3 Nrot
A bond counts as rotatable iff all of: order 1; not a ring bond (its endpoints stay
connected when it is removed); both endpoints have heavy degree >= 2; neither endpoint
takes part in a triple bond; not an amide bond (a C that has a double bond to O, bonded
to N by this bond, in either direction). Terminal groups (CH3, OH, NH2, halogens) are
excluded by the degree rule. This is the count of active heavy-atom rotors in the sense
of Trott and Olson; it need not match RDKit. Erlotinib (AQ4) gives 10, quercetin 1,
paclitaxel 14.

### 4.4 Ideal distances
For a pair of heavy atoms with SDF coordinates a, b in 0.0001 A units:
`s = (ax-bx)^2 + (ay-by)^2 + (az-bz)^2` (1e-8 A^2), `ideal_centi = (isqrt(s) + 50) // 100`
(nearest centi-A; an exact half rounds up). Stored for every bond (1-2) and for every
pair at graph distance 2 (1-3).

### 4.5 Geometry proof parameters
- Tolerance for 1-2 and 1-3 pairs: `tol = 6 + (ideal * 2) // 100` centi-A. Argument: a
  rigid transform plus torsion rotations preserve these distances exactly in float; the
  only noise is the int16 rounding (at most 0.5 centi-A per coordinate, so at most
  sqrt(3) = 1.73 centi-A on a distance), which 6 covers with a 3.4x margin. The 2 percent
  part absorbs float drift in long torsion chains built by the JS engine. It is NOT meant
  to accept other conformers: a 1.53 A bond gets +/- 9, a 2.5 A 1-3 distance +/- 11.
  The 1M17 crystal geometry of AQ4 (2.6 A structure) deviates from the CCD ideal by up
  to 0.157 A on bonds and 0.275 A on 1-3 pairs and is therefore rejected (vector
  rej_06); poses must carry the ideal geometry.
- Clash floor: every pair at graph distance >= 3 must satisfy `r2 >= 48400` (2.20 A),
  a single floor for both the 1-4 class and the 4+ class. Measured minima of the CCD
  ideal conformers (centi-A): AQ4 1-4 269, 4+ 264; QUE 274, 257; TA1 (paclitaxel) 254,
  239; CUR (curcumin) 270, 228; STL (resveratrol) 277, 413. A 2.60 A floor for 4+ pairs
  would reject paclitaxel and curcumin in their own ideal conformers (intramolecular
  hydrogen bonds and a methoxy contact sit at 2.28 to 2.39 A), so the 4+ floor cannot
  be above the 1-4 floor; 2.20 A is below every real non-bonded heavy-atom contact and
  still forbids interpenetration, which is the purpose of the check. The builder reports
  `min_dist14_centi`, `min_dist4plus_centi` and `ideal_passes_clash_floor` for every
  ligand so the catalog can refuse a ligand whose own ideal geometry fails.
- Mirror images: the proof uses distances only, so an enantiomeric pose passes.
  Documented limitation.

### 4.6 Topology bytes (version 1)
```
0    uint8   version = 1
1    uint8   N   heavy atom count (1..64)
2    uint8   B   bond count
3    uint8   Nrot
4    uint16  P   number of 1-3 pairs
6    uint16  reserved = 0
8    N x uint8                 type code per atom, SDF heavy-atom order
8+N        B x (uint8 i, uint8 j, uint16 ideal_centi)   i < j, bonds sorted by (i, j)
8+N+4B     P x (uint8 i, uint8 j, uint16 ideal_centi)   i < j, pairs sorted by (i, j)
8+N+4B+4P  N x uint64 near[i]: bit j set iff graph distance(i, j) <= 2 (bit i set)
```
Length 8 + 9N + 4B + 4P. Hash = keccak256 of the whole blob. A pair (i < j) with
`near[i] >> j & 1 == 0` is at graph distance >= 3 and is subject to the clash floor.
Sizes: AQ4 553 bytes, QUE 446, TA1 1250.

### 4.7 Pose bytes
`N x (int16 x, int16 y, int16 z)` BE, 6 bytes per atom, centi-A relative to the box
centre, in topology atom order. This is the canonical `bytes pose` of `submitRun` and of
every event.

## 5. Pocket bytes (version 1)
```
0    4 x ASCII   PDB id, upper case
4    uint16      n   atom count (<= 2000)
6    uint16      hx  half size x (centi-A)
8    uint16      hy
10   uint16      hz
12   int32       cx  centre x (milli-A, absolute)
16   int32       cy
20   int32       cz
24   uint8       nx  grid cells along x
25   uint8       ny
26   uint8       nz
27   uint8       version = 1
28   n x (int16 x, int16 y, int16 z, uint8 type)   7 bytes, sorted by cell index
28+7n  (nx*ny*nz + 1) x uint16   off[c]: atoms of cell c are [off[c], off[c+1]); off[ncells] = n
```
Hash = keccak256 of the whole blob. The viewer maps an atom back to the PDB frame with
`abs = c / 1000 + rel / 100`. 1M17 (AQ4 reference): 796 atoms, grid 5 x 4 x 4 (80
cells), 5762 bytes, keccak256
`0xf7e00d9d0145b195d4b991d39e47375afd3059dee67ed347c5ccbacc3c6c3ef0`.

## 6. Evaluation algorithm (what the contract does in `submitRun`)

Result codes: 0 OK, 1 ATOM_COUNT, 2 BOX, 3 BOND, 4 PAIR13, 5 CLASH. Checks run in this
order and the first failure decides the code (the vectors depend on this order).

```
evaluate(pocket, topology, pose) -> (code, score_milli)
  N := topology.N
  if len(pose) != 6*N: return ATOM_COUNT
  P[i] := (int16, int16, int16) from pose                              i in 0..N-1
  -- box
  for i in 0..N-1: if |P[i].x| > hx or |P[i].y| > hy or |P[i].z| > hz: return BOX
  -- bonds and 1-3 pairs (int64 arithmetic, no sqrt)
  for (i, j, ideal) in bonds then pairs13:
      r2  := dist2(P[i], P[j])                                          uint64
      tol := 6 + (ideal*2) / 100
      lo  := ideal > tol ? ideal - tol : 0;   hi := ideal + tol
      if r2 < lo*lo or r2 > hi*hi: return BOND (or PAIR13)
  -- clash floor
  for i in 0..N-2: for j in i+1..N-1:
      if (near[i] >> j) & 1 == 0 and dist2(P[i], P[j]) < 48400: return CLASH
  -- score
  S1 := S2 := SR := SH := SB := 0                                       uint64
  for a in 0..N-1:                                   (outer: ligand atoms)
      ta := types[a]; Ra := R[ta]
      for each pocket atom p in the 27 cells around cell(P[a])  (or all n atoms)
          dx := P[a].x - p.x; dy := ...; dz := ...                       int32
          r2 := dx*dx + dy*dy + dz*dz                                   uint64 (< 2^34)
          if r2 > 640000: continue
          r  := isqrt(r2)                                               0..800
          d  := r - (Ra + R[p.t])                                       -440..560
          S1 += GAUSS1[d+440]; S2 += GAUSS2[d+440]
          if d < 0: SR += d*d*100
          if HYD(ta) and HYD(p.t): SH += hyd(d)
          if (DON(ta) and ACC(p.t)) or (ACC(ta) and DON(p.t)): SB += hb(d)
  E := W_G1*S1 + W_G2*S2 + W_REP*SR + W_HYD*SH + W_HB*SB                int256
  score := tdiv(E, 100000 * (10000 + 585*Nrot))                         int256, stored int32
  return OK, score
```
Overflow bounds with the loop as written: every per-pair quantity is below 2^25, every
term sum below 2^42, `|E| < 2^61`, the divisor below 2^34. Solidity can do the whole
thing in unchecked uint256/int256 arithmetic; the only signed quantities are dx dy dz,
d, E and score.

### 6.1 Gas reasoning and ceiling
Measured pair counts on 1M17 (796 pocket atoms): AQ4 (29 atoms) examines 23084 pairs by
full scan, 11018 through the 27-cell grid, 1868 are inside the cutoff; TA1 (62 atoms)
49352 / 19604 / 2296; QUE (22 atoms) 17512 / 9020 / 1539. A pocket atom examined and
skipped costs about 80 gas in tight assembly when the pocket has been unpacked once into
memory words (three loads, three subtractions, three multiplications, two additions, a
comparison and the loop); an in-cutoff pair costs about 250 gas more (table square root
~50, radius and gauss lookups ~60, flags and piecewise terms ~80, accumulation and
control ~60). Fixed costs: one EXTCODECOPY each of pocket (<= 14028 bytes) and tables
(13010 bytes), unpacking (<= 2000 x ~50 gas = 100k), geometry checks (<= 64 atoms:
2016 pairs x ~80 = 160k), calldata (6N bytes), storage and the event (~100k).

- Typical run (25 to 30 ligand atoms, ~800 pocket atoms, grid scan): 11k examined x 80 +
  1.9k in-cutoff x 250 + ~0.35M fixed = about 1.6M gas (full scan instead of the grid
  adds ~1M).
- Worst case (64 atoms, 2000-atom fully buried pocket): up to ~44k examined pairs
  (27 cells x 512 A^3 x 0.05 atoms/A^3 per ligand atom) x 80 + ~5.1k in-cutoff x 250 +
  ~0.45M fixed = about 5.2M gas.
Proposed forge gate: `submitRun` <= 6,000,000 gas for the 64 x 2000 case built from the
TA1 topology on a synthetic 2000-atom pocket, and <= 2,500,000 for the AQ4 x 1M17 vector.
The 4,000,000 figure asked for in the build brief is not reachable for a fully buried
64-atom ligand with the 8 A grid (the in-cutoff pairs alone cost ~1.3M); tighten the gate
to the measured number plus 15 percent once the Solidity implementation exists. The grid
is what keeps the worst case bounded: a full scan of 64 x 2000 = 128k pairs would cost
about 10M.

## 7. What the browser must do (search is free, evaluation is not)

The float search (Web Worker, seeded) may use any method: Monte Carlo over rigid body plus
torsions with the float replica of the terms is what the Python reference does
(`ref/search.py`, 6 starts x 1000 steps with 8 greedy micro-steps each). It is not
specified bit for bit. What IS required at the end of a run:
1. Build the final coordinates in the box frame (angstrom, relative to the centre),
   round every coordinate to the nearest centi-A (round half to even in the reference;
   nearest is what matters) and encode the pose bytes of section 4.7.
2. Run `check_geometry` (section 6) on those int16 coordinates. If it fails, the engine
   must fix the pose (the reference nudges rigid body and torsions until the float
   replica of the box and clash checks is at zero, then re-checks) and never show or
   submit an invalid pose.
3. Run the integer scorer on those int16 coordinates with the frozen tables and show
   THAT `score_milli` (as dG = score_milli / 1000 kcal/mol) with the derived numbers of
   section 3.6. Never show the float energy as the result.
4. Submit exactly those pose bytes. The chain recomputes the same number; the site then
   displays the chain's number.
Conventions the reference uses for placing a ligand (`ref/pose.py`): rigid placement
`X = (X_tors - centroid(X_tors)) @ R^T + t` with `R = Rz(gamma) Ry(beta) Rx(alpha)`;
torsion k rotates the smaller side of rotatable bond (a, b) about the axis fixed -> moving
by theta_k, applied in list order before the rigid placement. A ligand whose ideal
conformer cannot fit inside a target's box (paclitaxel in erlotinib's box is the vector
case) can still be submitted only in a folded conformer; the site may hide such pairs
using the box half sizes and the ligand's extent.

## 8. Vectors (`data/vectors/`)

Flat JSON per case; bytes are `0x` hex strings; integers are JSON integers (forge:
`vm.parseJsonBytes(json, ".pocket_hex")`, `vm.parseJsonInt(json, ".expect_e_pico")`,
`vm.parseJsonIntArray(json, ".pose_flat")`). `index.json` lists every file with its kind
and expected code. `verify` (CLI) re-evaluates every case through the grid scan.

- `tables.json`: keccak256 of each table blob and of `tables.bin`, sizes, spot values of
  g1, g2 and isqrt.
- `terms.json`: 32 (type_a, type_b, r2) rows with r_centi, d_centi, g1, g2, rep, hyd, hb
  and e_pico in parallel arrays (`skipped = 1` for r2 = 640001). Covers the cutoff edge,
  isqrt truncation, every piecewise breakpoint (d = -70, -50, -10, -1, 0, 10, 20, 50,
  120, 150), donor/acceptor in both directions, the metal donor, hydrophobic pairs,
  r2 = 0 and r2 = 1.
- `syn_01` to `syn_05`: hand-checkable ligands built from V2000 SDF text (the SDF files
  sit next to the vectors): methanol against one pocket atom (two pairs: C..P r = 400,
  d = 20 gives g1 852144 g2 140858; O..P r = 543, d = 183 gives g1 2 g2 710188; sums
  852146 and 851046; e_pico = -35600*852146 - 5160*851046 = -34727794960; score = -34),
  ethanolamine with Nrot = 1 (denominator 1058500000, score -335 shows truncation toward
  zero), propane on a hydrophobic wall, pyridine with a donor on the lone pair and two
  stacking carbons (three para pairs at graph distance 3), propanediol with Nrot = 2
  (positive score 7157, truncation of a positive value).
- `rej_01` .. `rej_05`: BOX, BOND, PAIR13, CLASH (propanediol cis-cis: O..O at graph
  distance 4 falls to 1.76 A while every bond and 1-3 distance is intact), ATOM_COUNT.
  `rej_06`: the raw 1M17 crystal coordinates of AQ4 (BOND, bond 6-25 ideal 133 found
  at r2 = 20186, window 125..141).
- `real_01` .. `real_04`: 1M17 pocket (EGFR kinase domain with erlotinib, X-ray 2.6 A,
  Homo sapiens; title, method, resolution and organism from
  data.rcsb.org/rest/v1/core/entry/1M17 and /core/polymer_entity/1M17/1; ligand names,
  formulas and PubChem CIDs from /core/chemcomp/AQ4, QUE, TA1; structure and ideal SDFs
  from files.rcsb.org; all fetched 2026-09-22) with erlotinib fitted to the crystal
  pose, erlotinib refined, quercetin docked, paclitaxel docked.

## 9. Observed numbers (this machine: CPython 3.12.14, Apple M3)

- 1M17 pocket: 2497 typed receptor atoms in chain A; 796 inside the reach cube (no cap),
  types C_H 257, C_P 271, N_P 3, N_D 125, N_DA 4, O_A 119, O_DA 11, S_P 6; box centre
  (22.014, 0.253, 52.794) A, half sizes (10.18, 6.00, 6.26) A; grid 5 x 4 x 4; 5762 bytes.
- AQ4 (erlotinib), ideal geometry fitted to the crystal pose (RMSD 0.402 A):
  S1 79337969, S2 1427284177, SR 3817400, SH 35310000, SB 799999, E_pico
  -8691582462720, Nrot 10, score -5483 (dG -5.483 kcal/mol, pKd 4.02, LE 0.19), 1864
  pairs in cutoff. The intermolecular energy before the rotor penalty is -8.69 kcal/mol,
  inside the -8 to -11 range expected for a Vina-family function on this complex; the
  published Vina numbers for erlotinib on 1M17 (about -7 to -8.5) are lower because Vina
  reports its own locally optimised pose. The float replica gives -8.695 / -5.486, so the
  integer path is faithful to 3 decimals.
- AQ4 refined (800 small-move steps from the fitted pose, RMSD 0.64 A to the crystal):
  score -6446 (dG -6.446, pKd 4.73), E_pico -10217104125640, SR falls from 3817400 to
  2598400 (the 2.6 A crystal contacts relax).
- Raw crystal geometry, geometry proof ignored (information only): -5807.
- QUE (quercetin) docked, seed 3, 6 starts x 1000 steps: score -9289 (dG -9.289, pKd
  6.81, LE 0.42), Nrot 1, 1539 pairs in cutoff.
- TA1 (paclitaxel, 62 atoms, Nrot 14) docked into erlotinib's box: score -2837 (a poor
  but valid pose; the ligand is far larger than the box), 2296 pairs in cutoff.
- Timing, pure-Python integer scorer including the geometry proof (best of 5): AQ4 29 x
  796 3.8 ms full scan, 2.5 ms grid; QUE 3.0 / 2.0 ms; TA1 62 x 796 7.6 / 4.4 ms.
  Table generation 0.07 s; pocket build 0.02 s; crystal fit 0.56 s; refinement 0.6 s;
  quercetin search 28 s; paclitaxel search 81 s; whole `vectors` run 110 s.

## 10. Port notes

- Solidity: copy `tables.bin` and the pocket into memory once per run; unpack pocket
  atoms into words; `int256` for dx, dy, dz, d, E, score; everything else `uint256`;
  `/` on int256 already truncates toward zero; read the near masks as `uint64`; keep the
  check order of section 6; revert with the code name.
- JS: `Number` for coordinates, r2, r, d, the table values and the five sums (all below
  2^53); `BigInt` for the five products, E and the final division (`BigInt` division
  truncates toward zero like Solidity). Load `tables.bin` (or the arrays in
  `tables.json`) and verify the keccak256 of the bytes before use. Use `Math.trunc` for
  nothing: there is no float in this path.
- Python: `ref/score.py` is the reference; `tdiv` is in `ref/constants.py`.
- Hashes: keccak256 (Ethereum), not SHA3-256. `ref/keccak.py` is a verified pure-Python
  implementation (empty string gives `c5d2...a470`).

## 11. Deviations from the SPEC.md summary and open questions

1. Polar carbon: SPEC.md says "carbon bonded to N or O"; this document (and the
   reference) uses Vina's rule "bonded to any non-carbon heavy atom" (so carbons next to
   S, P, halogens are C_P). The docs page should say "next to a heteroatom".
2. Box half size: guaranteed-containment form `max(6, max|x_i - c| + 2)` instead of
   "half extent + 2" (section 2.2).
3. Clash floor: one floor of 2.20 A for every pair at graph distance >= 3 instead of
   2.20 / 2.60 (section 4.5, with the measurements that force it).
4. Gas ceiling: 6.0M proposed for the worst case instead of 4.0M (section 6.1).
5. Open: whether the catalog should restrict receptor chains to the reference ligand's
   chain plus contacting chains (the builder takes `--chains`); the vectors use the
   default (all chains). Open: extended PDB ids (pdb_00001m17) do not fit the 4-byte
   header field; the catalog uses classic 4-character ids.
