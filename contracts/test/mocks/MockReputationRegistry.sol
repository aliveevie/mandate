// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004ReputationRegistry} from "../../src/interfaces/IERC8004.sol";

contract MockReputationRegistry is IERC8004ReputationRegistry {
    struct Feedback {
        address from;
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        bytes32 feedbackHash;
    }

    Feedback[] public feedbacks;

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external override {
        feedbacks.push(Feedback(msg.sender, agentId, value, valueDecimals, tag1, feedbackHash));
    }

    function count() external view returns (uint256) {
        return feedbacks.length;
    }

    function getSummary(uint256 agentId, address[] calldata, string calldata, string calldata)
        external
        view
        override
        returns (uint64 n, int128 sum, uint8)
    {
        for (uint256 i; i < feedbacks.length; ++i) {
            if (feedbacks[i].agentId == agentId) {
                n++;
                sum += feedbacks[i].value;
            }
        }
        return (n, sum, 0);
    }

    function getIdentityRegistry() external pure override returns (address) {
        return address(0);
    }
}

contract RevertingReputationRegistry is IERC8004ReputationRegistry {
    error Nope();

    function giveFeedback(
        uint256,
        int128,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external pure override {
        revert Nope();
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        override
        returns (uint64, int128, uint8)
    {
        return (0, 0, 0);
    }

    function getIdentityRegistry() external pure override returns (address) {
        return address(0);
    }
}
