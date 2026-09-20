# Who builds on Mandate

Mandate is infrastructure. It has no end users of its own; it has integrators. This page names them, says why they
would take a dependency rather than build the same thing, and lists what each one calls.

## Three integrator profiles

| Profile | What they ship | What they get from Mandate | SDK surface |
|---|---|---|---|
| **Agent platforms and wallets** (passkey wallets, embedded-wallet apps, agent launchpads) | A place where a person authorises an agent | A passkey-owned account, a signed and revocable authorisation the chain enforces, one kill switch, and no session-key code of their own | `passkey.*`, `mandate.build/sign/grant/revoke`, `prf.*` for policy vaults and per-agent identities |
| **Agent developers** (trading agents, ops agents, consumer assistants) | An agent that spends someone else's money | Bounds they can read, typed refusals before a transaction is sent, and a reputation record they cannot forge | `agent.load/validate/execute`, `mandate.get/state`, `reputation.get` |
| **Reputation consumers** (marketplaces, routers, other agents choosing counterparties) | Ranking or gating of agents | ERC-8004 feedback written only from onchain evidence by a DON-signed workflow, with a recomputable evidence hash | `reputation.get/history`, the ERC-8004 registry, the Envio GraphQL schema |

## Why not build it yourself

Every team that lets an agent touch a wallet ends up writing the same four things: a session-key scheme, a spend
limiter, a circuit breaker, and some notion of "is this agent any good". Done properly that is weeks of security work
and an audit, and the result is private to one product.

| Roll your own | With Mandate |
|---|---|
| Session keys held by the agent, with app-specific limits enforced off-chain | Limits enforced by the registry on Monad; the agent key cannot exceed them even if the app is compromised |
| Revocation that depends on the app being online | Passkey revoke that takes effect in the block it lands |
| A drawdown check in the agent loop | A hysteresis breaker anyone can checkpoint and only the principal can re-arm |
| A leaderboard the agent reports into | ERC-8004 attestations written by a single authorised attestor from evidence anyone can recompute |
| Strategy parameters in a database | Strategy encrypted to the principal's passkey; the mandate commits to the ciphertext |
| Weeks of work, one product | One dependency, shared across products, audited once |

## Composability: what Mandate never owns

- **Keys.** Passkeys stay in the authenticator. Agent keys can be plain EOAs, Privy server wallets, or anything that can sign; Mandate only needs the address.
- **Venues.** Any contract can be a target. Mandate has no allow-list of its own.
- **Reputation.** Written into the canonical ERC-8004 Reputation Registry, readable by anyone without Mandate.
- **Front ends and relayers.** The reference app is one client. Wallet mode needs no relayer at all.
- **Data.** Policy vaults are ciphertext in any store; the indexer schema is public; the evidence hash is recomputable from public inputs.

No single operator, including the authors, can revoke a mandate, forge an attestation, read a policy, or stop a passkey
from re-deriving its keys on another device.

## Integrations shipped with the protocol

| Integration | What it adds | Where |
|---|---|---|
| Privy | Server wallets as agent keys, wallet policies that mirror mandates, scoped session signers for principals without a passkey device | [Integrations → Privy](integrations.md#privy) |
| Chainlink CRE | The only reputation writer: a DON workflow that scores compliance from onchain evidence and writes ERC-8004 attestations | [Integrations → Chainlink CRE](integrations.md#chainlink-cre) |
| Mera PRF | One passkey, many keys: passkey-encrypted policy vaults and passkey-derived ERC-8004 identity owners | [Integrations → Mera PRF](integrations.md#mera-prf) |

## Integrating

Start with [Integrate in 15 minutes](integrate.md). Open an issue with the *Integration* template to get your mandate
parameters reviewed and your project listed here. The first five integrators get a free IBX Lab review of their
integration.
