"""Frozen numeric constants of the Ponchem integer scorer (SPEC-ENGINE.md, section 1 and 3).

Every number here is part of the on-chain contract. Change nothing without
bumping the format version bytes and regenerating data/tables and data/vectors.
"""

# ---- atom type codes (uint8) -------------------------------------------------
C_H = 0     # hydrophobic carbon (no heteroatom neighbour)
C_P = 1     # polar carbon (bonded to at least one non-carbon heavy atom)
N_P = 2     # nitrogen, neither donor nor acceptor
N_D = 3     # nitrogen donor (carries at least one H)
N_A = 4     # nitrogen acceptor (lone pair available, no H)
N_DA = 5    # nitrogen donor and acceptor
O_A = 6     # oxygen acceptor (every oxygen accepts)
O_D = 7     # oxygen donor only (reserved, never produced by the typing rules)
O_DA = 8    # oxygen donor and acceptor (hydroxyl)
S_P = 9     # sulfur
P_P = 10    # phosphorus
F_H = 11    # fluorine (hydrophobic)
CL_H = 12   # chlorine (hydrophobic)
BR_H = 13   # bromine (hydrophobic)
I_H = 14    # iodine (hydrophobic)
MET_D = 15  # metal ion, treated as a hydrogen bond donor

NUM_TYPES = 16

TYPE_NAMES = [
    "C_H", "C_P", "N_P", "N_D", "N_A", "N_DA", "O_A", "O_D",
    "O_DA", "S_P", "P_P", "F_H", "Cl_H", "Br_H", "I_H", "Met_D",
]

# X-Score / Vina van der Waals radii in centi-angstrom (0.01 A), indexed by type code.
RADIUS_CENTI = [
    190, 190,            # C_H, C_P
    180, 180, 180, 180,  # N_P, N_D, N_A, N_DA
    170, 170, 170,       # O_A, O_D, O_DA
    200,                 # S_P
    210,                 # P_P
    150,                 # F_H
    180,                 # Cl_H
    200,                 # Br_H
    220,                 # I_H
    120,                 # Met_D
]

HYDROPHOBIC_TYPES = (C_H, F_H, CL_H, BR_H, I_H)
DONOR_TYPES = (N_D, N_DA, O_D, O_DA, MET_D)
ACCEPTOR_TYPES = (N_A, N_DA, O_A, O_DA)

# Bit masks (bit t set iff type t has the property); handy for Solidity/JS constants.
HYD_MASK = sum(1 << t for t in HYDROPHOBIC_TYPES)   # 0x7801
DON_MASK = sum(1 << t for t in DONOR_TYPES)          # 0x8128
ACC_MASK = sum(1 << t for t in ACCEPTOR_TYPES)       # 0x0170


def is_hydrophobic(t: int) -> bool:
    return (HYD_MASK >> t) & 1 == 1


def is_donor(t: int) -> bool:
    return (DON_MASK >> t) & 1 == 1


def is_acceptor(t: int) -> bool:
    return (ACC_MASK >> t) & 1 == 1


# ---- geometry units -------------------------------------------------------------
# Coordinates: int16, centi-angstrom (0.01 A), relative to the box centre.
# Squared distances: 0.0001 A^2 (centi-angstrom squared).
CUTOFF_CENTI = 800                 # 8.00 A
CUTOFF_R2 = CUTOFF_CENTI ** 2      # 640000; pairs with r2 > CUTOFF_R2 are skipped

# Surface distance table range (d = r - Ri - Rj in centi-angstrom).
# r in [0, 800], Ri + Rj in [240, 440]  =>  d in [-440, 560].
D_MIN = -440
D_MAX = 560
TABLE_LEN = D_MAX - D_MIN + 1      # 1001 entries per gauss table

TERM_ONE = 1_000_000               # a term value of exactly 1.0 in micro units

# sqrt helper table: SQ[k] = isqrt(k * 256) for k in 0..2500 (r2 >> 8 <= 2500)
SQRT_TABLE_LEN = (CUTOFF_R2 >> 8) + 1  # 2501

# ---- scoring weights in micro-kcal/mol per unit term (Trott and Olson 2010) ------
W_G1 = -35_600      # gauss1   -0.0356
W_G2 = -5_160       # gauss2   -0.00516
W_REP = 840_000     # repulsion 0.840
W_HYD = -35_100     # hydrophobic -0.0351
W_HB = -587_000     # hydrogen bond -0.587
NROT_NUM = 585      # 1 + 0.0585 * Nrot  ==  (10000 + 585 * Nrot) / 10000
NROT_DEN = 10_000

# hydrophobic term breakpoints (centi-angstrom): 1 for d <= 50, 0 for d >= 150, linear between
HYD_GOOD = 50
HYD_BAD = 150
# hydrogen bond breakpoints: 1 for d <= -70, 0 for d >= 0, linear between
HB_GOOD = -70
HB_BAD = 0

# ---- limits ----------------------------------------------------------------------
MAX_LIGAND_ATOMS = 64
MAX_POCKET_ATOMS = 2000
MIN_LIGAND_ATOMS = 1

# ---- pocket construction (milli-angstrom integers) ------------------------------
BOX_MIN_HALF_MILLI = 6000      # 6.00 A
BOX_PAD_MILLI = 2000           # 2.00 A
POCKET_REACH_CENTI = 800       # pocket atoms: |x| <= hx + 800 on every axis
CELL_CENTI = 800               # neighbour grid cell edge (equals the cutoff)

# ---- geometry proof -------------------------------------------------------------
TOL_ABS_CENTI = 6              # bonded / 1-3 tolerance: 6 centi-A ...
TOL_PCT = 2                    # ... plus 2 percent of the ideal distance (integer division)
CLASH_FLOOR_CENTI = 220        # every pair at graph distance >= 3 must satisfy r >= 2.20 A
CLASH_FLOOR_R2 = CLASH_FLOOR_CENTI ** 2   # 48400

# ---- format versions -------------------------------------------------------------
POCKET_VERSION = 1
TOPOLOGY_VERSION = 1

# ---- evaluation result codes ------------------------------------------------------
OK = 0
ERR_ATOM_COUNT = 1      # pose byte length != 6 * n_atoms
ERR_BOX = 2             # an atom lies outside the box
ERR_BOND = 3            # a 1-2 distance is off
ERR_PAIR13 = 4          # a 1-3 distance is off
ERR_CLASH = 5           # a pair at graph distance >= 3 is closer than the clash floor
ERROR_NAMES = ["OK", "ATOM_COUNT", "BOX", "BOND", "PAIR13", "CLASH"]

# ---- display-only float constants -----------------------------------------------
RT_KCAL_298 = 0.5925                 # R * 298.15 K in kcal/mol (1.98720425864e-3 * 298.15)
PKD_PER_KCAL = 1.0 / 1.36423         # pKd = -dG / (RT ln 10) = -dG / 1.36423


def tdiv(a: int, b: int) -> int:
    """Integer division truncating toward zero (Solidity and BigInt semantics)."""
    if b == 0:
        raise ZeroDivisionError
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def div_round_half_even(a: int, b: int) -> int:
    """a / b rounded half to even, applied to the magnitude (symmetric), b > 0."""
    if b <= 0:
        raise ValueError("b must be positive")
    neg = a < 0
    m = -a if neg else a
    q, r = divmod(m, b)
    twice = 2 * r
    if twice > b or (twice == b and (q & 1) == 1):
        q += 1
    return -q if neg else q
