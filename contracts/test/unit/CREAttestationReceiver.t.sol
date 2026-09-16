// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, ERC8004ReputationAdapter, IERC8004ReputationAdapter} from "../BaseTest.sol";
import {CREAttestationReceiver} from "../../src/cre/CREAttestationReceiver.sol";
import {IReceiver, IERC165} from "../../src/interfaces/ICREReceiver.sol";

contract CREAttestationReceiverTest is BaseTest {
    CREAttestationReceiver internal receiver;

    address internal forwarder = makeAddr("keystoneForwarder");
    address internal mockForwarder = makeAddr("mockKeystoneForwarder");
    address internal workflowOwner = makeAddr("workflowOwner");
    bytes32 internal constant WORKFLOW_ID = keccak256("workflow-id");
    string internal constant WORKFLOW_NAME = "mandate-reputation-attestor";
    bytes10 internal NAME;
    bytes internal META;

    function setUp() public override {
        super.setUp();
        address[] memory fwds = new address[](2);
        fwds[0] = forwarder;
        fwds[1] = mockForwarder;
        vm.startPrank(deployer);
        receiver = new CREAttestationReceiver(address(adapter), fwds);
        adapter.setAttestor(address(receiver));
        vm.stopPrank();
        NAME = receiver.workflowNameToBytes10(WORKFLOW_NAME);
        META = _metadata(WORKFLOW_ID, NAME, workflowOwner);
    }

    // ------------------------------------------------------------------ helpers

    function _attestation(uint64 windowEnd) internal pure returns (IERC8004ReputationAdapter.Attestation memory) {
        return IERC8004ReputationAdapter.Attestation({
            complianceScore: 88,
            tripCount: 1,
            executedCount: 12,
            realisedPnlBps: -340,
            windowStart: windowEnd > 3600 ? windowEnd - 3600 : 0,
            windowEnd: windowEnd,
            evidenceHash: keccak256(abi.encode("evidence", windowEnd))
        });
    }

    function _report(uint256 agentId, uint64 windowEnd) internal pure returns (bytes memory) {
        return abi.encode(agentId, _attestation(windowEnd));
    }

    function _metadata(bytes32 id, bytes10 name, address author) internal pure returns (bytes memory) {
        return abi.encodePacked(id, name, author);
    }

    function _metadata() internal view returns (bytes memory) {
        return META;
    }

    // ------------------------------------------------------------------ happy path

    function test_onReport_forwardsToAdapter() public {
        bytes memory report = _report(AGENT_ID, 10_000);
        vm.expectEmit(true, true, true, true, address(receiver));
        emit CREAttestationReceiver.ReportReceived(
            AGENT_ID,
            WORKFLOW_ID,
            workflowOwner,
            NAME,
            10_000 - 3600,
            10_000,
            keccak256(abi.encode("evidence", uint64(10_000)))
        );
        vm.prank(forwarder);
        receiver.onReport(_metadata(), report);

        assertEq(adapter.attestationCount(AGENT_ID), 1);
        IERC8004ReputationAdapter.Attestation memory got = adapter.latest(AGENT_ID);
        assertEq(got.complianceScore, 88);
        assertEq(got.tripCount, 1);
        assertEq(got.executedCount, 12);
        assertEq(got.realisedPnlBps, -340);
        assertEq(got.windowEnd, 10_000);
        assertEq(receiver.lastWindowEnd(AGENT_ID), 10_000);
        assertEq(receiver.reportCount(), 1);
        // the mirror into the ERC-8004 registry still happens, attributed to the receiver
        assertEq(repRegistry.count(), 1);
    }

    function test_onReport_bothForwardersAccepted() public {
        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));
        vm.prank(mockForwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 200));
        assertEq(adapter.attestationCount(AGENT_ID), 2);
    }

    function test_onReport_independentWindowsPerAgent() public {
        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 500));
        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID + 1, 100)); // older window, different agent: fine
        assertEq(receiver.lastWindowEnd(AGENT_ID + 1), 100);
    }

    // ------------------------------------------------------------------ gating

    function test_onReport_revertsForUntrustedSender() public {
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.UntrustedForwarder.selector, agentKey));
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));
    }

    function test_onReport_attestorPathIsTheOnlyWriter() public {
        // The old attestor (EOA) can no longer attest directly: the workflow is the single writer.
        vm.prank(attestor);
        vm.expectRevert(IERC8004ReputationAdapter.NotAttestor.selector);
        adapter.attest(AGENT_ID, _attestation(100));
    }

    function test_onReport_revertsOnStaleWindow() public {
        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 1000));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.StaleReport.selector, AGENT_ID, 1000, 1000));
        receiver.onReport(_metadata(), _report(AGENT_ID, 1000)); // replay
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.StaleReport.selector, AGENT_ID, 999, 1000));
        receiver.onReport(_metadata(), _report(AGENT_ID, 999)); // older
    }

    function test_onReport_revertsOnShortMetadata() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.MalformedMetadata.selector, 40));
        receiver.onReport(new bytes(40), _report(AGENT_ID, 100));
    }

    function test_onReport_authorCheck() public {
        vm.prank(deployer);
        receiver.setExpectedAuthor(workflowOwner);

        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));

        address impostor = makeAddr("impostor");
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.InvalidAuthor.selector, impostor, workflowOwner));
        receiver.onReport(_metadata(WORKFLOW_ID, NAME, impostor), _report(AGENT_ID, 200));
    }

    function test_onReport_nameCheckRequiresAuthor() public {
        vm.prank(deployer);
        receiver.setExpectedWorkflowName(WORKFLOW_NAME);
        vm.prank(forwarder);
        vm.expectRevert(CREAttestationReceiver.WorkflowNameRequiresAuthor.selector);
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));

        vm.prank(deployer);
        receiver.setExpectedAuthor(workflowOwner);
        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));

        bytes10 wrong = receiver.workflowNameToBytes10("someone-elses-workflow");
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.InvalidWorkflowName.selector, wrong, NAME));
        receiver.onReport(_metadata(WORKFLOW_ID, wrong, workflowOwner), _report(AGENT_ID, 200));

        // disabling the name check
        vm.prank(deployer);
        receiver.setExpectedWorkflowName("");
        assertEq(receiver.expectedWorkflowName(), bytes10(0));
        vm.prank(forwarder);
        receiver.onReport(_metadata(WORKFLOW_ID, wrong, workflowOwner), _report(AGENT_ID, 300));
    }

    function test_onReport_workflowIdCheck() public {
        vm.prank(deployer);
        receiver.setExpectedWorkflowId(WORKFLOW_ID);
        vm.prank(forwarder);
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));

        bytes32 other = keccak256("other");
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.InvalidWorkflowId.selector, other, WORKFLOW_ID));
        receiver.onReport(_metadata(other, NAME, workflowOwner), _report(AGENT_ID, 200));
    }

    function test_onReport_adapterRulesStillApply() public {
        IERC8004ReputationAdapter.Attestation memory a = _attestation(100);
        a.complianceScore = 101;
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(IERC8004ReputationAdapter.InvalidScore.selector, 101));
        receiver.onReport(_metadata(), abi.encode(AGENT_ID, a));
    }

    // ------------------------------------------------------------------ admin + helpers

    function test_admin_onlyOwner() public {
        vm.startPrank(agentKey);
        vm.expectRevert(CREAttestationReceiver.NotOwner.selector);
        receiver.setForwarder(agentKey, true);
        vm.expectRevert(CREAttestationReceiver.NotOwner.selector);
        receiver.setExpectedAuthor(agentKey);
        vm.expectRevert(CREAttestationReceiver.NotOwner.selector);
        receiver.setExpectedWorkflowName("x");
        vm.expectRevert(CREAttestationReceiver.NotOwner.selector);
        receiver.setExpectedWorkflowId(bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_setForwarder_revokes() public {
        vm.prank(deployer);
        receiver.setForwarder(mockForwarder, false);
        vm.prank(mockForwarder);
        vm.expectRevert(abi.encodeWithSelector(CREAttestationReceiver.UntrustedForwarder.selector, mockForwarder));
        receiver.onReport(_metadata(), _report(AGENT_ID, 100));
    }

    function test_constructor_rejectsZero() public {
        address[] memory fwds = new address[](1);
        fwds[0] = address(0);
        vm.expectRevert(CREAttestationReceiver.ZeroAddress.selector);
        new CREAttestationReceiver(address(adapter), fwds);
        fwds[0] = forwarder;
        vm.expectRevert(CREAttestationReceiver.ZeroAddress.selector);
        new CREAttestationReceiver(address(0), fwds);
    }

    function test_workflowNameToBytes10_matchesChainlinkTemplate() public view {
        // sha256("mandate-reputation-attestor") hex -> first 10 chars as ASCII, the ReceiverTemplate encoding.
        bytes32 h = sha256(bytes(WORKFLOW_NAME));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory expected = new bytes(10);
        for (uint256 i; i < 5; ++i) {
            expected[2 * i] = hexChars[uint8(h[i] >> 4)];
            expected[2 * i + 1] = hexChars[uint8(h[i] & 0x0f)];
        }
        assertEq(NAME, bytes10(expected));
        // every character is a hex digit
        bytes10 got = NAME;
        for (uint256 i; i < 10; ++i) {
            bytes1 c = got[i];
            assertTrue((c >= "0" && c <= "9") || (c >= "a" && c <= "f"));
        }
    }

    function test_supportsInterface() public view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
        assertEq(type(IReceiver).interfaceId, bytes4(keccak256("onReport(bytes,bytes)")));
        assertFalse(receiver.supportsInterface(0xdeadbeef));
    }

    function test_decodeReport_roundTrip() public view {
        (uint256 id, IERC8004ReputationAdapter.Attestation memory a) = receiver.decodeReport(_report(7, 900));
        assertEq(id, 7);
        assertEq(a.windowEnd, 900);
        assertEq(a.evidenceHash, keccak256(abi.encode("evidence", uint64(900))));
    }
}
