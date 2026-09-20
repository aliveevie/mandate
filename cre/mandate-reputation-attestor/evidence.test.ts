import { describe, expect, test } from 'bun:test'
import { EVIDENCE_SCHEMA, type Evidence, evidenceFromJson, evidenceHash, evidenceToJson } from './evidence'

const base: Evidence = {
	schema: EVIDENCE_SCHEMA,
	chainId: 10143n,
	agentId: 1831n,
	windowStart: 1n,
	windowEnd: 2n,
	fromBlock: 10n,
	toBlock: 20n,
	mandateHashes: ['0xBB'.padEnd(66, '0') as `0x${string}`, '0xaa'.padEnd(66, '0') as `0x${string}`],
	mandates: [
		{ mandateHash: '0xBB'.padEnd(66, '0') as `0x${string}`, spendCap: 300n, maxDrawdownBps: 1500n, spent: 186n, revoked: true, validUntil: 99n, phase: 1, peakEquity: 1000n, equityNow: 814n, drawdownBps: 1860n, trippedAtBlock: 12n },
		{ mandateHash: '0xaa'.padEnd(66, '0') as `0x${string}`, spendCap: 1n, maxDrawdownBps: 1n, spent: 0n, revoked: false, validUntil: 1n, phase: 0, peakEquity: 0n, equityNow: 0n, drawdownBps: 0n, trippedAtBlock: 0n },
	],
	executionTxHashes: ['0x02'.padEnd(66, '0') as `0x${string}`, '0x01'.padEnd(66, '0') as `0x${string}`],
	tripTxHashes: [],
	executedCount: 2,
	tripCount: 0,
	spentInWindow: 5n,
	realisedPnlBps: -12n,
	worstDrawdownBps: 300n,
	utilisationBps: 5000n,
	complianceScore: 97,
	penalties: { trips: 0, frozen: 0, drawdown: 3, utilisation: 0, revoked: 0, llm: 0 },
	markPriceUsdE6: 22295n,
	llmRiskScore: 20,
	llmLevel: 'low',
	sources: ['onchain', 'coingecko', 'anthropic'],
}

describe('evidence', () => {
	test('hash is order-independent and case-insensitive over hashes', () => {
		const shuffled: Evidence = {
			...base,
			mandateHashes: [...base.mandateHashes].reverse(),
			mandates: [...base.mandates].reverse(),
			executionTxHashes: [...base.executionTxHashes].reverse().map((h) => h.toUpperCase().replace('0X', '0x') as `0x${string}`),
			sources: [...base.sources].reverse(),
		}
		expect(evidenceHash(shuffled)).toBe(evidenceHash(base))
	})
	test('any field change changes the hash', () => {
		expect(evidenceHash({ ...base, complianceScore: 96 })).not.toBe(evidenceHash(base))
		expect(evidenceHash({ ...base, llmLevel: '' })).not.toBe(evidenceHash(base))
		expect(evidenceHash({ ...base, mandates: [{ ...base.mandates[0]!, spent: 187n }, base.mandates[1]!] })).not.toBe(evidenceHash(base))
		expect(evidenceHash({ ...base, penalties: { ...base.penalties, llm: 5 } })).not.toBe(evidenceHash(base))
	})
	test('json round trip preserves the hash', () => {
		const json = evidenceToJson(base)
		expect(evidenceHash(evidenceFromJson(json))).toBe(evidenceHash(base))
	})
})
