// evidenceHash = keccak256(abi.encode(Evidence)). The full evidence object is logged by the workflow so anyone can
// recompute the hash from public data (see scripts/verify-evidence.ts). Schema changes bump EVIDENCE_SCHEMA.
import { encodeAbiParameters, type Hex, keccak256, stringToHex } from 'viem'

export const EVIDENCE_SCHEMA = keccak256(stringToHex('mandate.reputation.evidence.v2'))

/** Onchain inputs per mandate, exactly as read in the run (so complianceScore is recomputable from the evidence). */
export interface EvidenceMandate {
	mandateHash: Hex
	spendCap: bigint
	maxDrawdownBps: bigint
	spent: bigint
	revoked: boolean
	validUntil: bigint
	phase: number // 0 Armed, 1 Tripped, 2 Cooldown
	peakEquity: bigint
	equityNow: bigint
	drawdownBps: bigint
	trippedAtBlock: bigint
}

export interface EvidencePenalties {
	trips: number
	frozen: number
	drawdown: number
	utilisation: number
	revoked: number
	llm: number
}

export interface Evidence {
	schema: Hex
	chainId: bigint
	agentId: bigint
	windowStart: bigint
	windowEnd: bigint
	fromBlock: bigint
	toBlock: bigint
	mandateHashes: Hex[]
	mandates: EvidenceMandate[]
	executionTxHashes: Hex[]
	tripTxHashes: Hex[]
	executedCount: number
	tripCount: number
	spentInWindow: bigint
	realisedPnlBps: bigint
	worstDrawdownBps: bigint
	utilisationBps: bigint
	complianceScore: number
	penalties: EvidencePenalties
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
			{
				name: 'mandates',
				type: 'tuple[]',
				components: [
					{ name: 'mandateHash', type: 'bytes32' },
					{ name: 'spendCap', type: 'uint256' },
					{ name: 'maxDrawdownBps', type: 'uint256' },
					{ name: 'spent', type: 'uint256' },
					{ name: 'revoked', type: 'bool' },
					{ name: 'validUntil', type: 'uint64' },
					{ name: 'phase', type: 'uint8' },
					{ name: 'peakEquity', type: 'uint256' },
					{ name: 'equityNow', type: 'uint256' },
					{ name: 'drawdownBps', type: 'uint256' },
					{ name: 'trippedAtBlock', type: 'uint256' },
				],
			},
			{ name: 'executionTxHashes', type: 'bytes32[]' },
			{ name: 'tripTxHashes', type: 'bytes32[]' },
			{ name: 'executedCount', type: 'uint32' },
			{ name: 'tripCount', type: 'uint32' },
			{ name: 'spentInWindow', type: 'uint256' },
			{ name: 'realisedPnlBps', type: 'int256' },
			{ name: 'worstDrawdownBps', type: 'uint256' },
			{ name: 'utilisationBps', type: 'uint256' },
			{ name: 'complianceScore', type: 'uint8' },
			{
				name: 'penalties',
				type: 'tuple',
				components: [
					{ name: 'trips', type: 'uint8' },
					{ name: 'frozen', type: 'uint8' },
					{ name: 'drawdown', type: 'uint8' },
					{ name: 'utilisation', type: 'uint8' },
					{ name: 'revoked', type: 'uint8' },
					{ name: 'llm', type: 'uint8' },
				],
			},
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
		mandates: [...e.mandates].map((m) => ({ ...m, mandateHash: m.mandateHash.toLowerCase() as Hex })).sort((a, b) => (a.mandateHash < b.mandateHash ? -1 : 1)),
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
		mandates: ((o.mandates as Record<string, unknown>[]) ?? []).map((m) => ({
			mandateHash: m.mandateHash as Hex,
			spendCap: BigInt(String(m.spendCap)),
			maxDrawdownBps: BigInt(String(m.maxDrawdownBps)),
			spent: BigInt(String(m.spent)),
			revoked: Boolean(m.revoked),
			validUntil: BigInt(String(m.validUntil)),
			phase: Number(m.phase),
			peakEquity: BigInt(String(m.peakEquity)),
			equityNow: BigInt(String(m.equityNow)),
			drawdownBps: BigInt(String(m.drawdownBps)),
			trippedAtBlock: BigInt(String(m.trippedAtBlock)),
		})),
		executionTxHashes: o.executionTxHashes as Hex[],
		tripTxHashes: o.tripTxHashes as Hex[],
		executedCount: Number(o.executedCount),
		tripCount: Number(o.tripCount),
		spentInWindow: big('spentInWindow'),
		realisedPnlBps: big('realisedPnlBps'),
		worstDrawdownBps: big('worstDrawdownBps'),
		utilisationBps: big('utilisationBps'),
		complianceScore: Number(o.complianceScore),
		penalties: Object.fromEntries(['trips', 'frozen', 'drawdown', 'utilisation', 'revoked', 'llm'].map((k) => [k, Number((o.penalties as Record<string, unknown>)?.[k] ?? 0)])) as unknown as EvidencePenalties,
		markPriceUsdE6: big('markPriceUsdE6'),
		llmRiskScore: Number(o.llmRiskScore),
		llmLevel: String(o.llmLevel),
		sources: o.sources as string[],
	}
}
