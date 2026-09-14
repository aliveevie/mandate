// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004ReputationAdapter} from "../interfaces/IERC8004ReputationAdapter.sol";
import {IERC8004ReputationRegistry} from "../interfaces/IERC8004.sol";

/// @title ERC8004ReputationAdapter
/// @notice Writes verified compliance attestations for agents. Only the Attestor (the CRE workflow's onchain
///         identity) may attest; agents cannot self-attest. Every attestation is stored here as the canonical
///         evidence record and mirrored into the ERC-8004 Reputation Registry (`giveFeedback`) when configured.
///         A failing mirror never loses the attestation: it is recorded and `MirrorFailed` is emitted.
contract ERC8004ReputationAdapter is IERC8004ReputationAdapter {
    string internal constant TAG1 = "mandate-compliance";

    address public immutable override owner;
    address public override attestor;
    address public override reputationRegistry;

    mapping(uint256 agentId => Attestation[]) internal _history;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address reputationRegistry_, address attestor_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        attestor = attestor_;
        reputationRegistry = reputationRegistry_;
        emit AttestorSet(attestor_);
        emit ReputationRegistrySet(reputationRegistry_);
    }

    // ------------------------------------------------------------------ attest

    /// @inheritdoc IERC8004ReputationAdapter
    function attest(uint256 agentId, Attestation calldata a) external override {
        if (msg.sender != attestor) revert NotAttestor();
        if (a.complianceScore > 100) revert InvalidScore(a.complianceScore);
        if (a.windowEnd <= a.windowStart) revert InvalidWindow(a.windowStart, a.windowEnd);

        _history[agentId].push(a);

        bool mirrored;
        address registry_ = reputationRegistry;
        if (registry_ != address(0)) {
            try IERC8004ReputationRegistry(registry_)
                .giveFeedback(agentId, int128(uint128(a.complianceScore)), 0, TAG1, "", "", "", a.evidenceHash) {
                mirrored = true;
            } catch (bytes memory reason) {
                emit MirrorFailed(agentId, reason);
            }
        }

        emit ReputationAttested(
            agentId,
            msg.sender,
            a.complianceScore,
            a.tripCount,
            a.executedCount,
            a.realisedPnlBps,
            a.windowStart,
            a.windowEnd,
            a.evidenceHash,
            mirrored
        );
    }

    // ------------------------------------------------------------------ admin

    function setAttestor(address attestor_) external override onlyOwner {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    function setReputationRegistry(address reputationRegistry_) external override onlyOwner {
        reputationRegistry = reputationRegistry_;
        emit ReputationRegistrySet(reputationRegistry_);
    }

    // ------------------------------------------------------------------ views

    function latest(uint256 agentId) external view override returns (Attestation memory a) {
        Attestation[] storage h = _history[agentId];
        if (h.length != 0) a = h[h.length - 1];
    }

    function attestationCount(uint256 agentId) external view override returns (uint256) {
        return _history[agentId].length;
    }

    function attestationAt(uint256 agentId, uint256 index) external view override returns (Attestation memory) {
        return _history[agentId][index];
    }
}
