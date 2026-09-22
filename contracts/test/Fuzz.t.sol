// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";

/// @notice Fuzz tests: random poses never pass the geometry proof unless they are near-copies of a valid pose
///         (a rigid translation inside the box, or rounding noise of one centi-A), random fees settle exactly,
///         random clocks give the right epoch.
contract FuzzTest is Base {
    Vector internal syn02;
    Vector internal syn04;
    uint16 internal t02;
    uint16 internal l02;
    uint16 internal t04;
    uint16 internal l04;

    function setUp() public override {
        super.setUp();
        syn02 = _vector("syn_02_ethanolamine_four_pocket_atoms.json");
        (t02, l02) = _register(syn02);
        syn04 = _vector("syn_04_pyridine_donor_and_stack.json");
        (t04, l04) = _register(syn04);
    }

    /// A random pose of the right length is rejected by one of the checks (the chance that random int16
    /// coordinates reproduce every bond length within tolerance is nil).
    function testFuzz_randomPoseIsRejected(uint256 seed) public {
        int16[] memory pose = new int16[](syn02.pose.length);
        for (uint256 i = 0; i < pose.length; i++) {
            pose[i] = int16(int256(uint256(keccak256(abi.encode(seed, i))) % 65536) - 32768);
        }
        vm.expectRevert();
        lab.quote(t02, l02, pose);
    }

    /// A random pose that stays inside the box still fails on a bond, a 1-3 pair or the clash floor.
    function testFuzz_randomPoseInsideTheBoxIsRejected(uint256 seed) public {
        int16[] memory pose = new int16[](syn04.pose.length);
        for (uint256 i = 0; i < pose.length; i++) {
            pose[i] = int16(int256(uint256(keccak256(abi.encode(seed, i))) % 1201) - 600);
        }
        vm.expectRevert();
        lab.quote(t04, l04, pose);
    }

    /// The wrong atom count is always ATOM_COUNT, whatever the numbers.
    function testFuzz_wrongLengthIsAtomCount(uint8 len, uint256 seed) public {
        vm.assume(len != syn02.pose.length);
        int16[] memory pose = new int16[](len);
        for (uint256 i = 0; i < len; i++) {
            pose[i] = int16(int256(uint256(keccak256(abi.encode(seed, i))) % 65536) - 32768);
        }
        _expectBadPose(1);
        lab.quote(t02, l02, pose);
    }

    /// A rigid translation that keeps every atom inside the box keeps every distance, so the proof passes; the
    /// score is whatever the pocket says.
    function testFuzz_translatedPosePasses(int16 dx, int16 dy, int16 dz) public view {
        dx = int16(bound(int256(dx), -400, 400));
        dy = int16(bound(int256(dy), -400, 400));
        dz = int16(bound(int256(dz), -400, 400));
        int16[] memory pose = new int16[](syn04.pose.length);
        for (uint256 i = 0; i < pose.length; i += 3) {
            pose[i] = syn04.pose[i] + dx;
            pose[i + 1] = syn04.pose[i + 1] + dy;
            pose[i + 2] = syn04.pose[i + 2] + dz;
        }
        for (uint256 i = 0; i < pose.length; i++) {
            if (pose[i] < -600 || pose[i] > 600) return; // outside the box: not this test
        }
        lab.quote(t04, l04, pose);
    }

    /// One centi-A of noise per coordinate moves a distance by at most 3.5 centi-A, inside the tolerance of 6.
    function testFuzz_roundingNoisePasses(uint256 seed) public view {
        int16[] memory pose = new int16[](syn04.pose.length);
        for (uint256 i = 0; i < pose.length; i++) {
            int16 noise = int16(int256(uint256(keccak256(abi.encode(seed, i))) % 3)) - 1;
            pose[i] = syn04.pose[i] + noise;
        }
        lab.quote(t04, l04, pose);
    }

    /// A translation that pushes any atom out of the box is BOX, before any other check.
    function testFuzz_outsideTheBoxIsBox(int16 dx) public {
        dx = int16(bound(int256(dx), 601, 2000));
        int16[] memory pose = new int16[](syn02.pose.length);
        for (uint256 i = 0; i < pose.length; i += 3) {
            pose[i] = syn02.pose[i] + dx;
            pose[i + 1] = syn02.pose[i + 1];
            pose[i + 2] = syn02.pose[i + 2];
        }
        _expectBadPose(2);
        lab.quote(t02, l02, pose);
    }

    /// Any fee up to the cap settles exactly: the winner gets pool minus fee, the treasury the fee, nothing stays.
    function testFuzz_settlementMath(uint16 bps, uint96 amount) public {
        bps = uint16(bound(bps, 0, 1000));
        amount = uint96(bound(amount, 1, 50 ether));
        vm.prank(owner);
        lab.setFeeBps(bps);
        vm.deal(carol, amount);
        _fund(carol, t02, amount);
        _submit(alice, t02, l02, syn02.pose);
        _warpEpochs(1);
        uint256 a = alice.balance;
        uint256 tr = treasury.balance;
        lab.settle(t02, 0);
        uint256 fee = (uint256(amount) * bps) / 10_000;
        assertEq(treasury.balance - tr, fee);
        assertEq(alice.balance - a, amount - fee);
        assertEq(lab.totalHeld(), 0);
        assertEq(address(lab).balance, 0);
    }

    function testFuzz_feeCap(uint16 bps) public {
        vm.prank(owner);
        if (bps > 1000) {
            vm.expectRevert(PonchemLab.FeeTooHigh.selector);
            lab.setFeeBps(bps);
        } else {
            lab.setFeeBps(bps);
            assertEq(lab.feeBps(), bps);
        }
    }

    /// The epoch is the floor of the elapsed time over the length; settle refuses anything not ended.
    function testFuzz_epochClock(uint64 dt, uint32 epoch) public {
        dt = uint64(bound(dt, 0, 20 * 365 days));
        _fund(carol, t02, 1 ether); // in epoch 0, so every later settle has something to roll
        vm.warp(T0 + dt);
        uint32 cur = uint32(dt / EPOCH);
        assertEq(lab.currentEpoch(), cur);
        if (epoch >= cur) {
            vm.expectRevert(PonchemLab.NotEnded.selector);
            lab.settle(t02, epoch);
        } else {
            lab.settle(t02, epoch);
            assertEq(lab.nextSettle(t02), epoch + 1);
        }
    }

    /// Whatever the run fee, only the exact value is accepted and it reaches the treasury.
    function testFuzz_runFee(uint96 fee, uint96 sent) public {
        fee = uint96(bound(fee, 0, 999 ether));
        sent = uint96(bound(sent, 0, 999 ether));
        vm.prank(owner);
        lab.setPrices(fee, RUN_PRICE);
        vm.deal(alice, 1000 ether);
        uint256 tr = treasury.balance;
        vm.prank(alice);
        if (sent != fee) {
            vm.expectRevert(PonchemLab.WrongFee.selector);
            lab.submitRun{value: sent}(t02, l02, syn02.pose);
        } else {
            lab.submitRun{value: sent}(t02, l02, syn02.pose);
            assertEq(treasury.balance - tr, fee);
            assertEq(lab.runCount(), 1);
        }
    }

    /// Reviews: any sequence of star values by one reviewer leaves count 1 and the sum at the last value.
    function testFuzz_reviewReplace(uint8 a, uint8 b, uint8 c) public {
        a = uint8(bound(a, 1, 5));
        b = uint8(bound(b, 1, 5));
        c = uint8(bound(c, 1, 5));
        (uint256 id,) = _submit(alice, t02, l02, syn02.pose);
        vm.prank(bob);
        lab.reviewRun(id, a, "");
        vm.prank(bob);
        lab.reviewRun(id, b, "");
        vm.prank(bob);
        lab.reviewRun(id, c, "");
        (uint32 count, uint32 sum) = lab.reviewStats(id);
        assertEq(count, 1);
        assertEq(sum, c);
        (,,, uint32 given, uint32 received, uint32 stars) = lab.stats(alice);
        assertEq(given, 0);
        assertEq(received, 1);
        assertEq(stars, c);
    }
}
