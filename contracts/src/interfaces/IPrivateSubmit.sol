// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPrivateSubmit
/// @notice Private execution path for mandated calls. One interface, two deploy-time modes:
///         - BTX: the agent sends `reveal` straight through Monad's BTX encrypted mempool; no commit needed.
///         - CommitReveal: `commit(hash)` then `reveal(calldata)` at least one block later.
interface IPrivateSubmit {
    enum Mode {
        BTX,
        CommitReveal
    }

    error CommitNotRequired();
    error CommitAlreadyExists(bytes32 commitment);
    error CommitNotFound(bytes32 commitment);
    error RevealTooEarly(uint256 commitBlock, uint256 currentBlock);
    error RevealExpired(uint256 commitBlock, uint256 currentBlock);

    event Committed(bytes32 indexed commitment, address indexed agentKey, uint256 blockNumber);
    event Revealed(bytes32 indexed commitment, bytes32 indexed mandateHash, address indexed agentKey);

    function mode() external view returns (Mode);
    function executor() external view returns (address);
    function revealWindow() external view returns (uint256);
    function commits(bytes32 commitment) external view returns (uint256 commitBlock);

    function commitmentOf(
        address agentKey,
        bytes32 mandateHash,
        address target,
        bytes calldata data,
        uint256 amount,
        bytes32 salt
    ) external pure returns (bytes32);

    function commit(bytes32 commitment) external;

    function reveal(bytes32 mandateHash, address target, bytes calldata data, uint256 amount, bytes32 salt)
        external
        returns (bytes memory result);
}
