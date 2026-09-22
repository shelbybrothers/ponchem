// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";
import {DataStore} from "../../src/DataStore.sol";

contract StoreHarness {
    function write(bytes calldata data) external returns (address) {
        return DataStore.write(data);
    }
}

contract RegGasTest is Base {
    function test_parts() public {
        Vector memory v = _vector("real_02_1M17_AQ4_refined.json");
        uint256 g = gasleft();
        (uint16 n,,,, bytes memory scan) = check.checkPocket(v.pocket, "1M17");
        emit log_named_uint("check.checkPocket (external, 796 atoms)", g - gasleft());
        emit log_named_uint("scan bytes", scan.length);
        StoreHarness sh = new StoreHarness();
        g = gasleft();
        sh.write(scan);
        emit log_named_uint("DataStore.write(scan)", g - gasleft());
        g = gasleft();
        (uint8 a, uint8 r) = check.checkTopology(v.topology);
        emit log_named_uint("check.checkTopology AQ4", g - gasleft());
        n; a; r;
    }
}
