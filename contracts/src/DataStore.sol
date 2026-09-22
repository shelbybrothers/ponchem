// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DataStore
/// @notice Bytes stored as contract code (the SSTORE2 idea). The runtime of a data contract is one STOP byte
///         followed by the payload, so nothing can execute it, and a reader copies the payload back with
///         EXTCODECOPY from offset 1. Writing costs 32,000 gas plus 200 per byte once; reading is a few hundred
///         gas per kilobyte, which is what keeps a scoring run affordable: the pocket, the topology and the
///         tables are copied into memory once per run and never touch storage.
library DataStore {
    /// @dev EIP-170: runtime code is at most 24,576 bytes, one of which is the STOP prefix.
    uint256 internal constant MAX_PAYLOAD = 24_575;

    error PayloadTooLarge();
    error StoreFailed();

    /// @notice Create a data contract holding `data`; returns its address.
    function write(bytes memory data) internal returns (address ptr) {
        if (data.length > MAX_PAYLOAD) revert PayloadTooLarge();
        // initcode:  63 <size:4>  80  60 0E  60 00  39  60 00  F3   then the runtime: 00 || data
        //            PUSH4 size   DUP1 PUSH1 14 PUSH1 0 CODECOPY PUSH1 0 RETURN
        bytes memory code = abi.encodePacked(hex"63", uint32(data.length + 1), hex"80600E6000396000F3", hex"00", data);
        assembly ("memory-safe") {
            ptr := create(0, add(code, 32), mload(code))
        }
        if (ptr == address(0)) revert StoreFailed();
    }

    /// @notice The payload length (code size minus the STOP byte).
    function size(address ptr) internal view returns (uint256 n) {
        n = ptr.code.length;
        if (n > 0) n -= 1;
    }

    /// @notice The whole payload as memory bytes.
    function read(address ptr) internal view returns (bytes memory data) {
        uint256 n = size(ptr);
        data = new bytes(n);
        assembly ("memory-safe") {
            extcodecopy(ptr, add(data, 32), 1, n)
        }
    }
}
