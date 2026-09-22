// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PonchemConstants} from "./PonchemConstants.sol";

/// @title PonchemEngine
/// @notice The integer Vina-style scorer and the geometry proof of SPEC-ENGINE.md (sections 1, 3, 4.5, 4.6, 5, 6),
///         written in Yul so that a run stays affordable. Nothing here touches storage: the pocket scan form, the
///         topology bytes and the frozen tables are copied from their data contracts into memory once per call.
///
///         Layouts (big-endian everywhere):
///          - topology  0 version(1) | 1 N | 2 B | 3 Nrot | 4 P(u16) | 6 reserved(u16) | 8 N types |
///                      B x (i, j, ideal u16) | P x (i, j, ideal u16) | N x near(u64)
///          - pocket    the spec blob: 0 pdb id(4) | 4 n(u16) | 6 hx hy hz(u16) | 12 cx cy cz(i32 milli) |
///                      24 nx ny nz | 27 version | 28 n x (x y z int16, type u8) sorted by cell |
///                      (nx*ny*nz + 1) x off(u16). The lab stores its scan form (PonchemCheck): the same header,
///                      n x 9-byte records, the same offsets.
///          - pose      N x (x, y, z) int16 centi-A relative to the box centre, in topology order
///          - tables    GAUSS1 1001 x u32 | GAUSS2 1001 x u32 | SQ 2501 x u16   (13,010 bytes)
///
///         Every intermediate stays inside the bounds the spec states: r2 < 2^34, the five term sums below 2^42
///         (packed into one 256-bit accumulator, 48 bits each), the weighted energy in int256, and the final
///         division truncates toward zero (sdiv).
abstract contract PonchemEngine is PonchemConstants {
    // ---------------------------------------------------------------- evaluation

    /// @dev The whole of SPEC-ENGINE.md section 6. `pocketScan` is the scan form of the pocket (see `_scanForm`),
    ///      `pose` the calldata int16 array of submitRun / quote. Returns the result code (0 = OK, else the failing
    ///      check), the score in milli-kcal/mol (valid when code == 0), the keccak256 of the canonical 6N pose bytes
    ///      (valid when code != ERR_ATOM_COUNT) and the packed term sums
    ///      (g1 | g2 << 48 | rep << 96 | hyd << 144 | hb << 192), for tests.
    ///      A pose word that is not a sign-extended int16 reverts with no data (an ABI violation).
    function _evaluate(address pocketScan, address topoData, address tablesData, int16[] calldata pose)
        internal
        view
        returns (uint256 code, int256 score, bytes32 poseHash, uint256 sums)
    {
        assembly ("memory-safe") {
            // Memory records (temporary, beyond the free memory pointer):
            //   pose atom, stride 224: 0 x | 32 y | 64 z (sign-extended words) | 96 aw | 128 tables | 160 A | 192 hh
            //   pocket atom: the 9-byte scan record R = (x + 32768) | (y + 32768) << 18 | (z + 32768) << 36 |
            //   tw << 54, read as the top 72 bits of a word.
            // A is the ligand atom in the same 18-bit fields, plus 800 per field, shifted to the top of the word,
            // so A - R holds (dx + 800, dy + 800, dz + 800) in the three fields: a pair with any axis gap beyond
            // 8 A shows as a negative or an oversized field (bits 11..17 set), and one AND rejects it before a
            // single multiplication. That is most of the visits. A field in (1600, 2047] slips through and r2
            // rejects it.
            //   aw = radius << 8 | want, tw = radius << 8 | flags: flags bit0 hydrophobic, bit1 donor,
            //   bit2 acceptor; want bit0 hydrophobic, bit1 acceptor, bit2 donor (the partner the ligand atom pairs
            //   with), so `aw & tw & 1` is a hydrophobic pair and `aw & tw & 6` a hydrogen bond pair.
            //   hh is a per-run table over d: hyd(d) << 144 | hb(d) << 192, so the pair terms need no branch.
            // ---- ABI words of the pose -> pose records and the canonical 6N pose bytes
            function unpackPose(src, n, P, pb) {
                for { let end := add(src, mul(96, n)) } lt(src, end) { src := add(src, 96) } {
                    let x := calldataload(src)
                    let y := calldataload(add(src, 32))
                    let z := calldataload(add(src, 64))
                    if iszero(and(and(eq(signextend(1, x), x), eq(signextend(1, y), y)), eq(signextend(1, z), z))) {
                        revert(0, 0)
                    }
                    mstore(P, x)
                    mstore(add(P, 32), y)
                    mstore(add(P, 64), z)
                    mstore(
                        add(P, 160),
                        shl(
                            184,
                            or(
                                or(add(xor(and(x, 0xffff), 0x8000), 800), shl(18, add(xor(and(y, 0xffff), 0x8000), 800))),
                                shl(36, add(xor(and(z, 0xffff), 0x8000), 800))
                            )
                        )
                    )
                    mstore8(pb, shr(8, x))
                    mstore8(add(pb, 1), x)
                    mstore8(add(pb, 2), shr(8, y))
                    mstore8(add(pb, 3), y)
                    mstore8(add(pb, 4), shr(8, z))
                    mstore8(add(pb, 5), z)
                    P := add(P, 224)
                    pb := add(pb, 6)
                }
            }
            // ---- every atom inside the box: |x| <= hx is (x + hx) <= 2hx in unsigned arithmetic
            function boxOK(P, n, ctx) -> ok {
                let hx := mload(ctx)
                let hy := mload(add(ctx, 32))
                let hz := mload(add(ctx, 64))
                ok := 1
                for { let end := add(P, mul(224, n)) } lt(P, end) { P := add(P, 224) } {
                    if gt(add(mload(P), hx), shl(1, hx)) {
                        ok := 0
                        leave
                    }
                    if gt(add(mload(add(P, 32)), hy), shl(1, hy)) {
                        ok := 0
                        leave
                    }
                    if gt(add(mload(add(P, 64)), hz), shl(1, hz)) {
                        ok := 0
                        leave
                    }
                }
            }
            // ---- bonded (1-2) or 1-3 list in [q, qend): r2 inside [(ideal - tol)^2, (ideal + tol)^2]
            function pairsOK(P, q, qend) -> ok {
                ok := 1
                for {} lt(q, qend) { q := add(q, 4) } {
                    let w := mload(q)
                    let pi := add(P, mul(224, byte(0, w)))
                    let pj := add(P, mul(224, byte(1, w)))
                    let dx := sub(mload(pi), mload(pj))
                    let dy := sub(mload(add(pi, 32)), mload(add(pj, 32)))
                    let dz := sub(mload(add(pi, 64)), mload(add(pj, 64)))
                    let r2 := add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz))
                    let ideal := and(shr(224, w), 0xffff)
                    let tol := add(6, div(shl(1, ideal), 100))
                    let lo := 0
                    if gt(ideal, tol) { lo := sub(ideal, tol) }
                    if or(lt(r2, mul(lo, lo)), gt(r2, mul(add(ideal, tol), add(ideal, tol)))) {
                        ok := 0
                        leave
                    }
                }
            }
            // ---- every pair at graph distance >= 3 at least 2.20 A apart (r2 >= 48400)
            function clashOK(P, n, tnear) -> ok {
                ok := 1
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let mi := shr(192, mload(add(tnear, shl(3, i))))
                    let pi := add(P, mul(224, i))
                    for { let j := add(i, 1) } lt(j, n) { j := add(j, 1) } {
                        if and(shr(j, mi), 1) { continue }
                        let pj := add(P, mul(224, j))
                        let dx := sub(mload(pi), mload(pj))
                        let dy := sub(mload(add(pi, 32)), mload(add(pj, 32)))
                        let dz := sub(mload(add(pi, 64)), mload(add(pj, 64)))
                        if lt(add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz)), 48400) {
                            ok := 0
                            leave
                        }
                    }
                }
            }
            // ---- the per-run table over d in [-440, 560]: hh[d + 440] = hyd(d) << 144 | hb(d) << 192 (zero from
            //      d = 150 on, left to the zero-filled memory)
            function buildHH(hh) {
                calldatacopy(hh, calldatasize(), 32032)
                for { let i := 0 } lt(i, 590) { i := add(i, 1) } {
                    let d := sub(i, 440)
                    let hyd := 1000000
                    if sgt(d, 50) { hyd := mul(sub(150, d), 10000) }
                    let hb := 0
                    if slt(d, 0) {
                        hb := 1000000
                        let nd := sub(0, d)
                        if lt(nd, 70) { hb := div(mul(nd, 100000), 7) }
                    }
                    mstore(add(hh, shl(5, i)), or(shl(144, hyd), shl(192, hb)))
                }
            }
            // ---- the five terms of one pair inside the cutoff, added to the packed accumulator
            //      acc = g1 | g2 << 48 | rep << 96 | hyd << 144 | hb << 192 (each sum below 2^42 in the worst case).
            //      Branch-free apart from the deep-clash square root: repulsion is masked by slt(d, 0), the
            //      hydrophobic and hydrogen bond values come from hh and are masked by the pair flags.
            function pairAcc(pa, p, r2, acc) -> out {
                let tab := mload(add(pa, 128))
                // exact floor square root: table on r2 >> 8, one correction for r2 >= 16384, a few below it
                let r := shr(240, mload(add(tab, add(8008, shl(1, shr(8, r2))))))
                r := add(r, iszero(gt(mul(add(r, 1), add(r, 1)), r2)))
                if lt(r2, 16384) {
                    for {} iszero(gt(mul(add(r, 1), add(r, 1)), r2)) {} { r := add(r, 1) }
                }
                let m := and(mload(add(pa, 96)), shr(238, mload(p)))
                let d := sub(r, add(shr(8, mload(add(pa, 96))), and(shr(246, mload(p)), 0xff)))
                let i := add(d, 440)
                let g := add(tab, shl(2, i))
                let hh := mload(add(mload(add(pa, 192)), shl(5, i)))
                out :=
                    add(
                        add(acc, add(shr(224, mload(g)), and(shr(176, mload(add(g, 4004))), 0xffffffff000000000000))),
                        add(
                            shl(96, mul(mul(mul(d, d), 100), slt(d, 0))),
                            add(
                                mul(and(hh, 0xffffffffffff000000000000000000000000000000000000), and(m, 1)),
                                mul(and(hh, 0xffffffffffff000000000000000000000000000000000000000000000000), iszero(iszero(and(m, 6))))
                            )
                        )
                    )
            }
            // ---- one ligand atom (record pa) against the scan records in [p, pend), four per iteration. Only
            //      A, pa, acc, p and pend live across the loop: every extra live variable costs swaps on each of the
            //      thousands of visits.
            function scanCell(pa, acc, p, pend) -> out {
                let A := mload(add(pa, 160))
                for {} lt(add(p, 27), pend) { p := add(p, 36) } {
                    {
                        let u := sub(A, and(mload(p), 0xffffffffffffffffff0000000000000000000000000000000000000000000000))
                        if iszero(and(u, 0x3f800fe003f8000000000000000000000000000000000000000000000000)) {
                            let d := sub(and(shr(184, u), 0x7ff), 800)
                            let r2 := mul(d, d)
                            d := sub(and(shr(202, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            d := sub(and(shr(220, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            if iszero(gt(r2, 640000)) { acc := pairAcc(pa, p, r2, acc) }
                        }
                    }
                    {
                        let u := sub(A, and(mload(add(p, 9)), 0xffffffffffffffffff0000000000000000000000000000000000000000000000))
                        if iszero(and(u, 0x3f800fe003f8000000000000000000000000000000000000000000000000)) {
                            let d := sub(and(shr(184, u), 0x7ff), 800)
                            let r2 := mul(d, d)
                            d := sub(and(shr(202, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            d := sub(and(shr(220, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            if iszero(gt(r2, 640000)) { acc := pairAcc(pa, add(p, 9), r2, acc) }
                        }
                    }
                    {
                        let u := sub(A, and(mload(add(p, 18)), 0xffffffffffffffffff0000000000000000000000000000000000000000000000))
                        if iszero(and(u, 0x3f800fe003f8000000000000000000000000000000000000000000000000)) {
                            let d := sub(and(shr(184, u), 0x7ff), 800)
                            let r2 := mul(d, d)
                            d := sub(and(shr(202, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            d := sub(and(shr(220, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            if iszero(gt(r2, 640000)) { acc := pairAcc(pa, add(p, 18), r2, acc) }
                        }
                    }
                    {
                        let u := sub(A, and(mload(add(p, 27)), 0xffffffffffffffffff0000000000000000000000000000000000000000000000))
                        if iszero(and(u, 0x3f800fe003f8000000000000000000000000000000000000000000000000)) {
                            let d := sub(and(shr(184, u), 0x7ff), 800)
                            let r2 := mul(d, d)
                            d := sub(and(shr(202, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            d := sub(and(shr(220, u), 0x7ff), 800)
                            r2 := add(r2, mul(d, d))
                            if iszero(gt(r2, 640000)) { acc := pairAcc(pa, add(p, 27), r2, acc) }
                        }
                    }
                }
                for {} lt(p, pend) { p := add(p, 9) } {
                    let u := sub(A, and(mload(p), 0xffffffffffffffffff0000000000000000000000000000000000000000000000))
                    if iszero(and(u, 0x3f800fe003f8000000000000000000000000000000000000000000000000)) {
                        let d := sub(and(shr(184, u), 0x7ff), 800)
                        let r2 := mul(d, d)
                        d := sub(and(shr(202, u), 0x7ff), 800)
                        r2 := add(r2, mul(d, d))
                        d := sub(and(shr(220, u), 0x7ff), 800)
                        r2 := add(r2, mul(d, d))
                        if iszero(gt(r2, 640000)) { acc := pairAcc(pa, p, r2, acc) }
                    }
                }
                out := acc
            }
            // ---- the 27 cells around a ligand atom. ctx: hx hy hz nx ny nz offs recs (eight words). Atoms are
            //      sorted by cell index, so the three z-neighbours of one (ix, iy) are one contiguous range.
            //      A ligand atom inside the box always has 1 <= cx <= nx - 2 (SPEC-ENGINE.md 2.3), so the
            //      neighbours exist and nothing is clamped.
            function scoreAtom(pa, acc, ctx) -> out {
                let ny := mload(add(ctx, 128))
                let nz := mload(add(ctx, 160))
                // never taken (hx is a uint16): a second call site keeps scanCell out of the Yul inliner, whose
                // flattening of a single-use function spilled the visit loop to memory (4.1M gas a run)
                if eq(mload(ctx), 0xffffffffffff) { acc := scanCell(pa, acc, 0, 0) }
                let cx := sub(div(add(add(mload(pa), mload(ctx)), 800), 800), 1)
                let cy := sub(div(add(add(mload(add(pa, 32)), mload(add(ctx, 32))), 800), 800), 1)
                let cz := sub(div(add(add(mload(add(pa, 64)), mload(add(ctx, 64))), 800), 800), 1)
                for { let ix := cx } lt(ix, add(cx, 3)) { ix := add(ix, 1) } {
                    for { let iy := cy } lt(iy, add(cy, 3)) { iy := add(iy, 1) } {
                        let op := add(mload(add(ctx, 192)), shl(1, add(mul(add(mul(ix, ny), iy), nz), cz)))
                        let k0 := shr(240, mload(op))
                        let k1 := shr(240, mload(add(op, 6)))
                        if lt(k0, k1) {
                            acc := scanCell(pa, acc, add(mload(add(ctx, 224)), mul(9, k0)), add(mload(add(ctx, 224)), mul(9, k1)))
                        }
                    }
                }
                out := acc
            }
            // ---- the whole evaluation, in the order of SPEC-ENGINE.md section 6
            function evaluate(pk, tp, tb, poseOff, poseLen, mem) -> rcode, rscore, rhash, racc {
                let topo := mem
                let n := 0
                {
                    let tsz := sub(extcodesize(tp), 1)
                    extcodecopy(tp, topo, 1, tsz)
                    n := byte(1, mload(topo))
                    mem := add(topo, and(add(tsz, 31), not(31)))
                }
                if iszero(eq(poseLen, mul(3, n))) {
                    rcode := 1
                    leave
                }
                let P := mem
                {
                    let pb := add(P, mul(224, n))
                    mem := add(pb, and(add(mul(6, n), 31), not(31)))
                    unpackPose(poseOff, n, P, pb)
                    rhash := keccak256(pb, mul(6, n))
                }
                let ctx := mem
                let raw := add(ctx, 256)
                {
                    let psz := sub(extcodesize(pk), 1)
                    extcodecopy(pk, raw, 1, psz)
                    mem := add(raw, and(add(psz, 31), not(31)))
                    let ph := mload(raw)
                    mstore(ctx, and(shr(192, ph), 0xffff))
                    mstore(add(ctx, 32), and(shr(176, ph), 0xffff))
                    mstore(add(ctx, 64), and(shr(160, ph), 0xffff))
                    mstore(add(ctx, 96), byte(24, ph))
                    mstore(add(ctx, 128), byte(25, ph))
                    mstore(add(ctx, 160), byte(26, ph))
                    mstore(add(ctx, 192), add(raw, add(28, mul(9, and(shr(208, ph), 0xffff)))))
                    mstore(add(ctx, 224), add(raw, 28))
                }
                if iszero(boxOK(P, n, ctx)) {
                    rcode := 2
                    leave
                }
                {
                    let tbonds := add(topo, add(8, n))
                    let tpairs := add(tbonds, shl(2, byte(2, mload(topo))))
                    let tnear := add(tpairs, shl(2, and(shr(208, mload(topo)), 0xffff)))
                    if iszero(pairsOK(P, tbonds, tpairs)) {
                        rcode := 3
                        leave
                    }
                    if iszero(pairsOK(P, tpairs, tnear)) {
                        rcode := 4
                        leave
                    }
                    if iszero(clashOK(P, n, tnear)) {
                        rcode := 5
                        leave
                    }
                }
                let tab := mem
                extcodecopy(tb, tab, 1, 13010)
                let hh := add(tab, 13024)
                buildHH(hh)
                for { let a := 0 } lt(a, n) { a := add(a, 1) } {
                    let pa := add(P, mul(224, a))
                    let ta := byte(0, mload(add(topo, add(8, a))))
                    let fa := byte(ta, 0x0100000204060402060000010101010200000000000000000000000000000000)
                    mstore(
                        add(pa, 96),
                        or(
                            shl(8, byte(ta, 0xBEBEB4B4B4B4AAAAAAC8D296B4C8DC7800000000000000000000000000000000)),
                            or(and(fa, 1), or(shr(1, and(fa, 4)), shl(1, and(fa, 2))))
                        )
                    )
                    mstore(add(pa, 128), tab)
                    mstore(add(pa, 192), hh)
                    racc := scoreAtom(pa, racc, ctx)
                }
                // E = W_G1*S1 + W_G2*S2 + W_REP*SR + W_HYD*SH + W_HB*SB, then / (100000 * (10000 + 585 * Nrot))
                rscore :=
                    sdiv(
                        add(
                            add(
                                add(
                                    add(
                                        mul(and(racc, 0xffffffffffff), sub(0, 35600)),
                                        mul(and(shr(48, racc), 0xffffffffffff), sub(0, 5160))
                                    ),
                                    mul(and(shr(96, racc), 0xffffffffffff), 840000)
                                ),
                                mul(and(shr(144, racc), 0xffffffffffff), sub(0, 35100))
                            ),
                            mul(and(shr(192, racc), 0xffffffffffff), sub(0, 587000))
                        ),
                        mul(100000, add(10000, mul(585, byte(3, mload(topo)))))
                    )
            }
            // temporary memory beyond the free pointer; nothing is kept after the block
            code, score, poseHash, sums := evaluate(pocketScan, topoData, tablesData, pose.offset, pose.length, mload(0x40))
        }
    }

}
