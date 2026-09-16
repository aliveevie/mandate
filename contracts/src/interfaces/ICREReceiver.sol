// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-165 introspection (subset used by the CRE forwarder).
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title IReceiver - receives Chainlink CRE (Keystone) reports
/// @notice Mirrors `@chainlink/contracts/cre/src/v1/interfaces/IReceiver.sol`. Implementations must advertise the
///         interface through ERC-165. The KeystoneForwarder calls `onReport` after verifying the DON signatures.
interface IReceiver is IERC165 {
    /// @param metadata `abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)`
    /// @param report   The workflow's report payload, byte for byte what the workflow passed to `runtime.report`.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
