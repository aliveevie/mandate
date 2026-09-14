// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {RiskBreaker} from "../src/modules/RiskBreaker.sol";
import {MandateExecutor} from "../src/execution/MandateExecutor.sol";
import {PrivateSubmitter} from "../src/execution/PrivateSubmitter.sol";
import {ERC8004ReputationAdapter} from "../src/adapters/ERC8004ReputationAdapter.sol";
import {IPrivateSubmit} from "../src/interfaces/IPrivateSubmit.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockVenue} from "../test/mocks/MockVenue.sol";
import {MockReputationRegistry} from "../test/mocks/MockReputationRegistry.sol";

/// @notice Local (anvil) fixture for SDK integration tests: full protocol + mock asset, venue and
///         ERC-8004 reputation registry. Writes addresses to deployments/local.json.
contract LocalFixture is Script {
    function run() external {
        vm.startBroadcast();
        MandateRegistry registry = new MandateRegistry();
        RiskBreaker breaker = new RiskBreaker(address(registry), 5, 5_000);
        MandateExecutor executor = new MandateExecutor(address(registry), address(breaker));
        registry.configure(address(executor), address(breaker));
        PrivateSubmitter submitter = new PrivateSubmitter(address(executor), IPrivateSubmit.Mode.CommitReveal, 256);
        executor.setSubmitter(address(submitter));
        MockReputationRegistry rep = new MockReputationRegistry();
        ERC8004ReputationAdapter adapter = new ERC8004ReputationAdapter(address(rep), msg.sender);
        MockERC20 asset = new MockERC20();
        MockVenue venue = new MockVenue();
        asset.mint(address(venue), 1_000_000e18);
        vm.stopBroadcast();

        string memory j = "fixture";
        vm.serializeAddress(j, "registry", address(registry));
        vm.serializeAddress(j, "breaker", address(breaker));
        vm.serializeAddress(j, "executor", address(executor));
        vm.serializeAddress(j, "submitter", address(submitter));
        vm.serializeAddress(j, "reputationAdapter", address(adapter));
        vm.serializeAddress(j, "erc8004Reputation", address(rep));
        vm.serializeAddress(j, "asset", address(asset));
        string memory out = vm.serializeAddress(j, "venue", address(venue));
        vm.writeJson(out, "deployments/local.json");
        console2.log(out);
    }
}
