// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Mandate} from "../libraries/MandateLib.sol";

/// @title IMandateRegistry
interface IMandateRegistry {
    struct MandateState {
        uint256 spent; // lifetime spend recorded
        uint256 spentThisBlock; // spend recorded in `lastBlock`
        uint256 lastBlock; // block of the last recorded execution
        uint64 grantedAt; // block.timestamp of grant
        bool revoked;
    }

    // ---- typed errors (mirrored 1:1 by the SDK) ----
    error MandateNotFound(bytes32 mandateHash);
    error MandateAlreadyExists(bytes32 mandateHash);
    error MandateRevoked(bytes32 mandateHash);
    error MandateExpired(uint64 validUntil);
    error MandateNotYetValid(uint64 validAfter);
    error TargetNotAllowed(address target, bytes4 selector);
    error SpendCapExceeded(uint256 requested, uint256 remaining);
    error PerBlockCapExceeded(uint256 requested, uint256 remaining);
    error Tripped(bytes32 mandateHash);
    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 provided);
    error InvalidMandate(string reason);
    error NotPrincipal();
    error NotExecutor();
    error NotOwner();
    error AlreadyConfigured();
    error NotConfigured();
    error ZeroAddress();

    // ---- events ----
    event MandateGranted(
        bytes32 indexed mandateHash,
        address indexed principal,
        uint256 indexed agentId,
        address agentKey,
        Mandate mandate
    );
    /// @dev Named `Revoked` because the `MandateRevoked` identifier is reserved for the typed error above.
    event Revoked(bytes32 indexed mandateHash, address indexed principal, uint256 indexed agentId);
    event ExecutionRecorded(bytes32 indexed mandateHash, uint256 spent, uint256 totalSpent, uint256 spentThisBlock);
    event Configured(address executor, address breaker);

    // ---- views ----
    function owner() external view returns (address);
    function executor() external view returns (address);
    function breaker() external view returns (address);
    function nonces(address principal) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function hashMandate(Mandate memory m) external pure returns (bytes32);
    function digest(Mandate memory m) external view returns (bytes32);
    function getMandate(bytes32 mandateHash) external view returns (Mandate memory);
    function getState(bytes32 mandateHash) external view returns (MandateState memory);
    function exists(bytes32 mandateHash) external view returns (bool);
    function isActive(bytes32 mandateHash) external view returns (bool);
    function remainingSpend(bytes32 mandateHash) external view returns (uint256);
    function remainingBlockSpend(bytes32 mandateHash) external view returns (uint256);

    /// @notice Reverts with a typed error if `amount` of `asset` may not be spent on `target.selector` right now.
    function validate(bytes32 mandateHash, address target, bytes4 selector, uint256 amount) external view;

    // ---- mutations ----
    function configure(address executor_, address breaker_) external;
    function grant(Mandate memory m, bytes calldata signature) external returns (bytes32 mandateHash);
    function revoke(bytes32 mandateHash) external;
    function recordExecution(bytes32 mandateHash, uint256 spent) external;
}
