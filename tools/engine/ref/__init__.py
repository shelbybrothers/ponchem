"""Ponchem engine reference implementation (Python).

This package is the numerical authority for SPEC-ENGINE.md. The integer path
(score.py) uses only Python ints so that it mirrors the Solidity scorer and the
JS scorer bit for bit. numpy is used only by the float search (search.py) and
the pose helpers, which merely propose poses.
"""

__version__ = "1.0.0"
