// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, Mandate, IMandateRegistry, IRiskBreaker, MockVenue} from "../BaseTest.sol";

contract RiskBreakerTest is BaseTest {
    uint256 constant MAX_DD = 2_000; // 20% trip; re-arm threshold = 10%
    bytes32 h;

    function setUp() public override {
        super.setUp();
        Mandate memory m = _defaultMandate();
        m.maxDrawdownBps = MAX_DD;
        h = _grant(m);
    }

    function _phase() internal view returns (IRiskBreaker.Phase) {
        return breaker.phaseOf(h);
    }

    function test_arm_snapshotsPeakAtGrant() public view {
        IRiskBreaker.BreakerState memory s = breaker.stateOf(h);
        assertTrue(s.initialized);
        assertEq(s.peakEquity, INITIAL_BALANCE);
        assertEq(uint8(s.phase), uint8(IRiskBreaker.Phase.Armed));
        assertEq(breaker.rearmThresholdBps(h), 1_000);
    }

    function test_arm_onlyRegistry() public {
        vm.expectRevert(IRiskBreaker.NotRegistry.selector);
        breaker.arm(h);
    }

    /// Property 4: trip on drawdown, zero executions until re-armed, hysteresis on re-arm.
    function test_fsm_tripCooldownHysteresisRearm() public {
        _buy(h, 100e18); // 10% drawdown: still armed
        assertEq(uint8(_phase()), uint8(IRiskBreaker.Phase.Armed));

        vm.roll(block.number + 1);
        vm.expectEmit(true, true, true, true);
        emit IRiskBreaker.Tripped(h, AGENT_ID, 2_500, block.number);
        _buy(h, 150e18); // 25% drawdown: this execution trips the breaker
        assertEq(uint8(_phase()), uint8(IRiskBreaker.Phase.Tripped));
        assertTrue(breaker.isTripped(h));
        assertFalse(registry.isActive(h));

        // Tripped => every execution reverts with the typed error.
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.Tripped.selector, h));
        _buy(h, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.Tripped.selector, h));
        _exec(h, address(venue), abi.encodeCall(MockVenue.noop, ()), 0);

        // Before the cooldown elapses nothing changes, even if equity fully recovers.
        venue.payout(address(asset), address(account), 250e18);
        assertEq(uint8(breaker.checkpoint(h)), uint8(IRiskBreaker.Phase.Tripped));
        venue.pull(address(asset), address(account), 250e18);

        // Cooldown reached, but drawdown (25%) is above the 10% re-arm threshold: stays blocked.
        vm.roll(block.number + COOLDOWN_BLOCKS);
        assertEq(uint8(breaker.checkpoint(h)), uint8(IRiskBreaker.Phase.Cooldown));
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.Tripped.selector, h));
        _buy(h, 1e18);

        // Recover to 15% drawdown: below the trip line but above the re-arm line -> hysteresis holds.
        venue.payout(address(asset), address(account), 100e18);
        assertEq(breaker.currentDrawdownBps(h), 1_500);
        assertEq(uint8(breaker.checkpoint(h)), uint8(IRiskBreaker.Phase.Cooldown));
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.Tripped.selector, h));
        _buy(h, 1e18);

        // Recover to 9% drawdown: re-arms and re-baselines the peak.
        venue.payout(address(asset), address(account), 60e18);
        vm.expectEmit(true, true, true, true);
        emit IRiskBreaker.Rearmed(h, 910e18, block.number);
        assertEq(uint8(breaker.checkpoint(h)), uint8(IRiskBreaker.Phase.Armed));
        assertEq(breaker.stateOf(h).peakEquity, 910e18);
        _buy(h, 1e18); // executions flow again
    }

    /// Market-driven drawdown (no mandated call involved) blocks execution and can be recorded by anyone.
    function test_liveDrawdown_blocksBeforeCheckpoint_andKeeperCanPersist() public {
        venue.pull(address(asset), address(account), 300e18); // 30% loss outside the executor
        assertEq(uint8(_phase()), uint8(IRiskBreaker.Phase.Armed)); // not yet persisted
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.Tripped.selector, h));
        _buy(h, 1e18);

        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        assertEq(uint8(breaker.checkpoint(h)), uint8(IRiskBreaker.Phase.Tripped));
        assertTrue(breaker.isTripped(h));
    }

    function test_peakRatchetsUp() public {
        venue.payout(address(asset), address(account), 1_000e18);
        breaker.checkpoint(h);
        assertEq(breaker.stateOf(h).peakEquity, 2_000e18);
        venue.pull(address(asset), address(account), 500e18); // 25% from the new peak
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.Tripped.selector, h));
        _buy(h, 1e18);
    }

    function test_resetPeak_principalOnly() public {
        venue.pull(address(asset), address(account), 300e18);
        breaker.checkpoint(h);
        assertTrue(breaker.isTripped(h));

        vm.prank(agentKey);
        vm.expectRevert(IRiskBreaker.NotPrincipal.selector);
        breaker.resetPeak(h);

        vm.prank(address(account));
        breaker.resetPeak(h);
        assertFalse(breaker.isTripped(h));
        assertEq(breaker.stateOf(h).peakEquity, 700e18);
        _buy(h, 1e18);
    }

    function test_disabledBreakerNeverTrips() public {
        Mandate memory m = _defaultMandate();
        m.maxDrawdownBps = 10_000;
        bytes32 h2 = _grant(m);
        venue.pull(address(asset), address(account), 999e18);
        assertEq(uint8(breaker.checkpoint(h2)), uint8(IRiskBreaker.Phase.Armed));
    }

    function test_checkpoint_unknownMandate() public {
        vm.expectRevert(abi.encodeWithSelector(IRiskBreaker.UnknownMandate.selector, bytes32(uint256(7))));
        breaker.checkpoint(bytes32(uint256(7)));
    }

    function test_setEquitySource_principalOnly() public {
        vm.expectRevert(IRiskBreaker.NotPrincipal.selector);
        breaker.setEquitySource(h, address(1));
        vm.prank(address(account));
        breaker.setEquitySource(h, address(0));
        assertEq(breaker.equitySourceOf(h), address(0));
    }
}
