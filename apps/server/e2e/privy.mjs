/**
 * Privy proof against the live server (needs a server started with the four PRIVY_* variables):
 *   - the provisioned agent's key is a Privy server wallet (custody = privy, no local key)
 *   - a grant mirrors a wallet policy; Privy refuses to sign anything outside it (policy probe)
 *   - the agent still executes within the mandate through Privy signing
 *   - revocation flips the policy to deny-all
 *
 *   API=http://localhost:8787 node e2e/privy.mjs
 */
import { createMandateClient, PasskeyAccountAbi } from "@ibxlab/mandate";
import { createPublicClient, http, encodeFunctionData, parseAbi } from "viem";
import { monadTestnet } from "viem/chains";

const API = process.env.API ?? "http://localhost:8787";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
async function api(p, body) {
  const r = await fetch(API + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? j(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${JSON.stringify(d)}`);
  return d;
}
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

const cfg = await api("/api/config");
assert(cfg.privy.enabled, "server is not configured for Privy");
const client = createMandateClient({ chain: monadTestnet, rpcUrl: cfg.rpcUrl, addresses: cfg.addresses });
const pc = createPublicClient({ chain: monadTestnet, transport: http(cfg.rpcUrl, { batch: true }) });

// principal: software passkey via the relay (the Privy part under test is the agent side)
const key = await client.passkey.createKey({ rpId: "localhost", software: true });
const acc = await api("/api/relay/account", { publicKey: key.publicKey });
const principal = await client.passkey.attach(key, acc.address);
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const call = { target: cfg.demo.asset, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [cfg.demo.venue, 2n ** 256n - 1n] }) };
const nonce = await pc.readContract({ address: acc.address, abi: PasskeyAccountAbi, functionName: "nonce" });
const digest = await pc.readContract({ address: acc.address, abi: PasskeyAccountAbi, functionName: "executeDigest", args: [call, nonce] });
await api("/api/relay/execute", { account: acc.address, call, signature: await principal.signChallenge(digest) });
lap(`principal ${acc.address} ready`);

const agent = await api("/api/agents", { label: "privy-e2e" });
assert(agent.custody === "privy" && agent.privyWalletId, "agent key is not a Privy server wallet");
lap(`agent #${agent.agentId}: Privy server wallet ${agent.privyWalletId} at ${agent.agentKey}`);

const draft = client.mandate.build({
  agentId: BigInt(agent.agentId), agentKey: agent.agentKey,
  targets: [{ address: cfg.demo.venue, selectors: ["buy(address,uint256)", "noop()"] }],
  asset: cfg.demo.asset, spendCap: 200n * 10n ** 18n, perBlockCap: 100n * 10n ** 18n, maxDrawdownBps: 5000,
  validUntil: new Date(Date.now() + 3600e3),
});
const signed = await client.mandate.sign(draft, principal);
const g = await api("/api/relay/grant", signed);
assert(g.policy?.policyId, `no policy mirrored: ${JSON.stringify(g.policy)}`);
lap(`granted ${g.mandateHash.slice(0, 12)}; Privy policy ${g.policy.policyId} attached (${g.policy.rules.length} rules)`);

const probe = await api(`/api/agents/${agent.id}/policy-probe`, { mandateHash: g.mandateHash });
assert(probe.blocked, `Privy signed a transfer outside the policy: ${JSON.stringify(probe)}`);
lap(`policy probe: Privy refused an out-of-policy transfer (${(probe.reason ?? "").slice(0, 90)})`);

await api(`/api/agents/${agent.id}/run`, { mandateHash: g.mandateHash });
let st;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  st = await api(`/api/agents/${agent.id}/state?mandateHash=${g.mandateHash}`);
  if (st.agent.feed.some((f) => f.kind === "executed")) break;
}
assert(st.agent.feed.some((f) => f.kind === "executed"), "agent did not execute through Privy");
await api(`/api/agents/${agent.id}/stop`, {});
lap(`agent executed within the mandate, signed by Privy (spent ${(Number(st.state.spent) / 1e18).toFixed(0)})`);

const rd = await client.mandate.revokeDigest(acc.address, g.mandateHash);
await api("/api/relay/revoke", { account: acc.address, mandateHash: g.mandateHash, signature: await principal.signChallenge(rd) });
const after = await api(`/api/agents/${agent.id}/state?mandateHash=${g.mandateHash}`);
assert(after.agent.policy?.revoked === true, "policy was not set to deny-all after revoke");
lap(`revoked; Privy policy ${after.agent.policy.policyId} is deny-all`);
const probe2 = await api(`/api/agents/${agent.id}/policy-probe`, { mandateHash: g.mandateHash });
assert(probe2.blocked, "deny-all policy did not block");
lap("post-revoke probe refused as well");
console.log("PRIVY FLOW OK");
