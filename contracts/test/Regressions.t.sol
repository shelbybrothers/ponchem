// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";
import {Bomber, GasBurner, Refuser} from "./mocks/MockToken.sol";

/// @notice Guards for problems met while building: receivers that return a bomb or burn gas, a treasury that
///         refuses payments, a target registered late, and the optimizer settings the scorer depends on.
contract RegressionsTest is Base {
    /// A winner that answers a settle with 144,000 bytes of return data must not cost more than a plain wallet
    /// beyond the refused-transfer bookkeeping: the payment copies nothing back (the ponbio lesson).
    function test_returnBombWinnerDoesNotInflateSettle() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        Bomber bomber = new Bomber();
        vm.deal(address(bomber), 1 ether);
        _fund(carol, t, 1 ether);
        vm.prank(address(bomber));
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        _warpEpochs(1);
        vm.cool(address(lab));
        lab.settle(t, 0);
        uint256 withBomb = vm.lastCallGas().gasTotalUsed;
        assertEq(lab.owed(address(bomber)), 0, "a receiver that returns data still got paid");

        // the same settle with a plain wallet
        PonchemLab fresh = new PonchemLab(check, owner, treasury, FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH);
        vm.prank(owner);
        fresh.setTables(tablesBlob);
        vm.prank(owner);
        uint16 ft = fresh.registerTarget(_pdbIdOf(v.pocket), "EGFR", 1, v.pocket, v.pocketHash);
        vm.prank(owner);
        uint16 fl = fresh.registerLigand("AQ4", "erlotinib", v.topology, v.topologyHash);
        vm.prank(carol);
        fresh.fund{value: 1 ether}(ft);
        vm.deal(alice, alice.balance + 1 wei);
        vm.prank(alice);
        fresh.submitRun{value: RUN_FEE}(ft, fl, v.pose, false, "");
        _warpEpochs(1);
        vm.cool(address(fresh));
        fresh.settle(ft, 0);
        uint256 plain = vm.lastCallGas().gasTotalUsed;
        // the receiver spends its own allowance (up to PAY_GAS) on the blob; the lab copies none of it, so the
        // extra stays within that allowance instead of growing with the blob (144,000 bytes would cost the lab
        // about 240,000 gas of memory if it copied them)
        assertLt(withBomb, plain + 100_000, "the return bomb costs at most the receiver's own allowance");
    }

    /// A treasury that burns all the gas it is given cannot block docking tests: the payment is capped and the
    /// refused amount is credited.
    function test_gasBurningTreasuryDoesNotBlockTests() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        GasBurner burner = new GasBurner();
        vm.prank(owner);
        lab.setTreasury(address(burner));
        vm.prank(alice);
        (uint256 id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        assertEq(id, 1);
        assertEq(lab.owed(address(burner)), RUN_FEE);
        _fund(carol, t, 1 ether);
        _warpEpochs(1);
        lab.settle(t, 0);
        assertEq(lab.owed(address(burner)), RUN_FEE + 0.05 ether);
        _assertSolvent();
    }

    /// A target registered long after genesis settles from its registration epoch: no walk over dead epochs.
    function test_lateTargetSettlesFromItsOwnEpoch() public {
        vm.warp(T0 + 300 * EPOCH);
        (Vector memory v, uint16 t, uint16 l) = _real02();
        assertEq(lab.nextSettle(t), 300);
        _fund(carol, t, 1 ether);
        _submit(alice, t, l, v.pose);
        _warpEpochs(1);
        vm.expectRevert(PonchemLab.AlreadySettled.selector);
        lab.settle(t, 299);
        vm.cool(address(lab));
        lab.settle(t, 300);
        assertLt(vm.lastCallGas().gasTotalUsed, 150_000, "one epoch settled, not 301");
    }

    /// Reentrancy: a winner that calls back into settle or withdraw during its payment gets nothing extra.
    function test_reentrantWinnerGetsNothingExtra() public {
        (Vector memory v, uint16 t, uint16 l) = _real02();
        Reenterer r = new Reenterer(lab, t);
        vm.deal(address(r), 1 ether);
        _fund(carol, t, 1 ether);
        vm.prank(address(r));
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        _warpEpochs(1);
        lab.settle(t, 0);
        // the callback reverted inside the gas-capped call, so the prize is credited, not lost or doubled
        assertEq(lab.owed(address(r)) + address(r).balance, 1 ether - RUN_FEE + 0.95 ether);
        _assertSolvent();
    }

    /// The scorer depends on the optimizer settings in foundry.toml: with the Yul inliner on, the visit loop was
    /// spilled to memory and a run cost 4.1M instead of the numbers in gas.md. This pins the metadata.
    function test_optimizerSettingsPinned() public view {
        string memory meta = vm.readFile("out/PonchemLab.sol/PonchemLab.json");
        string memory steps = vm.parseJsonString(meta, ".rawMetadata");
        assertTrue(_contains(steps, "dhfoDgvulfnTUtnf["), "the Yul optimizer sequence has no FullInliner step");
        assertTrue(_contains(steps, "\"runs\":10000"), "optimizer runs");
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i + n.length <= h.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}

contract Reenterer {
    PonchemLab internal lab;
    uint16 internal t;

    constructor(PonchemLab lab_, uint16 t_) {
        lab = lab_;
        t = t_;
    }

    receive() external payable {
        // try to settle again and to withdraw during the payment
        lab.settle(t, 0);
    }
}
