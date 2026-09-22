// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";
import {PonchemCheck} from "../src/PonchemCheck.sol";
import {DataStore} from "../src/DataStore.sol";
import {MockToken, Refuser} from "./mocks/MockToken.sol";

/// @notice Unit tests of PonchemLab: registration, runs and bests, epochs, pools and settlement, pull payments,
///         the two payment paths, reviews and ownership.
contract LabTest is Base {
    // ---------------------------------------------------------------- construction

    function test_constructor_state() public view {
        assertEq(lab.owner(), owner);
        assertEq(lab.treasury(), treasury);
        assertEq(lab.feeBps(), FEE_BPS);
        assertEq(lab.runFee(), RUN_FEE);
        assertEq(lab.runPrice(), RUN_PRICE);
        assertEq(lab.genesis(), T0);
        assertEq(lab.epochLength(), EPOCH);
        assertEq(lab.currentEpoch(), 0);
        assertEq(lab.epochStart(3), T0 + 3 * EPOCH);
        assertTrue(lab.ethAllowed());
        assertTrue(lab.tokenAllowed());
        assertEq(lab.token(), address(0));
        assertEq(address(lab.check()), address(check));
        assertEq(lab.targetCount(), 0);
        assertEq(lab.ligandCount(), 0);
        assertEq(lab.runCount(), 0);
        assertEq(lab.pendingOwner(), address(0));
    }

    function test_constructor_rejectsBadArguments() public {
        vm.expectRevert(PonchemLab.ZeroAddress.selector);
        new PonchemLab(check, address(0), treasury, FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH);
        vm.expectRevert(PonchemLab.ZeroAddress.selector);
        new PonchemLab(check, owner, address(0), FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH);
        vm.expectRevert(PonchemLab.ZeroAddress.selector);
        new PonchemLab(PonchemCheck(address(0)), owner, treasury, FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH);
        vm.expectRevert(PonchemLab.FeeTooHigh.selector);
        new PonchemLab(check, owner, treasury, 1001, RUN_FEE, RUN_PRICE, EPOCH);
        vm.expectRevert(PonchemLab.BadEpochLength.selector);
        new PonchemLab(check, owner, treasury, FEE_BPS, RUN_FEE, RUN_PRICE, 30 minutes);
        vm.expectRevert(PonchemLab.BadEpochLength.selector);
        new PonchemLab(check, owner, treasury, FEE_BPS, RUN_FEE, RUN_PRICE, 366 days);
    }

    // ---------------------------------------------------------------- tables

    function test_tables_onceAndChecked() public {
        PonchemLab fresh = new PonchemLab(check, owner, treasury, FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        fresh.setTables(tablesBlob);
        bytes memory wrong = tablesBlob;
        wrong[100] = ~wrong[100];
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadTables.selector);
        fresh.setTables(wrong);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadTables.selector);
        fresh.setTables(hex"00");
        // no run before the tables
        (Vector memory v,,) = _syn01();
        vm.prank(owner);
        uint16 t = fresh.registerTarget(_pdbIdOf(v.pocket), "methanol pocket", 1, v.pocket, v.pocketHash);
        vm.prank(owner);
        uint16 l = fresh.registerLigand("METHANOL", "methanol", v.topology, v.topologyHash);
        vm.expectRevert(PonchemLab.NoTables.selector);
        fresh.quote(t, l, v.pose);
        vm.prank(owner);
        fresh.setTables(tablesBlob);
        assertEq(fresh.tables().code.length, 13011);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.TablesAlreadySet.selector);
        fresh.setTables(tablesBlob);
        assertEq(fresh.quote(t, l, v.pose), int32(-34));
    }

    // ---------------------------------------------------------------- registration

    function test_registerTarget_recordsAndStoresScanForm() public {
        Vector memory v = _vector("real_02_1M17_AQ4_refined.json");
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit PonchemLab.TargetRegistered(1, "1M17", "EGFR", address(0), v.pocketHash);
        uint16 id = lab.registerTarget("1M17", "EGFR", 1 << 0 | 1 << 3, v.pocket, v.pocketHash);
        assertEq(id, 1);
        assertEq(lab.targetCount(), 1);
        (string memory pdbId, string memory name, uint32 bits, address data, bytes32 hash, uint16 atoms) = lab.target(1);
        assertEq(pdbId, "1M17");
        assertEq(name, "EGFR");
        assertEq(bits, 9);
        assertEq(hash, v.pocketHash);
        assertEq(atoms, 796);
        assertEq(uint8(data.code[0]), 0, "STOP prefix");
        // scan form: header + 9 bytes per atom + the offset table (80 cells + 1)
        assertEq(data.code.length, 1 + 28 + 9 * 796 + 2 * 81);
        bytes memory scan = DataStore.read(data);
        for (uint256 i = 0; i < 28; i++) {
            assertEq(scan[i], v.pocket[i], "header copied");
        }
        assertEq(lab.nextSettle(1), 0);
        _warpEpochs(4);
        vm.prank(owner);
        uint16 id2 = lab.registerTarget("1M17", "EGFR again", 2, v.pocket, v.pocketHash);
        assertEq(id2, 2);
        assertEq(lab.nextSettle(2), 4, "settlement starts at the registration epoch");
    }

    function test_registerTarget_rejects() public {
        Vector memory v = _vector("real_02_1M17_AQ4_refined.json");
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.registerTarget("1M17", "EGFR", 1, v.pocket, v.pocketHash);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.HashMismatch.selector);
        lab.registerTarget("1M17", "EGFR", 1, v.pocket, bytes32(uint256(v.pocketHash) ^ 1));
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadName.selector);
        lab.registerTarget("1M17", "", 1, v.pocket, v.pocketHash);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadName.selector);
        lab.registerTarget("1M17", _text(97), 1, v.pocket, v.pocketHash);
        // the id must match the header
        vm.prank(owner);
        vm.expectRevert(PonchemCheck.BadPocket.selector);
        lab.registerTarget("1M18", "EGFR", 1, v.pocket, v.pocketHash);
        vm.prank(owner);
        vm.expectRevert(PonchemCheck.BadPocket.selector);
        lab.registerTarget("1m17", "EGFR", 1, v.pocket, v.pocketHash);
        // a wrong version byte, a truncated blob, a bad type code, a broken offset table: all BadPocket, with the
        // hash of the altered bytes so that the structural check is what fails
        bytes memory p = v.pocket;
        p[27] = 0x02;
        _expectBadPocket("1M17", p);
        p = v.pocket;
        p[28 + 7 * 10 + 6] = 0x10;
        _expectBadPocket("1M17", p);
        p = _slice(v.pocket, v.pocket.length - 2);
        _expectBadPocket("1M17", p);
        p = v.pocket;
        uint256 offs = 28 + 7 * 796;
        p[offs + 2] = 0xff; // off[1] = 0xff.. > off[2]
        _expectBadPocket("1M17", p);
        p = v.pocket;
        p[24] = 0x06; // nx does not match hx
        _expectBadPocket("1M17", p);
        p = v.pocket;
        // move one atom out of its cell (x -> far away), keeping the offsets
        p[28 + 7 * 20] = 0x7f;
        p[28 + 7 * 20 + 1] = 0x00;
        _expectBadPocket("1M17", p);
        // too many atoms: header says 2001
        p = v.pocket;
        p[4] = 0x07;
        p[5] = 0xd1;
        _expectBadPocket("1M17", p);
    }

    function _expectBadPocket(string memory id, bytes memory p) internal {
        vm.prank(owner);
        vm.expectRevert(PonchemCheck.BadPocket.selector);
        lab.registerTarget(id, "x", 1, p, keccak256(p));
    }

    function test_registerLigand_recordsAndRejects() public {
        Vector memory v = _vector("real_04_1M17_TA1_docked.json");
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit PonchemLab.LigandRegistered(1, "PACLITAXEL", "paclitaxel", address(0), v.topologyHash);
        uint16 id = lab.registerLigand("PACLITAXEL", "paclitaxel", v.topology, v.topologyHash);
        assertEq(id, 1);
        (string memory key, string memory name, address data, bytes32 hash, uint8 atoms, uint8 nrot) = lab.ligand(1);
        assertEq(key, "PACLITAXEL");
        assertEq(name, "paclitaxel");
        assertEq(hash, v.topologyHash);
        assertEq(atoms, 62);
        assertEq(nrot, 14);
        assertEq(data.code.length, 1 + v.topology.length);
        assertEq(keccak256(DataStore.read(data)), v.topologyHash, "topology stored as is");

        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.registerLigand("X", "x", v.topology, v.topologyHash);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.HashMismatch.selector);
        lab.registerLigand("X", "x", v.topology, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadName.selector);
        lab.registerLigand("", "x", v.topology, v.topologyHash);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadName.selector);
        lab.registerLigand(_text(33), "x", v.topology, v.topologyHash);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.BadName.selector);
        lab.registerLigand("X", "", v.topology, v.topologyHash);
        bytes memory t = v.topology;
        t[0] = 0x02;
        _expectBadTopology(t);
        t = _slice(v.topology, v.topology.length - 1);
        _expectBadTopology(t);
        t = v.topology;
        t[8] = 0x10; // type code 16
        _expectBadTopology(t);
        t = v.topology;
        t[1] = 0x41; // 65 atoms
        _expectBadTopology(t);
        t = v.topology;
        t[8 + 62] = 0x05;
        t[8 + 62 + 1] = 0x02; // bond i >= j
        _expectBadTopology(t);
        t = v.topology;
        t[8 + 62 + 4 + 1] = 0x00; // second bond sorts before the first
        _expectBadTopology(t);
        t = v.topology;
        t[6] = 0x01; // reserved word
        _expectBadTopology(t);
    }

    function _expectBadTopology(bytes memory t) internal {
        vm.prank(owner);
        vm.expectRevert(PonchemCheck.BadTopology.selector);
        lab.registerLigand("X", "x", t, keccak256(t));
    }

    // ---------------------------------------------------------------- runs

    function test_submitRun_recordsScoreEventsAndPayment() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        uint256 before = treasury.balance;
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit PonchemLab.RunScored(1, alice, t, l, int32(-6446), 0, v.pose);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Paid(1, alice, 0, RUN_FEE);
        (uint256 id, int32 score) = lab.submitRun{value: RUN_FEE}(t, l, v.pose);
        assertEq(id, 1);
        assertEq(score, int32(-6446));
        assertEq(lab.runCount(), 1);
        assertEq(treasury.balance - before, RUN_FEE, "the fee went to the treasury");
        assertEq(address(lab).balance, 0, "nothing stays in the lab");
        (address wallet, uint16 tt, uint16 ll, int32 s, uint32 epoch, uint64 time, bytes32 poseHash) = lab.run(1);
        assertEq(wallet, alice);
        assertEq(tt, t);
        assertEq(ll, l);
        assertEq(s, int32(-6446));
        assertEq(epoch, 0);
        assertEq(time, T0);
        assertEq(poseHash, keccak256(_canonical(v.pose)));
        (uint64 runs, int32 best, uint256 prizes,,,) = lab.stats(alice);
        assertEq(runs, 1);
        assertEq(best, int32(-6446));
        assertEq(prizes, 0);
        assertEq(lab.bestOf(t), 1);
        assertEq(lab.bestOfEpoch(t, 0), 1);
        assertEq(lab.bestPair(t, l), 1);
        assertEq(lab.pool(t), 0, "run fees do not feed the pool");
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.run(0);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.run(2);
    }

    function test_submitRun_rejects() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: RUN_FEE - 1}(t, l, v.pose);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun(t, l, v.pose);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.NoTarget.selector);
        lab.submitRun{value: RUN_FEE}(0, l, v.pose);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.NoTarget.selector);
        lab.submitRun{value: RUN_FEE}(t + 1, l, v.pose);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.NoLigand.selector);
        lab.submitRun{value: RUN_FEE}(t, 0, v.pose);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.NoLigand.selector);
        lab.submitRun{value: RUN_FEE}(t, l + 1, v.pose);
        // the geometry proof, through submitRun and quote alike
        Vector memory r = _vector("rej_04_clash.json");
        (uint16 rt, uint16 rl) = _register(r);
        vm.prank(alice);
        _expectBadPose(5);
        lab.submitRun{value: RUN_FEE}(rt, rl, r.pose);
        _expectBadPose(5);
        lab.quote(rt, rl, r.pose);
        // a pose word that is not an int16 is an ABI violation: plain revert
        int16[] memory pose = v.pose;
        vm.prank(alice);
        vm.expectRevert();
        (bool ok,) = address(lab).call{value: RUN_FEE}(abi.encodeWithSignature("submitRun(uint16,uint16,int16[])", t, l, _dirty(pose)));
        ok;
    }

    function test_bests_strictlyLowerWinsTiesKeepTheEarlier() public {
        Vector memory v = _vector("syn_01_methanol_one_pocket_atom.json");
        (uint16 t, uint16 l) = _register(v);
        _submit(alice, t, l, v.pose);
        _submit(bob, t, l, v.pose); // same score: tie
        assertEq(lab.bestOf(t), 1);
        assertEq(lab.bestOfEpoch(t, 0), 1);
        assertEq(lab.bestPair(t, l), 1);
        // a translated pose scores differently; find one that is lower
        int16[] memory moved = _shift(v.pose, -50, 0, 0);
        int32 s = lab.quote(t, l, moved);
        (uint256 id,) = _submit(carol, t, l, moved);
        if (s < int32(-34)) {
            assertEq(lab.bestOf(t), id);
            assertEq(lab.bestPair(t, l), id);
        } else {
            assertEq(lab.bestOf(t), 1);
        }
        (, int32 bestCarol,,,,) = lab.stats(carol);
        assertEq(bestCarol, s);
        // a new epoch has its own best
        _warpEpochs(1);
        (uint256 id2,) = _submit(bob, t, l, v.pose);
        assertEq(lab.bestOfEpoch(t, 1), id2);
        assertEq(lab.bestOfEpoch(t, 0), lab.bestOf(t) == id ? id : 1);
        (,,,, uint32 epoch,,) = lab.run(id2);
        assertEq(epoch, 1);
    }

    // ---------------------------------------------------------------- epochs

    function test_epochs_followTheClock() public {
        assertEq(lab.currentEpoch(), 0);
        vm.warp(T0 + EPOCH - 1);
        assertEq(lab.currentEpoch(), 0);
        vm.warp(T0 + EPOCH);
        assertEq(lab.currentEpoch(), 1);
        vm.warp(T0 + 10 * EPOCH + 5);
        assertEq(lab.currentEpoch(), 10);
        assertEq(lab.epochStart(10), T0 + 10 * EPOCH);
    }

    // ---------------------------------------------------------------- pools and settlement

    function test_fund_and_pool() public {
        (, uint16 t,) = _real02();
        vm.prank(carol);
        vm.expectRevert(PonchemLab.NoValue.selector);
        lab.fund(t);
        vm.prank(carol);
        vm.expectRevert(PonchemLab.NoTarget.selector);
        lab.fund{value: 1 ether}(t + 1);
        vm.prank(carol);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Funded(t, carol, 1 ether, 1 ether);
        lab.fund{value: 1 ether}(t);
        assertEq(lab.poolAt(t, 0), 1 ether);
        assertEq(lab.pool(t), 1 ether);
        assertEq(lab.totalHeld(), 1 ether);
        _warpEpochs(1);
        // epoch 0 not settled and without a run: its pool rolls into the view of epoch 1
        assertEq(lab.pool(t), 1 ether);
        _fund(carol, t, 0.5 ether);
        assertEq(lab.pool(t), 1.5 ether);
        assertEq(lab.pool(0), 0);
        assertEq(lab.pool(t + 5), 0);
        _assertSolvent();
    }

    function test_settle_paysWinnerAndFee() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        _fund(carol, t, 1 ether);
        (uint256 id,) = _submit(alice, t, l, v.pose);
        _submit(bob, t, l, v.pose); // ties keep alice
        vm.expectRevert(PonchemLab.NotEnded.selector);
        lab.settle(t, 0);
        _warpEpochs(1);
        uint256 aliceBefore = alice.balance;
        uint256 treasuryBefore = treasury.balance;
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Settled(t, 0, alice, id, 0.95 ether);
        lab.settle(t, 0);
        assertEq(alice.balance - aliceBefore, 0.95 ether);
        assertEq(treasury.balance - treasuryBefore, 0.05 ether);
        assertEq(lab.totalHeld(), 0);
        assertEq(lab.nextSettle(t), 1);
        assertEq(lab.carry(t), 0);
        (,, uint256 prizes,,,) = lab.stats(alice);
        assertEq(prizes, 0.95 ether);
        vm.expectRevert(PonchemLab.AlreadySettled.selector);
        lab.settle(t, 0);
        vm.expectRevert(PonchemLab.NotEnded.selector);
        lab.settle(t, 1);
        _assertSolvent();
    }

    function test_settle_rollsEmptyEpochsInOrder() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        _fund(carol, t, 1 ether); // epoch 0, no run
        _warpEpochs(1);
        _fund(carol, t, 2 ether); // epoch 1, no run
        _warpEpochs(1);
        (uint256 id,) = _submit(alice, t, l, v.pose); // epoch 2, a run, no fresh money
        _warpEpochs(1);
        // settling epoch 2 settles 0 and 1 first: both roll, then epoch 2 pays 3 ether minus the fee
        uint256 before = alice.balance;
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Rolled(t, 0, 1 ether);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Rolled(t, 1, 3 ether);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Settled(t, 2, alice, id, 2.85 ether);
        lab.settle(t, 2);
        assertEq(alice.balance - before, 2.85 ether);
        assertEq(lab.nextSettle(t), 3);
        assertEq(lab.carry(t), 0);
        assertEq(lab.totalHeld(), 0);
        // nothing to settle in a dead range
        _warpEpochs(2);
        vm.expectRevert(PonchemLab.NoRuns.selector);
        lab.settle(t, 4);
        assertEq(lab.nextSettle(t), 3, "a NoRuns revert leaves the cursor alone");
        // a rolled pool without a run stays held (carry) and pays the next winner
        _fund(carol, t, 1 ether); // epoch 5
        _warpEpochs(1);
        lab.settle(t, 5);
        assertEq(lab.carry(t), 1 ether);
        assertEq(lab.totalHeld(), 1 ether);
        assertEq(lab.pool(t), 1 ether);
        _submit(bob, t, l, v.pose); // epoch 6
        _warpEpochs(1);
        uint256 bobBefore = bob.balance;
        lab.settle(t, 6);
        assertEq(bob.balance - bobBefore, 0.95 ether);
        assertEq(lab.carry(t), 0);
        _assertSolvent();
    }

    function test_settle_feeAtSettlementTime() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        _fund(carol, t, 1 ether);
        _submit(alice, t, l, v.pose);
        vm.prank(owner);
        lab.setFeeBps(1000);
        _warpEpochs(1);
        uint256 before = treasury.balance;
        lab.settle(t, 0);
        assertEq(treasury.balance - before, 0.1 ether);
    }

    function test_refusedPrizeIsOwedAndWithdrawn() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        Refuser r = new Refuser();
        vm.deal(address(r), 1 ether);
        _fund(carol, t, 1 ether);
        r.call(address(lab), abi.encodeWithSignature("submitRun(uint16,uint16,int16[])", t, l, v.pose), RUN_FEE);
        _warpEpochs(1);
        vm.expectEmit(true, false, false, true);
        emit PonchemLab.Owed(address(r), 0.95 ether);
        lab.settle(t, 0);
        assertEq(lab.owed(address(r)), 0.95 ether);
        assertEq(lab.totalOwed(), 0.95 ether);
        assertEq(address(lab).balance, 0.95 ether);
        // still refusing: withdraw fails and keeps the credit
        vm.expectRevert(PonchemLab.TransferFailed.selector);
        r.call(address(lab), abi.encodeWithSignature("withdraw()"), 0);
        assertEq(lab.owed(address(r)), 0.95 ether);
        r.allow();
        uint256 before = address(r).balance;
        r.call(address(lab), abi.encodeWithSignature("withdraw()"), 0);
        assertEq(address(r).balance - before, 0.95 ether);
        assertEq(lab.owed(address(r)), 0);
        assertEq(lab.totalOwed(), 0);
        vm.expectRevert(PonchemLab.NothingOwed.selector);
        r.call(address(lab), abi.encodeWithSignature("withdraw()"), 0);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NothingOwed.selector);
        lab.withdraw();
        _assertSolvent();
    }

    function test_refusedTestPaymentIsOwedToTheTreasury() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        Refuser r = new Refuser();
        vm.prank(owner);
        lab.setTreasury(address(r));
        _submit(alice, t, l, v.pose);
        assertEq(lab.owed(address(r)), RUN_FEE);
        assertEq(address(lab).balance, RUN_FEE);
        r.allow();
        r.call(address(lab), abi.encodeWithSignature("withdraw()"), 0);
        assertEq(address(r).balance, RUN_FEE);
    }

    // ---------------------------------------------------------------- the token path

    function test_tokenPayment() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenRequired.selector);
        lab.submitRun(t, l, v.pose, true);
        MockToken tok = new MockToken();
        vm.prank(owner);
        lab.setToken(address(tok));
        assertEq(lab.token(), address(tok));
        tok.mint(alice, 1000e18);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: 1}(t, l, v.pose, true);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenPaymentFailed.selector);
        lab.submitRun(t, l, v.pose, true); // no allowance
        vm.prank(alice);
        tok.approve(address(lab), 1000e18);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Paid(1, alice, 1, RUN_PRICE);
        (uint256 id, int32 score) = lab.submitRun(t, l, v.pose, true);
        assertEq(id, 1);
        assertEq(score, int32(-6446));
        assertEq(tok.balanceOf(treasury), RUN_PRICE);
        assertEq(tok.balanceOf(alice), 1000e18 - RUN_PRICE);
        // a token that returns nothing is accepted; false, a revert or a short answer are not
        tok.setMode(1);
        vm.prank(alice);
        lab.submitRun(t, l, v.pose, true);
        assertEq(tok.balanceOf(treasury), 2 * RUN_PRICE);
        tok.setMode(2);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenPaymentFailed.selector);
        lab.submitRun(t, l, v.pose, true);
        tok.setMode(3);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenPaymentFailed.selector);
        lab.submitRun(t, l, v.pose, true);
        tok.setMode(4);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenPaymentFailed.selector);
        lab.submitRun(t, l, v.pose, true);
        // an address without code is not a token
        vm.prank(owner);
        lab.setToken(stranger);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenPaymentFailed.selector);
        lab.submitRun(t, l, v.pose, true);
        // the ETH path still works with a token set, and the four-argument form with false is the ETH path
        vm.prank(alice);
        (id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false);
        assertEq(id, 3);
        assertEq(lab.runCount(), 3);
    }

    function test_paymentOptionsAndPrices() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        vm.prank(owner);
        lab.setPaymentOptions(false, true);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentNotAllowed.selector);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose);
        MockToken tok = new MockToken();
        vm.prank(owner);
        lab.setToken(address(tok));
        vm.prank(owner);
        lab.setPaymentOptions(true, false);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentNotAllowed.selector);
        lab.submitRun(t, l, v.pose, true);
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.PricesSet(0.0002 ether, 50e18);
        lab.setPrices(0.0002 ether, 50e18);
        assertEq(lab.runFee(), 0.0002 ether);
        assertEq(lab.runPrice(), 50e18);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose);
        vm.prank(alice);
        lab.submitRun{value: 0.0002 ether}(t, l, v.pose);
        // a free lab: runFee 0 and no value
        vm.prank(owner);
        lab.setPrices(0, 0);
        vm.prank(alice);
        lab.submitRun(t, l, v.pose);
        assertEq(lab.runCount(), 2);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setPrices(1, 1);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setPaymentOptions(true, true);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setToken(address(tok));
    }

    // ---------------------------------------------------------------- reviews

    function test_reviews() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        (uint256 id,) = _submit(alice, t, l, v.pose);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.OwnRun.selector);
        lab.reviewRun(id, 5, "mine");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.reviewRun(0, 5, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.reviewRun(2, 5, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.BadStars.selector);
        lab.reviewRun(id, 0, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.BadStars.selector);
        lab.reviewRun(id, 6, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NoteTooLong.selector);
        lab.reviewRun(id, 4, _text(281));
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Reviewed(id, bob, 4, "solid pose in the hinge");
        lab.reviewRun(id, 4, "solid pose in the hinge");
        (uint32 count, uint32 sum) = lab.reviewStats(id);
        assertEq(count, 1);
        assertEq(sum, 4);
        (uint8 stars, uint64 time) = lab.reviewOf(id, bob);
        assertEq(stars, 4);
        assertEq(time, T0);
        vm.warp(T0 + 100);
        vm.prank(carol);
        lab.reviewRun(id, 2, _text(280));
        (count, sum) = lab.reviewStats(id);
        assertEq(count, 2);
        assertEq(sum, 6);
        // bob changes his mind: replaces, the count stays, the sum moves
        vm.prank(bob);
        lab.reviewRun(id, 5, "");
        (count, sum) = lab.reviewStats(id);
        assertEq(count, 2);
        assertEq(sum, 7);
        (stars, time) = lab.reviewOf(id, bob);
        assertEq(stars, 5);
        assertEq(time, T0 + 100);
        (,,, uint32 given, uint32 received, uint32 starsReceived) = lab.stats(alice);
        assertEq(given, 0);
        assertEq(received, 2);
        assertEq(starsReceived, 7);
        (,,, given, received, starsReceived) = lab.stats(bob);
        assertEq(given, 1);
        assertEq(received, 0);
        assertEq(starsReceived, 0);
        (,,, given,,) = lab.stats(carol);
        assertEq(given, 1);
        (uint8 none,) = lab.reviewOf(id, stranger);
        assertEq(none, 0);
    }

    // ---------------------------------------------------------------- ownership and setters

    function test_ownership_twoStep() public {
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.transferOwnership(stranger);
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.OwnershipTransferStarted(owner, bob);
        lab.transferOwnership(bob);
        assertEq(lab.owner(), owner, "nothing moves until accepted");
        assertEq(lab.pendingOwner(), bob);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotPendingOwner.selector);
        lab.acceptOwnership();
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.OwnershipTransferred(owner, bob);
        lab.acceptOwnership();
        assertEq(lab.owner(), bob);
        assertEq(lab.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setFeeBps(1);
        vm.prank(bob);
        lab.setFeeBps(1);
        assertEq(lab.feeBps(), 1);
    }

    function test_setters() public {
        vm.prank(owner);
        vm.expectRevert(PonchemLab.FeeTooHigh.selector);
        lab.setFeeBps(1001);
        vm.prank(owner);
        lab.setFeeBps(1000);
        assertEq(lab.feeBps(), 1000);
        vm.prank(owner);
        vm.expectRevert(PonchemLab.ZeroAddress.selector);
        lab.setTreasury(address(0));
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.TreasurySet(bob);
        lab.setTreasury(bob);
        assertEq(lab.treasury(), bob);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setTreasury(bob);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setFeeBps(1);
    }

    // ---------------------------------------------------------------- helpers

    function _text(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = bytes1(uint8(97 + (i % 26)));
        }
        return string(b);
    }

    function _slice(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b[i];
        }
    }

    function _shift(int16[] memory pose, int16 dx, int16 dy, int16 dz) internal pure returns (int16[] memory out) {
        out = new int16[](pose.length);
        for (uint256 i = 0; i < pose.length; i += 3) {
            out[i] = pose[i] + dx;
            out[i + 1] = pose[i + 1] + dy;
            out[i + 2] = pose[i + 2] + dz;
        }
    }

    function _canonical(int16[] memory pose) internal pure returns (bytes memory out) {
        out = new bytes(pose.length * 2);
        for (uint256 i = 0; i < pose.length; i++) {
            uint16 v = uint16(pose[i]);
            out[2 * i] = bytes1(uint8(v >> 8));
            out[2 * i + 1] = bytes1(uint8(v));
        }
    }

    /// the pose as int256 words with one word carrying dirty high bits (not a valid int16)
    function _dirty(int16[] memory pose) internal pure returns (int256[] memory out) {
        out = new int256[](pose.length);
        for (uint256 i = 0; i < pose.length; i++) {
            out[i] = int256(pose[i]);
        }
        out[0] = out[0] | int256(1 << 40);
    }
}
