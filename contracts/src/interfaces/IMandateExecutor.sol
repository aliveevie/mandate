// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRiskBreaker} from "./IRiskBreaker.sol";

/// @title IMandateExecutor
interface IMandateExecutor {
    error NotAgentKey(address caller, address agentKey);
    error NotSubmitter();
    error NotOwner();
    error AlreadyConfigured();
    error Reentrancy();
    error SpendExceedsDeclared(uint256 actual, uint256 declared);

    event MandateExecuted(
        bytes32 indexed mandateHash,
        uint256 indexed agentId,
        address indexed agentKey,
        address target,
        bytes4 selector,
        uint256 declaredAmount,
        uint256 spent,
        IRiskBreaker.Phase phaseAfter
    );
    event SubmitterSet(address submitter);

    function registry() external view returns (address);
    function breaker() external view returns (address);
    function submitter() external view returns (address);
    function owner() external view returns (address);

    function setSubmitter(address submitter_) external;

    /// @notice Agent entrypoint. `msg.sender` must be `mandate.agentKey`. `amount` is the upper bound on
    ///         `asset` outflow from the principal caused by this call; the real outflow is measured and
    ///         must not exceed it.
    function execute(bytes32 mandateHash, address target, bytes calldata data, uint256 amount)
        external
        returns (bytes memory result);

    /// @notice Same as `execute`, but called by the trusted `PrivateSubmitter` on behalf of `agentKey`.
    function executeFor(address agentKey, bytes32 mandateHash, address target, bytes calldata data, uint256 amount)
        external
        returns (bytes memory result);
}
