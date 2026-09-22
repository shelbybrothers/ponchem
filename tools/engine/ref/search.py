"""Float Monte Carlo docking and reference-fitting (numpy). Proposes poses only.

The float objective mirrors the integer scorer's terms (Vina family) on the
receptor side and adds an intramolecular term for ligand pairs at graph distance
>= 4, a hard penalty for the on-chain clash floor and a box penalty. The final
pose of any search is rounded to int16 and validated by score.check_geometry;
the number reported is always the integer scorer's.
"""

import math

import numpy as np

from .constants import (
    RADIUS_CENTI, HYD_MASK, DON_MASK, ACC_MASK, W_G1, W_G2, W_REP, W_HYD, W_HB,
    CLASH_FLOOR_CENTI, OK,
)
from .pose import (
    rotation_from_rotvec, rigid_transform, torsion_sides, apply_torsions, kabsch, rmsd, to_centi,
)
from .score import check_geometry, score_pose
from .topology import graph_distances

WG1 = W_G1 / 1e6
WG2 = W_G2 / 1e6
WREP = W_REP / 1e6
WHYD = W_HYD / 1e6
WHB = W_HB / 1e6


def _flags(types):
    t = np.asarray(types, dtype=int)
    rad = np.array([RADIUS_CENTI[x] / 100.0 for x in t])
    hyd = np.array([(HYD_MASK >> x) & 1 for x in t], dtype=bool)
    don = np.array([(DON_MASK >> x) & 1 for x in t], dtype=bool)
    acc = np.array([(ACC_MASK >> x) & 1 for x in t], dtype=bool)
    return rad, hyd, don, acc


def vina_terms(d, hydmask, hbmask):
    """d: surface distances (angstrom) for pairs inside the cutoff; masks same shape."""
    g1 = np.exp(-(d / 0.5) ** 2)
    g2 = np.exp(-((d - 3.0) / 2.0) ** 2)
    rep = np.where(d < 0, d * d, 0.0)
    hyd = np.where(d <= 0.5, 1.0, np.where(d >= 1.5, 0.0, 1.5 - d)) * hydmask
    hb = np.where(d <= -0.7, 1.0, np.where(d >= 0.0, 0.0, -d / 0.7)) * hbmask
    return WG1 * g1 + WG2 * g2 + WREP * rep + WHYD * hyd + WHB * hb


class FloatScorer:
    def __init__(self, pocket, topo):
        atoms = pocket["atoms"]
        self.P = np.array([[a[0], a[1], a[2]] for a in atoms], dtype=float) / 100.0
        self.half = np.array(pocket["half"], dtype=float) / 100.0
        prad, phyd, pdon, pacc = _flags([a[3] for a in atoms])
        lrad, lhyd, ldon, lacc = _flags(topo["types"])
        self.rsum = lrad[:, None] + prad[None, :]
        self.hydmask = (lhyd[:, None] & phyd[None, :]).astype(float)
        self.hbmask = ((ldon[:, None] & pacc[None, :]) | (lacc[:, None] & pdon[None, :])).astype(float)
        self.nrot = topo["nrot"]
        n = topo["n_atoms"]
        bonds = [(i, j) for i, j, _d in topo["bonds"]]
        dist = graph_distances(n, [(i, j, 1) for i, j in bonds])
        iu, ju = np.triu_indices(n, 1)
        gd = np.array([dist[i][j] for i, j in zip(iu, ju)])
        self.pair_i = iu
        self.pair_j = ju
        self.far4 = gd >= 4
        self.far3 = gd >= 3
        self.lrsum = lrad[iu] + lrad[ju]
        self.lhyd = (lhyd[iu] & lhyd[ju]).astype(float)
        self.lhb = ((ldon[iu] & lacc[ju]) | (lacc[iu] & ldon[ju])).astype(float)
        self.floor = CLASH_FLOOR_CENTI / 100.0 + 0.05

    def inter(self, X):
        diff = X[:, None, :] - self.P[None, :, :]
        r = np.sqrt((diff * diff).sum(axis=2))
        inside = r <= 8.0
        d = r - self.rsum
        e = vina_terms(d, self.hydmask, self.hbmask)
        return float((e * inside).sum())

    def intra(self, X):
        if len(self.pair_i) == 0:
            return 0.0
        r = np.linalg.norm(X[self.pair_i] - X[self.pair_j], axis=1)
        d = r - self.lrsum
        e4 = vina_terms(d, self.lhyd, self.lhb) * self.far4 * (r <= 8.0)
        clash = np.maximum(0.0, self.floor - r) * self.far3
        return float(e4.sum()) + 50.0 * float((clash * clash).sum()) + 5.0 * float(clash.sum())

    def box(self, X):
        over = np.maximum(0.0, np.abs(X) - (self.half - 0.05))
        return 20.0 * float((over * over).sum()) + 2.0 * float(over.sum())

    def total(self, X):
        return self.inter(X) + self.intra(X) + self.box(X)

    def affinity(self, X):
        return self.inter(X) / (1.0 + 0.0585 * self.nrot)


class LigandModel:
    def __init__(self, topo, ideal_coords_angstrom, info=None):
        self.n = topo["n_atoms"]
        self.X0 = np.asarray(ideal_coords_angstrom, dtype=float)
        bonds = [(i, j) for i, j, _d in topo["bonds"]]
        if info is not None and "rotatable_bonds" in info:
            rot = [tuple(b) for b in info["rotatable_bonds"]]
        else:
            rot = []
        self.sides = torsion_sides(self.n, bonds, rot)
        self.nrot = len(self.sides)

    def build(self, rotvec, t, angles):
        X = apply_torsions(self.X0, self.sides, angles) if self.nrot else self.X0
        return rigid_transform(X, rotation_from_rotvec(rotvec), t)


def _random_rotvec(rng):
    v = rng.normal(size=3)
    v /= np.linalg.norm(v)
    return v * rng.uniform(0, math.pi)


def dock(pocket, topo, ligand: LigandModel, seed=1, n_starts=6, n_steps=1000, kT=1.2, log=None):
    """Monte Carlo search with greedy local refinement. Returns (pose_int16, float_energy, info)."""
    rng = np.random.default_rng(seed)
    fs = FloatScorer(pocket, topo)
    half = fs.half
    best = None
    for start in range(n_starts):
        t = rng.uniform(-half * 0.4, half * 0.4)
        rv = _random_rotvec(rng)
        ang = rng.uniform(-math.pi, math.pi, size=ligand.nrot)
        X = ligand.build(rv, t, ang)
        e = fs.total(X)
        cur = (t, rv, ang, e)
        local_best = cur
        for step in range(n_steps):
            t2, rv2, ang2 = cur[0].copy(), cur[1].copy(), cur[2].copy()
            m = rng.integers(0, 3 if ligand.nrot else 2)
            if m == 0:
                t2 += rng.normal(scale=0.5, size=3)
            elif m == 1:
                rv2 = _compose(rv2, rng.normal(scale=0.35, size=3))
            else:
                k = rng.integers(0, ligand.nrot)
                ang2[k] = rng.uniform(-math.pi, math.pi)
            e2 = fs.total(ligand.build(rv2, t2, ang2))
            # greedy local refinement
            for _ in range(8):
                t3, rv3, ang3 = t2.copy(), rv2.copy(), ang2.copy()
                mm = rng.integers(0, 3 if ligand.nrot else 2)
                if mm == 0:
                    t3 += rng.normal(scale=0.15, size=3)
                elif mm == 1:
                    rv3 = _compose(rv3, rng.normal(scale=0.1, size=3))
                else:
                    k = rng.integers(0, ligand.nrot)
                    ang3[k] += rng.normal(scale=0.3)
                e3 = fs.total(ligand.build(rv3, t3, ang3))
                if e3 < e2:
                    t2, rv2, ang2, e2 = t3, rv3, ang3, e3
            if e2 < cur[3] or rng.uniform() < math.exp(-(e2 - cur[3]) / kT):
                cur = (t2, rv2, ang2, e2)
                if e2 < local_best[3]:
                    local_best = cur
        if log:
            log("start %d: best float total %.3f" % (start, local_best[3]))
        if best is None or local_best[3] < best[3]:
            best = local_best
    t, rv, ang, e = best
    pose, X, attempts = _legalize(pocket, topo, ligand, fs, rng, rv, t, ang)
    return pose, fs.total(X), {"float_total": fs.total(X), "float_inter": fs.inter(X),
                               "float_affinity": fs.affinity(X), "legalize_steps": attempts}


def _violation(fs, X):
    """Float replica of the two checks a rigid+torsion move can break: box and clash floor."""
    r = np.linalg.norm(X[fs.pair_i] - X[fs.pair_j], axis=1) if len(fs.pair_i) else np.zeros(0)
    clash = np.maximum(0.0, (fs.floor + 0.02) - r) * fs.far3
    over = np.maximum(0.0, np.abs(X) - (fs.half - 0.02))
    return float(clash.sum()) + float(over.sum())


def _legalize(pocket, topo, ligand, fs, rng, rv, t, ang, max_steps=3000):
    """Greedy small moves that reduce the violation measure until the integer checks pass.
    Returns (pose, X, steps)."""
    rv = np.array(rv, dtype=float)
    t = np.array(t, dtype=float)
    ang = np.array(ang, dtype=float)
    X = ligand.build(rv, t, ang)
    v = _violation(fs, X)
    for step in range(max_steps):
        if v == 0.0:
            try:
                pose = to_centi(X)
                code, _d = check_geometry(topo, pose, pocket["half"])
            except ValueError:
                code = -1
            if code == OK:
                return pose, X, step
        t2, rv2, ang2 = t.copy(), rv.copy(), ang.copy()
        m = rng.integers(0, 3 if ligand.nrot else 2)
        if m == 0:
            t2 += rng.normal(scale=0.08, size=3)
        elif m == 1:
            rv2 = _compose(rv2, rng.normal(scale=0.04, size=3))
        else:
            k = rng.integers(0, ligand.nrot)
            ang2[k] += rng.normal(scale=0.15)
        X2 = ligand.build(rv2, t2, ang2)
        v2 = _violation(fs, X2)
        if v2 < v or (v2 == 0.0 and v == 0.0):
            t, rv, ang, X, v = t2, rv2, ang2, X2, v2
    raise RuntimeError("could not produce a pose that passes the integer geometry checks")


def _compose(rv, delta):
    R = rotation_from_rotvec(delta) @ rotation_from_rotvec(rv)
    # back to a rotation vector
    angle = math.acos(max(-1.0, min(1.0, (np.trace(R) - 1.0) / 2.0)))
    if angle < 1e-9:
        return np.zeros(3)
    axis = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2.0 * math.sin(angle))
    return axis * angle


def _rotvec_from_matrix(R):
    angle = math.acos(max(-1.0, min(1.0, (np.trace(R) - 1.0) / 2.0)))
    if angle < 1e-9:
        return np.zeros(3)
    if abs(angle - math.pi) < 1e-6:
        # axis from the symmetric part
        A = (R + np.eye(3)) / 2.0
        axis = np.sqrt(np.maximum(np.diag(A), 0.0))
        axis /= np.linalg.norm(axis)
        return axis * angle
    axis = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2.0 * math.sin(angle))
    return axis * angle


def fit_to_reference(ligand: LigandModel, target, seed=1, n_iter=4000, log=None):
    """Fit the ideal geometry onto target coordinates (angstrom, same atom order) by torsion
    Monte Carlo plus Kabsch superposition. Returns (coords, rmsd, state) where state is
    (rotvec, t, angles) such that ligand.build(*state) reproduces coords."""
    rng = np.random.default_rng(seed)
    T = np.asarray(target, dtype=float)

    def place(angles):
        X = apply_torsions(ligand.X0, ligand.sides, angles) if ligand.nrot else ligand.X0
        R, t = kabsch(X, T)
        return X @ R.T + t, R

    ang = np.zeros(ligand.nrot)
    X, R = place(ang)
    best = (rmsd(X, T), ang.copy(), X, R)
    cur = best
    for it in range(n_iter if ligand.nrot else 0):
        a2 = cur[1].copy()
        k = rng.integers(0, ligand.nrot)
        if rng.uniform() < 0.3:
            a2[k] = rng.uniform(-math.pi, math.pi)
        else:
            a2[k] += rng.normal(scale=0.25)
        X2, R2 = place(a2)
        r2 = rmsd(X2, T)
        if r2 < cur[0] or rng.uniform() < math.exp(-(r2 - cur[0]) / 0.05):
            cur = (r2, a2, X2, R2)
            if r2 < best[0]:
                best = cur
    if log:
        log("fit rmsd %.3f A" % best[0])
    r_best, ang_best, X_best, R_best = best
    state = (_rotvec_from_matrix(R_best), X_best.mean(axis=0), ang_best)
    return X_best, r_best, state


def refine(pocket, topo, ligand: LigandModel, state, seed=1, n_steps=600, log=None):
    """Small-move greedy Monte Carlo from a given state (rotvec, t, angles). Returns
    (pose_int16, float_total, info). Used to locally optimise a fitted crystal pose."""
    rng = np.random.default_rng(seed)
    fs = FloatScorer(pocket, topo)
    rv, t, ang = np.array(state[0], dtype=float), np.array(state[1], dtype=float), np.array(state[2], dtype=float)
    e = fs.total(ligand.build(rv, t, ang))
    start_e = e
    for step in range(n_steps):
        t2, rv2, ang2 = t.copy(), rv.copy(), ang.copy()
        m = rng.integers(0, 3 if ligand.nrot else 2)
        if m == 0:
            t2 += rng.normal(scale=0.12, size=3)
        elif m == 1:
            rv2 = _compose(rv2, rng.normal(scale=0.06, size=3))
        else:
            k = rng.integers(0, ligand.nrot)
            ang2[k] += rng.normal(scale=0.2)
        e2 = fs.total(ligand.build(rv2, t2, ang2))
        if e2 < e:
            t, rv, ang, e = t2, rv2, ang2, e2
    if log:
        log("refine: float total %.3f -> %.3f" % (start_e, e))
    pose, X, steps = _legalize(pocket, topo, ligand, fs, rng, rv, t, ang)
    return pose, fs.total(X), {"float_total": fs.total(X), "float_inter": fs.inter(X),
                               "float_affinity": fs.affinity(X), "start_total": start_e, "legalize_steps": steps}
