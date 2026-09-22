// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PonchemConstants
/// @notice The frozen numbers of SPEC-ENGINE.md shared by the scorer (PonchemEngine) and the registration checks
///         (PonchemCheck): the tables hash, the size limits, and the per-type radius and flag words.
abstract contract PonchemConstants {
    /// @notice keccak256 of data/tables/tables.bin (gauss1 || gauss2 || sqrt), SPEC-ENGINE.md 3.4
    bytes32 public constant TABLES_HASH = 0x0ecc4dd8e9494c3eb87f910dec144d463f5dc8e285fbbbbeaded5061d0365e93;
    uint256 public constant TABLES_SIZE = 13_010;
    uint256 public constant MAX_POCKET_ATOMS = 2000;
    uint256 public constant MAX_LIGAND_ATOMS = 64;
    uint256 public constant POCKET_VERSION = 1;
    uint256 public constant TOPOLOGY_VERSION = 1;

    /// @dev van der Waals radius in centi-A per type code, byte t of this word (byte 0 is the most significant)
    uint256 internal constant RADII = 0xBEBEB4B4B4B4AAAAAAC8D296B4C8DC7800000000000000000000000000000000;
    /// @dev per type code: bit0 hydrophobic, bit1 donor, bit2 acceptor (HYD_MASK 0x7801, DON_MASK 0x8128, ACC_MASK 0x0170)
    uint256 internal constant FLAGS = 0x0100000204060402060000010101010200000000000000000000000000000000;

    uint8 internal constant OK = 0;
    uint8 internal constant ERR_ATOM_COUNT = 1;
    uint8 internal constant ERR_BOX = 2;
    uint8 internal constant ERR_BOND = 3;
    uint8 internal constant ERR_PAIR13 = 4;
    uint8 internal constant ERR_CLASH = 5;

    function _radius(uint8 t) internal pure returns (uint256 r) {
        r = (RADII >> (248 - 8 * uint256(t))) & 0xff;
    }

    function _flags(uint8 t) internal pure returns (uint256 f) {
        f = (FLAGS >> (248 - 8 * uint256(t))) & 0xff;
    }

    function _u16(bytes memory b, uint256 off) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := shr(240, mload(add(add(b, 32), off)))
        }
    }

    function _u32(bytes memory b, uint256 off) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := shr(224, mload(add(add(b, 32), off)))
        }
    }

    function _u64(bytes memory b, uint256 off) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := shr(192, mload(add(add(b, 32), off)))
        }
    }

    function _i16(bytes memory b, uint256 off) internal pure returns (int256 v) {
        assembly ("memory-safe") {
            v := signextend(1, shr(240, mload(add(add(b, 32), off))))
        }
    }
}
