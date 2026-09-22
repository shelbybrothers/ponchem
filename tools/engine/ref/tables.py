"""Lookup tables (SPEC-ENGINE.md, section 3.4).

gauss1[d] = round_half_even(1e6 * exp(-(d/0.5)^2))       d in centi-A, d = -440..560
gauss2[d] = round_half_even(1e6 * exp(-((d-3.0)/2.0)^2))   same index range
sqrt[k]   = isqrt(256 * k)                                 k = 0..2500

Values are computed with the decimal module (correctly rounded exp, then
ROUND_HALF_EVEN to an integer), so the bytes are the same on every platform.
Ports never recompute the tables: they load the frozen bytes and check the
keccak256 written in data/tables/tables.json.

Byte layouts (all big-endian):
  gauss1.bin : 1001 x uint32   (4004 bytes)
  gauss2.bin : 1001 x uint32   (4004 bytes)
  sqrt.bin   : 2501 x uint16   (5002 bytes)
  tables.bin : gauss1.bin || gauss2.bin || sqrt.bin   (13010 bytes)
"""

import json
import math
import os
from decimal import Decimal, ROUND_HALF_EVEN, getcontext

from .constants import D_MIN, D_MAX, TABLE_LEN, SQRT_TABLE_LEN, TERM_ONE, CUTOFF_R2
from .keccak import keccak256_hex

getcontext().prec = 40


def _gauss_micro(d_centi: int, offset_centi: int, width_centi: int) -> int:
    # x = (d - offset) / width, value = exp(-x^2) * 1e6, rounded half even to an integer
    x = (Decimal(d_centi) - Decimal(offset_centi)) / Decimal(width_centi)
    v = (-(x * x)).exp() * Decimal(TERM_ONE)
    return int(v.quantize(Decimal(1), rounding=ROUND_HALF_EVEN))


def gauss1_table():
    return [_gauss_micro(d, 0, 50) for d in range(D_MIN, D_MAX + 1)]


def gauss2_table():
    return [_gauss_micro(d, 300, 200) for d in range(D_MIN, D_MAX + 1)]


def sqrt_table():
    return [math.isqrt(256 * k) for k in range(SQRT_TABLE_LEN)]


def encode_u32(values):
    return b"".join(int(v).to_bytes(4, "big") for v in values)


def encode_u16(values):
    return b"".join(int(v).to_bytes(2, "big") for v in values)


def decode_u32(data: bytes):
    return [int.from_bytes(data[i:i + 4], "big") for i in range(0, len(data), 4)]


def decode_u16(data: bytes):
    return [int.from_bytes(data[i:i + 2], "big") for i in range(0, len(data), 2)]


class Tables:
    """In-memory tables, indexable as tables.g1(d), tables.g2(d), tables.isqrt(r2)."""

    def __init__(self, g1, g2, sq):
        assert len(g1) == TABLE_LEN and len(g2) == TABLE_LEN and len(sq) == SQRT_TABLE_LEN
        self._g1 = list(g1)
        self._g2 = list(g2)
        self._sq = list(sq)

    def g1(self, d_centi: int) -> int:
        if d_centi < D_MIN or d_centi > D_MAX:
            return 0
        return self._g1[d_centi - D_MIN]

    def g2(self, d_centi: int) -> int:
        if d_centi < D_MIN or d_centi > D_MAX:
            return 0
        return self._g2[d_centi - D_MIN]

    def isqrt(self, r2: int) -> int:
        """Exact floor(sqrt(r2)) for 0 <= r2 <= CUTOFF_R2 using the sqrt table plus
        a correction loop. For r2 >= 16384 the loop runs at most once."""
        if r2 < 0 or r2 > CUTOFF_R2:
            raise ValueError("r2 out of table range")
        r = self._sq[r2 >> 8]
        while (r + 1) * (r + 1) <= r2:
            r += 1
        return r

    @property
    def raw_gauss1(self):
        return self._g1

    @property
    def raw_gauss2(self):
        return self._g2

    @property
    def raw_sqrt(self):
        return self._sq

    def to_bytes(self):
        g1 = encode_u32(self._g1)
        g2 = encode_u32(self._g2)
        sq = encode_u16(self._sq)
        return g1, g2, sq, g1 + g2 + sq

    @staticmethod
    def generate():
        return Tables(gauss1_table(), gauss2_table(), sqrt_table())

    @staticmethod
    def from_bytes(blob: bytes):
        n1 = TABLE_LEN * 4
        n2 = TABLE_LEN * 4
        n3 = SQRT_TABLE_LEN * 2
        if len(blob) != n1 + n2 + n3:
            raise ValueError("tables.bin has the wrong length")
        return Tables(decode_u32(blob[:n1]), decode_u32(blob[n1:n1 + n2]), decode_u16(blob[n1 + n2:]))

    @staticmethod
    def load(dir_path: str):
        with open(os.path.join(dir_path, "tables.bin"), "rb") as f:
            return Tables.from_bytes(f.read())


def write_tables(dir_path: str):
    """Generate and freeze the tables into dir_path. Returns the descriptor dict."""
    os.makedirs(dir_path, exist_ok=True)
    t = Tables.generate()
    g1, g2, sq, combined = t.to_bytes()
    files = {"gauss1.bin": g1, "gauss2.bin": g2, "sqrt.bin": sq, "tables.bin": combined}
    for name, blob in files.items():
        with open(os.path.join(dir_path, name), "wb") as f:
            f.write(blob)
    desc = {
        "format": "ponchem-tables-v1",
        "units": "gauss entries are the term value times 1e6 (micro units), sqrt entries are floor(sqrt(256*k))",
        "index": "gauss index i = d_centi - D_MIN, d_centi = r_centi - (Ri + Rj); sqrt index k = r2 >> 8",
        "d_min": D_MIN, "d_max": D_MAX, "gauss_len": TABLE_LEN, "sqrt_len": SQRT_TABLE_LEN,
        "gauss_entry": "uint32 big-endian", "sqrt_entry": "uint16 big-endian",
        "gauss1": {"offset_centi": 0, "width_centi": 50, "bytes": len(g1), "keccak256": keccak256_hex(g1)},
        "gauss2": {"offset_centi": 300, "width_centi": 200, "bytes": len(g2), "keccak256": keccak256_hex(g2)},
        "sqrt": {"bytes": len(sq), "keccak256": keccak256_hex(sq)},
        "tables": {"layout": "gauss1 || gauss2 || sqrt", "bytes": len(combined),
                   "offsets": {"gauss1": 0, "gauss2": len(g1), "sqrt": len(g1) + len(g2)},
                   "keccak256": keccak256_hex(combined)},
        "gauss1_values": t.raw_gauss1,
        "gauss2_values": t.raw_gauss2,
        "sqrt_values": t.raw_sqrt,
    }
    with open(os.path.join(dir_path, "tables.json"), "w") as f:
        json.dump(desc, f, indent=0)
    return desc
