// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {RiskBreaker} from "../src/modules/RiskBreaker.sol";
import {MandateExecutor} from "../src/execution/MandateExecutor.sol";
import {PrivateSubmitter} from "../src/execution/PrivateSubmitter.sol";
import {ERC8004ReputationAdapter} from "../src/adapters/ERC8004ReputationAdapter.sol";
import {IPrivateSubmit} from "../src/interfaces/IPrivateSubmit.sol";
import {Addresses} from "./Addresses.sol";

/// @notice Deploys the Mandate core. Signer comes from the CLI (`--account` / `--keystore` / `--private-key`). Env:
///   ERC8004_REPUTATION_REGISTRY  optional; defaults to the canonical registry for the chain (Addresses.sol)
///   ATTESTOR                     optional; defaults to the deployer (swap to the CRE identity later)
///   SUBMITTER_MODE               0 = BTX (default), 1 = CommitReveal
///   BREAKER_COOLDOWN_BLOCKS      default 50
///   BREAKER_REARM_FACTOR_BPS     default 5000
///   REVEAL_WINDOW_BLOCKS         default 256
contract Deploy is Script {
    function run() external {
        address deployer = msg.sender;
        address repRegistry = vm.envOr("ERC8004_REPUTATION_REGISTRY", Addresses.erc8004Reputation(block.chainid));
        address attestor = vm.envOr("ATTESTOR", deployer);
        uint256 modeRaw = vm.envOr("SUBMITTER_MODE", uint256(0));
        uint256 cooldown = vm.envOr("BREAKER_COOLDOWN_BLOCKS", uint256(50));
        uint256 rearm = vm.envOr("BREAKER_REARM_FACTOR_BPS", uint256(5_000));
        uint256 window = vm.envOr("REVEAL_WINDOW_BLOCKS", uint256(256));

        vm.startBroadcast();
        MandateRegistry registry = new MandateRegistry();
        RiskBreaker breaker = new RiskBreaker(address(registry), cooldown, rearm);
        MandateExecutor executor = new MandateExecutor(address(registry), address(breaker));
        registry.configure(address(executor), address(breaker));
        PrivateSubmitter submitter = new PrivateSubmitter(
            address(executor), modeRaw == 1 ? IPrivateSubmit.Mode.CommitReveal : IPrivateSubmit.Mode.BTX, window
        );
        executor.setSubmitter(address(submitter));
        ERC8004ReputationAdapter adapter = new ERC8004ReputationAdapter(repRegistry, attestor);
        vm.stopBroadcast();

        console2.log("MANDATE_REGISTRY=", address(registry));
        console2.log("RISK_BREAKER=", address(breaker));
        console2.log("MANDATE_EXECUTOR=", address(executor));
        console2.log("PRIVATE_SUBMITTER=", address(submitter));
        console2.log("SUBMITTER_MODE=", modeRaw == 1 ? "CommitReveal" : "BTX");
        console2.log("ERC8004_REPUTATION_ADAPTER=", address(adapter));
        console2.log("ATTESTOR=", attestor);
    }
}
