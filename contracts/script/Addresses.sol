// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Well-known addresses per chain. Verified on 2026-09-14 (see docs/ and the ERC-8004 contracts repo).
library Addresses {
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant MONAD_MAINNET = 143;

    /// @dev RIP-7212 secp256r1 precompile. Same address on Monad testnet and mainnet.
    address internal constant P256_PRECOMPILE = 0x0000000000000000000000000000000000000100;

    // ERC-8004 (Trustless Agents) canonical registries, deployed by the 8004 team behind ERC-1967 proxies.
    address internal constant ERC8004_IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant ERC8004_REPUTATION_TESTNET = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address internal constant ERC8004_IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant ERC8004_REPUTATION_MAINNET = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function erc8004Identity(uint256 chainId) internal pure returns (address) {
        if (chainId == MONAD_TESTNET) return ERC8004_IDENTITY_TESTNET;
        if (chainId == MONAD_MAINNET) return ERC8004_IDENTITY_MAINNET;
        return address(0);
    }

    function erc8004Reputation(uint256 chainId) internal pure returns (address) {
        if (chainId == MONAD_TESTNET) return ERC8004_REPUTATION_TESTNET;
        if (chainId == MONAD_MAINNET) return ERC8004_REPUTATION_MAINNET;
        return address(0);
    }
}
