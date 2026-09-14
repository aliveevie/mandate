// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Mandate, MandateLib} from "../libraries/MandateLib.sol";
import {IRiskBreaker, IEquitySource} from "../interfaces/IRiskBreaker.sol";
import {IMandateRegistry} from "../interfaces/IMandateRegistry.sol";

interface IERC20BalanceOf {
    function balanceOf(address) external view returns (uint256);
}

/// @title RiskBreaker
/// @notice Hysteresis drawdown FSM per mandate.
///         Armed  -> Tripped   : drawdown from peak > mandate.maxDrawdownBps
///         Tripped -> Cooldown : at least `cooldownBlocks` since the trip
///         Cooldown -> Armed   : drawdown <= maxDrawdownBps * rearmFactorBps / 10_000 (strictly lower than trip)
///         Tripped and Cooldown both block execution. `checkpoint` is permissionless so keepers / the CRE
///         workflow can record trips caused by market moves, not only by mandated calls.
contract RiskBreaker is IRiskBreaker {
    address public immutable override registry;
    uint256 public immutable override cooldownBlocks;
    uint256 public immutable override rearmFactorBps;

    mapping(bytes32 mandateHash => BreakerState) internal _states;
    mapping(bytes32 mandateHash => address) public override equitySourceOf;

    constructor(address registry_, uint256 cooldownBlocks_, uint256 rearmFactorBps_) {
        if (rearmFactorBps_ >= MandateLib.BPS) revert InvalidRearmFactor(rearmFactorBps_);
        registry = registry_;
        cooldownBlocks = cooldownBlocks_;
        rearmFactorBps = rearmFactorBps_;
    }

    // ------------------------------------------------------------------ registry hook

    /// @inheritdoc IRiskBreaker
    function arm(bytes32 mandateHash) external override {
        if (msg.sender != registry) revert NotRegistry();
        BreakerState storage s = _states[mandateHash];
        if (s.initialized) revert AlreadyArmed(mandateHash);
        Mandate memory m = IMandateRegistry(registry).getMandate(mandateHash);
        uint256 eq = _equity(mandateHash, m);
        s.initialized = true;
        s.phase = Phase.Armed;
        s.peakEquity = eq;
        s.lastEquity = eq;
        emit Armed(mandateHash, eq);
    }

    // ------------------------------------------------------------------ FSM

    /// @inheritdoc IRiskBreaker
    function checkpoint(bytes32 mandateHash) external override returns (Phase) {
        BreakerState storage s = _states[mandateHash];
        if (!s.initialized) revert UnknownMandate(mandateHash);
        Mandate memory m = IMandateRegistry(registry).getMandate(mandateHash);
        uint256 eq = _equity(mandateHash, m);

        if (s.phase == Phase.Armed) {
            if (eq > s.peakEquity) s.peakEquity = eq;
            uint256 dd = _drawdownBps(s.peakEquity, eq);
            s.lastDrawdownBps = dd;
            if (dd > m.maxDrawdownBps) {
                s.phase = Phase.Tripped;
                s.trippedAtBlock = block.number;
                emit Tripped(mandateHash, m.agentId, dd, block.number);
            }
        } else {
            if (s.phase == Phase.Tripped && block.number >= s.trippedAtBlock + cooldownBlocks) {
                s.phase = Phase.Cooldown;
                emit CooldownEntered(mandateHash, block.number);
            }
            uint256 dd = _drawdownBps(s.peakEquity, eq);
            s.lastDrawdownBps = dd;
            if (s.phase == Phase.Cooldown && dd <= _rearmThreshold(m.maxDrawdownBps)) {
                s.phase = Phase.Armed;
                s.peakEquity = eq;
                emit Rearmed(mandateHash, eq, block.number);
            }
        }
        s.lastEquity = eq;
        return s.phase;
    }

    /// @inheritdoc IRiskBreaker
    function resetPeak(bytes32 mandateHash) external override {
        BreakerState storage s = _states[mandateHash];
        if (!s.initialized) revert UnknownMandate(mandateHash);
        Mandate memory m = IMandateRegistry(registry).getMandate(mandateHash);
        if (msg.sender != m.principal) revert NotPrincipal();
        uint256 eq = _equity(mandateHash, m);
        s.phase = Phase.Armed;
        s.peakEquity = eq;
        s.lastEquity = eq;
        s.lastDrawdownBps = 0;
        emit PeakReset(mandateHash, eq);
    }

    /// @inheritdoc IRiskBreaker
    function setEquitySource(bytes32 mandateHash, address source) external override {
        Mandate memory m = IMandateRegistry(registry).getMandate(mandateHash);
        if (msg.sender != m.principal) revert NotPrincipal();
        equitySourceOf[mandateHash] = source;
        emit EquitySourceSet(mandateHash, source);
    }

    // ------------------------------------------------------------------ views

    function isTripped(bytes32 mandateHash) external view override returns (bool) {
        BreakerState storage s = _states[mandateHash];
        return s.initialized && s.phase != Phase.Armed;
    }

    function phaseOf(bytes32 mandateHash) external view override returns (Phase) {
        return _states[mandateHash].phase;
    }

    function stateOf(bytes32 mandateHash) external view override returns (BreakerState memory) {
        return _states[mandateHash];
    }

    function equityOf(bytes32 mandateHash) external view override returns (uint256) {
        return _equity(mandateHash, IMandateRegistry(registry).getMandate(mandateHash));
    }

    /// @notice Live drawdown versus the stored peak. Zero for unknown mandates.
    function currentDrawdownBps(bytes32 mandateHash) external view override returns (uint256) {
        BreakerState storage s = _states[mandateHash];
        if (!s.initialized) return 0;
        uint256 eq = _equity(mandateHash, IMandateRegistry(registry).getMandate(mandateHash));
        return _drawdownBps(s.peakEquity, eq);
    }

    function rearmThresholdBps(bytes32 mandateHash) external view override returns (uint256) {
        return _rearmThreshold(IMandateRegistry(registry).getMandate(mandateHash).maxDrawdownBps);
    }

    // ------------------------------------------------------------------ internal

    function _rearmThreshold(uint256 maxDrawdownBps) internal view returns (uint256) {
        return maxDrawdownBps * rearmFactorBps / MandateLib.BPS;
    }

    function _drawdownBps(uint256 peak, uint256 eq) internal pure returns (uint256) {
        if (peak == 0 || eq >= peak) return 0;
        return (peak - eq) * MandateLib.BPS / peak;
    }

    function _equity(bytes32 mandateHash, Mandate memory m) internal view returns (uint256) {
        address src = equitySourceOf[mandateHash];
        if (src != address(0)) return IEquitySource(src).equityOf(m.principal, m.asset);
        if (m.asset == address(0)) return m.principal.balance;
        return IERC20BalanceOf(m.asset).balanceOf(m.principal);
    }
}
