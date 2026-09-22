// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {PonchemLab} from "../src/PonchemLab.sol";

contract NamesTest is Base {
    event Named(address indexed wallet, string name);

    function test_setNameStoresAndEmits() public {
        vm.expectEmit(true, false, false, true, address(lab));
        emit Named(alice, "Dr Alice");
        vm.prank(alice);
        lab.setName("Dr Alice");
        assertEq(lab.nameOf(alice), "Dr Alice");
    }

    function test_setNameReplacesAndClears() public {
        vm.startPrank(alice);
        lab.setName("First");
        lab.setName("Second name");
        assertEq(lab.nameOf(alice), "Second name");
        lab.setName("");
        assertEq(lab.nameOf(alice), "");
        vm.stopPrank();
    }

    function test_setNameThirtyTwoBytesOk() public {
        vm.prank(alice);
        lab.setName("abcdefghijklmnopqrstuvwxyz012345");
        assertEq(bytes(lab.nameOf(alice)).length, 32);
    }

    function test_setNameRejectsTooLong() public {
        vm.prank(alice);
        vm.expectRevert(PonchemLab.BadResearcherName.selector);
        lab.setName("abcdefghijklmnopqrstuvwxyz0123456");
    }

    function test_setNameRejectsControlAndNonAscii() public {
        vm.startPrank(alice);
        vm.expectRevert(PonchemLab.BadResearcherName.selector);
        lab.setName("bad\nname");
        vm.expectRevert(PonchemLab.BadResearcherName.selector);
        lab.setName(unicode"café");
        vm.expectRevert(PonchemLab.BadResearcherName.selector);
        lab.setName(" padded");
        vm.expectRevert(PonchemLab.BadResearcherName.selector);
        lab.setName("padded ");
        vm.stopPrank();
    }

    function test_namesArePerWallet() public {
        vm.prank(alice);
        lab.setName("Alice");
        assertEq(lab.nameOf(bob), "");
    }
}
