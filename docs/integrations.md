# Integrations

Mandate is meant to sit under other people's agents. This page collects the integration surfaces that exist today and the three partner integrations that ship as separate pull requests.

## Integrate Mandate into your agent stack

1. **Principal side**: your app calls `client.passkey.create` in the browser, builds a mandate with `client.mandate.build`, and gets it signed and granted. Store the mandate hash.
2. **Agent side**: your agent runner holds the executing key, loads the mandate with `client.agent.load`, and routes every on-chain action through `agent.execute`. Handle `MandateError` by name.
3. **Observability**: read `agent.state()` for caps and breaker phase, or query the [indexer](indexer.md) for history.
4. **Reputation**: read `client.reputation.get(agentId)` or the ERC-8004 registry directly.

The [quickstart](quickstart.md) is the smallest complete example.

## Privy

*Ships in the `feat/privy` pull request.*

- Server wallets as agent keys. Each agent's executing key is a Privy server wallet provisioned by the SDK.
- Wallet policies mirroring the mandate. At grant time the SDK writes a matching Privy policy (allowed contracts, max value, expiry) onto the agent wallet. The registry enforces on-chain; Privy pre-blocks off-chain.
- Session signers for principals who use an embedded wallet instead of a passkey device. EOA principals are already accepted by the registry through ECDSA.

## Chainlink CRE

*Ships in the `feat/cre` pull request.*

The `mandate-reputation-attestor` workflow is the attestor. It fetches executions from the indexer, venue fills from the venue API, asks an LLM for a structured risk note, computes the compliance score, trip count and realised PnL, hashes the inputs into `evidenceHash`, and calls `ERC8004ReputationAdapter.attest`. Because only the attestor can write reputation, the workflow is the trust layer's single writer.

## Mera PRF

*Ships in the `feat/mera-prf` pull request.*

Two non-account uses of the passkey's PRF output with namespaced salts:

- `mandate:policy:<mandateHash>` derives, through HKDF, an AES-GCM key that encrypts the agent's strategy and running context. The mandate's `policyHash` commits to the ciphertext. Only the principal's passkey can decrypt.
- `mandate:agent-id:<n>` derives a deterministic keypair used as the ERC-8004 identity owner for agent `n`, unlinkable across agents and reconstructible from the passkey alone.
