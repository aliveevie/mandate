// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {Mandate} from "../src/libraries/MandateLib.sol";
import {PasskeyAccount} from "../src/PasskeyAccount.sol";
import {IPasskeyAccount} from "../src/interfaces/IPasskeyAccount.sol";
import {IMandateRegistry} from "../src/interfaces/IMandateRegistry.sol";
import {IMandateExecutor} from "../src/interfaces/IMandateExecutor.sol";
import {IRiskBreaker} from "../src/interfaces/IRiskBreaker.sol";
import {IERC8004ReputationAdapter} from "../src/interfaces/IERC8004ReputationAdapter.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockVenue} from "../test/mocks/MockVenue.sol";

/// @notice Live end-to-end flow against deployed contracts:
///         passkey account -> approve venue (passkey tx) -> grant mandate (passkey sig) -> agent executes
///         -> out-of-bounds typed revert -> breaker trips -> execution blocked -> passkey revoke -> attestation.
///         Env: MANDATE_REGISTRY, MANDATE_EXECUTOR, RISK_BREAKER, ERC8004_REPUTATION_ADAPTER, E2E_P256_PK (optional).
contract E2E is Script {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    IMandateRegistry registry;
    IMandateExecutor executor;
    IRiskBreaker breaker;
    IERC8004ReputationAdapter adapter;
    uint256 passkeyPk;

    function run() external {
        registry = IMandateRegistry(vm.envAddress("MANDATE_REGISTRY"));
        executor = IMandateExecutor(vm.envAddress("MANDATE_EXECUTOR"));
        breaker = IRiskBreaker(vm.envAddress("RISK_BREAKER"));
        adapter = IERC8004ReputationAdapter(vm.envAddress("ERC8004_REPUTATION_ADAPTER"));
        // Demo passkey. A real deployment never sees this key: it lives in the user's authenticator.
        passkeyPk = vm.envOr("E2E_P256_PK", uint256(keccak256("mandate-e2e-demo-passkey")) % P256_N);
        address agent = msg.sender; // the deployer EOA plays the agent key

        vm.startBroadcast();

        // 1. Venue + asset + passkey account
        MockERC20 asset = new MockERC20();
        MockVenue venue = new MockVenue();
        (uint256 x, uint256 y) = vm.publicKeyP256(passkeyPk);
        PasskeyAccount account = new PasskeyAccount(bytes32(x), bytes32(y), address(registry), address(executor));
        asset.mint(address(account), 1_000e18);
        asset.mint(address(venue), 1_000e18);
        console2.log("asset            ", address(asset));
        console2.log("venue            ", address(venue));
        console2.log("passkey account  ", address(account));

        // 2. Passkey-authorised owner tx: approve the venue
        IPasskeyAccount.Call memory approveCall = IPasskeyAccount.Call({
            target: address(asset),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(venue), type(uint256).max)
        });
        account.execute(approveCall, _webauthnSign(account.executeDigest(approveCall, account.nonce())));
        console2.log("passkey execute  ok (approve)");

        // 3. Grant a mandate signed by the passkey
        Mandate memory m = _mandate(address(account), agent, address(venue), address(asset));
        bytes32 h = registry.grant(m, _webauthnSign(registry.digest(m)));
        console2.log("mandate granted  ");
        console2.logBytes32(h);

        // 4. Agent executes within bounds (10% drawdown, still armed)
        executor.execute(h, address(venue), abi.encodeCall(MockVenue.buy, (address(asset), 100e18)), 100e18);
        console2.log("agent execute    ok, spent", registry.getState(h).spent / 1e18);

        vm.stopBroadcast();

        // 5. Out-of-bounds call -> typed revert (what the SDK sees before sending)
        _expectTyped(
            h,
            address(venue),
            MockVenue.forbidden.selector,
            0,
            IMandateRegistry.TargetNotAllowed.selector,
            "TargetNotAllowed"
        );
        _expectTyped(
            h,
            address(venue),
            MockVenue.buy.selector,
            501e18,
            IMandateRegistry.SpendCapExceeded.selector,
            "SpendCapExceeded"
        );

        vm.startBroadcast();

        // 6. Drawdown crosses 20% -> this execution trips the breaker (Tripped event in the receipt)
        executor.execute(h, address(venue), abi.encodeCall(MockVenue.buy, (address(asset), 150e18)), 150e18);
        console2.log("breaker phase    ", uint8(breaker.phaseOf(h)), "(1 = Tripped)");

        vm.stopBroadcast();

        // 7. Agent is frozen
        _expectTyped(h, address(venue), MockVenue.buy.selector, 1e18, IMandateRegistry.Tripped.selector, "Tripped");

        vm.startBroadcast();

        // 8. Principal revokes with the passkey
        account.revokeMandate(h, _webauthnSign(account.revokeDigest(h, account.nonce())));
        console2.log("revoked          ", !registry.isActive(h));

        // 9. Attestor writes reputation (deployer is the initial attestor)
        adapter.attest(
            m.agentId,
            IERC8004ReputationAdapter.Attestation({
                complianceScore: 90,
                tripCount: 1,
                executedCount: 2,
                realisedPnlBps: -2500,
                windowStart: uint64(block.timestamp - 600),
                windowEnd: uint64(block.timestamp),
                evidenceHash: keccak256(abi.encode(h, uint256(2), uint256(1)))
            })
        );
        console2.log("attestations     ", adapter.attestationCount(m.agentId));

        vm.stopBroadcast();

        _expectTyped(
            h, address(venue), MockVenue.noop.selector, 0, IMandateRegistry.MandateRevoked.selector, "MandateRevoked"
        );
        console2.log("E2E OK");
    }

    function _mandate(address principal, address agent, address venue, address asset)
        internal
        view
        returns (Mandate memory m)
    {
        address[] memory targets = new address[](2);
        bytes4[] memory selectors = new bytes4[](2);
        targets[0] = venue;
        selectors[0] = MockVenue.buy.selector;
        targets[1] = venue;
        selectors[1] = MockVenue.noop.selector;
        m = Mandate({
            principal: principal,
            agentId: 1,
            agentKey: agent,
            targets: targets,
            selectors: selectors,
            asset: asset,
            spendCap: 500e18,
            perBlockCap: 300e18,
            maxDrawdownBps: 2_000,
            validAfter: uint64(block.timestamp - 60),
            validUntil: uint64(block.timestamp + 7 days),
            nonce: registry.nonces(principal),
            policyHash: keccak256("e2e-policy")
        });
    }

    function _expectTyped(bytes32 h, address target, bytes4 sel, uint256 amount, bytes4 expected, string memory name)
        internal
        view
    {
        (bool ok, bytes memory ret) = address(registry)
            .staticcall(abi.encodeWithSelector(IMandateRegistry.validate.selector, h, target, sel, amount));
        require(!ok && ret.length >= 4 && bytes4(ret) == expected, string.concat("expected ", name));
        console2.log("typed revert     ", name);
    }

    function _webauthnSign(bytes32 challenge) internal view returns (bytes memory) {
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encode(abi.encodePacked(challenge), true, true),
            '","origin":"https://mandate.local","crossOrigin":false}'
        );
        bytes memory authenticatorData = abi.encodePacked(keccak256("rpIdHash:mandate.local"), bytes1(0x05), uint32(1));
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPk, messageHash);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        return abi.encode(WebAuthn.WebAuthnAuth(authenticatorData, clientDataJSON, 23, 1, r, s));
    }
}
