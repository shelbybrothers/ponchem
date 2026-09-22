// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PonchemConstants} from "./PonchemConstants.sol";

/// @title PonchemCheck
/// @notice The registration-time checks of the lab, deployed once next to it and called with STATICCALL: a pocket
///         blob is checked against SPEC-ENGINE.md section 5 and turned into the scan form the lab stores, a topology
///         blob is checked against section 4.6, and pairTerms exposes the per-pair intermediates for audits. It holds
///         no state. It lives apart from PonchemLab only because the lab's runtime would not fit under the EIP-170
///         code size limit with it inside.
contract PonchemCheck is PonchemConstants {
    error BadPocket();
    error BadTopology();

    /// @notice Check a pocket blob and its id, and return the atom count, the box half sizes and the scan form.
    function checkPocket(bytes calldata pocket, string calldata pdbId)
        external
        pure
        returns (uint16 n, uint16 hx, uint16 hy, uint16 hz, bytes memory scan)
    {
        (n, hx, hy, hz) = _checkPocket(pocket, pdbId);
        scan = _scanForm(pocket, n);
    }

    /// @notice Check a topology blob and return its atom count and rotor count.
    function checkTopology(bytes calldata topology) external pure returns (uint8 n, uint8 nrot) {
        return _checkTopology(topology);
    }

    /// @notice The intermediates of one pocket pair against the tables at `tablesData`: r = isqrt(r2),
    ///         d = r - Ra - Rb, the two gauss lookups, repulsion, hydrophobic and hydrogen bond terms in micro
    ///         units. `inCutoff` is false (and everything else zero) when r2 > 640000.
    function pairTerms(address tablesData, uint8 ta, uint8 tb, uint32 r2)
        external
        view
        returns (bool inCutoff, uint256 r, int256 d, uint256 g1, uint256 g2, uint256 rep, uint256 hyd, uint256 hb)
    {
        return _pairTerms(tablesData, ta, tb, r2);
    }

    function _pairTerms(address tablesData, uint8 ta, uint8 tb, uint256 r2)
        internal
        view
        returns (bool inCutoff, uint256 r, int256 d, uint256 g1, uint256 g2, uint256 rep, uint256 hyd, uint256 hb)
    {
        if (ta > 15 || tb > 15) revert BadTopology();
        if (r2 > 640000) return (false, 0, 0, 0, 0, 0, 0, 0);
        bytes memory tab = new bytes(TABLES_SIZE);
        assembly ("memory-safe") {
            extcodecopy(tablesData, add(tab, 32), 1, 13010)
        }
        r = _u16(tab, 8008 + 2 * (r2 >> 8));
        while ((r + 1) * (r + 1) <= r2) r++;
        d = int256(r) - int256(_radius(ta) + _radius(tb));
        uint256 idx = uint256(d + 440);
        g1 = _u32(tab, 4 * idx);
        g2 = _u32(tab, 4004 + 4 * idx);
        if (d < 0) rep = uint256(d * d) * 100;
        uint256 fa = _flags(ta);
        uint256 fb = _flags(tb);
        if ((fa & fb & 1) != 0) {
            if (d <= 50) hyd = 1_000_000;
            else if (d < 150) hyd = uint256(150 - d) * 10_000;
        }
        if (((fa & 2) != 0 && (fb & 4) != 0) || ((fa & 4) != 0 && (fb & 2) != 0)) {
            if (d <= -70) hb = 1_000_000;
            else if (d < 0) hb = (uint256(-d) * 100_000) / 7;
        }
        inCutoff = true;
    }

    // --------------------------------------------------------- registration checks

    /// @dev Full structural check of a pocket blob against SPEC-ENGINE.md section 5, run once at registration:
    ///      header, id, sizes, the grid dimensions against the box, the cell offsets, and that every atom sits in
    ///      the cell whose range holds it (this is what lets the scan trust the offsets). Returns n and the box.
    function _checkPocket(bytes memory p, string memory pdbId) internal pure returns (uint16 n, uint16 hx, uint16 hy, uint16 hz) {
        if (p.length < 28 || uint8(p[27]) != POCKET_VERSION) revert BadPocket();
        bytes memory id = bytes(pdbId);
        if (id.length != 4) revert BadPocket();
        for (uint256 i = 0; i < 4; i++) {
            bytes1 c = id[i];
            if (c != p[i]) revert BadPocket();
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A);
            if (!ok) revert BadPocket();
        }
        n = uint16(_u16(p, 4));
        if (n == 0 || n > MAX_POCKET_ATOMS) revert BadPocket();
        hx = uint16(_u16(p, 6));
        hy = uint16(_u16(p, 8));
        hz = uint16(_u16(p, 10));
        if (hx == 0 || hy == 0 || hz == 0) revert BadPocket();
        uint256 nx = uint8(p[24]);
        uint256 ny = uint8(p[25]);
        uint256 nz = uint8(p[26]);
        if (nx != (2 * uint256(hx) + 1600) / 800 + 1) revert BadPocket();
        if (ny != (2 * uint256(hy) + 1600) / 800 + 1) revert BadPocket();
        if (nz != (2 * uint256(hz) + 1600) / 800 + 1) revert BadPocket();
        uint256 ncells = nx * ny * nz;
        uint256 offs = 28 + 7 * uint256(n);
        if (p.length != offs + 2 * (ncells + 1)) revert BadPocket();
        if (_u16(p, offs) != 0 || _u16(p, offs + 2 * ncells) != n) revert BadPocket();
        uint256 k = 0;
        for (uint256 c = 0; c < ncells; c++) {
            uint256 end = _u16(p, offs + 2 * (c + 1));
            if (end < k) revert BadPocket();
            for (; k < end; k++) {
                uint256 rec = 28 + 7 * k;
                if (uint8(p[rec + 6]) > 15) revert BadPocket();
                int256 ax = _i16(p, rec) + int256(uint256(hx)) + 800;
                int256 ay = _i16(p, rec + 2) + int256(uint256(hy)) + 800;
                int256 az = _i16(p, rec + 4) + int256(uint256(hz)) + 800;
                if (ax < 0 || ay < 0 || az < 0) revert BadPocket();
                uint256 cell = (uint256(ax / 800) * ny + uint256(ay / 800)) * nz + uint256(az / 800);
                if (cell != c) revert BadPocket();
            }
        }
    }

    /// @dev Structural check of a topology blob against SPEC-ENGINE.md section 4.6: header, sizes, type codes,
    ///      ordered in-range bond and 1-3 lists, and near masks that carry the self bit and nothing beyond N.
    function _checkTopology(bytes memory t) internal pure returns (uint8 n, uint8 nrot) {
        if (t.length < 8 || uint8(t[0]) != TOPOLOGY_VERSION) revert BadTopology();
        n = uint8(t[1]);
        uint256 b = uint8(t[2]);
        nrot = uint8(t[3]);
        uint256 p = _u16(t, 4);
        if (n == 0 || n > MAX_LIGAND_ATOMS) revert BadTopology();
        if (_u16(t, 6) != 0) revert BadTopology();
        if (t.length != 8 + 9 * uint256(n) + 4 * b + 4 * p) revert BadTopology();
        for (uint256 i = 0; i < n; i++) {
            if (uint8(t[8 + i]) > 15) revert BadTopology();
        }
        uint256 off = 8 + n;
        off = _checkPairList(t, off, b, n);
        off = _checkPairList(t, off, p, n);
        for (uint256 i = 0; i < n; i++) {
            uint256 near = _u64(t, off + 8 * i);
            if ((near >> i) & 1 == 0) revert BadTopology();
            if (near >> n != 0) revert BadTopology();
        }
    }

    function _checkPairList(bytes memory t, uint256 off, uint256 count, uint256 n) private pure returns (uint256) {
        uint256 last = 0;
        for (uint256 k = 0; k < count; k++) {
            uint256 i = uint8(t[off]);
            uint256 j = uint8(t[off + 1]);
            uint256 ideal = _u16(t, off + 2);
            if (i >= j || j >= n || ideal == 0) revert BadTopology();
            uint256 key = (i << 8) | j;
            if (k != 0 && key <= last) revert BadTopology();
            last = key;
            off += 4;
        }
        return off;
    }

    // ------------------------------------------------------------- scan form

    /// @dev The scan form of a checked pocket blob: the same 28-byte header, then one 9-byte record per atom in the
    ///      blob's cell order, R = (x + 32768) | (y + 32768) << 18 | (z + 32768) << 36 | tw << 54 with
    ///      tw = radius << 8 | flags of the atom's type, then the blob's cell offset table unchanged. It holds every
    ///      byte of the blob in a lossless transform (the blob is x, y, z, type per atom), so anyone can rebuild the
    ///      registered pocket bytes from it and check the hash. This is what the lab stores and what a run scans.
    function _scanForm(bytes memory p, uint256 n) internal pure returns (bytes memory scan) {
        uint256 offs = 28 + 7 * n;
        uint256 tail = p.length - offs;
        scan = new bytes(28 + 9 * n + tail);
        for (uint256 i = 0; i < 28; i++) {
            scan[i] = p[i];
        }
        for (uint256 k = 0; k < n; k++) {
            uint256 rec = 28 + 7 * k;
            uint256 x = _u16(p, rec) ^ 0x8000;
            uint256 y = _u16(p, rec + 2) ^ 0x8000;
            uint256 z = _u16(p, rec + 4) ^ 0x8000;
            uint8 t = uint8(p[rec + 6]);
            uint256 tw = (_radius(t) << 8) | _flags(t);
            uint256 r = x | (y << 18) | (z << 36) | (tw << 54);
            uint256 at = 28 + 9 * k;
            for (uint256 b = 0; b < 9; b++) {
                scan[at + b] = bytes1(uint8(r >> (64 - 8 * b)));
            }
        }
        uint256 dst = 28 + 9 * n;
        for (uint256 i = 0; i < tail; i++) {
            scan[dst + i] = p[offs + i];
        }
    }

}
