// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Mandate} from "../libraries/MandateLib.sol";
import {IMandateExecutor} from "../interfaces/IMandateExecutor.sol";
import {IMandateRegistry} from "../interfaces/IMandateRegistry.sol";
import {IRiskBreaker} from "../interfaces/IRiskBreaker.sol";
import {IMandateAccount} from "../interfaces/IPasskeyAccount.sol";

interface IERC20BalanceOf {
    function balanceOf(address) external view returns (uint256);
}

/// @title MandateExecutor
/// @notice The only path through which an agent acts on a principal's account. Validates against the
///         registry, performs the call from the principal's account, measures the real `asset` outflow,
///         records spend, and checkpoints the breaker.
contract MandateExecutor is IMandateExecutor {
    address public immutable override registry;
    address public immutable override breaker;
    address public immutable override owner;
    address public override submitter;

    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address registry_, address breaker_) {
        registry = registry_;
        breaker = breaker_;
        owner = msg.sender;
    }

    /// @inheritdoc IMandateExecutor
    function setSubmitter(address submitter_) external override {
        if (msg.sender != owner) revert NotOwner();
        if (submitter != address(0)) revert AlreadyConfigured();
        submitter = submitter_;
        emit SubmitterSet(submitter_);
    }

    /// @inheritdoc IMandateExecutor
    function execute(bytes32 mandateHash, address target, bytes calldata data, uint256 amount)
        external
        override
        nonReentrant
        returns (bytes memory)
    {
        return _execute(msg.sender, mandateHash, target, data, amount);
    }

    /// @inheritdoc IMandateExecutor
    function executeFor(address agentKey, bytes32 mandateHash, address target, bytes calldata data, uint256 amount)
        external
        override
        nonReentrant
        returns (bytes memory)
    {
        if (msg.sender != submitter || submitter == address(0)) revert NotSubmitter();
        return _execute(agentKey, mandateHash, target, data, amount);
    }

    function _execute(address caller, bytes32 mandateHash, address target, bytes calldata data, uint256 amount)
        internal
        returns (bytes memory result)
    {
        Mandate memory m = IMandateRegistry(registry).getMandate(mandateHash); // reverts MandateNotFound
        if (caller != m.agentKey) revert NotAgentKey(caller, m.agentKey);

        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        IMandateRegistry(registry).validate(mandateHash, target, selector, amount);

        uint256 spent;
        (result, spent) = _callAndMeasure(m.principal, m.asset, target, data, amount);

        IMandateRegistry(registry).recordExecution(mandateHash, spent);
        IRiskBreaker.Phase phase = IRiskBreaker(breaker).checkpoint(mandateHash);

        _emitExecuted(mandateHash, m, target, selector, amount, spent, phase);
    }

    /// @dev Performs the call from the principal's account and measures the real `asset` outflow.
    function _callAndMeasure(address principal, address asset, address target, bytes calldata data, uint256 amount)
        internal
        returns (bytes memory result, uint256 spent)
    {
        uint256 before = _balance(asset, principal);
        uint256 value = asset == address(0) ? amount : 0;
        result = IMandateAccount(principal).executeFromExecutor(target, value, data);
        uint256 after_ = _balance(asset, principal);
        spent = before > after_ ? before - after_ : 0;
        if (spent > amount) revert SpendExceedsDeclared(spent, amount);
    }

    function _emitExecuted(
        bytes32 mandateHash,
        Mandate memory m,
        address target,
        bytes4 selector,
        uint256 amount,
        uint256 spent,
        IRiskBreaker.Phase phase
    ) internal {
        emit MandateExecuted(mandateHash, m.agentId, m.agentKey, target, selector, amount, spent, phase);
    }

    function _balance(address asset, address account) internal view returns (uint256) {
        if (asset == address(0)) return account.balance;
        return IERC20BalanceOf(asset).balanceOf(account);
    }
}
