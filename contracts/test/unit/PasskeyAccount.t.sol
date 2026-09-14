// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, IPasskeyAccount, MockERC20} from "../BaseTest.sol";

contract PasskeyAccountTest is BaseTest {
    bytes4 constant MAGIC = 0x1626ba7e;

    function test_isValidSignature_acceptsOwnerPasskey() public view {
        bytes32 h = keccak256("challenge");
        assertEq(account.isValidSignature(h, _webauthnSign(PRINCIPAL_PK, h)), MAGIC);
    }

    function test_isValidSignature_rejectsOtherKey() public view {
        bytes32 h = keccak256("challenge");
        assertEq(account.isValidSignature(h, _webauthnSign(STRANGER_PK, h)), bytes4(0xffffffff));
    }

    function test_isValidSignature_rejectsWrongChallenge() public view {
        bytes memory sig = _webauthnSign(PRINCIPAL_PK, keccak256("a"));
        assertEq(account.isValidSignature(keccak256("b"), sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_requiresUserVerificationFlag() public view {
        bytes32 h = keccak256("challenge");
        // UP only (0x01): valid P256 signature, but UV bit is missing -> rejected.
        assertEq(account.isValidSignature(h, _webauthnSignWithFlags(PRINCIPAL_PK, h, 0x01)), bytes4(0xffffffff));
    }

    function test_isValidSignature_rejectsGarbageWithoutReverting() public view {
        assertEq(account.isValidSignature(keccak256("x"), hex"deadbeef"), bytes4(0xffffffff));
        assertEq(account.isValidSignature(keccak256("x"), ""), bytes4(0xffffffff));
    }

    function test_execute_withPasskey_andNonceReplayProtection() public {
        address to = makeAddr("to");
        IPasskeyAccount.Call memory c = IPasskeyAccount.Call({
            target: address(asset), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", to, 5e18)
        });
        bytes memory sig = _webauthnSign(PRINCIPAL_PK, account.executeDigest(c, 0));
        account.execute(c, sig);
        assertEq(asset.balanceOf(to), 5e18);
        assertEq(account.nonce(), 1);

        vm.expectRevert(IPasskeyAccount.InvalidSignature.selector);
        account.execute(c, sig); // same signature cannot be replayed
    }

    function test_execute_rejectsStrangerSignature() public {
        IPasskeyAccount.Call memory c = IPasskeyAccount.Call({target: address(venue), value: 0, data: ""});
        bytes memory sig = _webauthnSign(STRANGER_PK, account.executeDigest(c, 0));
        vm.expectRevert(IPasskeyAccount.InvalidSignature.selector);
        account.execute(c, sig);
    }

    function test_executeFromExecutor_onlyExecutor() public {
        vm.expectRevert(IPasskeyAccount.NotExecutor.selector);
        account.executeFromExecutor(address(venue), 0, "");
        vm.prank(agentKey);
        vm.expectRevert(IPasskeyAccount.NotExecutor.selector);
        account.executeFromExecutor(address(venue), 0, "");
    }

    function test_grantMandate_forwardsToRegistry() public {
        (bytes32 expected,) = (registry.hashMandate(_defaultMandate()), 0);
        bytes32 h = account.grantMandate(_defaultMandate(), _signMandate(_defaultMandate()));
        assertEq(h, expected);
        assertTrue(registry.exists(h));
    }
}
