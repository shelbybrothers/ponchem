// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What PonchemLab is deployed with on Robinhood Chain (4663). deploy.sh reads these constants with sed
///         to print its plan, so keep each one on a single line in this exact shape.
library Mainnet {
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant OWNER = 0xb53cB636243AAD194628B88Cfcd770fFBE0cEDd8; // keystore pontoon-treasury
    address internal constant TREASURY = 0xb53cB636243AAD194628B88Cfcd770fFBE0cEDd8;
    uint16 internal constant FEE_BPS = 500; // 5% of a settled prize pool
    uint256 internal constant RUN_FEE = 0.0001 ether; // a docking test paid in ETH
    uint256 internal constant RUN_PRICE = 100e18; // a docking test paid in $PONCHEM (18 decimals)
    uint64 internal constant EPOCH = 7 days;
}
