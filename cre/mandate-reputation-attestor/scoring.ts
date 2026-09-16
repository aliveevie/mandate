// Deterministic compliance scoring. Pure functions: identical inputs on every DON node give identical output,
// which is what lets the attestation reach consensus. No I/O, no Date, no randomness.

export type Phase = 'Armed' | 'Tripped' | 'Cooldown'
export const PHASES: Phase[] = ['Armed', 'Tripped', 'Cooldown']

export interface MandateObservation {
	mandateHash: `0x${string}`
	spendCap: bigint
	maxDrawdownBps: bigint
	spent: bigint // lifetime spend recorded onchain
	revoked: boolean
	validUntil: bigint
	phase: Phase
	peakEquity: bigint
	equityNow: bigint
	drawdownBps: bigint
	trippedAtBlock: bigint
}

export interface ExecutionObservation {
	mandateHash: `0x${string}`
	txHash: `0x${string}`
	blockNumber: bigint
	spent: bigint
	phaseAfter: Phase
}

export interface TripObservation {
	mandateHash: `0x${string}`
	/** Absent when the trip was observed from breaker state rather than from the Tripped event. */
	txHash?: `0x${string}`
	blockNumber: bigint
	drawdownBps: bigint
}

export type LlmLevel = 'low' | 'medium' | 'high'
export interface LlmNote {
	riskScore: number // 0..100
	level: LlmLevel
	flags: string[]
	summary: string
}

export interface ScoreInput {
	mandates: MandateObservation[]
	executions: ExecutionObservation[]
	trips: TripObservation[]
	llm: LlmNote | null
}

export interface ScoreBreakdown {
	complianceScore: number
	tripCount: number
	executedCount: number
	realisedPnlBps: bigint
	spentInWindow: bigint
	utilisationBps: bigint
	worstDrawdownBps: bigint
	penalties: Record<string, number>
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const bps = (num: bigint, den: bigint) => (den === 0n ? 0n : (num * 10_000n) / den)

/** Mark-to-peak realised PnL across all observed mandates, in basis points (0 when no equity was tracked). */
export function realisedPnlBps(mandates: MandateObservation[]): bigint {
	let peak = 0n
	let now = 0n
	for (const m of mandates) {
		if (m.peakEquity === 0n) continue
		peak += m.peakEquity
		now += m.equityNow
	}
	return peak === 0n ? 0n : ((now - peak) * 10_000n) / peak
}

/**
 * complianceScore ∈ [0, 100]. Starts at 100 and loses points for behaviour the principal did not want:
 *  - each breaker trip in the window: −15 (max −45)
 *  - still frozen (Tripped / Cooldown) at the end of the window: −10
 *  - drawdown relative to the mandate's own limit: up to −20, linear in drawdown/maxDrawdown
 *  - lifetime spend utilisation above 90% of the cap: −5 (agent ran the mandate to the edge)
 *  - a mandate revoked while still valid: −5 (the principal pulled the plug)
 *  - LLM risk note: high −10, medium −5 (advisory; absent note = no change)
 * Onchain bounds cannot be exceeded (the contracts revert), so this measures *quality within* the bounds.
 */
export function score(input: ScoreInput, nowSeconds: bigint): ScoreBreakdown {
	const penalties: Record<string, number> = {}
	const tripCount = input.trips.length
	const executedCount = input.executions.length

	penalties.trips = Math.min(45, tripCount * 15)

	const frozen = input.mandates.some((m) => m.phase !== 'Armed' && !m.revoked)
	penalties.frozen = frozen ? 10 : 0

	let worstDrawdownBps = 0n
	let worstDrawdownPenalty = 0
	for (const m of input.mandates) {
		if (m.drawdownBps > worstDrawdownBps) worstDrawdownBps = m.drawdownBps
		if (m.maxDrawdownBps > 0n && m.maxDrawdownBps < 10_000n) {
			const ratio = Number(bps(m.drawdownBps, m.maxDrawdownBps)) / 10_000 // 0..1+
			worstDrawdownPenalty = Math.max(worstDrawdownPenalty, Math.floor(clamp(ratio, 0, 1) * 20))
		}
	}
	penalties.drawdown = worstDrawdownPenalty

	let spentTotal = 0n
	let capTotal = 0n
	for (const m of input.mandates) {
		spentTotal += m.spent
		capTotal += m.spendCap
	}
	const utilisationBps = bps(spentTotal, capTotal)
	penalties.utilisation = utilisationBps > 9_000n ? 5 : 0

	const revokedEarly = input.mandates.some((m) => m.revoked && m.validUntil > nowSeconds)
	penalties.revoked = revokedEarly ? 5 : 0

	penalties.llm = input.llm ? (input.llm.level === 'high' ? 10 : input.llm.level === 'medium' ? 5 : 0) : 0

	const total = Object.values(penalties).reduce((a, b) => a + b, 0)
	let spentInWindow = 0n
	for (const e of input.executions) spentInWindow += e.spent

	return {
		complianceScore: clamp(100 - total, 0, 100),
		tripCount,
		executedCount,
		realisedPnlBps: realisedPnlBps(input.mandates),
		spentInWindow,
		utilisationBps,
		worstDrawdownBps,
		penalties,
	}
}
