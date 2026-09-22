"""Pose helpers (float, numpy): rigid transforms, torsions, Kabsch, int16 conversion.

These only PROPOSE poses. The integer scorer (score.py) is the authority on
validity and on the number shown. Conventions (SPEC-ENGINE.md, section 7):

  rigid placement:  X = (X_ideal - centroid(X_ideal)) @ R^T + t
                    R = Rz(gamma) @ Ry(beta) @ Rx(alpha)   (extrinsic x, then y, then z)
                    t = ligand centroid in the box frame (angstrom, relative to the box centre)
  torsion k about rotatable bond (a, b): the moving side is the smaller of the two
                    components obtained by cutting the bond (ties: the side of the higher
                    index endpoint); it rotates about the axis fixed -> moving by theta_k.
                    Torsions are applied in list order on the current coordinates, before
                    the rigid placement.
  int16 pose:       centi = rint(100 * X) with round half to even (numpy rint), must fit int16.
"""

from collections import deque

import numpy as np


def rot_x(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(b):
    c, s = np.cos(b), np.sin(b)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(g):
    c, s = np.cos(g), np.sin(g)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def rotation_from_euler(alpha, beta, gamma):
    return rot_z(gamma) @ rot_y(beta) @ rot_x(alpha)


def rotation_from_rotvec(v):
    v = np.asarray(v, dtype=float)
    theta = np.linalg.norm(v)
    if theta < 1e-12:
        return np.eye(3)
    k = v / theta
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(theta) * K + (1 - np.cos(theta)) * (K @ K)


def rigid_transform(coords, R, t):
    coords = np.asarray(coords, dtype=float)
    c = coords.mean(axis=0)
    return (coords - c) @ R.T + np.asarray(t, dtype=float)


def _side(n, bonds, cut, start):
    adj = [[] for _ in range(n)]
    for (i, j) in bonds:
        if (i, j) == cut:
            continue
        adj[i].append(j)
        adj[j].append(i)
    seen = {start}
    q = deque([start])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if v not in seen:
                seen.add(v)
                q.append(v)
    return seen


def torsion_sides(n, bonds, rot_bonds):
    """rot_bonds: list of (a, b). Returns list of (fixed, moving, moving_atoms sorted)."""
    bset = [(min(i, j), max(i, j)) for (i, j) in bonds]
    out = []
    for (a, b) in rot_bonds:
        cut = (min(a, b), max(a, b))
        sa = _side(n, bset, cut, a)
        sb = _side(n, bset, cut, b)
        if len(sb) < len(sa) or (len(sb) == len(sa) and b > a):
            fixed, moving, mv = a, b, sb
        else:
            fixed, moving, mv = b, a, sa
        out.append((fixed, moving, np.array(sorted(mv), dtype=int)))
    return out


def apply_torsions(coords, sides, angles):
    """Rotate each moving side about its bond axis by angles[k], sequentially."""
    X = np.array(coords, dtype=float)
    for (fixed, moving, mv), theta in zip(sides, angles):
        if abs(theta) < 1e-12:
            continue
        axis = X[moving] - X[fixed]
        norm = np.linalg.norm(axis)
        if norm < 1e-9:
            continue
        R = rotation_from_rotvec(axis / norm * theta)
        X[mv] = (X[mv] - X[moving]) @ R.T + X[moving]
    return X


def kabsch(P, Q):
    """R, t such that P @ R.T + t best fits Q (least squares). Proper rotation only."""
    P = np.asarray(P, dtype=float)
    Q = np.asarray(Q, dtype=float)
    pc = P.mean(axis=0)
    qc = Q.mean(axis=0)
    H = (P - pc).T @ (Q - qc)
    U, S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    t = qc - pc @ R.T
    return R, t


def rmsd(P, Q):
    P = np.asarray(P, dtype=float)
    Q = np.asarray(Q, dtype=float)
    return float(np.sqrt(((P - Q) ** 2).sum(axis=1).mean()))


def to_centi(coords):
    """Angstrom (relative to the box centre) -> list of int16 triples, round half to even."""
    c = np.rint(np.asarray(coords, dtype=float) * 100.0).astype(np.int64)
    if c.min() < -32768 or c.max() > 32767:
        raise ValueError("pose does not fit int16")
    return [(int(x), int(y), int(z)) for x, y, z in c]


def from_centi(pose):
    return np.asarray(pose, dtype=float) / 100.0
