// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    BaseTest,
    Mandate,
    MandateRegistry,
    RiskBreaker,
    MandateExecutor,
    IMandateRegistry,
    MockVenue
} from "../BaseTest.sol";

contract MandateRegistryTest is BaseTest {
    function test_grant_storesMandateAndBumpsNonce() public {
        Mandate memory m = _defaultMandate();
        bytes32 expected = registry.hashMandate(m);

        vm.expectEmit(true, true, true, true);
        emit IMandateRegistry.MandateGranted(expected, address(account), AGENT_ID, agentKey, m);
        bytes32 h = _grant(m);

        assertEq(h, expected);
        assertEq(registry.nonces(address(account)), 1);
        assertTrue(registry.isActive(h));
        Mandate memory stored = registry.getMandate(h);
        assertEq(stored.spendCap, SPEND_CAP);
        assertEq(stored.targets.length, 3);
        assertEq(registry.remainingSpend(h), SPEND_CAP);
        assertEq(registry.remainingBlockSpend(h), PER_BLOCK_CAP);
    }

    function test_grant_rejectsWrongSigner() public {
        Mandate memory m = _defaultMandate();
        bytes memory sig = _webauthnSign(STRANGER_PK, registry.digest(m));
        vm.expectRevert(IMandateRegistry.InvalidSignature.selector);
        registry.grant(m, sig);
    }

    function test_grant_rejectsTamperedMandate() public {
        Mandate memory m = _defaultMandate();
        bytes memory sig = _signMandate(m);
        m.spendCap = SPEND_CAP * 10;
        vm.expectRevert(IMandateRegistry.InvalidSignature.selector);
        registry.grant(m, sig);
    }

    function test_grant_rejectsNonceReuse() public {
        Mandate memory m = _defaultMandate();
        _grant(m);
        m.policyHash = keccak256("other"); // different hash, same nonce
        bytes memory sig = _signMandate(m);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.InvalidNonce.selector, 1, 0));
        registry.grant(m, sig);
    }

    /// Property 5: signature is bound to chainId.
    function test_grant_replayAcrossChainsFails() public {
        Mandate memory m = _defaultMandate();
        bytes memory sig = _signMandate(m);
        vm.chainId(999);
        vm.expectRevert(IMandateRegistry.InvalidSignature.selector);
        registry.grant(m, sig);
        vm.chainId(31337);
        registry.grant(m, sig); // sanity: valid again on the original chain
    }

    /// Property 5: signature is bound to the verifying registry.
    function test_grant_replayAcrossRegistriesFails() public {
        vm.startPrank(deployer);
        MandateRegistry other = new MandateRegistry();
        RiskBreaker otherBreaker = new RiskBreaker(address(other), COOLDOWN_BLOCKS, REARM_FACTOR_BPS);
        MandateExecutor otherExecutor = new MandateExecutor(address(other), address(otherBreaker));
        other.configure(address(otherExecutor), address(otherBreaker));
        vm.stopPrank();

        Mandate memory m = _defaultMandate();
        bytes memory sig = _signMandate(m); // signed for `registry`
        vm.expectRevert(IMandateRegistry.InvalidSignature.selector);
        other.grant(m, sig);
    }

    function test_grant_supportsEoaPrincipalViaEcdsa() public {
        (address eoa, uint256 pk) = makeAddrAndKey("eoaPrincipal");
        Mandate memory m = _defaultMandate();
        m.principal = eoa;
        m.nonce = 0;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.digest(m));
        bytes32 h = registry.grant(m, abi.encodePacked(r, s, v));
        assertEq(registry.getMandate(h).principal, eoa);
    }

    function test_grant_inputValidation() public {
        Mandate memory m = _defaultMandate();
        m.selectors = new bytes4[](1);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.InvalidMandate.selector, "targets/selectors length"));
        registry.grant(m, "");

        m = _defaultMandate();
        m.validUntil = m.validAfter;
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.InvalidMandate.selector, "validUntil <= validAfter"));
        registry.grant(m, "");

        m = _defaultMandate();
        m.maxDrawdownBps = 10_001;
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.InvalidMandate.selector, "maxDrawdownBps > 10000"));
        registry.grant(m, "");
    }

    // ------------------------------------------------------------------ validate: typed errors

    /// Property 2: non-whitelisted target / selector.
    function test_validate_targetNotAllowed() public {
        (bytes32 h,) = _grantDefault();
        address other = makeAddr("otherVenue");
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.TargetNotAllowed.selector, other, MockVenue.buy.selector)
        );
        registry.validate(h, other, MockVenue.buy.selector, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IMandateRegistry.TargetNotAllowed.selector, address(venue), MockVenue.forbidden.selector
            )
        );
        registry.validate(h, address(venue), MockVenue.forbidden.selector, 0);
    }

    function test_validate_spendCapExceeded() public {
        (bytes32 h,) = _grantDefault();
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.SpendCapExceeded.selector, SPEND_CAP + 1, SPEND_CAP));
        registry.validate(h, address(venue), MockVenue.buy.selector, SPEND_CAP + 1);
    }

    function test_validate_perBlockCapExceeded() public {
        (bytes32 h,) = _grantDefault();
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.PerBlockCapExceeded.selector, PER_BLOCK_CAP + 1, PER_BLOCK_CAP)
        );
        registry.validate(h, address(venue), MockVenue.buy.selector, PER_BLOCK_CAP + 1);
    }

    function test_validate_timeWindow() public {
        Mandate memory m = _defaultMandate();
        m.validAfter = uint64(block.timestamp + 100);
        m.validUntil = uint64(block.timestamp + 200);
        bytes32 h = _grant(m);

        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateNotYetValid.selector, m.validAfter));
        registry.validate(h, address(venue), MockVenue.noop.selector, 0);

        vm.warp(block.timestamp + 150);
        registry.validate(h, address(venue), MockVenue.noop.selector, 0);

        vm.warp(block.timestamp + 100);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateExpired.selector, m.validUntil));
        registry.validate(h, address(venue), MockVenue.noop.selector, 0);
        assertFalse(registry.isActive(h));
    }

    function test_validate_unknownMandate() public {
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateNotFound.selector, bytes32(uint256(1))));
        registry.validate(bytes32(uint256(1)), address(venue), MockVenue.noop.selector, 0);
    }

    // ------------------------------------------------------------------ revoke

    /// Property 3: revocation is immediate, in the same block.
    function test_revoke_viaPasskey_isImmediate() public {
        (bytes32 h,) = _grantDefault();
        _buy(h, 10e18);

        vm.expectEmit(true, true, true, true);
        emit IMandateRegistry.Revoked(h, address(account), AGENT_ID);
        _revokeWithPasskey(h);

        assertFalse(registry.isActive(h));
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateRevoked.selector, h));
        _buy(h, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateRevoked.selector, h));
        registry.validate(h, address(venue), MockVenue.noop.selector, 0);
    }

    function test_revoke_onlyPrincipal() public {
        (bytes32 h,) = _grantDefault();
        vm.prank(agentKey);
        vm.expectRevert(IMandateRegistry.NotPrincipal.selector);
        registry.revoke(h);
        vm.prank(deployer);
        vm.expectRevert(IMandateRegistry.NotPrincipal.selector);
        registry.revoke(h);
    }

    function test_revoke_twiceReverts() public {
        (bytes32 h,) = _grantDefault();
        vm.prank(address(account));
        registry.revoke(h);
        vm.prank(address(account));
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateRevoked.selector, h));
        registry.revoke(h);
    }

    // ------------------------------------------------------------------ access control / config

    function test_recordExecution_onlyExecutor() public {
        (bytes32 h,) = _grantDefault();
        vm.prank(agentKey);
        vm.expectRevert(IMandateRegistry.NotExecutor.selector);
        registry.recordExecution(h, 1);
    }

    function test_configure_onceOnly() public {
        vm.prank(deployer);
        vm.expectRevert(IMandateRegistry.AlreadyConfigured.selector);
        registry.configure(address(1), address(2));
        vm.expectRevert(IMandateRegistry.NotOwner.selector);
        registry.configure(address(1), address(2));
    }

    function test_domainSeparator_matchesSpec() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Mandate"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        assertEq(registry.DOMAIN_SEPARATOR(), expected);
    }
}
