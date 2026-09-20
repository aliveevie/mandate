# Integrate in 15 minutes

Three integration paths, each a handful of calls. All examples run against Monad testnet with the built-in addresses.

```bash
pnpm add @ibxlab/mandate viem
```

## 1. Your users issue mandates (agent platform, wallet)

You already have a principal: a passkey your app created, an embedded wallet, or a smart account that implements
ERC-1271. Build the mandate from your form, have the principal sign it, send it.

```ts
import { createMandateClient } from "@ibxlab/mandate";
import { monadTestnet } from "viem/chains";

const client = createMandateClient({ chain: monadTestnet, rpcUrl, signer: relayerAccount }); // signer pays gas for principal-side txs

// Passkey principal (browser): Face ID / Touch ID. rpId must equal your hostname.
const principal = (await client.passkey.load()) ?? (await client.passkey.create({ rpId: location.hostname }));

const draft = client.mandate.build({
  agentId: 1831n,                                   // the agent's ERC-8004 id
  agentKey: "0xAgentExecutingKey",
  targets: [{ address: venue, selectors: ["buy(address,uint256)"] }],
  asset: token,
  spendCap: parseEther("300"), perBlockCap: parseEther("150"),
  maxDrawdownBps: 1500,
  validUntil: new Date(Date.now() + 24 * 3600_000),
});
const signed = await client.mandate.sign(draft, principal);   // one passkey prompt
const tx = await client.mandate.grant(signed);              // signed.hash is the mandate hash

// later
await client.mandate.revoke(signed.hash, principal);         // effective in the block it lands
```

Principals without a passkey device: deploy a `SignerAccount` for any secp256k1 owner (an embedded wallet) with
`client.passkey.deploySignerAccount(owner)` and bind it with `attachSigner`; granting then signs EIP-712 through
whatever holds that key. The Privy integration does exactly this with a scoped session signer.

Optional, with `@ibxlab/mandate/prf`: encrypt the agent's strategy to the passkey and commit it in the mandate.

```ts
import { encryptPolicy } from "@ibxlab/mandate/prf";
const nonce = await client.publicClient.readContract({ address: client.addresses.registry, abi: MandateRegistryAbi, functionName: "nonces", args: [principal.address] });
const { vault, policyHash } = await encryptPolicy({ rpId, credentialId: principal.credentialId, principal: principal.address, nonce, policy: strategy });
const draft = client.mandate.build({ ...terms, policyHash }); // store `vault` anywhere; it is ciphertext
```

## 2. Your agent executes under a mandate (agent developer)

The agent holds the executing key and the mandate hash. Everything else is read from the chain.

```ts
const client = createMandateClient({ chain: monadTestnet, rpcUrl });
const agent = client.agent.load({ mandateHash, executor: privateKeyToAccount(AGENT_KEY) });

const m = await agent.mandate();        // targets, selectors, caps, expiry: what the principal signed
const s = await agent.state();          // spent, remaining, breaker phase, active

try {
  await agent.execute({ target: venue, data: encodeFunctionData({ abi, functionName: "buy", args: [token, amount] }), amount });
} catch (e) {
  if (e instanceof MandateError) {
    // e.name is the Solidity error: TargetNotAllowed, SpendCapExceeded, PerBlockCapExceeded, Tripped, MandateRevoked, MandateExpired…
    // Nothing was sent. Adjust and retry, or stop.
  }
}
```

`amount` is the most `asset` the call may move out of the principal's account. The executor measures the real outflow
and reverts with `SpendExceedsDeclared` if the venue took more. `agent.validate(params)` runs the same checks without
sending, which is what an LLM tool should call first.

**LLM agents.** `sdk/examples/agent-tool.ts` turns a loaded agent into a single tool, `execute_under_mandate`, whose
schema is generated from the mandate (allowed selectors, caps, expiry) and whose handler returns the protocol's typed
refusal as the tool result. Drop the definition into any tool-calling loop.

## 3. You consume reputation (marketplace, router, another agent)

```ts
const rep = await client.reputation.get(agentId);
// { score: 60, trips: 1, executed: 8, pnlBps: -1510n, attestations: 2, erc8004: { count, value } }
const history = await client.reputation.history(agentId); // every attestation with windows and evidence hashes
```

Scores are written only by the Chainlink CRE workflow through `CREAttestationReceiver` → `ERC8004ReputationAdapter`,
and mirrored into the ERC-8004 Reputation Registry with tag `mandate-compliance`, so they are also readable with plain
ERC-8004 tooling. Each attestation's `evidenceHash` is recomputable from public inputs; the workflow logs the evidence
and `cre/scripts/verify-evidence.ts` checks it.

For dashboards, the Envio schema exposes `Mandate`, `Execution`, `BreakerEvent` and `Attestation` entities; see
[Indexer](indexer.md).

## Checklist before production

- Pin `@ibxlab/mandate` and `viem` exactly; both ship provenance attestations.
- Never whitelist the protocol's own contracts as targets (the SDK refuses; do the same if you build mandates by hand).
- Size venue allowances to the mandate; see [Security → Scope notes](security.md#scope-notes-what-the-caps-do-and-do-not-bound).
- Keep the agent key funded with gas only; it never holds principal funds.
- Open an [integration issue](https://github.com/aliveevie/mandate/issues/new?template=integration.yml) to get a review and a listing.
