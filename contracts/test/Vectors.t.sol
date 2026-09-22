// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";

/// @notice The shared engine vectors of SPEC-ENGINE.md section 8, every file in ../data/vectors: the contract's
///         quote() must give the expected score or revert with the expected BadPose reason, the tables blob must
///         carry the frozen hash, and every row of terms.json must come out of PonchemCheck.pairTerms.
///         Run:  forge test --match-contract VectorsTest -vv
contract VectorsTest is Base {
    function test_tablesHash() public view {
        string memory json = _json("tables.json");
        assertEq(keccak256(tablesBlob), vm.parseJsonBytes32(json, ".tables_keccak"), "tables.bin hash");
        assertEq(tablesBlob.length, vm.parseJsonUint(json, ".tables_bytes"), "tables.bin size");
        assertEq(lab.TABLES_HASH(), vm.parseJsonBytes32(json, ".tables_keccak"), "constant");
        assertTrue(lab.tables() != address(0), "tables stored");
        assertEq(lab.tables().code.length, 13011, "one STOP byte plus the blob");
    }

    function test_termsVector() public view {
        string memory json = _json("terms.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        uint256[] memory ta = vm.parseJsonUintArray(json, ".type_a");
        uint256[] memory tb = vm.parseJsonUintArray(json, ".type_b");
        uint256[] memory r2 = vm.parseJsonUintArray(json, ".r2");
        uint256[] memory skipped = vm.parseJsonUintArray(json, ".skipped");
        uint256[] memory r = vm.parseJsonUintArray(json, ".r_centi");
        int256[] memory d = vm.parseJsonIntArray(json, ".d_centi");
        uint256[] memory g1 = vm.parseJsonUintArray(json, ".g1");
        uint256[] memory g2 = vm.parseJsonUintArray(json, ".g2");
        uint256[] memory rep = vm.parseJsonUintArray(json, ".rep");
        uint256[] memory hyd = vm.parseJsonUintArray(json, ".hyd");
        uint256[] memory hb = vm.parseJsonUintArray(json, ".hb");
        assertEq(ta.length, count, "row count");
        for (uint256 i = 0; i < count; i++) {
            (bool inCutoff, uint256 rr, int256 dd, uint256 a1, uint256 a2, uint256 ar, uint256 ah, uint256 ab) =
                check.pairTerms(lab.tables(), uint8(ta[i]), uint8(tb[i]), uint32(r2[i]));
            string memory row = string.concat("terms row ", vm.toString(i));
            assertEq(inCutoff ? 0 : 1, skipped[i], string.concat(row, " skipped"));
            if (!inCutoff) continue;
            assertEq(rr, r[i], string.concat(row, " r"));
            assertEq(dd, d[i], string.concat(row, " d"));
            assertEq(a1, g1[i], string.concat(row, " g1"));
            assertEq(a2, g2[i], string.concat(row, " g2"));
            assertEq(ar, rep[i], string.concat(row, " rep"));
            assertEq(ah, hyd[i], string.concat(row, " hyd"));
            assertEq(ab, hb[i], string.concat(row, " hb"));
        }
    }

    /// Every case file: quote() equals the expected score, or reverts with the expected reason; the harness
    /// also returns the five term sums of the passing cases.
    function test_everyVector() public {
        Vm.DirEntry[] memory entries = vm.readDir("../data/vectors");
        uint256 cases = 0;
        for (uint256 e = 0; e < entries.length; e++) {
            string memory path = entries[e].path;
            if (!_endsWith(path, ".json")) continue;
            string memory json = vm.readFile(path);
            if (!vm.keyExistsJson(json, ".kind")) continue;
            string memory kind = vm.parseJsonString(json, ".kind");
            bytes32 k = keccak256(bytes(kind));
            if (k != keccak256("synthetic") && k != keccak256("reject") && k != keccak256("real")) continue;
            _checkCase(_vector(_basename(path)));
            cases += 1;
        }
        assertGe(cases, 15, "the vector set holds at least the 15 cases of the spec");
        emit log_named_uint("vector cases checked", cases);
    }

    function _checkCase(Vector memory v) internal {
        (uint16 t, uint16 l) = _register(v);
        if (v.code == 0) {
            int32 score = lab.quote(t, l, v.pose);
            assertEq(int256(score), v.score, string.concat(v.name, " score"));
            (uint256 code, int256 s2, bytes32 poseHash, uint256 sums) = harness.evaluate(_dataOf(t), _dataOfLigand(l), lab.tables(), v.pose);
            assertEq(code, 0, string.concat(v.name, " harness code"));
            assertEq(s2, v.score, string.concat(v.name, " harness score"));
            assertEq(sums & 0xffffffffffff, v.sums[0], string.concat(v.name, " sum g1"));
            assertEq((sums >> 48) & 0xffffffffffff, v.sums[1], string.concat(v.name, " sum g2"));
            assertEq((sums >> 96) & 0xffffffffffff, v.sums[2], string.concat(v.name, " sum rep"));
            assertEq((sums >> 144) & 0xffffffffffff, v.sums[3], string.concat(v.name, " sum hyd"));
            assertEq((sums >> 192) & 0xffffffffffff, v.sums[4], string.concat(v.name, " sum hb"));
            assertEq(poseHash, keccak256(_canonical(v.pose)), string.concat(v.name, " pose hash"));
            emit log_named_int(string.concat("  ", v.name, " score"), score);
        } else {
            _expectBadPose(uint8(v.code));
            lab.quote(t, l, v.pose);
            emit log_named_uint(string.concat("  ", v.name, " rejected with reason"), v.code);
        }
    }

    function _dataOf(uint16 t) internal view returns (address data) {
        (,,, data,,) = lab.target(t);
    }

    function _dataOfLigand(uint16 l) internal view returns (address data) {
        (,, data,,,) = lab.ligand(l);
    }

    function _canonical(int16[] memory pose) internal pure returns (bytes memory out) {
        out = new bytes(pose.length * 2);
        for (uint256 i = 0; i < pose.length; i++) {
            uint16 v = uint16(pose[i]);
            out[2 * i] = bytes1(uint8(v >> 8));
            out[2 * i + 1] = bytes1(uint8(v));
        }
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }

    function _basename(string memory path) internal pure returns (string memory) {
        bytes memory p = bytes(path);
        uint256 start = 0;
        for (uint256 i = 0; i < p.length; i++) {
            if (p[i] == "/") start = i + 1;
        }
        bytes memory out = new bytes(p.length - start);
        for (uint256 i = start; i < p.length; i++) {
            out[i - start] = p[i];
        }
        return string(out);
    }
}
