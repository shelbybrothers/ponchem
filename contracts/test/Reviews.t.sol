// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";

/// @notice SPEC.md 9.2 (reviews) and 9.8 (the attached analysis).
contract ReviewsTest is Base {
    Vector internal v;
    uint16 internal t;
    uint16 internal l;
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        (v, t, l) = _real02();
        (id,) = _submit(alice, t, l, v.pose);
    }

    function _bytesOf(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = "n";
        }
        return string(b);
    }

    // ---------------------------------------------------------------- reviews

    function test_reviewRejects() public {
        vm.prank(alice);
        vm.expectRevert(PonchemLab.SelfReview.selector);
        lab.reviewRun(id, 5, "mine");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.reviewRun(0, 5, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.reviewRun(id + 1, 5, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.BadStars.selector);
        lab.reviewRun(id, 0, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.BadStars.selector);
        lab.reviewRun(id, 6, "");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NoteTooLong.selector);
        lab.reviewRun(id, 4, _bytesOf(281));
        (uint32 count, uint32 sum) = lab.reviewStats(id);
        assertEq(count, 0);
        assertEq(sum, 0);
        assertEq(lab.MAX_NOTE(), 280);
    }

    function test_reviewCountsAndReplacement() public {
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
        (,,, uint32 given, uint32 received, uint32 starsReceived) = lab.stats(alice);
        assertEq(given, 0);
        assertEq(received, 1);
        assertEq(starsReceived, 4);
        (,,, given, received, starsReceived) = lab.stats(bob);
        assertEq(given, 1);
        assertEq(received, 0);
        assertEq(starsReceived, 0);

        vm.warp(T0 + 100);
        vm.prank(carol);
        lab.reviewRun(id, 2, _bytesOf(280));
        (count, sum) = lab.reviewStats(id);
        assertEq(count, 2);
        assertEq(sum, 6);

        // bob changes his mind: the count stays, the sum moves, the time is the new one
        vm.warp(T0 + 200);
        vm.prank(bob);
        lab.reviewRun(id, 5, "");
        (count, sum) = lab.reviewStats(id);
        assertEq(count, 2);
        assertEq(sum, 7);
        (stars, time) = lab.reviewOf(id, bob);
        assertEq(stars, 5);
        assertEq(time, T0 + 200);
        (,,, given, received, starsReceived) = lab.stats(alice);
        assertEq(received, 2);
        assertEq(starsReceived, 7);
        (,,, given,,) = lab.stats(bob);
        assertEq(given, 1, "a replacement is not a second review given");
        (stars,) = lab.reviewOf(id, stranger);
        assertEq(stars, 0);

        // a second run keeps its own stats
        (uint256 id2,) = _submit(bob, t, l, v.pose);
        vm.prank(alice);
        lab.reviewRun(id2, 1, "");
        (count, sum) = lab.reviewStats(id2);
        assertEq(count, 1);
        assertEq(sum, 1);
        (,,, given, received, starsReceived) = lab.stats(bob);
        assertEq(given, 1);
        assertEq(received, 1);
        assertEq(starsReceived, 1);
        (,,, given,,) = lab.stats(alice);
        assertEq(given, 1);
    }

    // ---------------------------------------------------------------- analysis

    function test_attachAnalysis() public {
        vm.prank(alice);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.attachAnalysis(0, "claude", "text");
        vm.prank(alice);
        vm.expectRevert(PonchemLab.NoRun.selector);
        lab.attachAnalysis(id + 1, "claude", "text");
        vm.prank(bob);
        vm.expectRevert(PonchemLab.NotAuthor.selector);
        lab.attachAnalysis(id, "claude", "text");
        vm.prank(alice);
        vm.expectRevert(PonchemLab.ProviderTooLong.selector);
        lab.attachAnalysis(id, _bytesOf(33), "text");
        vm.prank(alice);
        vm.expectRevert(PonchemLab.AnalysisTooLong.selector);
        lab.attachAnalysis(id, "claude", _bytesOf(2049));
        assertEq(lab.analysisHash(id), bytes32(0));

        string memory text = "The pose sits in the hinge region with the quinazoline stacked against the gatekeeper.";
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit PonchemLab.Analysis(id, "claude", text);
        lab.attachAnalysis(id, "claude", text);
        assertEq(lab.analysisHash(id), keccak256(bytes(text)));

        // a later one replaces the earlier
        string memory longest = _bytesOf(2048);
        vm.prank(alice);
        lab.attachAnalysis(id, _bytesOf(32), longest);
        assertEq(lab.analysisHash(id), keccak256(bytes(longest)));
        assertEq(lab.MAX_ANALYSIS(), 2048);
        assertEq(lab.MAX_PROVIDER(), 32);
    }
}
