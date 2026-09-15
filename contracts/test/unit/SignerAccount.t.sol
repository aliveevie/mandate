// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, Mandate, IMandateRegistry, MockVenue} from "../BaseTest.sol";
import {SignerAccount} from "../../src/SignerAccount.sol";
import {ISignerAccount} from "../../src/interfaces/ISignerAccount.sol";

/// @notice The ECDSA-owned account: an embedded wallet or EOA is the principal's key, owner actions are EIP-712.
contract SignerAccountTest is BaseTest {
    SignerAccount acct;
    address owner;
    uint256 ownerPk;

    function setUp() public override {
        super.setUp();
        (owner, ownerPk) = makeAddrAndKey("embeddedWallet");
        acct = new SignerAccount(owner, address(registry), address(executor));
        asset.mint(address(acct), INITIAL_BALANCE);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mandateFor(address principal) internal view returns (Mandate memory m) {
        m = _defaultMandate();
        m.principal = principal;
        m.nonce = registry.nonces(principal);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(ISignerAccount.ZeroAddress.selector);
        new SignerAccount(address(0), address(registry), address(executor));
    }

    function test_isValidSignature_ownerOnly() public {
        bytes32 h = keccak256("x");
        assertEq(acct.isValidSignature(h, _sign(ownerPk, h)), bytes4(0x1626ba7e));
        (, uint256 otherPk) = makeAddrAndKey("other");
        assertEq(acct.isValidSignature(h, _sign(otherPk, h)), bytes4(0xffffffff));
    }

    /// The owner signs the Mandate as EIP-712 typed data of the registry; the account validates it for grant.
    function test_grant_withTypedDataSignature_andAgentExecutes() public {
        vm.prank(address(acct));
        asset.approve(address(venue), type(uint256).max);

        Mandate memory m = _mandateFor(address(acct));
        bytes32 h = registry.grant(m, _sign(ownerPk, registry.digest(m)));
        assertTrue(registry.isActive(h));

        _buy(h, 50e18);
        assertEq(asset.balanceOf(address(acct)), INITIAL_BALANCE - 50e18);
        assertEq(registry.getState(h).spent, 50e18);
    }

    function test_execute_typedData_andNonceReplay() public {
        ISignerAccount.Call memory c = ISignerAccount.Call({
            target: address(asset),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(venue), 1e18)
        });
        bytes32 d = acct.executeDigest(c, 0);
        // digest is EIP-712: \x19\x01 || domainSeparator || structHash
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce)"),
                c.target,
                c.value,
                keccak256(c.data),
                uint256(0)
            )
        );
        assertEq(d, keccak256(abi.encodePacked("\x19\x01", acct.domainSeparator(), structHash)));

        bytes memory sig = _sign(ownerPk, d);
        acct.execute(c, sig);
        assertEq(asset.allowance(address(acct), address(venue)), 1e18);
        assertEq(acct.nonce(), 1);
        vm.expectRevert(ISignerAccount.InvalidSignature.selector);
        acct.execute(c, sig);
    }

    function test_revoke_typedData_isImmediate() public {
        vm.prank(address(acct));
        asset.approve(address(venue), type(uint256).max);
        Mandate memory m = _mandateFor(address(acct));
        bytes32 h = registry.grant(m, _sign(ownerPk, registry.digest(m)));
        _buy(h, 10e18);

        bytes memory sig = _sign(ownerPk, acct.revokeDigest(h, acct.nonce()));
        acct.revokeMandate(h, sig);
        vm.expectRevert(abi.encodeWithSelector(IMandateRegistry.MandateRevoked.selector, h));
        _buy(h, 1e18);
    }

    function test_revoke_rejectsStranger() public {
        Mandate memory m = _mandateFor(address(acct));
        bytes32 h = registry.grant(m, _sign(ownerPk, registry.digest(m)));
        (, uint256 otherPk) = makeAddrAndKey("stranger");
        bytes memory sig = _sign(otherPk, acct.revokeDigest(h, 0));
        vm.expectRevert(ISignerAccount.InvalidSignature.selector);
        acct.revokeMandate(h, sig);
    }

    function test_executeFromExecutor_onlyExecutor() public {
        vm.expectRevert(ISignerAccount.NotExecutor.selector);
        acct.executeFromExecutor(address(venue), 0, "");
    }

    function test_domainSeparator_bindsChainAndAccount() public {
        bytes32 before = acct.domainSeparator();
        vm.chainId(999);
        assertTrue(acct.domainSeparator() != before);
    }
}
