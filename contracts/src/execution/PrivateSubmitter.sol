// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPrivateSubmit} from "../interfaces/IPrivateSubmit.sol";
import {IMandateExecutor} from "../interfaces/IMandateExecutor.sol";

/// @title PrivateSubmitter
/// @notice Private execution front-door for mandated calls, selected at deploy time:
///         - `Mode.BTX`: the agent submits `reveal` through Monad's BTX encrypted mempool. Pre-inclusion
///           privacy comes from the mempool, so no commit is needed and `commit` reverts.
///         - `Mode.CommitReveal`: `commit(keccak(agentKey, mandateHash, target, data, amount, salt))`, then
///           `reveal(...)` from the same key at least one block later and within `revealWindow` blocks.
///         Both modes end in `MandateExecutor.executeFor`, so every registry / breaker check still applies.
contract PrivateSubmitter is IPrivateSubmit {
    Mode public immutable override mode;
    address public immutable override executor;
    uint256 public immutable override revealWindow;

    mapping(bytes32 commitment => uint256 commitBlock) public override commits;

    constructor(address executor_, Mode mode_, uint256 revealWindow_) {
        executor = executor_;
        mode = mode_;
        revealWindow = revealWindow_;
    }

    /// @inheritdoc IPrivateSubmit
    function commitmentOf(
        address agentKey,
        bytes32 mandateHash,
        address target,
        bytes calldata data,
        uint256 amount,
        bytes32 salt
    ) public pure override returns (bytes32) {
        return keccak256(abi.encode(agentKey, mandateHash, target, keccak256(data), amount, salt));
    }

    /// @inheritdoc IPrivateSubmit
    function commit(bytes32 commitment) external override {
        if (mode == Mode.BTX) revert CommitNotRequired();
        if (commits[commitment] != 0) revert CommitAlreadyExists(commitment);
        commits[commitment] = block.number;
        emit Committed(commitment, msg.sender, block.number);
    }

    /// @inheritdoc IPrivateSubmit
    function reveal(bytes32 mandateHash, address target, bytes calldata data, uint256 amount, bytes32 salt)
        external
        override
        returns (bytes memory)
    {
        bytes32 c = commitmentOf(msg.sender, mandateHash, target, data, amount, salt);
        if (mode == Mode.CommitReveal) {
            uint256 committedAt = commits[c];
            if (committedAt == 0) revert CommitNotFound(c);
            if (block.number <= committedAt) revert RevealTooEarly(committedAt, block.number);
            if (block.number > committedAt + revealWindow) revert RevealExpired(committedAt, block.number);
            delete commits[c];
        }
        emit Revealed(c, mandateHash, msg.sender);
        return IMandateExecutor(executor).executeFor(msg.sender, mandateHash, target, data, amount);
    }
}
