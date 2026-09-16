// Recompute an attestation's evidenceHash from the evidence the workflow logged and compare it with what the adapter
// stores onchain.
//   bun run scripts/verify-evidence.ts <simulation.log> [agentId] [rpcUrl] [adapter]
//   bun run scripts/verify-evidence.ts '<evidence json>'  [agentId] [rpcUrl] [adapter]
import { readFileSync, statSync } from 'node:fs'
import { createPublicClient, http } from 'viem'
import { ReputationAdapterAbi } from '../mandate-reputation-attestor/abi'
import { evidenceFromJson, evidenceHash } from '../mandate-reputation-attestor/evidence'

const [input, agentFilter, rpcUrl = 'https://testnet-rpc.monad.xyz', adapter = '0x3b1d977C1270dF25252041D0671b6FD90dF7a757'] = process.argv.slice(2)
if (!input) {
	console.error('usage: bun run scripts/verify-evidence.ts <simulation.log | evidence-json> [agentId] [rpcUrl] [adapter]')
	process.exit(2)
}

/** Reassemble `EVIDENCE <agent> <i>/<n> <chunk>` lines (last complete set per agent) from a simulation log. */
function evidenceFromLog(text: string): Map<string, { json: string; loggedHash?: string }> {
	const out = new Map<string, { json: string; loggedHash?: string }>()
	const parts = new Map<string, string[]>()
	for (const line of text.split('\n')) {
		const m = line.match(/EVIDENCE (\d+) (\d+)\/(\d+) (.*)$/)
		if (m) {
			const [, agent, i, n, chunk] = m
			const arr = parts.get(agent) ?? []
			if (i === '1') arr.length = 0
			arr[Number(i) - 1] = chunk
			parts.set(agent, arr)
			if (Number(i) === Number(n)) out.set(agent, { json: arr.join('') })
			continue
		}
		const h = line.match(/EVIDENCE_HASH (\d+) (0x[0-9a-fA-F]{64})/)
		if (h) {
			const e = out.get(h[1])
			if (e) e.loggedHash = h[2]
		}
	}
	return out
}

const candidates = new Map<string, { json: string; loggedHash?: string }>()
const source: string = input
const isFile = (() => {
	try {
		return statSync(source).isFile()
	} catch {
		return false
	}
})()
if (isFile) {
	for (const [agent, e] of evidenceFromLog(readFileSync(source, 'utf8'))) candidates.set(agent, e)
} else {
	const json = source.startsWith('EVIDENCE ') ? source.replace(/^EVIDENCE( \d+ \d+\/\d+)? /, '') : source
	candidates.set(agentFilter ?? 'input', { json })
}
if (candidates.size === 0) {
	console.error('no complete EVIDENCE set found')
	process.exit(2)
}

const client = createPublicClient({ transport: http(rpcUrl) })
let failures = 0
for (const [agent, e] of candidates) {
	if (agentFilter && agent !== agentFilter && agent !== 'input') continue
	const evidence = evidenceFromJson(e.json)
	const local = evidenceHash(evidence)
	console.log(`agent ${evidence.agentId} window ${evidence.windowStart}-${evidence.windowEnd} score ${evidence.complianceScore}`)
	console.log(`  recomputed evidenceHash ${local}${e.loggedHash ? (e.loggedHash.toLowerCase() === local.toLowerCase() ? ' (matches the logged hash)' : ` (LOGGED HASH DIFFERS: ${e.loggedHash})`) : ''}`)
	const count = await client.readContract({ address: adapter as `0x${string}`, abi: ReputationAdapterAbi, functionName: 'attestationCount', args: [evidence.agentId] })
	let match = false
	for (let i = 0n; i < count; i++) {
		const a = await client.readContract({ address: adapter as `0x${string}`, abi: ReputationAdapterAbi, functionName: 'attestationAt', args: [evidence.agentId, i] })
		if (a.evidenceHash.toLowerCase() === local.toLowerCase()) {
			console.log(`  onchain: attestation #${i} score=${a.complianceScore} trips=${a.tripCount} executed=${a.executedCount} pnlBps=${a.realisedPnlBps} window ${a.windowStart}-${a.windowEnd}`)
			match = true
		}
	}
	if (!match) {
		console.log(`  onchain: no attestation with this evidenceHash (${count} attestation(s) for the agent)`)
		failures++
	}
}
process.exit(failures ? 1 : 0)
