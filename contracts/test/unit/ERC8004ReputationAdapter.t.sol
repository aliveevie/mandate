// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, ERC8004ReputationAdapter, IERC8004ReputationAdapter} from "../BaseTest.sol";
import {RevertingReputationRegistry} from "../mocks/MockReputationRegistry.sol";

contract ERC8004ReputationAdapterTest is BaseTest {
    function _attestation() internal view returns (IERC8004ReputationAdapter.Attestation memory) {
        return IERC8004ReputationAdapter.Attestation({
            complianceScore: 97,
            tripCount: 1,
            executedCount: 40,
            realisedPnlBps: -120,
            windowStart: uint64(block.timestamp - 3600),
            windowEnd: uint64(block.timestamp),
            evidenceHash: keccak256("cre-inputs")
        });
    }

    /// Property 6: only the Attestor writes reputation; agents cannot self-attest.
    function test_attest_onlyAttestor() public {
        IERC8004ReputationAdapter.Attestation memory a = _attestation();
        vm.prank(agentKey);
        vm.expectRevert(IERC8004ReputationAdapter.NotAttestor.selector);
        adapter.attest(AGENT_ID, a);
        vm.prank(address(account));
        vm.expectRevert(IERC8004ReputationAdapter.NotAttestor.selector);
        adapter.attest(AGENT_ID, a);
        vm.prank(deployer); // even the owner cannot attest
        vm.expectRevert(IERC8004ReputationAdapter.NotAttestor.selector);
        adapter.attest(AGENT_ID, a);
        assertEq(adapter.attestationCount(AGENT_ID), 0);
    }

    function test_attest_storesAndMirrors() public {
        IERC8004ReputationAdapter.Attestation memory a = _attestation();
        vm.prank(attestor);
        vm.expectEmit(true, true, true, true);
        emit IERC8004ReputationAdapter.ReputationAttested(
            AGENT_ID, attestor, 97, 1, 40, -120, a.windowStart, a.windowEnd, a.evidenceHash, true
        );
        adapter.attest(AGENT_ID, a);

        assertEq(adapter.attestationCount(AGENT_ID), 1);
        IERC8004ReputationAdapter.Attestation memory got = adapter.latest(AGENT_ID);
        assertEq(got.complianceScore, 97);
        assertEq(got.evidenceHash, a.evidenceHash);
        assertEq(adapter.attestationAt(AGENT_ID, 0).executedCount, 40);

        assertEq(repRegistry.count(), 1);
        (address from, uint256 agentId, int128 value, uint8 dec, string memory tag1, bytes32 fh) =
            repRegistry.feedbacks(0);
        assertEq(from, address(adapter));
        assertEq(agentId, AGENT_ID);
        assertEq(value, 97);
        assertEq(dec, 0);
        assertEq(tag1, "mandate-compliance");
        assertEq(fh, a.evidenceHash);
    }

    function test_attest_validation() public {
        IERC8004ReputationAdapter.Attestation memory a = _attestation();
        a.complianceScore = 101;
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(IERC8004ReputationAdapter.InvalidScore.selector, 101));
        adapter.attest(AGENT_ID, a);

        a = _attestation();
        a.windowEnd = a.windowStart;
        vm.prank(attestor);
        vm.expectRevert(
            abi.encodeWithSelector(IERC8004ReputationAdapter.InvalidWindow.selector, a.windowStart, a.windowEnd)
        );
        adapter.attest(AGENT_ID, a);
    }

    function test_attest_mirrorFailureDoesNotLoseAttestation() public {
        RevertingReputationRegistry bad = new RevertingReputationRegistry();
        vm.prank(deployer);
        adapter.setReputationRegistry(address(bad));

        IERC8004ReputationAdapter.Attestation memory a = _attestation();
        vm.prank(attestor);
        vm.expectEmit(true, false, false, true);
        emit IERC8004ReputationAdapter.MirrorFailed(
            AGENT_ID, abi.encodeWithSelector(RevertingReputationRegistry.Nope.selector)
        );
        adapter.attest(AGENT_ID, a);
        assertEq(adapter.attestationCount(AGENT_ID), 1);
    }

    function test_attest_withoutRegistryStillRecords() public {
        vm.prank(deployer);
        adapter.setReputationRegistry(address(0));
        vm.prank(attestor);
        adapter.attest(AGENT_ID, _attestation());
        assertEq(adapter.attestationCount(AGENT_ID), 1);
        assertEq(repRegistry.count(), 0);
    }

    function test_admin_ownerOnly() public {
        vm.prank(agentKey);
        vm.expectRevert(IERC8004ReputationAdapter.NotOwner.selector);
        adapter.setAttestor(agentKey);
        vm.prank(deployer);
        vm.expectRevert(IERC8004ReputationAdapter.ZeroAddress.selector);
        adapter.setAttestor(address(0));
        vm.prank(deployer);
        adapter.setAttestor(agentKey);
        assertEq(adapter.attestor(), agentKey);
    }
}
