// Minimal ABIs for the Mandate contracts the workflow reads and the receiver it writes to.
// Source of truth: contracts/src (kept in sync by contracts/test + the SDK's generated ABIs).
import { parseAbi } from 'viem'

export const MandateRegistryAbi = parseAbi([
	'struct Mandate { address principal; uint256 agentId; address agentKey; address[] targets; bytes4[] selectors; address asset; uint256 spendCap; uint256 perBlockCap; uint256 maxDrawdownBps; uint64 validAfter; uint64 validUntil; uint256 nonce; bytes32 policyHash; }',
	'struct MandateState { uint256 spent; uint256 spentThisBlock; uint256 lastBlock; uint64 grantedAt; bool revoked; }',
	'function getMandate(bytes32 mandateHash) view returns (Mandate)',
	'function getState(bytes32 mandateHash) view returns (MandateState)',
	'function exists(bytes32 mandateHash) view returns (bool)',
	'event MandateGranted(bytes32 indexed mandateHash, address indexed principal, uint256 indexed agentId, address agentKey, Mandate mandate)',
	'event Revoked(bytes32 indexed mandateHash, address indexed principal, uint256 indexed agentId)',
])

export const MandateExecutorAbi = parseAbi([
	'event MandateExecuted(bytes32 indexed mandateHash, uint256 indexed agentId, address indexed agentKey, address target, bytes4 selector, uint256 declaredAmount, uint256 spent, uint8 phaseAfter)',
])

export const RiskBreakerAbi = parseAbi([
	'struct BreakerState { uint8 phase; bool initialized; uint256 peakEquity; uint256 lastEquity; uint256 lastDrawdownBps; uint256 trippedAtBlock; }',
	'function stateOf(bytes32 mandateHash) view returns (BreakerState)',
	'function equityOf(bytes32 mandateHash) view returns (uint256)',
	'function currentDrawdownBps(bytes32 mandateHash) view returns (uint256)',
	'event Tripped(bytes32 indexed mandateHash, uint256 indexed agentId, uint256 drawdownBps, uint256 blockNumber)',
	'event Rearmed(bytes32 indexed mandateHash, uint256 peakEquity, uint256 blockNumber)',
])

export const ReputationAdapterAbi = parseAbi([
	'struct Attestation { uint8 complianceScore; uint32 tripCount; uint32 executedCount; int256 realisedPnlBps; uint64 windowStart; uint64 windowEnd; bytes32 evidenceHash; }',
	'function attestor() view returns (address)',
	'function attestationCount(uint256 agentId) view returns (uint256)',
	'function latest(uint256 agentId) view returns (Attestation)',
	'function attestationAt(uint256 agentId, uint256 index) view returns (Attestation)',
])

export const ReceiverAbi = parseAbi([
	'function lastWindowEnd(uint256 agentId) view returns (uint64)',
	'function forwarders(address forwarder) view returns (bool)',
])

/** `abi.encode(uint256 agentId, Attestation a)` — exactly what CREAttestationReceiver.decodeReport expects. */
export const reportParams = [
	{ name: 'agentId', type: 'uint256' },
	{
		name: 'attestation',
		type: 'tuple',
		components: [
			{ name: 'complianceScore', type: 'uint8' },
			{ name: 'tripCount', type: 'uint32' },
			{ name: 'executedCount', type: 'uint32' },
			{ name: 'realisedPnlBps', type: 'int256' },
			{ name: 'windowStart', type: 'uint64' },
			{ name: 'windowEnd', type: 'uint64' },
			{ name: 'evidenceHash', type: 'bytes32' },
		],
	},
] as const

/** Multicall3 (same address on every EVM chain incl. Monad testnet): batches every read into one chain call. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
export const Multicall3Abi = parseAbi([
	'struct Call3 { address target; bool allowFailure; bytes callData; }',
	'struct Result { bool success; bytes returnData; }',
	'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
