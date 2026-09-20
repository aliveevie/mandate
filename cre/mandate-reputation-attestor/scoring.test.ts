import { describe, expect, test } from 'bun:test'
import { type MandateObservation, realisedPnlBps, score } from './scoring'

const H = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const T = '0x2222222222222222222222222222222222222222222222222222222222222222' as const

const mandate = (o: Partial<MandateObservation> = {}): MandateObservation => ({
	mandateHash: H,
	spendCap: 1000n,
	maxDrawdownBps: 2000n,
	spent: 100n,
	revoked: false,
	validUntil: 2_000_000n,
	phase: 'Armed',
	peakEquity: 10_000n,
	equityNow: 10_000n,
	drawdownBps: 0n,
	trippedAtBlock: 0n,
	...o,
})

describe('score', () => {
	test('clean window scores 100', () => {
		const s = score({ mandates: [mandate()], executions: [], trips: [], llm: null }, 1_000_000n)
		expect(s.complianceScore).toBe(100)
		expect(s.tripCount).toBe(0)
		expect(s.realisedPnlBps).toBe(0n)
	})

	test('trips cost 15 each, capped at 45, plus frozen state', () => {
		const trip = { mandateHash: H, txHash: T, blockNumber: 1n, drawdownBps: 2500n }
		const one = score({ mandates: [mandate({ phase: 'Tripped', drawdownBps: 0n })], executions: [], trips: [trip], llm: null }, 1n)
		expect(one.penalties.trips).toBe(15)
		expect(one.penalties.frozen).toBe(10)
		expect(one.complianceScore).toBe(75)
		const many = score({ mandates: [mandate()], executions: [], trips: [trip, trip, trip, trip, trip], llm: null }, 1n)
		expect(many.penalties.trips).toBe(45)
	})

	test('drawdown penalty is linear in drawdown / maxDrawdown and capped at 20', () => {
		const half = score({ mandates: [mandate({ drawdownBps: 1000n })], executions: [], trips: [], llm: null }, 1n)
		expect(half.penalties.drawdown).toBe(10)
		const over = score({ mandates: [mandate({ drawdownBps: 5000n })], executions: [], trips: [], llm: null }, 1n)
		expect(over.penalties.drawdown).toBe(20)
		const disabled = score({ mandates: [mandate({ maxDrawdownBps: 10_000n, drawdownBps: 5000n })], executions: [], trips: [], llm: null }, 1n)
		expect(disabled.penalties.drawdown).toBe(0)
	})

	test('utilisation, early revoke and llm level', () => {
		const s = score(
			{
				mandates: [mandate({ spent: 950n, revoked: true, validUntil: 10n })],
				executions: [{ mandateHash: H, txHash: T, blockNumber: 1n, spent: 50n, phaseAfter: 'Armed' }],
				trips: [],
				llm: { riskScore: 80, level: 'high' },
			},
			5n,
		)
		expect(s.penalties.utilisation).toBe(5)
		expect(s.penalties.revoked).toBe(5)
		expect(s.penalties.llm).toBe(10)
		expect(s.executedCount).toBe(1)
		expect(s.spentInWindow).toBe(50n)
		expect(s.complianceScore).toBe(80)
	})

	test('never below 0 and deterministic', () => {
		const trip = { mandateHash: H, txHash: T, blockNumber: 1n, drawdownBps: 9000n }
		const input = {
			mandates: [mandate({ phase: 'Cooldown' as const, drawdownBps: 9000n, spent: 1000n, revoked: true, validUntil: 10n })],
			executions: [],
			trips: [trip, trip, trip],
			llm: { riskScore: 99, level: 'high' as const },
		}
		const a = score(input, 1n)
		const b = score(input, 1n)
		expect(a).toEqual(b)
		// frozen penalty does not apply to a revoked mandate (it is no longer the agent's to unfreeze)
		expect(a.penalties.frozen).toBe(0)
		expect(a.complianceScore).toBe(100 - 45 - 20 - 5 - 5 - 10)
	})
})

describe('realisedPnlBps', () => {
	test('mark-to-peak across mandates', () => {
		expect(realisedPnlBps([mandate({ peakEquity: 10_000n, equityNow: 9_000n })])).toBe(-1000n)
		expect(realisedPnlBps([mandate({ peakEquity: 0n, equityNow: 0n })])).toBe(0n)
		expect(realisedPnlBps([mandate({ peakEquity: 100n, equityNow: 100n }), mandate({ peakEquity: 100n, equityNow: 50n })])).toBe(-2500n)
	})
})
