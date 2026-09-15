// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Mandate} from "../libraries/MandateLib.sol";
import {IMandateAccount} from "./IPasskeyAccount.sol";

/// @notice Mandate account owned by a secp256k1 signer (EOA, embedded wallet, or ERC-1271 contract).
interface ISignerAccount is IMandateAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error NotExecutor();
    error InvalidSignature();
    error ZeroAddress();

    event Executed(address indexed target, uint256 value, bytes data);
    event ExecutedFromMandate(address indexed target, uint256 value, bytes data);
    event MandateRevokeRequested(bytes32 indexed mandateHash);

    function owner() external view returns (address);
    function registry() external view returns (address);
    function executor() external view returns (address);
    function nonce() external view returns (uint256);

    function domainSeparator() external view returns (bytes32);
    function executeDigest(Call calldata call, uint256 nonce_) external view returns (bytes32);
    function revokeDigest(bytes32 mandateHash, uint256 nonce_) external view returns (bytes32);

    /// @notice Owner call, authorised by an EIP-712 signature over `Execute(target,value,data,nonce)`.
    function execute(Call calldata call, bytes calldata signature) external returns (bytes memory result);
    /// @notice Convenience forwarder: `registry.grant(mandate, signature)`.
    function grantMandate(Mandate memory mandate, bytes calldata signature) external returns (bytes32 mandateHash);
    /// @notice Revoke, authorised by an EIP-712 signature over `Revoke(mandateHash,nonce)`.
    function revokeMandate(bytes32 mandateHash, bytes calldata signature) external;
}
