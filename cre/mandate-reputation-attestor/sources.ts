// External data sources, all executed in node mode and reconciled by DON consensus:
//  - Envio GraphQL (optional): executions / breaker events / mandates for the window, identical-aggregated
//  - market price feed (CoinGecko public API): MON/USD mark, median-aggregated
//  - Anthropic Messages API: a structured risk note on the agent's window, aggregated by field
// The CRE WASM runtime has no fetch and cannot load the Anthropic SDK, so the API is called over the HTTP
// capability with the documented request shape (output_config.format json_schema, adaptive thinking default).
import {
	HTTPClient,
	consensusIdenticalAggregation,
	consensusMedianAggregation,
	hexToBase64,
	json,
	ok,
	type NodeRuntime,
	type Runtime,
	text,
} from '@chainlink/cre-sdk'
import { type Hex, stringToHex } from 'viem'
import type { LlmNote, Phase } from './scoring'
import { PHASES, llmLevelOf } from './scoring'

export interface IndexedWindow {
	mandateHashes: Hex[]
	executions: { mandateHash: Hex; txHash: Hex; blockNumber: bigint; spent: bigint; phaseAfter: Phase }[]
	trips: { mandateHash: Hex; txHash: Hex; blockNumber: bigint; drawdownBps: bigint }[]
}

const postJson = (rt: NodeRuntime<unknown>, url: string, body: unknown, headers: Record<string, string> = {}) =>
	new HTTPClient()
		.sendRequest(rt, {
			url,
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: hexToBase64(stringToHex(JSON.stringify(body))),
		})
		.result()

// ------------------------------------------------------------------ Envio indexer

const INDEXER_QUERY = `query($agent: String!, $from: numeric!) {
  Mandate(where: { agent_id: { _eq: $agent } }) { id }
  Execution(where: { agent_id: { _eq: $agent }, timestamp: { _gte: $from } }, order_by: { block: asc }) {
    mandate_id tx block spent phaseAfter
  }
  BreakerEvent(where: { agent_id: { _eq: $agent }, kind: { _eq: "Tripped" }, timestamp: { _gte: $from } }, order_by: { block: asc }) {
    mandate_id tx block drawdownBps
  }
}`

/** Returns null when no indexer is configured; throws when the indexer is configured but unreachable. */
export function fetchIndexedWindow(
	runtime: Runtime<unknown>,
	indexerUrl: string,
	agentId: bigint,
	windowStart: bigint,
): IndexedWindow | null {
	if (!indexerUrl) return null
	const fetchFn = (rt: NodeRuntime<unknown>, url: string, agent: string, from: string): string => {
		const resp = postJson(rt, url, { query: INDEXER_QUERY, variables: { agent, from } })
		if (!ok(resp)) throw new Error(`indexer ${resp.statusCode}: ${text(resp).slice(0, 200)}`)
		const data = (json(resp) as { data?: unknown; errors?: unknown }).data
		if (!data) throw new Error(`indexer returned no data: ${text(resp).slice(0, 200)}`)
		return JSON.stringify(data)
	}
	const raw = runtime
		.runInNodeMode(fetchFn, consensusIdenticalAggregation<string>())(indexerUrl, agentId.toString(), windowStart.toString())
		.result()
	const d = JSON.parse(raw) as {
		Mandate: { id: string }[]
		Execution: { mandate_id: string; tx: string; block: string | number; spent: string; phaseAfter: string }[]
		BreakerEvent: { mandate_id: string; tx: string; block: string | number; drawdownBps: string | null }[]
	}
	const phase = (p: string): Phase => (PHASES.includes(p as Phase) ? (p as Phase) : 'Armed')
	return {
		mandateHashes: d.Mandate.map((m) => m.id as Hex),
		executions: d.Execution.map((e) => ({
			mandateHash: e.mandate_id as Hex,
			txHash: e.tx as Hex,
			blockNumber: BigInt(e.block),
			spent: BigInt(e.spent),
			phaseAfter: phase(e.phaseAfter),
		})),
		trips: d.BreakerEvent.map((b) => ({
			mandateHash: b.mandate_id as Hex,
			txHash: b.tx as Hex,
			blockNumber: BigInt(b.block),
			drawdownBps: BigInt(b.drawdownBps ?? '0'),
		})),
	}
}

// ------------------------------------------------------------------ Mandate reference API

export interface ReferenceAgent {
	agentId: string
	mandateHash?: Hex
	/** Executions the reference server relayed for this agent (declared amounts; the chain has the measured spend). */
	executions: { mandateHash: Hex; txHash: Hex; amount: bigint; at: bigint }[]
}

/** Agents the reference server knows about, with their current mandate and relayed executions. */
export function fetchReferenceAgents(runtime: Runtime<unknown>, apiUrl: string): ReferenceAgent[] {
	if (!apiUrl) return []
	const fetchFn = (rt: NodeRuntime<unknown>, url: string): string => {
		const resp = new HTTPClient().sendRequest(rt, { url: `${url.replace(/\/$/, '')}/api/agents`, method: 'GET' }).result()
		if (!ok(resp)) throw new Error(`reference api ${resp.statusCode}`)
		const list = json(resp) as { agentId: string; mandateHash?: string; feed?: { kind: string; tx?: string; amount?: string; mandateHash?: string; at?: number }[] }[]
		const agents = list
			.map((a) => ({
				agentId: String(a.agentId),
				mandateHash: a.mandateHash,
				executions: (a.feed ?? [])
					.filter((f) => f.kind === 'executed' && f.tx && f.mandateHash)
					.map((f) => ({ mandateHash: f.mandateHash!, txHash: f.tx!, amount: f.amount ?? '0', at: Math.floor((f.at ?? 0) / 1000) }))
					.sort((x, y) => (x.txHash < y.txHash ? -1 : 1)),
			}))
			.sort((a, b) => (BigInt(a.agentId) < BigInt(b.agentId) ? -1 : 1))
		return JSON.stringify(agents)
	}
	const raw = runtime.runInNodeMode(fetchFn, consensusIdenticalAggregation<string>())(apiUrl).result()
	const parsed = JSON.parse(raw) as { agentId: string; mandateHash?: string; executions: { mandateHash: string; txHash: string; amount: string; at: number }[] }[]
	return parsed.map((a) => ({
		agentId: a.agentId,
		mandateHash: a.mandateHash as Hex | undefined,
		executions: a.executions.map((e) => ({ mandateHash: e.mandateHash as Hex, txHash: e.txHash as Hex, amount: BigInt(e.amount), at: BigInt(e.at) })),
	}))
}

// ------------------------------------------------------------------ market feed

/** MON/USD mark price scaled by 1e6 (median across nodes); 0 when the feed is unavailable. */
export function fetchMarkPriceUsdE6(runtime: Runtime<unknown>, url: string): number {
	if (!url) return 0
	const fetchFn = (rt: NodeRuntime<unknown>, u: string): number => {
		const resp = new HTTPClient().sendRequest(rt, { url: u, method: 'GET' }).result()
		if (!ok(resp)) throw new Error(`market feed ${resp.statusCode}`)
		const body = json(resp) as Record<string, Record<string, number>>
		const first = Object.values(body)[0]
		const usd = first?.usd
		if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new Error('market feed: no usd price')
		return Math.round(usd * 1e6)
	}
	return runtime.runInNodeMode(fetchFn, consensusMedianAggregation<number>())(url).result()
}

// ------------------------------------------------------------------ LLM risk note

export interface LlmConfig {
	enabled: boolean
	apiUrl: string
	model: string
	maxTokens: number
	effort: 'low' | 'medium' | 'high'
}

export interface LlmContext {
	agentId: string
	windowStart: string
	windowEnd: string
	executedCount: number
	tripCount: number
	spentInWindow: string
	utilisationBps: string
	worstDrawdownBps: string
	realisedPnlBps: string
	phases: string[]
	revoked: boolean
	markPriceUsd: string
}

const LLM_FLAGS = ['cap-edge', 'drawdown', 'breaker-trip', 'frozen', 'revoked', 'idle', 'burst', 'none'] as const

const RISK_NOTE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['riskScore', 'level', 'flags', 'summary'],
	properties: {
		riskScore: { type: 'integer', minimum: 0, maximum: 100 },
		level: { type: 'string', enum: ['low', 'medium', 'high'] },
		flags: { type: 'array', items: { type: 'string', enum: [...LLM_FLAGS] }, maxItems: 4 },
		summary: { type: 'string', maxLength: 240 },
	},
} as const

const SYSTEM_PROMPT = `You review the behaviour of an autonomous trading agent that acts under a Mandate: an onchain, principal-signed
delegation with a lifetime spend cap, a per-block cap, a drawdown circuit breaker and an allow-list of venues.
The contracts already enforce those bounds; you assess the quality of behaviour inside them from the window
metrics you are given. Be conservative and deterministic: the same metrics must yield the same answer.
Rules of thumb: trips or a frozen breaker are high risk; utilisation above 90% or drawdown near the limit is
medium; a quiet, in-bounds window is low. Use 'none' as the only flag when nothing stands out.`

/**
 * Returns null when the LLM step is disabled, has no key, or fails; the attestation then proceeds without it.
 * Consensus: each node asks the model for a structured note and reports only the integer riskScore; the DON takes
 * the median. Free text cannot reach byte-identical agreement across nodes, so the summary and flags are logged per
 * node and never enter consensus or the evidence. `level` is derived from the agreed score.
 */
export function fetchRiskNote(runtime: Runtime<unknown>, cfg: LlmConfig, apiKey: string, ctx: LlmContext): LlmNote | null {
	if (!cfg.enabled || !apiKey) return null
	const fetchFn = (rt: NodeRuntime<unknown>, key: string, context: string): number => {
		const resp = postJson(
			rt,
			cfg.apiUrl,
			{
				model: cfg.model,
				max_tokens: cfg.maxTokens,
				system: SYSTEM_PROMPT,
				output_config: { effort: cfg.effort, format: { type: 'json_schema', schema: RISK_NOTE_SCHEMA } },
				messages: [{ role: 'user', content: `Window metrics (JSON):\n${context}\n\nReturn the risk note.` }],
			},
			{ 'x-api-key': key, 'anthropic-version': '2023-06-01' },
		)
		if (!ok(resp)) throw new Error(`llm ${resp.statusCode}: ${text(resp).slice(0, 200)}`)
		const body = json(resp) as { stop_reason?: string; content?: { type: string; text?: string }[] }
		if (body.stop_reason === 'refusal') throw new Error('llm refused')
		const textBlock = body.content?.find((b) => b.type === 'text')?.text
		if (!textBlock) throw new Error('llm: no text block')
		const parsed = JSON.parse(textBlock) as { riskScore?: unknown; level?: unknown; flags?: unknown; summary?: unknown }
		const riskScore = Math.max(0, Math.min(100, Math.round(Number(parsed.riskScore))))
		if (!Number.isFinite(riskScore)) throw new Error('llm: riskScore missing')
		rt.log(`llm node note: score ${riskScore} level ${String(parsed.level)} flags ${JSON.stringify(parsed.flags ?? [])} summary ${String(parsed.summary ?? '').slice(0, 240)}`)
		return riskScore
	}
	const riskScore = runtime.runInNodeMode(fetchFn, consensusMedianAggregation<number>())(apiKey, JSON.stringify(ctx)).result()
	return { riskScore, level: llmLevelOf(riskScore) }
}
