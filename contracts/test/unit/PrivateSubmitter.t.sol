// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, PrivateSubmitter, IPrivateSubmit, IMandateExecutor, MandateExecutor} from "../BaseTest.sol";

contract PrivateSubmitterTest is BaseTest {
    bytes32 constant SALT = keccak256("salt");

    function test_mode() public view {
        assertEq(uint8(submitter.mode()), uint8(IPrivateSubmit.Mode.CommitReveal));
        assertEq(submitter.executor(), address(executor));
    }

    function test_commitReveal_flow() public {
        (bytes32 h,) = _grantDefault();
        bytes memory data = _buyData(50e18);
        bytes32 c = submitter.commitmentOf(agentKey, h, address(venue), data, 50e18, SALT);

        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IPrivateSubmit.CommitNotFound.selector, c));
        submitter.reveal(h, address(venue), data, 50e18, SALT);

        vm.prank(agentKey);
        submitter.commit(c);
        assertEq(submitter.commits(c), block.number);

        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IPrivateSubmit.RevealTooEarly.selector, block.number, block.number));
        submitter.reveal(h, address(venue), data, 50e18, SALT);

        vm.roll(block.number + 1);
        vm.prank(agentKey);
        submitter.reveal(h, address(venue), data, 50e18, SALT);
        assertEq(asset.balanceOf(address(account)), INITIAL_BALANCE - 50e18);
        assertEq(registry.getState(h).spent, 50e18);

        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IPrivateSubmit.CommitNotFound.selector, c)); // consumed
        submitter.reveal(h, address(venue), data, 50e18, SALT);
    }

    function test_commit_duplicateReverts() public {
        vm.prank(agentKey);
        submitter.commit(bytes32(uint256(1)));
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IPrivateSubmit.CommitAlreadyExists.selector, bytes32(uint256(1))));
        submitter.commit(bytes32(uint256(1)));
    }

    function test_reveal_expires() public {
        (bytes32 h,) = _grantDefault();
        bytes memory data = _buyData(1e18);
        bytes32 c = submitter.commitmentOf(agentKey, h, address(venue), data, 1e18, SALT);
        vm.prank(agentKey);
        submitter.commit(c);
        uint256 committed = block.number;
        vm.roll(committed + REVEAL_WINDOW + 1);
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IPrivateSubmit.RevealExpired.selector, committed, block.number));
        submitter.reveal(h, address(venue), data, 1e18, SALT);
    }

    function test_reveal_bindsToCommitter() public {
        (bytes32 h,) = _grantDefault();
        bytes memory data = _buyData(1e18);
        address other = makeAddr("other");
        bytes32 c = submitter.commitmentOf(other, h, address(venue), data, 1e18, SALT);
        vm.prank(other);
        submitter.commit(c);
        vm.roll(block.number + 1);
        // Even with a valid commit, the executor still enforces agentKey.
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IMandateExecutor.NotAgentKey.selector, other, agentKey));
        submitter.reveal(h, address(venue), data, 1e18, SALT);
    }

    function test_btxMode_directSubmission() public {
        vm.startPrank(deployer);
        MandateExecutor exec2 = new MandateExecutor(address(registry), address(breaker));
        PrivateSubmitter btx = new PrivateSubmitter(address(exec2), IPrivateSubmit.Mode.BTX, 0);
        exec2.setSubmitter(address(btx));
        vm.stopPrank();
        assertEq(uint8(btx.mode()), uint8(IPrivateSubmit.Mode.BTX));

        vm.expectRevert(IPrivateSubmit.CommitNotRequired.selector);
        btx.commit(bytes32(uint256(1)));

        // A BTX-mode submitter still goes through the executor; here exec2 is not the registry's executor,
        // so the account rejects it. This proves the submitter cannot bypass the account's executor binding.
        (bytes32 h,) = _grantDefault();
        vm.prank(agentKey);
        vm.expectRevert();
        btx.reveal(h, address(venue), _buyData(1e18), 1e18, SALT);
    }
}
