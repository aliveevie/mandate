# Integrations

Mandate is meant to sit under other people's agents. This page collects the integration surfaces that exist today and the three partner integrations that ship as separate pull requests.

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
| `eth_sendTransaction` ALLOW | `to == MandateExecutor`, `chain_id == 10143`, `value == 0`, calldata is `execute(mandateHash == this mandate, target in whitelist, amount <= perBlockCap)`, and `now <= validUntil` |
| `personal_sign`, `eth_signTypedData_v4`, `eth_signTransaction`, `exportPrivateKey` DENY | nothing else, ever |

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

*Ships in the `feat/cre` pull request.*

The `mandate-reputation-attestor` workflow is the attestor. It fetches executions from the indexer, venue fills from the venue API, asks an LLM for a structured risk note, computes the compliance score, trip count and realised PnL, hashes the inputs into `evidenceHash`, and calls `ERC8004ReputationAdapter.attest`. Because only the attestor can write reputation, the workflow is the trust layer's single writer.

## Mera PRF

*Ships in the `feat/mera-prf` pull request.*

Two non-account uses of the passkey's PRF output with namespaced salts:

- `mandate:policy:<mandateHash>` derives, through HKDF, an AES-GCM key that encrypts the agent's strategy and running context. The mandate's `policyHash` commits to the ciphertext. Only the principal's passkey can decrypt.
- `mandate:agent-id:<n>` derives a deterministic keypair used as the ERC-8004 identity owner for agent `n`, unlinkable across agents and reconstructible from the passkey alone.
