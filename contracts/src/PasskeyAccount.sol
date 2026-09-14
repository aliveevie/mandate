// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {Mandate} from "./libraries/MandateLib.sol";
import {IPasskeyAccount} from "./interfaces/IPasskeyAccount.sol";
import {IMandateRegistry} from "./interfaces/IMandateRegistry.sol";

/// @title PasskeyAccount
/// @notice Minimal smart account owned by a P256 (WebAuthn / passkey) public key.
///         Signatures are ABI-encoded `WebAuthn.WebAuthnAuth` assertions. Verification checks the
///         clientDataJSON type + challenge, authenticatorData UP/UV flags, then verifies the P256 signature
///         through the RIP-7212 precompile at 0x100 (Monad) via Solady's audited WebAuthn/P256 libraries.
///         No P256 math is implemented here.
contract PasskeyAccount is IPasskeyAccount {
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_FAIL = 0xffffffff;

    /// @notice Passkeys (Face ID / Touch ID) always set UV; we require it for every owner action.
    bool public constant REQUIRE_USER_VERIFICATION = true;

    bytes32 internal constant EXECUTE_TYPEHASH = keccak256(
        "Execute(address target,uint256 value,bytes32 dataHash,uint256 nonce,uint256 chainId,address account)"
    );
    bytes32 internal constant REVOKE_TYPEHASH =
        keccak256("Revoke(bytes32 mandateHash,uint256 nonce,uint256 chainId,address account)");

    bytes32 public immutable override pubKeyX;
    bytes32 public immutable override pubKeyY;
    address public immutable override registry;
    address public immutable override executor;

    uint256 public override nonce;

    constructor(bytes32 x, bytes32 y, address registry_, address executor_) {
        pubKeyX = x;
        pubKeyY = y;
        registry = registry_;
        executor = executor_;
    }

    receive() external payable {}

    // ------------------------------------------------------------------ ERC-1271

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        return _verify(hash, signature) ? ERC1271_MAGIC : ERC1271_FAIL;
    }

    // ------------------------------------------------------------------ digests

    function executeDigest(Call calldata call, uint256 nonce_) public view override returns (bytes32) {
        return keccak256(
            abi.encode(
                EXECUTE_TYPEHASH, call.target, call.value, keccak256(call.data), nonce_, block.chainid, address(this)
            )
        );
    }

    function revokeDigest(bytes32 mandateHash, uint256 nonce_) public view override returns (bytes32) {
        return keccak256(abi.encode(REVOKE_TYPEHASH, mandateHash, nonce_, block.chainid, address(this)));
    }

    // ------------------------------------------------------------------ owner actions

    /// @inheritdoc IPasskeyAccount
    function execute(Call calldata call, bytes calldata signature) external override returns (bytes memory) {
        bytes32 d = executeDigest(call, nonce++);
        if (!_verify(d, signature)) revert InvalidSignature();
        emit Executed(call.target, call.value, call.data);
        return _call(call.target, call.value, call.data);
    }

    /// @inheritdoc IPasskeyAccount
    function grantMandate(Mandate memory mandate, bytes calldata signature) external override returns (bytes32) {
        return IMandateRegistry(registry).grant(mandate, signature);
    }

    /// @inheritdoc IPasskeyAccount
    function revokeMandate(bytes32 mandateHash, bytes calldata signature) external override {
        bytes32 d = revokeDigest(mandateHash, nonce++);
        if (!_verify(d, signature)) revert InvalidSignature();
        emit MandateRevokeRequested(mandateHash);
        IMandateRegistry(registry).revoke(mandateHash);
    }

    // ------------------------------------------------------------------ mandate execution hook

    /// @notice Trusted executor hook: performs a mandated call from this account.
    function executeFromExecutor(address target, uint256 value, bytes calldata data)
        external
        override
        returns (bytes memory)
    {
        if (msg.sender != executor) revert NotExecutor();
        emit ExecutedFromMandate(target, value, data);
        return _call(target, value, data);
    }

    // ------------------------------------------------------------------ internal

    function _verify(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        // Best-effort decode: a malformed encoding yields an empty struct, which `verify` rejects.
        WebAuthn.WebAuthnAuth memory auth = WebAuthn.tryDecodeAuth(signature);
        return WebAuthn.verify(abi.encodePacked(hash), REQUIRE_USER_VERIFICATION, auth, pubKeyX, pubKeyY);
    }

    function _call(address target, uint256 value, bytes memory data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            // Bubble the exact revert so typed venue errors reach the agent / SDK.
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}
