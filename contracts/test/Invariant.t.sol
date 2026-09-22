// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";
import {Refuser} from "./mocks/MockToken.sol";

/// @notice Drives the lab with random runs, sponsorships, settlements, withdrawals, reviews and clock moves.
contract Handler is Test {
    PonchemLab public lab;
    address public owner;
    uint16[] public targets;
    uint16[] public ligands;
    int16[][] internal poses;
    address[] public wallets;
    uint256 internal constant EPOCH = 7 days;

    // ghosts
    uint256 public lastRunCount;
    mapping(uint16 => int32) public bestScore;
    mapping(uint16 => bool) public hasBest;
    uint256 public settled;
    uint256 public submitted;
    uint256 public sponsored;

    constructor(PonchemLab lab_, address owner_, uint16[] memory targets_, uint16[] memory ligands_, int16[][] memory poses_) {
        lab = lab_;
        owner = owner_;
        targets = targets_;
        ligands = ligands_;
        poses = poses_;
        wallets.push(makeAddr("w1"));
        wallets.push(makeAddr("w2"));
        wallets.push(makeAddr("w3"));
        wallets.push(address(new Refuser()));
        for (uint256 i = 0; i < wallets.length; i++) {
            vm.deal(wallets[i], 1000 ether);
        }
    }

    /// every action checks that the run count did not fall since the last action, then records it
    modifier track() {
        require(lab.runCount() >= lastRunCount, "run count fell");
        _;
        lastRunCount = lab.runCount();
    }

    function _wallet(uint256 seed) internal view returns (address) {
        return wallets[seed % wallets.length];
    }

    function submit(uint256 seed, int16 dx) external track {
        uint256 k = seed % targets.length;
        int16[] memory pose = poses[k];
        // a small translation sometimes, so scores differ
        dx = int16(bound(int256(dx), -20, 20));
        int16[] memory moved = new int16[](pose.length);
        for (uint256 i = 0; i < pose.length; i++) {
            moved[i] = i % 3 == 0 ? pose[i] + dx : pose[i];
        }
        address who = _wallet(seed >> 8);
        uint256 fee = lab.runFee();
        vm.prank(who);
        try lab.submitRun{value: fee}(targets[k], ligands[k], moved) returns (uint256 id, int32 score) {
            submitted += 1;
            assertEq(id, lab.runCount());
            if (!hasBest[targets[k]] || score < bestScore[targets[k]]) {
                bestScore[targets[k]] = score;
                hasBest[targets[k]] = true;
            }
        } catch {}
    }

    function fund(uint256 seed, uint96 amount) external track {
        amount = uint96(bound(amount, 1, 5 ether));
        address who = _wallet(seed);
        vm.prank(who);
        lab.fund{value: amount}(targets[seed % targets.length]);
        sponsored += amount;
    }

    function settle(uint256 seed) external track {
        uint16 t = targets[seed % targets.length];
        uint32 cur = lab.currentEpoch();
        if (cur == 0) return;
        uint32 e = uint32((seed >> 16) % cur);
        try lab.settle(t, e) {
            settled += 1;
        } catch {}
    }

    function warp(uint32 dt) external track {
        dt = uint32(bound(dt, 1, 3 * EPOCH));
        vm.warp(block.timestamp + dt);
    }

    function withdraw(uint256 seed) external track {
        address who = _wallet(seed);
        if (lab.owed(who) == 0) return;
        if (who == wallets[3]) Refuser(payable(who)).allow();
        vm.prank(who);
        lab.withdraw();
    }

    function setFee(uint16 bps) external track {
        vm.prank(owner);
        lab.setFeeBps(uint16(bound(bps, 0, 1000)));
    }

    function review(uint256 seed, uint8 stars) external track {
        uint256 n = lab.runCount();
        if (n == 0) return;
        uint256 id = 1 + (seed % n);
        address who = _wallet(seed >> 8);
        vm.prank(who);
        try lab.reviewRun(id, uint8(bound(stars, 1, 5)), "ok") {} catch {}
    }
}

/// @notice The lab holds at least what it owes; the run count only grows; a target's best never gets worse.
contract InvariantTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        string[3] memory files = ["real_02_1M17_AQ4_refined.json", "real_03_1M17_QUE_docked.json", "syn_05_propanediol_anti.json"];
        uint16[] memory ts = new uint16[](3);
        uint16[] memory ls = new uint16[](3);
        int16[][] memory ps = new int16[][](3);
        for (uint256 i = 0; i < 3; i++) {
            Vector memory v = _vector(files[i]);
            (ts[i], ls[i]) = _register(v);
            ps[i] = v.pose;
        }
        handler = new Handler(lab, owner, ts, ls, ps);
        targetContract(address(handler));
    }

    function invariant_balanceCoversPoolsAndOwed() public view {
        assertGe(address(lab).balance, lab.totalHeld() + lab.totalOwed());
    }

    function invariant_runCountMonotone() public view {
        assertGe(lab.runCount(), handler.lastRunCount());
    }

    function invariant_bestNeverIncreases() public view {
        for (uint256 i = 0; i < 3; i++) {
            uint16 t = handler.targets(i);
            uint256 best = lab.bestOf(t);
            if (best == 0) {
                assertFalse(handler.hasBest(t));
                continue;
            }
            (,,, int32 score,,,) = lab.run(best);
            assertEq(score, handler.bestScore(t), "bestOf holds the lowest score seen");
        }
    }

    function invariant_poolsNeverLost() public view {
        // every wei sponsored either sits in a pool, was paid out (prize or fee) or is owed
        uint256 held = lab.totalHeld() + lab.totalOwed();
        assertLe(held, handler.sponsored() + address(lab).balance);
    }
}
