// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {Mandate, MandateLib} from "./libraries/MandateLib.sol";
import {IMandateRegistry} from "./interfaces/IMandateRegistry.sol";
import {IRiskBreaker} from "./interfaces/IRiskBreaker.sol";

/// @title MandateRegistry
/// @notice Source of truth for mandates: grant (signature-verified), revoke (principal-only, immediate),
///         validate (typed reverts) and spend accounting (executor-only). Nonce per principal, replay-safe,
///         signature bound to chainId + this contract via EIP-712.
contract MandateRegistry is IMandateRegistry {
    using MandateLib for Mandate;

    address public immutable override owner;
    address public override executor;
    address public override breaker;

    mapping(address principal => uint256) public override nonces;
    mapping(bytes32 mandateHash => Mandate) internal _mandates;
    mapping(bytes32 mandateHash => MandateState) internal _states;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ------------------------------------------------------------------ config

    /// @notice One-shot wiring of the executor and breaker (they need this address at construction).
    function configure(address executor_, address breaker_) external override onlyOwner {
        if (executor != address(0) || breaker != address(0)) revert AlreadyConfigured();
        if (executor_ == address(0) || breaker_ == address(0)) revert ZeroAddress();
        executor = executor_;
        breaker = breaker_;
        emit Configured(executor_, breaker_);
    }

    // ------------------------------------------------------------------ views

    function DOMAIN_SEPARATOR() public view override returns (bytes32) {
        return MandateLib.domainSeparator(block.chainid, address(this));
    }

    function hashMandate(Mandate memory m) public pure override returns (bytes32) {
        return m.hash();
    }

    function digest(Mandate memory m) public view override returns (bytes32) {
        return MandateLib.digest(DOMAIN_SEPARATOR(), m);
    }

    function getMandate(bytes32 mandateHash) public view override returns (Mandate memory m) {
        m = _mandates[mandateHash];
        if (m.principal == address(0)) revert MandateNotFound(mandateHash);
    }

    function getState(bytes32 mandateHash) external view override returns (MandateState memory) {
        return _states[mandateHash];
    }

    function exists(bytes32 mandateHash) public view override returns (bool) {
        return _mandates[mandateHash].principal != address(0);
    }

    function isActive(bytes32 mandateHash) external view override returns (bool) {
        Mandate storage m = _mandates[mandateHash];
        if (m.principal == address(0) || _states[mandateHash].revoked) return false;
        if (block.timestamp < m.validAfter || block.timestamp > m.validUntil) return false;
        return !IRiskBreaker(breaker).isTripped(mandateHash);
    }

    function remainingSpend(bytes32 mandateHash) public view override returns (uint256) {
        uint256 cap = _mandates[mandateHash].spendCap;
        uint256 spent = _states[mandateHash].spent;
        return cap > spent ? cap - spent : 0;
    }

    function remainingBlockSpend(bytes32 mandateHash) public view override returns (uint256) {
        uint256 cap = _mandates[mandateHash].perBlockCap;
        MandateState storage s = _states[mandateHash];
        uint256 used = s.lastBlock == block.number ? s.spentThisBlock : 0;
        return cap > used ? cap - used : 0;
    }

    /// @inheritdoc IMandateRegistry
    function validate(bytes32 mandateHash, address target, bytes4 selector, uint256 amount) public view override {
        Mandate storage m = _mandates[mandateHash];
        if (m.principal == address(0)) revert MandateNotFound(mandateHash);
        MandateState storage s = _states[mandateHash];
        if (s.revoked) revert MandateRevoked(mandateHash);
        if (block.timestamp < m.validAfter) revert MandateNotYetValid(m.validAfter);
        if (block.timestamp > m.validUntil) revert MandateExpired(m.validUntil);
        if (!_isAllowed(m, target, selector)) revert TargetNotAllowed(target, selector);

        uint256 remaining = remainingSpend(mandateHash);
        if (amount > remaining) revert SpendCapExceeded(amount, remaining);
        uint256 remainingBlock = remainingBlockSpend(mandateHash);
        if (amount > remainingBlock) revert PerBlockCapExceeded(amount, remainingBlock);

        IRiskBreaker b = IRiskBreaker(breaker);
        // Persisted trip, or a live drawdown that would trip on the next checkpoint: both block execution.
        if (b.isTripped(mandateHash) || b.currentDrawdownBps(mandateHash) > m.maxDrawdownBps) {
            revert Tripped(mandateHash);
        }
    }

    // ------------------------------------------------------------------ mutations

    /// @inheritdoc IMandateRegistry
    function grant(Mandate memory m, bytes calldata signature) external override returns (bytes32 mandateHash) {
        if (executor == address(0)) revert NotConfigured();
        if (m.principal == address(0) || m.agentKey == address(0)) revert ZeroAddress();
        if (m.targets.length == 0) revert InvalidMandate("no targets");
        if (m.targets.length != m.selectors.length) revert InvalidMandate("targets/selectors length");
        if (m.validUntil <= m.validAfter) revert InvalidMandate("validUntil <= validAfter");
        if (m.validUntil < block.timestamp) revert MandateExpired(m.validUntil);
        if (m.spendCap == 0 || m.perBlockCap == 0) revert InvalidMandate("zero cap");
        if (m.maxDrawdownBps > MandateLib.BPS) revert InvalidMandate("maxDrawdownBps > 10000");

        uint256 expectedNonce = nonces[m.principal];
        if (m.nonce != expectedNonce) revert InvalidNonce(expectedNonce, m.nonce);

        mandateHash = m.hash();
        if (_mandates[mandateHash].principal != address(0)) revert MandateAlreadyExists(mandateHash);

        // ERC-1271 for contract principals (PasskeyAccount), ECDSA for EOA principals.
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(m.principal, digest(m), signature)) {
            revert InvalidSignature();
        }

        nonces[m.principal] = expectedNonce + 1;
        _mandates[mandateHash] = m;
        _states[mandateHash].grantedAt = uint64(block.timestamp);

        IRiskBreaker(breaker).arm(mandateHash);

        emit MandateGranted(mandateHash, m.principal, m.agentId, m.agentKey, m);
    }

    /// @inheritdoc IMandateRegistry
    function revoke(bytes32 mandateHash) external override {
        Mandate storage m = _mandates[mandateHash];
        if (m.principal == address(0)) revert MandateNotFound(mandateHash);
        if (msg.sender != m.principal) revert NotPrincipal();
        MandateState storage s = _states[mandateHash];
        if (s.revoked) revert MandateRevoked(mandateHash);
        s.revoked = true;
        emit Revoked(mandateHash, m.principal, m.agentId);
    }

    /// @inheritdoc IMandateRegistry
    /// @dev Caps are re-checked here so accounting can never exceed them even if a caller skipped `validate`.
    function recordExecution(bytes32 mandateHash, uint256 spent) external override onlyExecutor {
        Mandate storage m = _mandates[mandateHash];
        if (m.principal == address(0)) revert MandateNotFound(mandateHash);
        MandateState storage s = _states[mandateHash];
        if (s.revoked) revert MandateRevoked(mandateHash);

        if (s.lastBlock != block.number) {
            s.lastBlock = block.number;
            s.spentThisBlock = 0;
        }
        uint256 remaining = m.spendCap - s.spent;
        if (spent > remaining) revert SpendCapExceeded(spent, remaining);
        uint256 remainingBlock = m.perBlockCap - s.spentThisBlock;
        if (spent > remainingBlock) revert PerBlockCapExceeded(spent, remainingBlock);

        s.spent += spent;
        s.spentThisBlock += spent;
        emit ExecutionRecorded(mandateHash, spent, s.spent, s.spentThisBlock);
    }

    // ------------------------------------------------------------------ internal

    function _isAllowed(Mandate storage m, address target, bytes4 selector) internal view returns (bool) {
        uint256 n = m.targets.length;
        for (uint256 i; i < n; ++i) {
            if (m.targets[i] == target && m.selectors[i] == selector) return true;
        }
        return false;
    }
}
