// mandate-reputation-attestor — Chainlink CRE workflow, the single writer of Mandate reputation.
//
// Every run: read the agents' onchain window on Monad (EVM capability), enrich it with the Envio indexer, the
// reference API, an external market feed and an LLM risk note (HTTP capability, DON consensus), compute a
// deterministic compliance score, hash the full evidence, and deliver `(agentId, Attestation)` through the
// KeystoneForwarder to CREAttestationReceiver, which is the ERC8004ReputationAdapter's Attestor.
//
// Chain-read budget: CRE allows 15 chain reads per execution. Every contract read goes through one Multicall3
// call, and the recent-log tail scan is bounded by `tailBlocks / logChunkBlocks` queries (Monad's public RPC
// caps eth_getLogs at 100 blocks). Long windows come from the indexer, not from log scans.
import {
	CronCapability,
	EVMClient,
	LATEST_BLOCK_NUMBER,
	Runner,
	TxStatus,
	bigintToProtoBigInt,
	bytesToBigint,
	bytesToHex,
	encodeCallMsg,
	getNetwork,
	handler,
	hexToBase64,
	prepareReportRequest,
	type Runtime,
} from '@chainlink/cre-sdk'
import { type Address, type Hex, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, toEventSelector, zeroAddress } from 'viem'
import { z } from 'zod'
import {
	MULTICALL3,
	MandateExecutorAbi,
	MandateRegistryAbi,
	Multicall3Abi,
	ReputationAdapterAbi,
	RiskBreakerAbi,
	reportParams,
} from './abi'
import { EVIDENCE_SCHEMA, type Evidence, evidenceHash, evidenceToJson } from './evidence'
import { type ExecutionObservation, type MandateObservation, PHASES, type TripObservation, score } from './scoring'
import { fetchIndexedWindow, fetchMarkPriceUsdE6, fetchReferenceAgents, fetchRiskNote } from './sources'

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/)
const configSchema = z.object({
	schedule: z.string(),
	chainSelectorName: z.string(),
	windowSeconds: z.number().int().positive(),
	tailBlocks: z.number().int().min(0),
	logChunkBlocks: z.number().int().positive().max(2000),
	blockTimeMs: z.number().int().positive(),
	attestIdle: z.boolean(),
	dryRun: z.boolean(),
	gasLimit: z.string(),
	contracts: z.object({ registry: hex, executor: hex, breaker: hex, adapter: hex, receiver: hex }),
	agents: z.array(z.object({ agentId: z.string(), mandateHashes: z.array(hex) })),
	indexerUrl: z.string(),
	referenceApiUrl: z.string(),
	marketApiUrl: z.string(),
	llm: z.object({
		enabled: z.boolean(),
		apiUrl: z.string(),
		model: z.string(),
		maxTokens: z.number().int().positive(),
		effort: z.enum(['low', 'medium', 'high']),
	}),
})
type Config = z.infer<typeof configSchema>

const TOPIC_GRANTED = toEventSelector(
	'MandateGranted(bytes32,address,uint256,address,(address,uint256,address,address[],bytes4[],address,uint256,uint256,uint256,uint64,uint64,uint256,bytes32))',
)
const TOPIC_EXECUTED = toEventSelector('MandateExecuted(bytes32,uint256,address,address,bytes4,uint256,uint256,uint8)')
const TOPIC_TRIPPED = toEventSelector('Tripped(bytes32,uint256,uint256,uint256)')

interface AgentWindow {
	mandateHashes: Set<Hex>
	executions: ExecutionObservation[]
	trips: TripObservation[]
	sources: Set<string>
}

const lower = (h: string) => h.toLowerCase() as Hex
const phaseOf = (n: number) => PHASES[n] ?? 'Armed'
const newWindow = (): AgentWindow => ({ mandateHashes: new Set(), executions: [], trips: [], sources: new Set() })

// ------------------------------------------------------------------ chain reads (1 header + N log chunks + 1 multicall)

function latestHeader(runtime: Runtime<Config>, evm: EVMClient): { number: bigint; timestamp: bigint } {
	const r = evm.headerByNumber(runtime, { blockNumber: LATEST_BLOCK_NUMBER }).result()
	const h = r.header
	if (!h?.blockNumber) throw new Error('headerByNumber returned no header')
	return { number: bytesToBigint(h.blockNumber.absVal), timestamp: BigInt(String(h.timestamp)) }
}

/** Fresh tail of the chain: catches activity the indexer has not ingested yet. Bounded by the read budget. */
function scanTail(runtime: Runtime<Config>, evm: EVMClient, fromBlock: bigint, toBlock: bigint, byAgent: Map<string, AgentWindow>) {
	const { contracts, logChunkBlocks } = runtime.config
	const addresses = [contracts.registry, contracts.executor, contracts.breaker].map((a) => hexToBase64(a))
	const bucket = (agentId: bigint) => {
		const k = agentId.toString()
		let w = byAgent.get(k)
		if (!w) byAgent.set(k, (w = newWindow()))
		w.sources.add('monad-logs')
		return w
	}
	let calls = 0
	let found = 0
	for (let start = fromBlock; start <= toBlock; start += BigInt(logChunkBlocks)) {
		const end = start + BigInt(logChunkBlocks) - 1n < toBlock ? start + BigInt(logChunkBlocks) - 1n : toBlock
		const r = evm.filterLogs(runtime, { filterQuery: { addresses, fromBlock: bigintToProtoBigInt(start), toBlock: bigintToProtoBigInt(end) } }).result()
		calls++
		for (const log of r.logs) {
			const topics = log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]]
			const data = bytesToHex(log.data)
			const txHash = lower(bytesToHex(log.txHash))
			const blockNumber = log.blockNumber ? bytesToBigint(log.blockNumber.absVal) : start
			if (topics[0] === TOPIC_GRANTED) {
				const ev = decodeEventLog({ abi: MandateRegistryAbi, eventName: 'MandateGranted', topics, data })
				bucket(ev.args.agentId).mandateHashes.add(lower(ev.args.mandateHash))
				found++
			} else if (topics[0] === TOPIC_EXECUTED) {
				const ev = decodeEventLog({ abi: MandateExecutorAbi, eventName: 'MandateExecuted', topics, data })
				const w = bucket(ev.args.agentId)
				w.mandateHashes.add(lower(ev.args.mandateHash))
				w.executions.push({ mandateHash: lower(ev.args.mandateHash), txHash, blockNumber, spent: ev.args.spent, phaseAfter: phaseOf(ev.args.phaseAfter) })
				found++
			} else if (topics[0] === TOPIC_TRIPPED) {
				const ev = decodeEventLog({ abi: RiskBreakerAbi, eventName: 'Tripped', topics, data })
				const w = bucket(ev.args.agentId)
				w.mandateHashes.add(lower(ev.args.mandateHash))
				w.trips.push({ mandateHash: lower(ev.args.mandateHash), txHash, blockNumber, drawdownBps: ev.args.drawdownBps })
				found++
			}
		}
	}
	runtime.log(`tail scan blocks ${fromBlock}-${toBlock}: ${calls} log queries, ${found} Mandate event(s)`)
}

type Call = { target: Address; allowFailure: boolean; callData: Hex }
const enc = (abi: readonly unknown[], functionName: string, args: readonly unknown[]): Hex => encodeFunctionData({ abi, functionName, args } as never)
const dec = <T>(abi: readonly unknown[], functionName: string, data: Hex): T => decodeFunctionResult({ abi, functionName, data } as never) as T

/** All contract state for this run in a single Multicall3 read: attestor, latest attestation per agent, every mandate. */
function readChainState(runtime: Runtime<Config>, evm: EVMClient, agents: { agentId: bigint; mandateHashes: Hex[] }[]) {
	const { contracts } = runtime.config
	const registry = contracts.registry as Address
	const breaker = contracts.breaker as Address
	const adapter = contracts.adapter as Address
	const calls: Call[] = [{ target: adapter, allowFailure: false, callData: enc(ReputationAdapterAbi, 'attestor', []) }]
	const agentSlots: { agentId: bigint; latest: number; mandates: { hash: Hex; at: number }[] }[] = []
	for (const a of agents) {
		const slot = { agentId: a.agentId, latest: calls.length, mandates: [] as { hash: Hex; at: number }[] }
		calls.push({ target: adapter, allowFailure: false, callData: enc(ReputationAdapterAbi, 'latest', [a.agentId]) })
		for (const hash of a.mandateHashes) {
			slot.mandates.push({ hash, at: calls.length })
			calls.push(
				{ target: registry, allowFailure: false, callData: enc(MandateRegistryAbi, 'exists', [hash]) },
				{ target: registry, allowFailure: true, callData: enc(MandateRegistryAbi, 'getMandate', [hash]) },
				{ target: registry, allowFailure: true, callData: enc(MandateRegistryAbi, 'getState', [hash]) },
				{ target: breaker, allowFailure: true, callData: enc(RiskBreakerAbi, 'stateOf', [hash]) },
				{ target: breaker, allowFailure: true, callData: enc(RiskBreakerAbi, 'currentDrawdownBps', [hash]) },
				{ target: breaker, allowFailure: true, callData: enc(RiskBreakerAbi, 'equityOf', [hash]) },
			)
		}
		agentSlots.push(slot)
	}
	const data = encodeFunctionData({ abi: Multicall3Abi, functionName: 'aggregate3', args: [calls] })
	const r = evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to: MULTICALL3, data }), blockNumber: LATEST_BLOCK_NUMBER }).result()
	const results = decodeFunctionResult({ abi: Multicall3Abi, functionName: 'aggregate3', data: bytesToHex(r.data) })
	runtime.log(`multicall: ${calls.length} reads in one chain call`)

	const attestor = dec<string>(ReputationAdapterAbi, 'attestor', results[0]!.returnData).toLowerCase()
	const perAgent = new Map<string, { latestWindowEnd: bigint; mandates: MandateObservation[] }>()
	for (const slot of agentSlots) {
		const latest = dec<{ windowEnd: bigint }>(ReputationAdapterAbi, 'latest', results[slot.latest]!.returnData)
		const mandates: MandateObservation[] = []
		for (const m of slot.mandates) {
			const at = (i: number) => results[m.at + i]!
			if (!dec<boolean>(MandateRegistryAbi, 'exists', at(0).returnData)) continue
			const md = dec<{ spendCap: bigint; maxDrawdownBps: bigint; validUntil: bigint }>(MandateRegistryAbi, 'getMandate', at(1).returnData)
			const st = dec<{ spent: bigint; revoked: boolean }>(MandateRegistryAbi, 'getState', at(2).returnData)
			const bs = dec<{ phase: number; initialized: boolean; peakEquity: bigint; lastEquity: bigint; lastDrawdownBps: bigint; trippedAtBlock: bigint }>(RiskBreakerAbi, 'stateOf', at(3).returnData)
			const drawdownBps = at(4).success ? dec<bigint>(RiskBreakerAbi, 'currentDrawdownBps', at(4).returnData) : bs.lastDrawdownBps
			const equityNow = at(5).success ? dec<bigint>(RiskBreakerAbi, 'equityOf', at(5).returnData) : bs.lastEquity
			mandates.push({
				mandateHash: m.hash,
				spendCap: md.spendCap,
				maxDrawdownBps: md.maxDrawdownBps,
				spent: st.spent,
				revoked: st.revoked,
				validUntil: md.validUntil,
				phase: phaseOf(bs.phase),
				peakEquity: bs.peakEquity,
				equityNow,
				drawdownBps,
				trippedAtBlock: bs.trippedAtBlock,
			})
		}
		perAgent.set(slot.agentId.toString(), { latestWindowEnd: latest.windowEnd, mandates })
	}
	return { attestor, perAgent }
}

// ------------------------------------------------------------------ handler

const onCronTrigger = (runtime: Runtime<Config>) => {
	const cfg = runtime.config
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName, isTestnet: true })
	if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`)
	const evm = new EVMClient(network.chainSelector.selector)
	const chainId = BigInt(network.chainId)

	// 1. Window from the chain head (DON-agreed), tail range for the fresh-log scan.
	const head = latestHeader(runtime, evm)
	const windowEnd = head.timestamp
	const windowStart = windowEnd - BigInt(cfg.windowSeconds)
	const tailFrom = head.number > BigInt(cfg.tailBlocks) ? head.number - BigInt(cfg.tailBlocks) : 0n
	// Block that approximately opened the window (Monad ≈ 400 ms blocks); used to judge breaker-state trips.
	const windowBlocks = BigInt(Math.floor((cfg.windowSeconds * 1000) / cfg.blockTimeMs))
	const windowFromBlock = head.number > windowBlocks ? head.number - windowBlocks : 0n
	runtime.log(`window ${windowStart}-${windowEnd} head block ${head.number} on ${network.chainSelector.name} chainId=${chainId}`)

	// 2. Discover agents: seeds, reference API, fresh onchain tail, indexer (per agent, below).
	const byAgent = new Map<string, AgentWindow>()
	for (const a of cfg.agents) {
		const w = newWindow()
		w.sources.add('config')
		for (const h of a.mandateHashes) w.mandateHashes.add(lower(h))
		byAgent.set(a.agentId, w)
	}
	try {
		for (const a of fetchReferenceAgents(runtime, cfg.referenceApiUrl)) {
			let w = byAgent.get(a.agentId)
			if (!w) byAgent.set(a.agentId, (w = newWindow()))
			w.sources.add('mandate-api')
			if (a.mandateHash) w.mandateHashes.add(lower(a.mandateHash))
			for (const e of a.executions) {
				w.mandateHashes.add(lower(e.mandateHash))
				w.executions.push({ mandateHash: lower(e.mandateHash), txHash: lower(e.txHash), blockNumber: 0n, spent: e.amount, phaseAfter: 'Armed' })
			}
		}
	} catch (e) {
		runtime.log(`reference API unavailable: ${String(e).slice(0, 160)}`)
	}
	if (cfg.tailBlocks > 0) scanTail(runtime, evm, tailFrom, head.number, byAgent)
	for (const w of byAgent.values()) {
		// chain-sourced executions (measured spend, block) replace API-sourced ones with the same tx hash
		const byTx = new Map<Hex, ExecutionObservation>()
		for (const e of w.executions) if (!byTx.has(e.txHash) || e.blockNumber > 0n) byTx.set(e.txHash, e)
		w.executions = [...byTx.values()]
	}
	for (const [agentKey, w] of byAgent) {
		try {
			const idx = fetchIndexedWindow(runtime, cfg.indexerUrl, BigInt(agentKey), windowStart)
			if (!idx) continue
			w.sources.add('envio')
			for (const h of idx.mandateHashes) w.mandateHashes.add(lower(h))
			const seen = new Set(w.executions.map((e) => e.txHash))
			for (const e of idx.executions) if (!seen.has(lower(e.txHash))) w.executions.push({ ...e, txHash: lower(e.txHash), mandateHash: lower(e.mandateHash) })
			const seenTrips = new Set(w.trips.map((t) => t.txHash))
			for (const t of idx.trips) if (!seenTrips.has(lower(t.txHash))) w.trips.push({ ...t, txHash: lower(t.txHash), mandateHash: lower(t.mandateHash) })
		} catch (e) {
			runtime.log(`agent ${agentKey}: indexer unavailable: ${String(e).slice(0, 160)}`)
		}
	}

	// 3. Everything onchain, in one read.
	const agentIds = [...byAgent.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
	const { attestor, perAgent } = readChainState(
		runtime,
		evm,
		agentIds.map((id) => ({ agentId: BigInt(id), mandateHashes: [...byAgent.get(id)!.mandateHashes].sort() })),
	)
	const receiverIsAttestor = attestor === cfg.contracts.receiver.toLowerCase()
	runtime.log(`adapter.attestor=${attestor} receiver=${cfg.contracts.receiver.toLowerCase()} ok=${receiverIsAttestor}`)

	// 4. Shared external context: market feed, LLM key.
	let markPriceUsdE6 = 0
	try {
		markPriceUsdE6 = fetchMarkPriceUsdE6(runtime, cfg.marketApiUrl)
	} catch (e) {
		runtime.log(`market feed unavailable: ${String(e).slice(0, 160)}`)
	}
	let llmKey = ''
	if (cfg.llm.enabled) {
		try {
			llmKey = runtime.getSecret({ id: 'LLM_API_KEY' }).result().value
		} catch {
			runtime.log('LLM_API_KEY secret not available: attesting without the risk note')
		}
	}

	const attested: string[] = []
	const skipped: string[] = []

	for (const agentKey of agentIds) {
		const agentId = BigInt(agentKey)
		const w = byAgent.get(agentKey)!
		const chain = perAgent.get(agentKey)!
		const sources = new Set(w.sources)
		sources.add('monad-rpc')
		if (markPriceUsdE6 > 0) sources.add('coingecko')

		if (!cfg.attestIdle && w.executions.length === 0 && w.trips.length === 0) {
			skipped.push(`${agentKey}: idle in window`)
			continue
		}
		if (chain.latestWindowEnd >= windowEnd) {
			skipped.push(`${agentKey}: already attested through ${chain.latestWindowEnd}`)
			continue
		}
		if (chain.mandates.length === 0) {
			skipped.push(`${agentKey}: no mandates found onchain`)
			continue
		}
		const mandates = chain.mandates
		for (const m of mandates) {
			const seen = w.trips.some((t) => t.mandateHash === m.mandateHash)
			// Fallback when the Tripped event itself was not observed (tail too short, indexer lag): the breaker's
			// own state says the mandate is frozen and records the block it tripped at.
			if (!seen && m.phase !== 'Armed' && m.trippedAtBlock >= windowFromBlock && m.trippedAtBlock > 0n) {
				w.trips.push({ mandateHash: m.mandateHash, blockNumber: m.trippedAtBlock, drawdownBps: m.drawdownBps })
				sources.add('breaker-state')
			}
		}

		// 5. LLM risk note on the deterministic window metrics (advisory, consensus by field).
		const pre = score({ mandates, executions: w.executions, trips: w.trips, llm: null }, windowEnd)
		let llm = null
		if (llmKey) {
			try {
				llm = fetchRiskNote(runtime, cfg.llm, llmKey, {
					agentId: agentKey,
					windowStart: windowStart.toString(),
					windowEnd: windowEnd.toString(),
					executedCount: pre.executedCount,
					tripCount: pre.tripCount,
					spentInWindow: pre.spentInWindow.toString(),
					utilisationBps: pre.utilisationBps.toString(),
					worstDrawdownBps: pre.worstDrawdownBps.toString(),
					realisedPnlBps: pre.realisedPnlBps.toString(),
					phases: mandates.map((m) => m.phase),
					revoked: mandates.some((m) => m.revoked),
					markPriceUsd: (markPriceUsdE6 / 1e6).toFixed(6),
				})
				if (llm) {
					sources.add('anthropic')
					runtime.log(`agent ${agentKey}: llm risk ${llm.riskScore}/100 ${llm.level} [${llm.flags.join(',')}] ${llm.summary}`)
				}
			} catch (e) {
				runtime.log(`agent ${agentKey}: llm note unavailable: ${String(e).slice(0, 160)}`)
			}
		}

		// 6. Final score + evidence.
		const s = score({ mandates, executions: w.executions, trips: w.trips, llm }, windowEnd)
		const evidence: Evidence = {
			schema: EVIDENCE_SCHEMA,
			chainId,
			agentId,
			windowStart,
			windowEnd,
			fromBlock: tailFrom,
			toBlock: head.number,
			mandateHashes: mandates.map((m) => m.mandateHash),
			executionTxHashes: w.executions.map((e) => e.txHash),
			tripTxHashes: w.trips.flatMap((t) => (t.txHash ? [t.txHash] : [])),
			executedCount: s.executedCount,
			tripCount: s.tripCount,
			spentInWindow: s.spentInWindow,
			realisedPnlBps: s.realisedPnlBps,
			worstDrawdownBps: s.worstDrawdownBps,
			utilisationBps: s.utilisationBps,
			complianceScore: s.complianceScore,
			markPriceUsdE6: BigInt(markPriceUsdE6),
			llmRiskScore: llm ? llm.riskScore : 255,
			llmLevel: llm ? llm.level : '',
			sources: [...sources],
		}
		const eh = evidenceHash(evidence)
		runtime.log(
			`agent ${agentKey}: score=${s.complianceScore} penalties=${JSON.stringify(s.penalties)} executed=${s.executedCount} trips=${s.tripCount} pnlBps=${s.realisedPnlBps} mandates=${mandates.length}`,
		)
		// The simulator truncates log lines around 1 kB, so the evidence JSON is logged in numbered chunks that
		// scripts/verify-evidence.ts reassembles.
		const evidenceJson = evidenceToJson(evidence)
		const chunks = evidenceJson.match(/[\s\S]{1,700}/g) ?? []
		chunks.forEach((c, i) => runtime.log(`EVIDENCE ${agentKey} ${i + 1}/${chunks.length} ${c}`))
		runtime.log(`EVIDENCE_HASH ${agentKey} ${eh}`)

		// 7. Report -> forwarder -> receiver -> adapter.attest
		const payload = encodeAbiParameters(reportParams, [
			agentId,
			{
				complianceScore: s.complianceScore,
				tripCount: s.tripCount,
				executedCount: s.executedCount,
				realisedPnlBps: s.realisedPnlBps,
				windowStart,
				windowEnd,
				evidenceHash: eh,
			},
		])
		if (cfg.dryRun || !receiverIsAttestor) {
			skipped.push(`${agentKey}: report built (${payload.length / 2 - 1} bytes) but not written: ${cfg.dryRun ? 'dryRun' : 'receiver is not the attestor'}`)
			continue
		}
		const report = runtime.report(prepareReportRequest(payload)).result()
		const resp = evm.writeReport(runtime, { receiver: cfg.contracts.receiver, report, gasConfig: { gasLimit: cfg.gasLimit } }).result()
		if (resp.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed for agent ${agentKey}: ${resp.errorMessage || resp.txStatus}`)
		// The forwarder's transaction can succeed while the receiver call inside it reverts (e.g. out of gas):
		// 0 = RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS, 1 = REVERTED. A reverted receiver means no attestation.
		if (resp.receiverContractExecutionStatus !== 0) {
			throw new Error(`receiver reverted for agent ${agentKey} (status ${resp.receiverContractExecutionStatus}); raise gasLimit or check the receiver's checks`)
		}
		const txHash = resp.txHash ? bytesToHex(resp.txHash) : '0x'
		runtime.log(`agent ${agentKey}: attestation written tx=${txHash}`)
		attested.push(`${agentKey}: score ${s.complianceScore} evidence ${eh} tx ${txHash}`)
	}

	return {
		chain: network.chainSelector.name,
		window: `${windowStart}-${windowEnd}`,
		headBlock: head.number.toString(),
		receiverIsAttestor: String(receiverIsAttestor),
		markPriceUsd: (markPriceUsdE6 / 1e6).toFixed(6),
		llm: llmKey ? 'enabled' : 'unavailable',
		attested,
		skipped,
	}
}

const initWorkflow = (config: Config) => {
	const cron = new CronCapability()
	return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
