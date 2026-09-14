// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC8004ReputationAdapter
/// @notice Only the Attestor (the CRE workflow's onchain identity) may write reputation. Agents cannot self-attest.
interface IERC8004ReputationAdapter {
    struct Attestation {
        uint8 complianceScore; // 0-100
        uint32 tripCount;
        uint32 executedCount;
        int256 realisedPnlBps;
        uint64 windowStart;
        uint64 windowEnd;
        bytes32 evidenceHash; // hash of the CRE workflow's computed inputs
    }

    error NotAttestor();
    error NotOwner();
    error ZeroAddress();
    error InvalidScore(uint8 complianceScore);
    error InvalidWindow(uint64 windowStart, uint64 windowEnd);

    event ReputationAttested(
        uint256 indexed agentId,
        address indexed attestor,
        uint8 complianceScore,
        uint32 tripCount,
        uint32 executedCount,
        int256 realisedPnlBps,
        uint64 windowStart,
        uint64 windowEnd,
        bytes32 evidenceHash,
        bool mirrored
    );
    event MirrorFailed(uint256 indexed agentId, bytes reason);
    event AttestorSet(address attestor);
    event ReputationRegistrySet(address reputationRegistry);

    function owner() external view returns (address);
    function attestor() external view returns (address);
    function reputationRegistry() external view returns (address);

    function attest(uint256 agentId, Attestation calldata a) external;
    function setAttestor(address attestor_) external;
    function setReputationRegistry(address reputationRegistry_) external;

    function latest(uint256 agentId) external view returns (Attestation memory);
    function attestationCount(uint256 agentId) external view returns (uint256);
    function attestationAt(uint256 agentId, uint256 index) external view returns (Attestation memory);
}
