// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Optional per-mandate valuation hook. Default equity is the principal's raw `asset` balance.
interface IEquitySource {
    function equityOf(address principal, address asset) external view returns (uint256);
}

/// @title IRiskBreaker
/// @notice Hysteresis drawdown breaker. Armed -> Tripped when drawdown from peak equity exceeds
///         `maxDrawdownBps`; Tripped -> Cooldown after `cooldownBlocks`; Cooldown -> Armed only once
///         drawdown falls back under a re-arm threshold that is strictly lower than the trip threshold.
interface IRiskBreaker {
    enum Phase {
        Armed,
        Tripped,
        Cooldown
    }

    struct BreakerState {
        Phase phase;
        bool initialized;
        uint256 peakEquity;
        uint256 lastEquity;
        uint256 lastDrawdownBps;
        uint256 trippedAtBlock;
    }

    error NotRegistry();
    error NotPrincipal();
    error UnknownMandate(bytes32 mandateHash);
    error AlreadyArmed(bytes32 mandateHash);
    error InvalidRearmFactor(uint256 rearmFactorBps);

    event Armed(bytes32 indexed mandateHash, uint256 peakEquity);
    event Tripped(bytes32 indexed mandateHash, uint256 indexed agentId, uint256 drawdownBps, uint256 blockNumber);
    event CooldownEntered(bytes32 indexed mandateHash, uint256 blockNumber);
    event Rearmed(bytes32 indexed mandateHash, uint256 peakEquity, uint256 blockNumber);
    event PeakReset(bytes32 indexed mandateHash, uint256 peakEquity);
    event EquitySourceSet(bytes32 indexed mandateHash, address source);

    function registry() external view returns (address);
    function cooldownBlocks() external view returns (uint256);
    function rearmFactorBps() external view returns (uint256);

    /// @notice Registry hook at grant time: snapshots peak equity and arms the breaker.
    function arm(bytes32 mandateHash) external;

    /// @notice Permissionless. Observes current equity and advances the FSM. Returns the resulting phase.
    function checkpoint(bytes32 mandateHash) external returns (Phase);

    /// @notice Principal escape hatch: re-baseline peak equity to current and force Armed.
    function resetPeak(bytes32 mandateHash) external;

    /// @notice Principal-only: plug a valuation adapter for this mandate (address(0) = raw balance).
    function setEquitySource(bytes32 mandateHash, address source) external;

    function isTripped(bytes32 mandateHash) external view returns (bool);
    function phaseOf(bytes32 mandateHash) external view returns (Phase);
    function stateOf(bytes32 mandateHash) external view returns (BreakerState memory);
    function equityOf(bytes32 mandateHash) external view returns (uint256);
    function currentDrawdownBps(bytes32 mandateHash) external view returns (uint256);
    function rearmThresholdBps(bytes32 mandateHash) external view returns (uint256);
    function equitySourceOf(bytes32 mandateHash) external view returns (address);
}
