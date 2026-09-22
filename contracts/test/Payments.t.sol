// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";
import {MockToken, Refuser} from "./mocks/MockToken.sol";

/// @notice SPEC.md 9.1: a docking test is paid to the treasury, in ETH or in the lab token, the payer's choice;
///         9.7: the method JSON travels in the Method event and its hash in the run.
contract PaymentsTest is Base {
    Vector internal v;
    uint16 internal t;
    uint16 internal l;

    function setUp() public override {
        super.setUp();
        (v, t, l) = _real02();
    }

    function _bytesOf(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = "m";
        }
        return string(b);
    }

    // ---------------------------------------------------------------- ETH

    function test_ethGoesToTreasury() public {
        uint256 before = treasury.balance;
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Paid(1, alice, 0, RUN_FEE);
        (uint256 id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        assertEq(id, 1);
        assertEq(treasury.balance - before, RUN_FEE, "the fee reached the treasury");
        assertEq(address(lab).balance, 0, "nothing stays in the lab");
        assertEq(lab.pool(t), 0, "run fees do not feed the pool");
        assertEq(lab.totalHeld(), 0);
        assertEq(lab.owed(treasury), 0);
    }

    function test_ethWrongValue() public {
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: RUN_FEE + 1}(t, l, v.pose, false, "");
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: 0}(t, l, v.pose, false, "");
        assertEq(lab.runCount(), 0);
    }

    function test_refusedTreasuryIsOwed() public {
        Refuser r = new Refuser();
        vm.prank(owner);
        lab.setTreasury(address(r));
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit PonchemLab.Owed(address(r), RUN_FEE);
        (uint256 id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        assertEq(id, 1, "the test is recorded even though the treasury refused");
        assertEq(lab.owed(address(r)), RUN_FEE);
        assertEq(lab.totalOwed(), RUN_FEE);
        assertEq(address(lab).balance, RUN_FEE, "the refused fee waits in the lab");
        // still refusing: the credit stays
        vm.expectRevert(PonchemLab.TransferFailed.selector);
        r.call(address(lab), abi.encodeWithSignature("withdraw()"), 0);
        r.allow();
        r.call(address(lab), abi.encodeWithSignature("withdraw()"), 0);
        assertEq(address(r).balance, RUN_FEE);
        assertEq(lab.owed(address(r)), 0);
        assertEq(lab.totalOwed(), 0);
        assertEq(address(lab).balance, 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- token

    function test_tokenPathWithAllowance() public {
        MockToken tok = new MockToken();
        tok.mint(alice, 1000e18);
        assertFalse(lab.tokenAllowed());
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.TokenSet(address(tok));
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.PaymentOptionsSet(true, true);
        lab.setToken(address(tok));
        assertTrue(lab.tokenAllowed(), "setToken with an address opens the token option");
        assertTrue(lab.ethAllowed());

        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: 1}(t, l, v.pose, true, "");
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentRefused.selector);
        lab.submitRun(t, l, v.pose, true, ""); // no allowance yet

        vm.prank(alice);
        tok.approve(address(lab), 1000e18);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Paid(1, alice, 1, RUN_PRICE);
        (uint256 id, int32 score) = lab.submitRun(t, l, v.pose, true, "");
        assertEq(id, 1);
        assertEq(score, int32(-6446));
        assertEq(tok.balanceOf(treasury), RUN_PRICE, "the price reached the treasury");
        assertEq(tok.balanceOf(alice), 1000e18 - RUN_PRICE);
        assertEq(tok.balanceOf(address(lab)), 0);
        assertEq(lab.pool(t), 0);

        // a token that returns nothing (USDT style) is accepted
        tok.setMode(1);
        vm.prank(alice);
        lab.submitRun(t, l, v.pose, true, "");
        assertEq(tok.balanceOf(treasury), 2 * RUN_PRICE);
        // false, a revert and a short answer are refused
        tok.setMode(2);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentRefused.selector);
        lab.submitRun(t, l, v.pose, true, "");
        tok.setMode(3);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentRefused.selector);
        lab.submitRun(t, l, v.pose, true, "");
        tok.setMode(4);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentRefused.selector);
        lab.submitRun(t, l, v.pose, true, "");
        // an address without code is not a token
        vm.prank(owner);
        lab.setToken(stranger);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentRefused.selector);
        lab.submitRun(t, l, v.pose, true, "");
        // the ETH path is untouched by a token
        vm.prank(alice);
        (id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        assertEq(id, 3);
        assertEq(tok.balanceOf(treasury), 2 * RUN_PRICE);
    }

    function test_tokenRequiredBeforeLaunch() public {
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenRequired.selector);
        lab.submitRun(t, l, v.pose, true, "");
        // even when the owner opens the option early, a zero token cannot pay
        vm.prank(owner);
        lab.setPaymentOptions(true, true);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.TokenRequired.selector);
        lab.submitRun(t, l, v.pose, true, "");
    }

    // ---------------------------------------------------------------- options and prices

    function test_disabledOptions() public {
        MockToken tok = new MockToken();
        tok.mint(alice, 1000e18);
        vm.prank(alice);
        tok.approve(address(lab), 1000e18);
        vm.prank(owner);
        lab.setToken(address(tok));

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.PaymentOptionsSet(false, true);
        lab.setPaymentOptions(false, true);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentDisabled.selector);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        vm.prank(alice);
        lab.submitRun(t, l, v.pose, true, "");

        vm.prank(owner);
        lab.setPaymentOptions(true, false);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentDisabled.selector);
        lab.submitRun(t, l, v.pose, true, "");
        vm.prank(alice);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");

        vm.prank(owner);
        lab.setPaymentOptions(false, false);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentDisabled.selector);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        vm.prank(alice);
        vm.expectRevert(PonchemLab.PaymentDisabled.selector);
        lab.submitRun(t, l, v.pose, true, "");
        assertEq(lab.runCount(), 2);

        // clearing the token closes the token option and says so
        vm.prank(owner);
        lab.setPaymentOptions(true, true);
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.PaymentOptionsSet(true, false);
        lab.setToken(address(0));
        assertFalse(lab.tokenAllowed());
        assertTrue(lab.ethAllowed());

        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setPaymentOptions(true, true);
        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setToken(address(tok));
    }

    function test_prices() public {
        MockToken tok = new MockToken();
        tok.mint(alice, 1000e18);
        vm.prank(alice);
        tok.approve(address(lab), 1000e18);
        vm.prank(owner);
        lab.setToken(address(tok));

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PonchemLab.PricesSet(0.0002 ether, 50e18);
        lab.setPrices(0.0002 ether, 50e18);
        assertEq(lab.runFee(), 0.0002 ether);
        assertEq(lab.runPrice(), 50e18);
        vm.prank(alice);
        vm.expectRevert(PonchemLab.WrongFee.selector);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        uint256 before = treasury.balance;
        vm.prank(alice);
        lab.submitRun{value: 0.0002 ether}(t, l, v.pose, false, "");
        assertEq(treasury.balance - before, 0.0002 ether);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Paid(2, alice, 1, 50e18);
        lab.submitRun(t, l, v.pose, true, "");
        assertEq(tok.balanceOf(treasury), 50e18);

        // a free lab: runFee 0 with no value, and Paid says 0
        vm.prank(owner);
        lab.setPrices(0, 0);
        before = treasury.balance;
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PonchemLab.Paid(3, alice, 0, 0);
        lab.submitRun(t, l, v.pose, false, "");
        assertEq(treasury.balance, before);
        assertEq(lab.runCount(), 3);

        vm.prank(stranger);
        vm.expectRevert(PonchemLab.NotOwner.selector);
        lab.setPrices(1, 1);
    }

    // ---------------------------------------------------------------- the method

    function test_methodEventAndHash() public {
        string memory method = '{"name":"Quick","version":1,"budget":{"ms":10000}}';
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit PonchemLab.Method(1, method);
        (uint256 id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, method);
        (,,,,,,, bytes32 methodHash) = lab.run(id);
        assertEq(methodHash, keccak256(bytes(method)));

        // an empty method: no Method event, zero hash
        vm.recordLogs();
        vm.prank(alice);
        (id,) = lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 methodTopic = keccak256("Method(uint256,string)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != methodTopic, "no Method event for an empty method");
        }
        (,,,,,,, methodHash) = lab.run(id);
        assertEq(methodHash, bytes32(0));

        // the limit
        vm.prank(alice);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, _bytesOf(1024));
        vm.prank(alice);
        vm.expectRevert(PonchemLab.MethodTooLong.selector);
        lab.submitRun{value: RUN_FEE}(t, l, v.pose, false, _bytesOf(1025));
        assertEq(lab.runCount(), 3);
        assertEq(lab.MAX_METHOD(), 1024);
    }
}
