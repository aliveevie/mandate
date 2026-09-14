// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Mandate} from "../libraries/MandateLib.sol";

/// @notice ERC-1271.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

/// @notice Minimal account surface the protocol needs from a principal: signature validation plus a
///         hook that lets the trusted `MandateExecutor` act from the account within a mandate.
interface IMandateAccount is IERC1271 {
    function executeFromExecutor(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory result);
}

/// @notice Passkey-rooted smart account. Owner is a P256 public key; signatures are WebAuthn assertions.
interface IPasskeyAccount is IMandateAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error NotExecutor();
    error InvalidSignature();

    event Executed(address indexed target, uint256 value, bytes data);
    event ExecutedFromMandate(address indexed target, uint256 value, bytes data);
    event MandateRevokeRequested(bytes32 indexed mandateHash);

    function pubKeyX() external view returns (bytes32);
    function pubKeyY() external view returns (bytes32);
    function registry() external view returns (address);
    function executor() external view returns (address);
    function nonce() external view returns (uint256);

    function executeDigest(Call calldata call, uint256 nonce_) external view returns (bytes32);
    function revokeDigest(bytes32 mandateHash, uint256 nonce_) external view returns (bytes32);

    /// @notice Owner call, authorised by a WebAuthn assertion over `executeDigest(call, nonce)`.
    function execute(Call calldata call, bytes calldata signature) external returns (bytes memory result);

    /// @notice Convenience forwarder: `registry.grant(mandate, signature)`.
    function grantMandate(Mandate memory mandate, bytes calldata signature) external returns (bytes32 mandateHash);

    /// @notice Revoke a mandate, authorised by a WebAuthn assertion over `revokeDigest(mandateHash, nonce)`.
    function revokeMandate(bytes32 mandateHash, bytes calldata signature) external;
}
