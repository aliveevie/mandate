# Integrations

Mandate is meant to sit under other people's agents. This page collects the integration surfaces that exist today and the three partner integrations that ship with the protocol.

## Integrate Mandate into your agent stack

1. **Principal side**: your app calls `client.passkey.create` in the browser, builds a mandate with `client.mandate.build`, and gets it signed and granted. Store the mandate hash.
2. **Agent side**: your agent runner holds the executing key, loads the mandate with `client.agent.load`, and routes every on-chain action through `agent.execute`. Handle `MandateError` by name.
3. **Observability**: read `agent.state()` for caps and breaker phase, or query the [indexer](indexer.md) for history.
4. **Reputation**: read `client.reputation.get(agentId)` or the ERC-8004 registry directly.

The [quickstart](quickstart.md) is the smallest complete example.

## Privy

Privy is used for three things beyond sign-in, each of which removes a class of risk from the reference deployment. The integration lives in `@ibxlab/mandate/privy` (SDK), `apps/server/src/privy.ts` (server) and `apps/web/src/lib/privy.tsx` (UI), and switches on when four environment variables are set:

```
PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_KEY_QUORUM_ID
```

Without them the app runs exactly as before with local demo keys.

### 1. Server wallets are the agent keys

Every provisioned agent's executing key is a Privy server wallet owned by our key quorum. The server never holds a private key: it holds a P-256 authorization key and asks Privy's TEE to sign. In the SDK this is one line, because a server wallet is exposed as a viem account:

```ts
const privy = await createPrivyIntegration({ appId, appSecret, authorizationKey, keyQuorumId, chainId, addresses });
const wallet = await privy.agents.createWallet({ label: "trader-1" });
const agent = client.agent.load({ mandateHash, executor: privy.agents.account(wallet) });
await agent.execute({ target, data, amount });   // signed inside Privy, validated by the registry
```

### 2. Wallet policies mirror the mandate

When a mandate is granted, the server writes a policy onto the agent wallet that says the same thing the chain says, in Privy's language:

| Rule | What it allows |
|---|---|
| `eth_signTransaction` and `eth_sendTransaction` ALLOW | `to == MandateExecutor`, `chain_id == 10143`, `value == 0`, calldata is `execute(mandateHash == this mandate, target in whitelist, amount <= perBlockCap)`, and `now <= validUntil` |
| `personal_sign`, `eth_signTypedData_v4`, `exportPrivateKey` DENY | nothing else, ever |

The chain remains the enforcement layer and additionally holds the lifetime cap and the breaker. Privy is defence in depth: a compromised agent process cannot even produce a signature outside the mandate, so a bad transaction never exists. On revocation the policy is replaced with a single deny-all rule. `buildMandatePolicy` is a pure function with unit tests, and the Agent screen has a **Test the policy** button that asks Privy to sign a plain transfer and shows the refusal.

### 3. Session signers for principals without a passkey device

A user can sign in with Privy (email, Google, passkey or wallet) and get an embedded wallet. The app then:

1. Deploys a `SignerAccount` owned by that embedded wallet, the ECDSA sibling of `PasskeyAccount` whose owner actions are EIP-712 typed data.
2. Creates a scope policy allowing the server's key quorum to sign `eth_signTypedData_v4` only when the domain is the Mandate registry or that account on chain 10143, and nothing else.
3. Asks the user, once, to delegate a session signer with that policy attached.

From then on, granting and revoking do not prompt: the server signs the `Mandate`, `Execute` and `Revoke` typed data through the session signer and relays the transaction. The delegation is revocable by the user in their Privy account at any time, and the policy means the server could not use the signer for anything but Mandate even if it tried.

### Authorization keys

Agent wallets, mirror policies and session-signer scope policies are all owned by one key quorum, so only a holder of that authorization key can change them. Register the key in the dashboard under Authorization keys, or generate one with `generateP256KeyPair()` from `@privy-io/node` and create the quorum with `privy.keyQuorums().create({ public_keys: [publicKey] })`.

### Verify it yourself

```bash
cd apps/server && PRIVY_APP_ID=… PRIVY_APP_SECRET=… PRIVY_AUTHORIZATION_KEY=… PRIVY_KEY_QUORUM_ID=… \
  DEMO_AGENT_DEPLOYER_KEY=0x… pnpm dev
pnpm --filter server e2e:privy    # server-wallet agent -> grant -> policy mirrored -> policy probe refused -> revoke -> deny-all
```

## Chainlink CRE

The `mandate-reputation-attestor` workflow (`cre/`) is the **only writer of
Mandate reputation**: its onchain identity, `CREAttestationReceiver`, holds the `ERC8004ReputationAdapter` Attestor role,
so every score in the ERC-8004 Reputation Registry was computed by the DON from verifiable inputs. Agents cannot
self-attest and neither can the deployer any more.

### What one run does

1. **Window** — reads the chain head through the EVM capability; the window is the last `windowSeconds`.
2. **Discover** — merges configured seeds, the reference API (`/api/agents`), a bounded scan of the freshest blocks for
   `MandateGranted` / `MandateExecuted` / `Tripped`, and, per agent, the Envio GraphQL indexer (`Execution`, `BreakerEvent`,
   `Mandate` for the window). Indexer and API calls run in node mode with identical-aggregation consensus.
3. **Onchain truth** — one Multicall3 read returns the adapter's attestor, the latest attestation per agent and, per mandate,
   `getMandate`, `getState`, the breaker `stateOf`, `currentDrawdownBps` and `equityOf`. CRE allows 15 chain reads per
   execution and Monad's public RPC caps `eth_getLogs` at 100 blocks, so the whole run fits in 1 header + ≤13 log
   chunks + 1 multicall (+1 write); the config schema refuses `tailBlocks`/`logChunkBlocks` combinations that exceed it.
4. **External context** — the MON/USD mark from CoinGecko (median consensus) and a structured risk note from Claude
   (`claude-opus-5`, JSON-schema output). Each node reports only the integer `riskScore`; the DON takes the median and
   `level` is derived from it, so free text never has to agree byte for byte across nodes (each node's summary is in its
   own log). The LLM is advisory: without a key the attestation proceeds without it and the evidence says so.
5. **Score** — `scoring.ts` is pure and unit-tested: 100 minus 15 per trip (max 45), 10 while frozen, up to 20 for drawdown
   relative to the mandate's own limit, 5 above 90% cap utilisation, 5 for an early revoke, 10/5 for a high/medium LLM
   level. `realisedPnlBps` is mark-to-peak equity from the breaker.
6. **Evidence** — `evidenceHash = keccak256(abi.encode(Evidence))` (schema v2) over the window, blocks, every
   per-mandate onchain input exactly as read (`spendCap`, `maxDrawdownBps`, `spent`, `revoked`, `validUntil`, breaker
   phase, peak and current equity, drawdown, trip block), execution and trip tx hashes, counts, spend, PnL, the penalty
   breakdown, mark price, LLM score/level and the list of sources. `complianceScore` is therefore recomputable from the
   evidence alone. The evidence JSON is logged in numbered chunks; `bun run scripts/verify-evidence.ts <simulation.log>`
   reassembles it, recomputes the hash and finds the matching attestation onchain.
7. **Write** — `runtime.report(abi.encode(agentId, Attestation))` → `evmClient.writeReport` → KeystoneForwarder →
   `CREAttestationReceiver.onReport` → `adapter.attest` → mirrored into the ERC-8004 registry as `giveFeedback`.

**Fail-safe by default.** If a configured source (the indexer or the reference API) is unreachable in a run, the run is
*degraded*: missing trips or executions would only ever raise a score, so no attestation is written unless
`attestWhenDegraded` is set. One agent's failed write never blocks the others; the run still reports the failure.

### The receiver

`contracts/src/cre/CREAttestationReceiver.sol` implements Chainlink's `IReceiver` (+ ERC-165). It accepts reports only
from allow-listed forwarders (the Monad testnet KeystoneForwarder and the MockKeystoneForwarder used by
`cre workflow simulate --broadcast`), optionally pins the workflow owner, name (`sha256(name)` hex prefix as `bytes10`,
the same encoding as Chainlink's `ReceiverTemplate`) and id, and discards stale windows per agent. Deployed on Monad testnet
at `0x0c89d72a5ABf96556EEB14c31d87D55c7ECCC573`; `adapter.setAttestor(receiver)` tx
`0x7d3a366c11e20a2a06f475bad11899864effc4f9bf8a4f234fa86969128039dd`.

### Run it

```bash
cd cre && bun install
cp .env.example .env            # CRE_ETH_PRIVATE_KEY (funded), optional LLM_API_KEY_VALUE (Anthropic)
bun test && bun run typecheck   # scoring + evidence unit tests
bun run simulate                # dry run: reads Monad, builds the report, no transaction
bun run simulate:broadcast      # writes through the MockKeystoneForwarder; requires `cre login`
```

`cre/simulation.log` and `cre/simulation-broadcast.log` are committed runs. The broadcast run wrote attestation #1 for
agent `1869` (score 60: one breaker trip, drawdown at the limit, early revoke) in tx
`0x6e1c564d808369ba339d31f95606cace3396b0625c3cbd1917fa9d7fb8b1a35b`; `bun run scripts/verify-evidence.ts
simulation-broadcast.log` recomputes its evidence hash from the log and finds that attestation onchain. The report gas
limit is 600k: the receiver path (forwarder → receiver → adapter → ERC-8004 mirror) measures ~420k, and a forwarder
transaction can succeed while the receiver call inside it runs out of gas, so the workflow also checks the reply's
`receiverContractExecutionStatus`. Monad testnet is declared as an
`experimental-chains` entry in `project.yaml` (selector `2183018362218727504`) because it is not in the CLI's built-in
chain list yet; deploying to a DON uses the `production-settings` target and the production forwarder.

### Trust boundary

- Only the receiver can attest; only allow-listed forwarders can call the receiver; only DON-signed reports pass the
  forwarder. Revoking the mock forwarder (`setForwarder(mock, false)`) closes the simulation path for production.
- `expectedAuthor` / `expectedWorkflowName` pin the receiver to one workflow owner once the workflow is deployed (the
  simulator reports placeholder owner `0xaaaa…` and id `0x1111…`, so leave them unset for simulation).
- Stale or replayed windows revert (`StaleReport`); the adapter still enforces score ≤ 100 and `windowEnd > windowStart`.

## Mera PRF

**One passkey, many keys**: the passkey that owns the `PasskeyAccount` also
does two jobs that are not wallet signing, each under its own PRF namespace, with nothing derived ever stored.

| Namespace (PRF salt = `sha256(namespace)`) | Derivation | Job |
|---|---|---|
| `mandate:policy:<principal>:<nonce>` | PRF → HKDF-SHA-256 (`mandate:prf:policy-key:v1`) → AES-256-GCM key | Encrypts the agent's strategy parameters. Ciphertext lives in a dumb blob store; the mandate's onchain `policyHash` commits to it. |
| `mandate:agent-id:<n>` | PRF → HKDF-SHA-256 (`mandate:prf:agent-identity:v1:<n>`) → secp256k1 key | Owns agent *n*'s ERC-8004 identity. Unlinkable across agents; re-derivable from the passkey on any device. |

Correctness rules, enforced by code and tests (`sdk/test/prf.test.ts`): derivation ≠ encryption (HKDF for keys, AES-GCM for
data), every namespace is a distinct PRF salt so outputs are unrelated at the authenticator, PRF outputs and derived keys
are zeroized after use, and no secret is persisted anywhere (no server DB, no localStorage, no env).

### Library

`@category-labs/mera@0.2.0` (Category Labs; published from GitHub Actions with SLSA provenance, tarball checksum and
sources verified against tag `v0.2.0`). The SDK uses `getPasskeyPrfOutput` for the ceremony with an explicit namespaced
`prfSalt`, `createSecp256k1SigningSession` + `getEvmAddress` + `toViemAccount` for the per-agent identity, and WebCrypto
for HKDF and AES-GCM. Passkeys are created with the PRF extension requested so synced platform passkeys can evaluate PRF.

```ts
import { encryptPolicy, decryptPolicy, deriveAgentIdentity, PRF_NAMESPACE, policyHashOf } from "@ibxlab/mandate/prf";

// 1. seal the strategy before signing the mandate (nonce = registry.nonces(principal))
const { vault, policyHash } = await encryptPolicy({ rpId, credentialId, principal, nonce, policy: { strategy: "mean-reversion", maxSlippageBps: 25 } });
const draft = client.mandate.build({ ...terms, policyHash });      // the mandate commits to the ciphertext
await fetch(`/api/blobs/${policyHash}`, { method: "PUT", body: JSON.stringify(vault) }); // any dumb store

// 2. the agent's identity: deterministic, never stored
const id = await deriveAgentIdentity({ rpId, credentialId, agentId });
await fetch(`/api/agents/${agentId}/claim`, { method: "POST", body: JSON.stringify({ owner: id.address }) }); // relayer transfers the ERC-8004 NFT
id.end();

// 3. on any device: only the passkey and the mandate hash are needed
const { policy } = await decryptPolicy({ rpId, vault: await (await fetch(`/api/blobs/${m.policyHash}`)).json() });
```

### In the reference app

- **Grant** — "Agent strategy, encrypted with your passkey": edits the policy, seals it (PRF ceremony), puts `policyHash`
  in the mandate, stores the vault at `PUT /api/blobs/:policyHash` (the server validates that the hash matches the
  vault's canonical encoding and can neither read nor alter it). "Own this identity with my passkey" derives
  `mandate:agent-id:<n>` and calls `POST /api/agents/:id/claim`; the relayer transfers the ERC-8004 identity to that key.
- **Passkey screen → "One passkey, many keys"** — the cross-device check: paste a mandate hash (or open
  `/?verify=<mandateHash>`), press "Re-derive with passkey". With no local state, the app reads the mandate's
  `policyHash` onchain, fetches the vault, decrypts it, re-derives the agent identity and compares it with `ownerOf(agentId)`
  in the ERC-8004 registry. "Simulate a fresh device" wipes local storage and reloads into that flow.

### Proof

`apps/web/e2e/webauthn.mjs` drives Chrome with a CDP virtual authenticator (`hasPrf: true`): it claims the identity,
grants with an encrypted policy, wipes every byte of local state, reloads with only the mandate hash and asserts that the
decrypted policy and the re-derived identity equal what was created, and that the identity equals the onchain owner.
Chrome's virtual authenticator cannot export its PRF secret, so the automated run proves *zero local state → same keys*;
the true two-device run (a synced passkey on a second phone or laptop, same decrypted policy, same identity address) is the
on-camera step.

