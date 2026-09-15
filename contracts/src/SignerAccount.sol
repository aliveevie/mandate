// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {Mandate} from "./libraries/MandateLib.sol";
import {ISignerAccount} from "./interfaces/ISignerAccount.sol";
import {IMandateRegistry} from "./interfaces/IMandateRegistry.sol";

/// @title SignerAccount
/// @notice A mandate account owned by a secp256k1 signer: an EOA, an embedded wallet, or an ERC-1271 contract.
///         Owner actions are EIP-712 typed data (domain `MandateAccount` v1, verifying contract = this account),
///         so any wallet can sign them without raw-hash signing, and signing policies can scope a delegated
///         signer to exactly this account and the registry. Same execution surface as `PasskeyAccount`.
contract SignerAccount is ISignerAccount {
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_FAIL = 0xffffffff;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("MandateAccount");
    bytes32 internal constant VERSION_HASH = keccak256("1");
    bytes32 internal constant EXECUTE_TYPEHASH =
        keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce)");
    bytes32 internal constant REVOKE_TYPEHASH = keccak256("Revoke(bytes32 mandateHash,uint256 nonce)");

    address public immutable override owner;
    address public immutable override registry;
    address public immutable override executor;

    uint256 public override nonce;

    constructor(address owner_, address registry_, address executor_) {
        if (owner_ == address(0) || registry_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        owner = owner_;
        registry = registry_;
        executor = executor_;
    }

    receive() external payable {}

    // ------------------------------------------------------------------ ERC-1271

    /// @notice Valid when `owner` signed `hash` (ECDSA, or ERC-1271 if the owner is a contract).
    ///         The registry passes the EIP-712 mandate digest, so an owner signs the Mandate as typed data.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        return SignatureCheckerLib.isValidSignatureNowCalldata(owner, hash, signature) ? ERC1271_MAGIC : ERC1271_FAIL;
    }

    // ------------------------------------------------------------------ EIP-712

    function domainSeparator() public view override returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function executeDigest(Call calldata call, uint256 nonce_) public view override returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(EXECUTE_TYPEHASH, call.target, call.value, keccak256(call.data), nonce_));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function revokeDigest(bytes32 mandateHash, uint256 nonce_) public view override returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, mandateHash, nonce_));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ owner actions

    /// @inheritdoc ISignerAccount
    function execute(Call calldata call, bytes calldata signature) external override returns (bytes memory) {
        bytes32 d = executeDigest(call, nonce++);
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(owner, d, signature)) revert InvalidSignature();
        emit Executed(call.target, call.value, call.data);
        return _call(call.target, call.value, call.data);
    }

    /// @inheritdoc ISignerAccount
    function grantMandate(Mandate memory mandate, bytes calldata signature) external override returns (bytes32) {
        return IMandateRegistry(registry).grant(mandate, signature);
    }

    /// @inheritdoc ISignerAccount
    function revokeMandate(bytes32 mandateHash, bytes calldata signature) external override {
        bytes32 d = revokeDigest(mandateHash, nonce++);
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(owner, d, signature)) revert InvalidSignature();
        emit MandateRevokeRequested(mandateHash);
        IMandateRegistry(registry).revoke(mandateHash);
    }

    // ------------------------------------------------------------------ mandate execution hook

    /// @notice Trusted executor hook: performs a mandated call from this account.
    function executeFromExecutor(address target, uint256 value, bytes calldata data)
        external
        override
        returns (bytes memory)
    {
        if (msg.sender != executor) revert NotExecutor();
        emit ExecutedFromMandate(target, value, data);
        return _call(target, value, data);
    }

    function _call(address target, uint256 value, bytes memory data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}
