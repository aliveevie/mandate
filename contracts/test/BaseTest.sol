// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

import {Mandate, MandateLib} from "../src/libraries/MandateLib.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {PasskeyAccount} from "../src/PasskeyAccount.sol";
import {RiskBreaker} from "../src/modules/RiskBreaker.sol";
import {MandateExecutor} from "../src/execution/MandateExecutor.sol";
import {PrivateSubmitter} from "../src/execution/PrivateSubmitter.sol";
import {ERC8004ReputationAdapter} from "../src/adapters/ERC8004ReputationAdapter.sol";
import {IMandateRegistry} from "../src/interfaces/IMandateRegistry.sol";
import {IMandateExecutor} from "../src/interfaces/IMandateExecutor.sol";
import {IRiskBreaker} from "../src/interfaces/IRiskBreaker.sol";
import {IPrivateSubmit} from "../src/interfaces/IPrivateSubmit.sol";
import {IPasskeyAccount} from "../src/interfaces/IPasskeyAccount.sol";
import {IERC8004ReputationAdapter} from "../src/interfaces/IERC8004ReputationAdapter.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockVenue} from "./mocks/MockVenue.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @notice Shared harness: full protocol deployment, a passkey principal, an agent, a mock venue,
///         and a WebAuthn signer that produces real P256 assertions verified through the 0x100 precompile.
abstract contract BaseTest is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    uint256 internal constant COOLDOWN_BLOCKS = 10;
    uint256 internal constant REARM_FACTOR_BPS = 5_000; // re-arm at half the trip drawdown
    uint256 internal constant REVEAL_WINDOW = 256;

    uint256 internal constant PRINCIPAL_PK = 0x5EED0000000000000000000000000000000000000000000000000000000000A1;
    uint256 internal constant STRANGER_PK = 0x5EED0000000000000000000000000000000000000000000000000000000000B2;

    uint256 internal constant INITIAL_BALANCE = 1_000e18;
    uint256 internal constant SPEND_CAP = 500e18;
    uint256 internal constant PER_BLOCK_CAP = 200e18;
    uint256 internal constant AGENT_ID = 42;

    MockERC20 internal asset;
    MockVenue internal venue;
    MockReputationRegistry internal repRegistry;

    MandateRegistry internal registry;
    RiskBreaker internal breaker;
    MandateExecutor internal executor;
    PrivateSubmitter internal submitter;
    ERC8004ReputationAdapter internal adapter;
    PasskeyAccount internal account;

    address internal agentKey = makeAddr("agentKey");
    address internal attestor = makeAddr("attestor");
    address internal deployer = makeAddr("deployer");

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        vm.roll(1_000);

        asset = new MockERC20();
        venue = new MockVenue();
        repRegistry = new MockReputationRegistry();

        vm.startPrank(deployer);
        registry = new MandateRegistry();
        breaker = new RiskBreaker(address(registry), COOLDOWN_BLOCKS, REARM_FACTOR_BPS);
        executor = new MandateExecutor(address(registry), address(breaker));
        registry.configure(address(executor), address(breaker));
        submitter = new PrivateSubmitter(address(executor), IPrivateSubmit.Mode.CommitReveal, REVEAL_WINDOW);
        executor.setSubmitter(address(submitter));
        adapter = new ERC8004ReputationAdapter(address(repRegistry), attestor);
        vm.stopPrank();

        (uint256 x, uint256 y) = vm.publicKeyP256(PRINCIPAL_PK);
        account = new PasskeyAccount(bytes32(x), bytes32(y), address(registry), address(executor));

        asset.mint(address(account), INITIAL_BALANCE);
        asset.mint(address(venue), INITIAL_BALANCE); // venue inventory for simulated gains
        vm.prank(address(account));
        asset.approve(address(venue), type(uint256).max);
        vm.deal(address(account), 10 ether);
    }

    // ------------------------------------------------------------------ mandate helpers

    function _defaultMandate() internal view returns (Mandate memory m) {
        address[] memory targets = new address[](3);
        bytes4[] memory selectors = new bytes4[](3);
        targets[0] = address(venue);
        selectors[0] = MockVenue.buy.selector;
        targets[1] = address(venue);
        selectors[1] = MockVenue.noop.selector;
        targets[2] = address(venue);
        selectors[2] = MockVenue.fail.selector;
        m = Mandate({
            principal: address(account),
            agentId: AGENT_ID,
            agentKey: agentKey,
            targets: targets,
            selectors: selectors,
            asset: address(asset),
            spendCap: SPEND_CAP,
            perBlockCap: PER_BLOCK_CAP,
            maxDrawdownBps: MandateLib.BPS, // breaker disabled unless a test lowers it
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 days),
            nonce: registry.nonces(address(account)),
            policyHash: keccak256("policy")
        });
    }

    function _signMandate(Mandate memory m) internal view returns (bytes memory) {
        return _webauthnSign(PRINCIPAL_PK, registry.digest(m));
    }

    function _grant(Mandate memory m) internal returns (bytes32) {
        return registry.grant(m, _signMandate(m));
    }

    function _grantDefault() internal returns (bytes32, Mandate memory) {
        Mandate memory m = _defaultMandate();
        return (_grant(m), m);
    }

    function _buyData(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(MockVenue.buy, (address(asset), amount));
    }

    function _exec(bytes32 h, address target, bytes memory data, uint256 amount) internal returns (bytes memory) {
        vm.prank(agentKey);
        return executor.execute(h, target, data, amount);
    }

    function _buy(bytes32 h, uint256 amount) internal returns (bytes memory) {
        return _exec(h, address(venue), _buyData(amount), amount);
    }

    function _revokeWithPasskey(bytes32 h) internal {
        bytes memory sig = _webauthnSign(PRINCIPAL_PK, account.revokeDigest(h, account.nonce()));
        account.revokeMandate(h, sig);
    }

    // ------------------------------------------------------------------ WebAuthn signer

    function _webauthnSign(uint256 pk, bytes32 challenge) internal pure returns (bytes memory) {
        return _webauthnSignWithFlags(pk, challenge, 0x05); // UP | UV
    }

    function _webauthnSignWithFlags(uint256 pk, bytes32 challenge, bytes1 flags) internal pure returns (bytes memory) {
        string memory challengeB64 = Base64.encode(abi.encodePacked(challenge), true, true);
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            challengeB64,
            '","origin":"https://mandate.local","crossOrigin":false}'
        );
        bytes memory authenticatorData = abi.encodePacked(keccak256("rpIdHash:mandate.local"), flags, uint32(1));
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, messageHash);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        WebAuthn.WebAuthnAuth memory auth = WebAuthn.WebAuthnAuth({
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON,
            challengeIndex: 23,
            typeIndex: 1,
            r: r,
            s: s
        });
        return abi.encode(auth);
    }
}
