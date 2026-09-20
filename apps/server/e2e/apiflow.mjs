/**
 * Drives the whole reference flow through the server API with a software passkey (no browser):
 * account relay -> passkey-signed approve -> agent provisioning -> grant -> agent loop until the breaker
 * trips -> out-of-bounds typed revert -> passkey revoke -> reputation.
 *
 *   API=http://localhost:8787 node e2e/apiflow.mjs
 */
import { createMandateClient, PasskeyAccountAbi } from "@ibxlab/mandate";
import { createPublicClient, http, encodeFunctionData, parseAbi, encodeAbiParameters, keccak256 } from "viem";
import { monadTestnet } from "viem/chains";

const API = process.env.API ?? "http://localhost:8787";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
let SESSION = null;
async function api(p, body) {
  const r = await fetch(API + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(SESSION ? { authorization: `Bearer ${SESSION}` } : {}) }, body: body ? j(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${JSON.stringify(d)}`);
  return d;
}
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const cfg = await api("/api/config");
const client = createMandateClient({ chain: monadTestnet, rpcUrl: cfg.rpcUrl, addresses: cfg.addresses });
const pc = createPublicClient({ chain: monadTestnet, transport: http(cfg.rpcUrl, { batch: true }) });

const key = await client.passkey.createKey({ rpId: "localhost", software: true });
const acc = await api("/api/relay/account", { publicKey: key.publicKey });
const principal = await client.passkey.attach(key, acc.address);
// Session: one passkey signature over a chain-bound challenge, checked by the server via ERC-1271.
{
  const issuedAt = Date.now();
  const digest = keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], ["mandate:session:v1", BigInt(cfg.chainId), acc.address, BigInt(issuedAt)]));
  SESSION = (await api("/api/session", { account: acc.address, issuedAt, signature: await principal.signChallenge(digest) })).token;
}
lap(`account ${acc.address} (demo tokens minted ${acc.mintTx.slice(0, 12)})`);

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const call = { target: cfg.demo.asset, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [cfg.demo.venue, 2n ** 256n - 1n] }) };
const nonce = await pc.readContract({ address: acc.address, abi: PasskeyAccountAbi, functionName: "nonce" });
const digest = await pc.readContract({ address: acc.address, abi: PasskeyAccountAbi, functionName: "executeDigest", args: [call, nonce] });
const ex = await api("/api/relay/execute", { account: acc.address, call, signature: await principal.signChallenge(digest) });
lap(`approve relayed ${ex.hash.slice(0, 12)}`);

const agent = await api("/api/agents", { label: "apiflow" });
lap(`agent provisioned #${agent.agentId} key ${agent.agentKey}`);

const draft = client.mandate.build({
  agentId: BigInt(agent.agentId), agentKey: agent.agentKey,
  targets: [{ address: cfg.demo.venue, selectors: ["buy(address,uint256)", "noop()"] }],
  asset: cfg.demo.asset, spendCap: 300n * 10n ** 18n, perBlockCap: 300n * 10n ** 18n, maxDrawdownBps: 1500,
  validUntil: new Date(Date.now() + 3600e3),
});
const signed = await client.mandate.sign(draft, principal);
const g = await api("/api/relay/grant", signed);
lap(`granted ${g.mandateHash.slice(0, 12)} tx ${g.hash.slice(0, 12)}`);

await api(`/api/agents/${agent.id}/run`, { mandateHash: g.mandateHash });
let st;
for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  st = await api(`/api/agents/${agent.id}/state?mandateHash=${g.mandateHash}`);
  if (!st.agent.running) break;
}
const executed = st.agent.feed.filter((f) => f.kind === "executed").length;
lap(`agent stopped: "${st.agent.stopReason}" after ${executed} executions, spent ${(Number(st.state.spent) / 1e18).toFixed(0)}, breaker ${st.state.breaker} at ${st.state.drawdownBps} bps`);
if (st.state.breaker !== "Tripped") throw new Error("expected the breaker to trip");

const forced = await api(`/api/agents/${agent.id}/force-out-of-bounds`, { mandateHash: g.mandateHash });
lap(`out-of-bounds blocked=${forced.blocked} ${forced.error?.name}`);
if (forced.error?.name !== "TargetNotAllowed") throw new Error("expected TargetNotAllowed");

const rd = await client.mandate.revokeDigest(acc.address, g.mandateHash);
const rv = await api("/api/relay/revoke", { account: acc.address, mandateHash: g.mandateHash, signature: await principal.signChallenge(rd) });
const after = await api(`/api/agents/${agent.id}/state?mandateHash=${g.mandateHash}`);
lap(`revoked tx ${rv.hash.slice(0, 12)} -> revoked=${after.state.revoked} active=${after.state.active}`);
if (!after.state.revoked) throw new Error("expected revoked");

const rep = await api(`/api/reputation/1831`);
lap(`reputation 1831: score ${rep.score}, ${rep.attestations} attestation(s), erc8004 ${JSON.stringify(rep.erc8004)}`);
console.log("API FLOW OK");
