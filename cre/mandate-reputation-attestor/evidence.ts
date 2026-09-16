// evidenceHash = keccak256(abi.encode(Evidence)). The full evidence object is logged by the workflow so anyone can
// recompute the hash from public data (see scripts/verify-evidence.ts). Schema changes bump EVIDENCE_SCHEMA.
import { encodeAbiParameters, type Hex, keccak256, stringToHex } from 'viem'

export const EVIDENCE_SCHEMA = keccak256(stringToHex('mandate.reputation.evidence.v1'))

export interface Evidence {
	schema: Hex
	chainId: bigint
	agentId: bigint
	windowStart: bigint
	windowEnd: bigint
	fromBlock: bigint
	toBlock: bigint
	mandateHashes: Hex[]
	executionTxHashes: Hex[]
	tripTxHashes: Hex[]
	executedCount: number
	tripCount: number
	spentInWindow: bigint
	realisedPnlBps: bigint
	worstDrawdownBps: bigint
	utilisationBps: bigint
	complianceScore: number
	markPriceUsdE6: bigint // 0 when the market feed was unavailable
	llmRiskScore: number // 255 when no LLM note was obtained
	llmLevel: string // '' when no LLM note
	sources: string[] // data sources that contributed, sorted
}

export const evidenceParams = [
	{
		type: 'tuple',
		components: [
			{ name: 'schema', type: 'bytes32' },
			{ name: 'chainId', type: 'uint256' },
			{ name: 'agentId', type: 'uint256' },
			{ name: 'windowStart', type: 'uint64' },
			{ name: 'windowEnd', type: 'uint64' },
			{ name: 'fromBlock', type: 'uint256' },
			{ name: 'toBlock', type: 'uint256' },
			{ name: 'mandateHashes', type: 'bytes32[]' },
			{ name: 'executionTxHashes', type: 'bytes32[]' },
			{ name: 'tripTxHashes', type: 'bytes32[]' },
			{ name: 'executedCount', type: 'uint32' },
			{ name: 'tripCount', type: 'uint32' },
			{ name: 'spentInWindow', type: 'uint256' },
			{ name: 'realisedPnlBps', type: 'int256' },
			{ name: 'worstDrawdownBps', type: 'uint256' },
			{ name: 'utilisationBps', type: 'uint256' },
			{ name: 'complianceScore', type: 'uint8' },
			{ name: 'markPriceUsdE6', type: 'uint256' },
			{ name: 'llmRiskScore', type: 'uint8' },
			{ name: 'llmLevel', type: 'string' },
			{ name: 'sources', type: 'string[]' },
		],
	},
] as const

const sortHex = (xs: Hex[]) => [...xs].map((x) => x.toLowerCase() as Hex).sort()

/** Canonicalise (sorted arrays, lowercase hashes) so the hash does not depend on observation order. */
export function canonicalEvidence(e: Evidence): Evidence {
	return {
		...e,
		mandateHashes: sortHex(e.mandateHashes),
		executionTxHashes: sortHex(e.executionTxHashes),
		tripTxHashes: sortHex(e.tripTxHashes),
		sources: [...e.sources].sort(),
	}
}

export function evidenceHash(e: Evidence): Hex {
	const c = canonicalEvidence(e)
	return keccak256(encodeAbiParameters(evidenceParams, [c]))
}

/** JSON with bigints as decimal strings — what the workflow logs and verify-evidence reads back. */
export function evidenceToJson(e: Evidence): string {
	return JSON.stringify(canonicalEvidence(e), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

export function evidenceFromJson(s: string): Evidence {
	const o = JSON.parse(s) as Record<string, unknown>
	const big = (k: string) => BigInt(String(o[k]))
	return {
		schema: o.schema as Hex,
		chainId: big('chainId'),
		agentId: big('agentId'),
		windowStart: big('windowStart'),
		windowEnd: big('windowEnd'),
		fromBlock: big('fromBlock'),
		toBlock: big('toBlock'),
		mandateHashes: o.mandateHashes as Hex[],
		executionTxHashes: o.executionTxHashes as Hex[],
		tripTxHashes: o.tripTxHashes as Hex[],
		executedCount: Number(o.executedCount),
		tripCount: Number(o.tripCount),
		spentInWindow: big('spentInWindow'),
		realisedPnlBps: big('realisedPnlBps'),
		worstDrawdownBps: big('worstDrawdownBps'),
		utilisationBps: big('utilisationBps'),
		complianceScore: Number(o.complianceScore),
		markPriceUsdE6: big('markPriceUsdE6'),
		llmRiskScore: Number(o.llmRiskScore),
		llmLevel: String(o.llmLevel),
		sources: o.sources as string[],
	}
}
