// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-8004 Identity Registry surface (ERC-721 based agent identities).
interface IERC8004IdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function register() external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice Minimal ERC-8004 Reputation Registry surface used by the adapter (Trustless Agents, v1).
/// @dev Selector 0x3c036a7e verified against the Monad testnet implementation on 2026-09-14.
///      Feedback must not come from the agent's owner or operator; the adapter contract is the sender.
interface IERC8004ReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function getIdentityRegistry() external view returns (address);
}
