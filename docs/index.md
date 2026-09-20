# Mandate

**Mandate is a delegation and trust primitive for the agent economy on Monad.** Humans issue scoped, revocable, privately-executed *mandates* to ERC-8004 agents from a passkey. Agents accumulate portable onchain reputation for how they honour them. Any app that lets an AI agent touch a wallet integrates Mandate instead of rolling its own session keys.

Mandate is a primitive, not a product. The reference app exists only to prove the SDK works. The customers are trading-agent and consumer-agent teams who would otherwise hand-roll session keys and self-reported leaderboards.

## What you get

| You want | Mandate gives you |
|---|---|
| A human to authorise an agent without a seed phrase | A `PasskeyAccount` owned by a P256 passkey, verified on-chain through Monad's RIP-7212 precompile |
| Hard limits the agent cannot talk its way around | Whitelisted targets and selectors, lifetime and per-block spend caps, expiry, all enforced by the registry, with real asset outflow measured on-chain |
| A kill switch | Passkey revoke that takes effect in the block it lands, and a hysteresis drawdown breaker that freezes the agent automatically |
| Errors you can program against | Every Solidity custom error surfaces in the SDK as a `MandateError` with the same name and arguments, before a transaction is sent |
| Reputation that is not a leaderboard | Compliance attested by one authorised attestor from on-chain evidence and mirrored into the ERC-8004 Reputation Registry. Agents cannot self-attest |
| Pre-inclusion privacy | Execution through Monad's BTX encrypted mempool, with a commit-reveal mode behind the same interface |

## Why no single platform can capture it

- **Authorisation lives in the authenticator.** The passkey never leaves the device; the account it owns is a contract on Monad. No operator can sign for the principal.
- **Enforcement lives in the registry.** Caps, whitelist, expiry and revocation are checked onchain on every call. Compromising the app, the relayer or the agent does not widen a mandate.
- **Reputation lives in ERC-8004 and is written from evidence.** The only writer is a DON-signed workflow whose evidence hash anyone can recompute; the operator cannot forge a score and the agent cannot self-report.
- **Policy lives in ciphertext.** Strategy is encrypted to the principal's passkey; the store that holds it learns nothing.
- **Every other part is replaceable.** Relayer, front end, indexer, agent key custody and venues are all integrator choices. Wallet mode needs no server at all.

## Who builds on it

Agent platforms and wallets (issuing mandates), agent developers (executing under them), and marketplaces or routers
(consuming reputation). [Who builds on Mandate](adopters.md) names them and explains why they would not build it
themselves; [Integrate in 15 minutes](integrate.md) shows each path in code.

## Where things are

- **Monad testnet deployment** and every transaction hash: [Contracts](contracts.md)
- **Install**: `pnpm add @ibxlab/mandate viem` ([npm](https://www.npmjs.com/package/@ibxlab/mandate))
- **Ten-minute quickstart** against testnet: [Quickstart](quickstart.md); every call, typed: [SDK reference](sdk-reference.md)
- **How mandates, the breaker and reputation fit together**: [Concepts](concepts.md)
- **Threat model and the seven tested properties**: [Security](security.md)
- **GraphQL for mandates, executions and reputation**: [Indexer](indexer.md)
- **Reference app** (four screens, wallet connect or gasless relay): [Try the reference app](try-it.md)
- **What ships next**: [Roadmap](roadmap.md)

## The three Monad primitives, and how Mandate uses each

| Building block | Use in Mandate |
|---|---|
| P256 precompile / WebAuthn | Passkey-rooted `PasskeyAccount`. Mandates are signed by the passkey and verified on-chain via the precompile at `0x100` |
| ERC-8004 agent registry | Every agent is an ERC-8004 identity. Reputation is written by the attestor from verified compliance, not self-reported |
| BTX encrypted mempool | Mandated agent transactions are submitted encrypted so strategy and policy are not observable before inclusion |
