// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Addresses} from "./Addresses.sol";
import {IERC8004IdentityRegistry, IERC8004ReputationRegistry} from "../src/interfaces/IERC8004.sol";
import {IERC8004ReputationAdapter} from "../src/interfaces/IERC8004ReputationAdapter.sol";

/// @notice Wires the deployed adapter to the canonical ERC-8004 registries, registers a demo agent identity,
///         and writes one attestation through the adapter to prove the mirror lands in the Reputation Registry.
///         Env: ERC8004_REPUTATION_ADAPTER, optional AGENT_URI, optional ERC8004_AGENT_ID (skip registration).
contract SetupERC8004 is Script {
    function run() external {
        IERC8004ReputationAdapter adapter = IERC8004ReputationAdapter(vm.envAddress("ERC8004_REPUTATION_ADAPTER"));
        IERC8004IdentityRegistry identity = IERC8004IdentityRegistry(Addresses.erc8004Identity(block.chainid));
        IERC8004ReputationRegistry reputation = IERC8004ReputationRegistry(Addresses.erc8004Reputation(block.chainid));
        require(address(identity) != address(0), "no ERC-8004 registries for this chain");
        require(reputation.getIdentityRegistry() == address(identity), "registry pair mismatch");

        string memory agentURI = vm.envOr("AGENT_URI", string("https://mandate.ibxlab.xyz/agents/demo.json"));
        uint256 agentId = vm.envOr("ERC8004_AGENT_ID", uint256(0));

        vm.startBroadcast();

        if (adapter.reputationRegistry() != address(reputation)) {
            adapter.setReputationRegistry(address(reputation));
            console2.log("adapter.reputationRegistry set to", address(reputation));
        }

        if (agentId == 0) {
            agentId = identity.register(agentURI);
            console2.log("registered ERC-8004 agent, agentId", agentId);
        }
        console2.log("agent owner", identity.ownerOf(agentId));

        adapter.attest(
            agentId,
            IERC8004ReputationAdapter.Attestation({
                complianceScore: 100,
                tripCount: 0,
                executedCount: 0,
                realisedPnlBps: 0,
                windowStart: uint64(block.timestamp - 60),
                windowEnd: uint64(block.timestamp),
                evidenceHash: keccak256(abi.encode("bootstrap", agentId, block.chainid))
            })
        );

        vm.stopBroadcast();

        address[] memory clients = new address[](1);
        clients[0] = address(adapter);
        (uint64 count, int128 value, uint8 dec) = reputation.getSummary(agentId, clients, "mandate-compliance", "");
        console2.log("ERC-8004 summary for agent", agentId);
        console2.log("  feedback count", count);
        console2.log("  summary value ", uint256(int256(value)), "decimals", dec);
        console2.log("  local attestations", adapter.attestationCount(agentId));
    }
}
