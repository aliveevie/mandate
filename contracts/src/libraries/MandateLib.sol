// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A scoped, revocable delegation from a principal to an agent. EIP-712 typed struct.
/// @dev `targets` and `selectors` are parallel arrays: `selectors[i]` is allowed on `targets[i]`.
struct Mandate {
    address principal; // PasskeyAccount (or any IMandateAccount / ERC-1271 signer / EOA)
    uint256 agentId; // ERC-8004 agent id
    address agentKey; // agent's executing key
    address[] targets; // allowed contracts
    bytes4[] selectors; // allowed function selector per target (parallel array)
    address asset; // spend asset (address(0) = native)
    uint256 spendCap; // lifetime cap, in asset units
    uint256 perBlockCap; // max spend per block, in asset units
    uint256 maxDrawdownBps; // breaker trip threshold; 10_000 disables the breaker
    uint64 validAfter; // unix timestamp (inclusive)
    uint64 validUntil; // unix timestamp (inclusive)
    uint256 nonce; // per-principal nonce, must equal registry.nonces(principal)
    bytes32 policyHash; // hash of the encrypted off-chain policy blob
}

/// @title MandateLib
/// @notice EIP-712 hashing for `Mandate` plus small helpers shared by the protocol contracts.
library MandateLib {
    uint256 internal constant BPS = 10_000;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant NAME_HASH = keccak256("Mandate");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    bytes32 internal constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address principal,uint256 agentId,address agentKey,address[] targets,bytes4[] selectors,"
        "address asset,uint256 spendCap,uint256 perBlockCap,uint256 maxDrawdownBps,uint64 validAfter,"
        "uint64 validUntil,uint256 nonce,bytes32 policyHash)"
    );

    /// @notice EIP-712 struct hash of a mandate. This is the `mandateHash` used everywhere in the protocol.
    function hash(Mandate memory m) internal pure returns (bytes32) {
        // Split into two encodes to stay clear of stack limits; static-type abi.encode is plain word concatenation.
        bytes memory head = abi.encode(
            MANDATE_TYPEHASH,
            m.principal,
            m.agentId,
            m.agentKey,
            keccak256(abi.encodePacked(m.targets)),
            keccak256(abi.encodePacked(m.selectors)),
            m.asset
        );
        bytes memory tail =
            abi.encode(m.spendCap, m.perBlockCap, m.maxDrawdownBps, m.validAfter, m.validUntil, m.nonce, m.policyHash);
        return keccak256(bytes.concat(head, tail));
    }

    /// @notice EIP-712 domain separator: name="Mandate", version="1", chainId, verifyingContract=MandateRegistry.
    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, verifyingContract));
    }

    /// @notice Full EIP-712 digest the principal signs.
    function digest(bytes32 domainSeparator_, Mandate memory m) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator_, hash(m)));
    }

    /// @notice True when `selector` on `target` is whitelisted by the mandate.
    function isAllowed(Mandate memory m, address target, bytes4 selector) internal pure returns (bool) {
        uint256 n = m.targets.length;
        for (uint256 i; i < n; ++i) {
            if (m.targets[i] == target && m.selectors[i] == selector) return true;
        }
        return false;
    }
}
