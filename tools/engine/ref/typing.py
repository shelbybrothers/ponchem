"""Atom typing (SPEC-ENGINE.md, sections 1, 2 and 4).

Receptor typing is a fixed table keyed by (residue name, atom name). Ligand
typing is a graph rule over the heavy-atom bond graph of the SDF. Both produce
the uint8 type codes of constants.py.

Rule for carbon (receptor and ligand alike, Vina's rule): a carbon bonded to at
least one heavy atom that is not carbon is C_P, otherwise C_H. This is why
CYS CB, MET CG and MET CE are polar carbons (they touch sulfur).
"""

from .constants import (
    C_H, C_P, N_P, N_D, N_A, N_DA, O_A, O_DA, S_P, P_P, F_H, CL_H, BR_H, I_H, MET_D,
)

# Backbone atoms shared by every standard residue (PRO N is overridden below).
_BACKBONE = {"N": N_D, "CA": C_P, "C": C_P, "O": O_A, "OXT": O_A}

_SIDE = {
    "ALA": {"CB": C_H},
    "ARG": {"CB": C_H, "CG": C_H, "CD": C_P, "NE": N_D, "CZ": C_P, "NH1": N_D, "NH2": N_D},
    "ASN": {"CB": C_H, "CG": C_P, "OD1": O_A, "ND2": N_D},
    "ASP": {"CB": C_H, "CG": C_P, "OD1": O_A, "OD2": O_A},
    "CYS": {"CB": C_P, "SG": S_P},
    "GLN": {"CB": C_H, "CG": C_H, "CD": C_P, "OE1": O_A, "NE2": N_D},
    "GLU": {"CB": C_H, "CG": C_H, "CD": C_P, "OE1": O_A, "OE2": O_A},
    "GLY": {},
    "HIS": {"CB": C_H, "CG": C_P, "ND1": N_DA, "CD2": C_P, "CE1": C_P, "NE2": N_DA},
    "ILE": {"CB": C_H, "CG1": C_H, "CG2": C_H, "CD1": C_H},
    "LEU": {"CB": C_H, "CG": C_H, "CD1": C_H, "CD2": C_H},
    "LYS": {"CB": C_H, "CG": C_H, "CD": C_H, "CE": C_P, "NZ": N_D},
    "MET": {"CB": C_H, "CG": C_P, "SD": S_P, "CE": C_P},
    "PHE": {"CB": C_H, "CG": C_H, "CD1": C_H, "CD2": C_H, "CE1": C_H, "CE2": C_H, "CZ": C_H},
    "PRO": {"CB": C_H, "CG": C_H, "CD": C_P},
    "SER": {"CB": C_P, "OG": O_DA},
    "THR": {"CB": C_P, "OG1": O_DA, "CG2": C_H},
    "TRP": {"CB": C_H, "CG": C_H, "CD1": C_P, "CD2": C_H, "NE1": N_D, "CE2": C_P,
            "CE3": C_H, "CZ2": C_H, "CZ3": C_H, "CH2": C_H},
    "TYR": {"CB": C_H, "CG": C_H, "CD1": C_H, "CD2": C_H, "CE1": C_H, "CE2": C_H, "CZ": C_P, "OH": O_DA},
    "VAL": {"CB": C_H, "CG1": C_H, "CG2": C_H},
    # selenomethionine: selenium is typed as sulfur (nearest listed element)
    "MSE": {"CB": C_H, "CG": C_P, "SE": S_P, "CE": C_P},
}

# Residue name aliases that share a table.
_ALIAS = {"HID": "HIS", "HIE": "HIS", "HIP": "HIS", "HSD": "HIS", "HSE": "HIS", "HSP": "HIS",
          "CYX": "CYS", "CYM": "CYS", "ASH": "ASP", "GLH": "GLU", "LYN": "LYS", "ARN": "ARG"}

RESIDUE_TABLE = {}
for _res, _side in _SIDE.items():
    _t = dict(_BACKBONE)
    if _res == "PRO":
        _t["N"] = N_P
    _t.update(_side)
    RESIDUE_TABLE[_res] = _t
for _a, _r in _ALIAS.items():
    RESIDUE_TABLE[_a] = RESIDUE_TABLE[_r]

# Metal ions kept from HETATM records, keyed by element symbol (upper case).
METAL_ELEMENTS = ("ZN", "MG", "MN", "CA", "FE", "NA", "K", "CO", "NI", "CU")

WATER_RESIDUES = ("HOH", "WAT", "DOD", "H2O")


def receptor_atom_type(resname: str, atomname: str):
    """Type code for a protein atom, or None if the atom is not in the table (dropped)."""
    table = RESIDUE_TABLE.get(resname)
    if table is None:
        return None
    return table.get(atomname)


def metal_type(element: str):
    return MET_D if element.upper() in METAL_ELEMENTS else None


# ---- ligand typing ---------------------------------------------------------------

_HALOGEN = {"F": F_H, "CL": CL_H, "BR": BR_H, "I": I_H}


class UnsupportedElement(ValueError):
    pass


def ligand_atom_type(element: str, heavy_neighbour_elements, h_count: int, formal_charge: int) -> int:
    """Type of one heavy ligand atom from its element, its heavy neighbours' elements,
    the number of hydrogens attached and its formal charge.

    N is a donor iff h_count >= 1. N is an acceptor iff formal_charge <= 0 and
    (heavy degree + h_count) <= 2 (pyridine, imine, nitrile, azo). O is always an
    acceptor and a donor too iff h_count >= 1. Halogens are hydrophobic.
    """
    el = element.upper()
    if el == "C":
        return C_P if any(e.upper() != "C" for e in heavy_neighbour_elements) else C_H
    if el == "N":
        donor = h_count >= 1
        acceptor = formal_charge <= 0 and (len(heavy_neighbour_elements) + h_count) <= 2
        if donor and acceptor:
            return N_DA
        if donor:
            return N_D
        if acceptor:
            return N_A
        return N_P
    if el == "O":
        return O_DA if h_count >= 1 else O_A
    if el == "S":
        return S_P
    if el == "P":
        return P_P
    if el in _HALOGEN:
        return _HALOGEN[el]
    raise UnsupportedElement("unsupported ligand element: " + element)
