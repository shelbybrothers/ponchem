// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PonchemLab} from "../src/PonchemLab.sol";
import {PonchemCheck} from "../src/PonchemCheck.sol";
import {Mainnet} from "./Mainnet.sol";

/// @notice Deploys PonchemCheck, PonchemLab and the scoring tables on Robinhood Chain: three transactions. Run it
///         through ./deploy.sh, which checks the node, the nonce and the balance first, prints the plan with the
///         gas estimate of the whole registry, asks for confirmation, and records the result.
///
///   OWNER, TREASURY, FEE_BPS, RUN_FEE, RUN_PRICE, EPOCH   optional overrides (default: script/Mainnet.sol)
///
///         The broadcast sender must be the owner: setTables and every registration are owner-only.
///         Nitro trap: inside the EVM block.number is the PARENT chain's block, so this script never reports a
///         deploy block. deploy.sh takes it from the transaction receipt through the RPC.
contract Deploy is Script {
    function run() external returns (PonchemLab lab, PonchemCheck check) {
        address owner = vm.envOr("OWNER", Mainnet.OWNER);
        address treasury = vm.envOr("TREASURY", Mainnet.TREASURY);
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(Mainnet.FEE_BPS));
        uint256 runFee = vm.envOr("RUN_FEE", Mainnet.RUN_FEE);
        uint256 runPrice = vm.envOr("RUN_PRICE", Mainnet.RUN_PRICE);
        uint256 epoch = vm.envOr("EPOCH", uint256(Mainnet.EPOCH));

        require(block.chainid == Mainnet.CHAIN_ID, "not Robinhood Chain (4663)");
        require(owner != address(0) && treasury != address(0), "zero owner or treasury");
        require(feeBps <= 1000, "FEE_BPS above the 1000 cap");
        require(epoch >= 1 hours && epoch <= 365 days, "EPOCH out of range");

        bytes memory tables = vm.readFileBinary("../data/tables/tables.bin");
        require(tables.length == 13010, "tables.bin is not 13010 bytes");
        require(keccak256(tables) == 0x0ecc4dd8e9494c3eb87f910dec144d463f5dc8e285fbbbbeaded5061d0365e93, "tables.bin hash");

        vm.startBroadcast();
        check = new PonchemCheck();
        lab = new PonchemLab(check, owner, treasury, uint16(feeBps), runFee, runPrice, uint64(epoch));
        lab.setTables(tables);
        vm.stopBroadcast();

        require(lab.owner() == owner, "owner did not read back");
        require(lab.treasury() == treasury, "treasury did not read back");
        require(lab.feeBps() == feeBps, "fee did not read back");
        require(lab.runFee() == runFee, "run fee did not read back");
        require(lab.tables() != address(0), "tables did not read back");
        require(address(lab.check()) == address(check), "check did not read back");

        console2.log("PonchemCheck  ", address(check));
        console2.log("PonchemLab    ", address(lab));
        console2.log("tables        ", lab.tables());
        console2.log("owner         ", owner);
        console2.log("treasury      ", treasury);
        console2.log("feeBps        ", feeBps);
        console2.log("runFee (wei)  ", runFee);
        console2.log("runPrice      ", runPrice);
        console2.log("epoch (s)     ", epoch);
        console2.log("genesis       ", lab.genesis());
    }
}
