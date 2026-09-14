// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, IMandateRegistry, IMandateExecutor, IRiskBreaker, MockVenue} from "../BaseTest.sol";

contract MandateExecutorTest is BaseTest {
    function test_execute_happyPath() public {
        (bytes32 h,) = _grantDefault();

        vm.expectEmit(true, true, true, true);
        emit IMandateExecutor.MandateExecuted(
            h, AGENT_ID, agentKey, address(venue), MockVenue.buy.selector, 100e18, 100e18, IRiskBreaker.Phase.Armed
        );
        _buy(h, 100e18);

        assertEq(asset.balanceOf(address(account)), INITIAL_BALANCE - 100e18);
        IMandateRegistry.MandateState memory s = registry.getState(h);
        assertEq(s.spent, 100e18);
        assertEq(s.spentThisBlock, 100e18);
        assertEq(s.lastBlock, block.number);
        assertEq(registry.remainingSpend(h), SPEND_CAP - 100e18);
    }

    function test_execute_onlyAgentKey() public {
        (bytes32 h,) = _grantDefault();
        address impostor = makeAddr("impostor");
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(IMandateExecutor.NotAgentKey.selector, impostor, agentKey));
        executor.execute(h, address(venue), _buyData(1e18), 1e18);
    }

    /// Property 1: lifetime cap.
    function test_execute_enforcesLifetimeCap() public {
        (bytes32 h,) = _grantDefault();
        _buy(h, 200e18);
        vm.roll(block.number + 1);
        _buy(h, 200e18);
        vm.roll(block.number + 1);
        _buy(h, 100e18); // exactly at cap
        vm.roll(block.number + 1);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.SpendCapExceeded.selector, 1, 0));
        _buy(h, 1);
        assertEq(registry.getState(h).spent, SPEND_CAP);
    }

    /// Property 1: per-block cap, resets next block.
    function test_execute_enforcesPerBlockCap() public {
        (bytes32 h,) = _grantDefault();
        _buy(h, 150e18);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.PerBlockCapExceeded.selector, 51e18, 50e18));
        _buy(h, 51e18);
        _buy(h, 50e18);
        assertEq(registry.remainingBlockSpend(h), 0);

        vm.roll(block.number + 1);
        assertEq(registry.remainingBlockSpend(h), PER_BLOCK_CAP);
        _buy(h, 200e18);
    }

    /// The declared amount is an upper bound on real outflow, measured on-chain.
    function test_execute_rejectsUnderDeclaredSpend() public {
        (bytes32 h,) = _grantDefault();
        vm.expectRevert(abi.encodeWithSelector(IMandateExecutor.SpendExceedsDeclared.selector, 20e18, 10e18));
        _exec(h, address(venue), _buyData(20e18), 10e18);
    }

    /// Property 2 through the executor.
    function test_execute_rejectsNonWhitelistedSelector() public {
        (bytes32 h,) = _grantDefault();
        vm.expectRevert(
            abi.encodeWithSelector(
                IMandateRegistry.TargetNotAllowed.selector, address(venue), MockVenue.forbidden.selector
            )
        );
        _exec(h, address(venue), abi.encodeCall(MockVenue.forbidden, ()), 0);
    }

    function test_execute_rejectsNonWhitelistedTarget() public {
        (bytes32 h,) = _grantDefault();
        MockVenue rogue = new MockVenue();
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.TargetNotAllowed.selector, address(rogue), MockVenue.noop.selector)
        );
        _exec(h, address(rogue), abi.encodeCall(MockVenue.noop, ()), 0);
    }

    function test_execute_bubblesVenueRevert() public {
        (bytes32 h,) = _grantDefault();
        vm.expectRevert(abi.encodeWithSelector(MockVenue.VenueRejected.selector, 7));
        _exec(h, address(venue), abi.encodeCall(MockVenue.fail, (7)), 0);
    }

    function test_execute_zeroSpendCallDoesNotConsumeCaps() public {
        (bytes32 h,) = _grantDefault();
        _exec(h, address(venue), abi.encodeCall(MockVenue.noop, ()), 0);
        assertEq(venue.noopCalls(), 1);
        assertEq(registry.getState(h).spent, 0);
    }

    function test_executeFor_onlySubmitter() public {
        (bytes32 h,) = _grantDefault();
        vm.prank(agentKey);
        vm.expectRevert(IMandateExecutor.NotSubmitter.selector);
        executor.executeFor(agentKey, h, address(venue), _buyData(1e18), 1e18);
    }

    function test_setSubmitter_onceAndOwnerOnly() public {
        vm.prank(deployer);
        vm.expectRevert(IMandateExecutor.AlreadyConfigured.selector);
        executor.setSubmitter(address(1));
        vm.expectRevert(IMandateExecutor.NotOwner.selector);
        executor.setSubmitter(address(1));
    }
}
