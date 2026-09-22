// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PonchemLab} from "../src/PonchemLab.sol";
import {PonchemCheck} from "../src/PonchemCheck.sol";
import {PonchemEngine} from "../src/PonchemEngine.sol";

/// @dev Exposes the engine's internal evaluation (with the packed term sums) to the tests.
contract EngineHarness is PonchemEngine {
    function evaluate(address pocketScan, address topoData, address tablesData, int16[] calldata pose)
        external
        view
        returns (uint256 code, int256 score, bytes32 poseHash, uint256 sums)
    {
        return _evaluate(pocketScan, topoData, tablesData, pose);
    }
}

/// @notice Shared fixture: one lab with the frozen tables, an owner, a treasury and a few wallets. Vector files
///         from ../data/vectors are read on demand and their pockets and topologies registered once per hash.
abstract contract Base is Test {
    PonchemLab internal lab;
    PonchemCheck internal check;
    EngineHarness internal harness;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant FEE_BPS = 500;
    uint256 internal constant RUN_FEE = 0.0001 ether;
    uint256 internal constant RUN_PRICE = 100e18;
    uint64 internal constant EPOCH = 7 days;
    uint256 internal constant T0 = 1_790_000_000;

    string internal constant VECTORS = "../data/vectors/";
    bytes internal tablesBlob;

    mapping(bytes32 => uint16) internal targetByHash;
    mapping(bytes32 => uint16) internal ligandByHash;

    struct Vector {
        string name;
        bytes pocket;
        bytes32 pocketHash;
        bytes topology;
        bytes32 topologyHash;
        int16[] pose;
        uint256 code;
        int256 score;
        uint256[5] sums; // g1 g2 rep hyd hb, when code == 0
    }

    function setUp() public virtual {
        vm.warp(T0);
        tablesBlob = vm.readFileBinary("../data/tables/tables.bin");
        check = new PonchemCheck();
        lab = new PonchemLab(check, owner, treasury, FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH);
        harness = new EngineHarness();
        vm.prank(owner);
        lab.setTables(tablesBlob);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // ---------------------------------------------------------------- vectors

    function _json(string memory file) internal view returns (string memory) {
        return vm.readFile(string.concat(VECTORS, file));
    }

    function _vector(string memory file) internal view returns (Vector memory v) {
        string memory json = _json(file);
        v.name = vm.parseJsonString(json, ".name");
        v.pocket = vm.parseJsonBytes(json, ".pocket_hex");
        v.pocketHash = vm.parseJsonBytes32(json, ".pocket_keccak");
        v.topology = vm.parseJsonBytes(json, ".topology_hex");
        v.topologyHash = vm.parseJsonBytes32(json, ".topology_keccak");
        v.pose = _toPose(vm.parseJsonIntArray(json, ".pose_flat"));
        v.code = vm.parseJsonUint(json, ".expect_code");
        if (v.code == 0) {
            v.score = vm.parseJsonInt(json, ".expect_score_milli");
            v.sums[0] = vm.parseJsonUint(json, ".expect_sum_g1");
            v.sums[1] = vm.parseJsonUint(json, ".expect_sum_g2");
            v.sums[2] = vm.parseJsonUint(json, ".expect_sum_rep");
            v.sums[3] = vm.parseJsonUint(json, ".expect_sum_hyd");
            v.sums[4] = vm.parseJsonUint(json, ".expect_sum_hb");
        }
    }

    function _toPose(int256[] memory flat) internal pure returns (int16[] memory pose) {
        pose = new int16[](flat.length);
        for (uint256 i = 0; i < flat.length; i++) {
            pose[i] = int16(flat[i]);
        }
    }

    function _pdbIdOf(bytes memory pocket) internal pure returns (string memory) {
        bytes memory id = new bytes(4);
        for (uint256 i = 0; i < 4; i++) {
            id[i] = pocket[i];
        }
        return string(id);
    }

    /// Registers the vector's pocket and topology (once per hash) and returns their ids.
    function _register(Vector memory v) internal returns (uint16 targetId, uint16 ligandId) {
        targetId = targetByHash[v.pocketHash];
        if (targetId == 0) {
            vm.prank(owner);
            targetId = lab.registerTarget(_pdbIdOf(v.pocket), string.concat("pocket ", v.name), 1, v.pocket, v.pocketHash);
            targetByHash[v.pocketHash] = targetId;
        }
        ligandId = ligandByHash[v.topologyHash];
        if (ligandId == 0) {
            vm.prank(owner);
            ligandId = lab.registerLigand(string.concat("L", vm.toString(uint256(v.topologyHash) % 1_000_000_007)), string.concat("ligand ", v.name), v.topology, v.topologyHash);
            ligandByHash[v.topologyHash] = ligandId;
        }
    }

    function _real02() internal returns (Vector memory v, uint16 t, uint16 l) {
        v = _vector("real_02_1M17_AQ4_refined.json");
        (t, l) = _register(v);
    }

    function _syn01() internal returns (Vector memory v, uint16 t, uint16 l) {
        v = _vector("syn_01_methanol_one_pocket_atom.json");
        (t, l) = _register(v);
    }

    // ---------------------------------------------------------------- actions

    function _submit(address who, uint16 t, uint16 l, int16[] memory pose) internal returns (uint256 id, int32 score) {
        uint256 fee = lab.runFee(); // read first: a call between prank and submitRun would consume the prank
        vm.prank(who);
        (id, score) = lab.submitRun{value: fee}(t, l, pose);
    }

    function _fund(address who, uint16 t, uint256 amount) internal {
        vm.prank(who);
        lab.fund{value: amount}(t);
    }

    function _warpEpochs(uint256 n) internal {
        vm.warp(block.timestamp + n * EPOCH);
    }

    /// A fresh wallet per number.
    function _person(uint256 n) internal returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("ponchem person", n)))));
        vm.deal(a, 10 ether);
    }

    function _assertSolvent() internal view {
        assertGe(address(lab).balance, lab.totalHeld() + lab.totalOwed(), "balance covers pools and owed");
    }

    function _expectBadPose(uint8 reason) internal {
        vm.expectRevert(abi.encodeWithSelector(PonchemLab.BadPose.selector, reason));
    }
}
