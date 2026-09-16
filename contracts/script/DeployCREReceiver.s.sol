// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Addresses} from "./Addresses.sol";
import {CREAttestationReceiver} from "../src/cre/CREAttestationReceiver.sol";
import {IERC8004ReputationAdapter} from "../src/interfaces/IERC8004ReputationAdapter.sol";

/// @notice Deploys the CRE attestation receiver and hands it the Attestor role, making the
///         `mandate-reputation-attestor` workflow the only writer of reputation. Env:
///   ERC8004_REPUTATION_ADAPTER   required
///   CRE_FORWARDER                optional; defaults to the KeystoneForwarder for the chain (Addresses.sol)
///   CRE_MOCK_FORWARDER           optional; defaults to the MockKeystoneForwarder for the chain (simulation)
///   CRE_TRUST_MOCK_FORWARDER     optional bool, default true (set false for a production-only receiver)
///   CRE_WORKFLOW_OWNER           optional; if set, only reports authored by this address are accepted
///   CRE_WORKFLOW_NAME            optional; requires CRE_WORKFLOW_OWNER; defaults to "" (no name check)
///   SKIP_SET_ATTESTOR            optional bool, default false
contract DeployCREReceiver is Script {
    function run() external {
        IERC8004ReputationAdapter adapter = IERC8004ReputationAdapter(vm.envAddress("ERC8004_REPUTATION_ADAPTER"));
        address forwarder = vm.envOr("CRE_FORWARDER", Addresses.creForwarder(block.chainid));
        address mockForwarder = vm.envOr("CRE_MOCK_FORWARDER", Addresses.creMockForwarder(block.chainid));
        bool trustMock = vm.envOr("CRE_TRUST_MOCK_FORWARDER", true);
        address workflowOwner = vm.envOr("CRE_WORKFLOW_OWNER", address(0));
        string memory workflowName = vm.envOr("CRE_WORKFLOW_NAME", string(""));
        bool skipSetAttestor = vm.envOr("SKIP_SET_ATTESTOR", false);
        require(forwarder != address(0), "no CRE forwarder for this chain");

        uint256 n = (trustMock && mockForwarder != address(0)) ? 2 : 1;
        address[] memory forwarders = new address[](n);
        forwarders[0] = forwarder;
        if (n == 2) forwarders[1] = mockForwarder;

        vm.startBroadcast();
        CREAttestationReceiver receiver = new CREAttestationReceiver(address(adapter), forwarders);
        if (workflowOwner != address(0)) {
            receiver.setExpectedAuthor(workflowOwner);
            if (bytes(workflowName).length != 0) receiver.setExpectedWorkflowName(workflowName);
        }
        if (!skipSetAttestor && adapter.owner() == msg.sender && adapter.attestor() != address(receiver)) {
            adapter.setAttestor(address(receiver));
        }
        vm.stopBroadcast();

        console2.log("CRE_ATTESTATION_RECEIVER=", address(receiver));
        console2.log("forwarder            ", forwarder);
        if (n == 2) console2.log("mock forwarder       ", mockForwarder);
        console2.log("expected author      ", workflowOwner);
        console2.log("adapter.attestor()   ", adapter.attestor());
        console2.log("attestor is receiver ", adapter.attestor() == address(receiver));
    }
}
