// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReceiver, IERC165} from "../interfaces/ICREReceiver.sol";
import {IERC8004ReputationAdapter} from "../interfaces/IERC8004ReputationAdapter.sol";

/// @title CREAttestationReceiver
/// @notice The onchain identity of the `mandate-reputation-attestor` Chainlink CRE workflow. It is the adapter's
///         Attestor: the only address that can write reputation. Reports arrive through the KeystoneForwarder,
///         which has already verified the DON's signatures; this contract verifies *which* workflow signed
///         (forwarder allow-list, workflow owner, workflow name, workflow id), rejects stale windows, decodes the
///         payload and forwards it to `ERC8004ReputationAdapter.attest`.
/// @dev Report payload: `abi.encode(uint256 agentId, IERC8004ReputationAdapter.Attestation a)`.
///      Metadata: `abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)` (62 bytes).
contract CREAttestationReceiver is IReceiver {
    // ------------------------------------------------------------------ errors
    error NotOwner();
    error ZeroAddress();
    error UntrustedForwarder(address sender);
    error MalformedMetadata(uint256 length);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error WorkflowNameRequiresAuthor();
    error StaleReport(uint256 agentId, uint64 windowEnd, uint64 lastWindowEnd);

    // ------------------------------------------------------------------ events
    event ForwarderSet(address indexed forwarder, bool trusted);
    event ExpectedAuthorSet(address author);
    event ExpectedWorkflowNameSet(bytes10 name);
    event ExpectedWorkflowIdSet(bytes32 id);
    event ReportReceived(
        uint256 indexed agentId,
        bytes32 indexed workflowId,
        address indexed workflowOwner,
        bytes10 workflowName,
        uint64 windowStart,
        uint64 windowEnd,
        bytes32 evidenceHash
    );

    // ------------------------------------------------------------------ storage
    address public immutable owner;
    IERC8004ReputationAdapter public immutable adapter;

    /// @notice Forwarders allowed to deliver reports. Monad testnet has two: the production KeystoneForwarder and the
    ///         MockKeystoneForwarder used by `cre workflow simulate --broadcast`.
    mapping(address forwarder => bool trusted) public forwarders;
    /// @notice If set, only reports authored by this workflow owner are accepted.
    address public expectedAuthor;
    /// @notice If set (requires `expectedAuthor`), only reports from this workflow name are accepted.
    bytes10 public expectedWorkflowName;
    /// @notice If set, only reports from this exact workflow id are accepted.
    bytes32 public expectedWorkflowId;
    /// @notice Newest attested window per agent; a report must strictly advance it (stale-report discard).
    mapping(uint256 agentId => uint64 windowEnd) public lastWindowEnd;
    uint256 public reportCount;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address adapter_, address[] memory forwarders_) {
        if (adapter_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        adapter = IERC8004ReputationAdapter(adapter_);
        for (uint256 i; i < forwarders_.length; ++i) {
            if (forwarders_[i] == address(0)) revert ZeroAddress();
            forwarders[forwarders_[i]] = true;
            emit ForwarderSet(forwarders_[i], true);
        }
    }

    // ------------------------------------------------------------------ IReceiver

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (!forwarders[msg.sender]) revert UntrustedForwarder(msg.sender);

        (bytes32 workflowId, bytes10 workflowName, address workflowOwner) = decodeMetadata(metadata);
        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }
        if (expectedAuthor != address(0) && workflowOwner != expectedAuthor) {
            revert InvalidAuthor(workflowOwner, expectedAuthor);
        }
        if (expectedWorkflowName != bytes10(0)) {
            // Names are only unique per owner and are 40-bit truncated, so a name check is meaningless without an
            // author check. Enforced at runtime, exactly like Chainlink's ReceiverTemplate.
            if (expectedAuthor == address(0)) revert WorkflowNameRequiresAuthor();
            if (workflowName != expectedWorkflowName) revert InvalidWorkflowName(workflowName, expectedWorkflowName);
        }

        (uint256 agentId, IERC8004ReputationAdapter.Attestation memory a) = decodeReport(report);
        uint64 last = lastWindowEnd[agentId];
        if (a.windowEnd <= last) revert StaleReport(agentId, a.windowEnd, last);
        lastWindowEnd[agentId] = a.windowEnd;
        unchecked {
            ++reportCount;
        }

        adapter.attest(agentId, a);
        emit ReportReceived(
            agentId, workflowId, workflowOwner, workflowName, a.windowStart, a.windowEnd, a.evidenceHash
        );
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ------------------------------------------------------------------ admin

    function setForwarder(address forwarder, bool trusted) external onlyOwner {
        if (forwarder == address(0)) revert ZeroAddress();
        forwarders[forwarder] = trusted;
        emit ForwarderSet(forwarder, trusted);
    }

    /// @param author Workflow owner address; `address(0)` disables the check (and therefore the name check).
    function setExpectedAuthor(address author) external onlyOwner {
        expectedAuthor = author;
        emit ExpectedAuthorSet(author);
    }

    /// @param name Plaintext workflow name (as in `workflow.yaml`); empty string disables the check.
    function setExpectedWorkflowName(string calldata name) external onlyOwner {
        bytes10 encoded = bytes(name).length == 0 ? bytes10(0) : workflowNameToBytes10(name);
        expectedWorkflowName = encoded;
        emit ExpectedWorkflowNameSet(encoded);
    }

    function setExpectedWorkflowId(bytes32 id) external onlyOwner {
        expectedWorkflowId = id;
        emit ExpectedWorkflowIdSet(id);
    }

    // ------------------------------------------------------------------ pure helpers

    /// @notice The forwarder's `bytes10` workflow name: the first 10 hex characters of `sha256(name)`, as ASCII.
    function workflowNameToBytes10(string memory name) public pure returns (bytes10 out) {
        bytes32 h = sha256(bytes(name));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory buf = new bytes(10);
        for (uint256 i; i < 5; ++i) {
            buf[2 * i] = hexChars[uint8(h[i] >> 4)];
            buf[2 * i + 1] = hexChars[uint8(h[i] & 0x0f)];
        }
        assembly {
            out := mload(add(buf, 32))
        }
    }

    function decodeMetadata(bytes calldata metadata)
        public
        pure
        returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    {
        if (metadata.length < 62) revert MalformedMetadata(metadata.length);
        workflowId = bytes32(metadata[0:32]);
        workflowName = bytes10(metadata[32:42]);
        workflowOwner = address(bytes20(metadata[42:62]));
    }

    function decodeReport(bytes calldata report)
        public
        pure
        returns (uint256 agentId, IERC8004ReputationAdapter.Attestation memory a)
    {
        (agentId, a) = abi.decode(report, (uint256, IERC8004ReputationAdapter.Attestation));
    }
}
