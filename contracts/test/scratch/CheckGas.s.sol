// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {PonchemCheck} from "../../src/PonchemCheck.sol";

contract Caller {
    bytes32 public last;

    function go(PonchemCheck c, bytes calldata pocket, string calldata id) external {
        (,,,, bytes memory scan) = c.checkPocket(pocket, id);
        last = keccak256(scan);
    }
}

contract CheckGas is Script {
    function run() external {
        string memory json = vm.readFile("../data/vectors/real_02_1M17_AQ4_refined.json");
        bytes memory pocket = vm.parseJsonBytes(json, ".pocket_hex");
        vm.startBroadcast();
        PonchemCheck c = new PonchemCheck();
        Caller k = new Caller();
        k.go(c, pocket, "1M17");
        vm.stopBroadcast();
    }
}
