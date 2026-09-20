<p align="center"><img src="assets/logo.png" alt="Mandate" width="96" /></p>

# Mandate

**Mandate is a delegation and trust primitive for the agent economy on Monad.** A person authorises an AI agent from a passkey with a scoped, revocable, privately executed *mandate*: which contracts, which functions, how much per block and in total, what drawdown trips the breaker, until when. The chain enforces it on every call. The agent is an ERC-8004 identity and earns portable reputation for how it honours its mandates, written only from onchain evidence.

Mandate is infrastructure. The reference app exists to prove the SDK; the customers are the wallets, agent platforms and agent developers who would otherwise hand-roll session keys, spend limiters, circuit breakers and self-reported leaderboards.

| | |
|---|---|
| **Docs** | https://aliveevie.github.io/mandate/ — [quickstart](https://aliveevie.github.io/mandate/quickstart/) · [integrate in 15 minutes](https://aliveevie.github.io/mandate/integrate/) · [SDK reference](https://aliveevie.github.io/mandate/sdk-reference/) · [security model](https://aliveevie.github.io/mandate/security/) |
| **Contracts** | Live on Monad testnet (chain id 10143). Addresses and every deployment tx: [`contracts/deployments/monad-testnet.json`](contracts/deployments/monad-testnet.json) |
| **SDK** | [`@ibxlab/mandate` on npm](https://www.npmjs.com/package/@ibxlab/mandate) (TypeScript, viem): `pnpm add @ibxlab/mandate viem`. Source in [`sdk/`](sdk/); `cd sdk && pnpm quickstart` runs the whole protocol against testnet |
| **Live app** | **https://mandate-reference.onrender.com** — passkey → grant → agent → reputation, plus the Mera cross-device check. No credentials needed. [How to use it](https://aliveevie.github.io/mandate/try-it/) |
| **Who builds on it** | [Adopters and why not build it yourself](https://aliveevie.github.io/mandate/adopters/) · [Roadmap](https://aliveevie.github.io/mandate/roadmap/) |

## Thirty seconds of code

```ts
import { createMandateClient, MandateError } from "@ibxlab/mandate";

const client = createMandateClient({ chain: monadTestnet, rpcUrl, signer: relayer });

// principal: a passkey owns a smart account on Monad; one Face ID tap signs the mandate
const principal = (await client.passkey.load()) ?? (await client.passkey.create({ rpId: location.hostname }));
const signed = await client.mandate.sign(client.mandate.build({ agentId, agentKey, targets: [{ address: venue, selectors: ["buy(address,uint256)"] }], spendCap, perBlockCap, maxDrawdownBps: 1500, validUntil }), principal);
await client.mandate.grant(signed);

// agent: reads its bounds from the chain and is refused, before sending, for anything outside them
const agent = client.agent.load({ mandateHash: signed.hash, executor: agentKeyAccount });
try { await agent.execute({ target: venue, data, amount }); }
catch (e) { if (e instanceof MandateError) console.log(e.name, e.args); } // TargetNotAllowed, SpendCapExceeded, Tripped, MandateRevoked…

// anyone: reputation written from evidence, mirrored into ERC-8004
const rep = await client.reputation.get(agentId); // { score, trips, executed, pnlBps, erc8004 }
```

## What is built on Monad's primitives

| Building block | Use in Mandate |
|---|---|
| **P256 precompile (RIP-7212) / WebAuthn** | `PasskeyAccount` is owned by a passkey. Every mandate, owner action and revoke is a WebAuthn assertion verified onchain at `0x100`. Mera PRF turns the same passkey into an encryption key for the agent's strategy and into deterministic per-agent identity keys. |
| **ERC-8004** | Every agent is an ERC-8004 identity (optionally owned by a passkey-derived key). Reputation is written into the canonical Reputation Registry only by the Chainlink CRE workflow's onchain identity, from an evidence hash anyone can recompute. |
| **BTX encrypted mempool** | `PrivateSubmitter` is deployed in BTX mode on testnet so mandated calls are not observable before inclusion; a commit-reveal mode ships behind the same interface (`SUBMITTER_MODE=1`). BTX is the production target. |

## Why no single platform can capture it

Authorisation lives in the authenticator; enforcement lives in the registry; reputation lives in ERC-8004 and is written from evidence by a DON; policy lives in ciphertext only the passkey opens; and the relayer, front end, indexer, agent-key custody and venues are all replaceable. Wallet mode runs with no server at all.

## Repository

| Path | Contents |
|---|---|
| `contracts/` | Foundry. `MandateRegistry`, `PasskeyAccount`, `SignerAccount`, `RiskBreaker`, `MandateExecutor`, `PrivateSubmitter`, `ERC8004ReputationAdapter`, `CREAttestationReceiver`. 92 tests incl. invariants; Slither triaged in `docs/security.md` |
| `sdk/` | `@ibxlab/mandate`: client, typed errors 1:1 with Solidity, EIP-712 helpers, `prf` and `privy` entry points, anvil e2e with the real P256 precompile, runnable examples |
| `apps/server/` | Express API and agent runner: relayer, principal-bound sessions, ERC-8004 registration, Privy wiring, policy blob store |
| `apps/web/` | Vite + React reference client: passkey, grant, agent, reputation, Mera cross-device check |
| `cre/` | Chainlink CRE workflow `mandate-reputation-attestor`, the only reputation writer; committed simulation logs |
| `indexer/` | Envio HyperIndex: mandates, executions, breaker events, attestations |
| `docs/` | mkdocs site, built with `--strict` in CI |

## Integrations

| | |
|---|---|
| **Privy** | Agent keys are Privy server wallets; every granted mandate is mirrored as a wallet policy (deny-all after revocation); principals without a passkey device sign in with Privy and delegate a scoped session signer. `pnpm --filter server e2e:privy` proves it. [Details](https://aliveevie.github.io/mandate/integrations/#privy) |
| **Chainlink CRE** | The workflow reads the window onchain and from the indexer, adds a market feed and a structured LLM risk note, scores compliance, hashes the evidence and writes the attestation through the KeystoneForwarder. Receiver live at `0x0c89d72a5ABf96556EEB14c31d87D55c7ECCC573`. [Details](https://aliveevie.github.io/mandate/integrations/#chainlink-cre) |
| **Mera PRF** | One passkey, many keys: `mandate:policy:<principal>:<nonce>` encrypts the agent's strategy (the mandate commits to the ciphertext); `mandate:agent-id:<n>` derives the key that owns agent *n*'s ERC-8004 identity. Re-derivable on any device the passkey syncs to. [Details](https://aliveevie.github.io/mandate/integrations/#mera-prf) |

## Run it

```bash
pnpm install && pnpm --filter @ibxlab/mandate build
cd apps/server && DEMO_AGENT_DEPLOYER_KEY=0x… pnpm dev   # API + agent runner; the key only pays gas
cd apps/web && pnpm dev                                  # http://localhost:5173
```

Proofs against a running app: `pnpm --filter server e2e` (the whole flow through the API with a software passkey) and `pnpm --filter web e2e` (real Chrome with a WebAuthn virtual authenticator: passkey creation, four PRF ceremonies, onchain P256 verification, breaker trip, revoke, the fresh-device check). `WALLET_KEY=0x… node apps/web/e2e/wallet.mjs` runs wallet mode and asserts the relayer sent nothing for the principal.

## Security

`docs/security.md` has the threat model, the seven tested properties with the tests that prove them, the Slither triage and the scope notes. No secret (passkey private key, PRF output, Privy key) is ever in a contract, log, committed file or server database; CI runs gitleaks over the full history. Contributions and integrations: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Deploy

`render.yaml` is a Render Blueprint (Docker, `/healthz`, one service for UI and API). Set `DEMO_AGENT_DEPLOYER_KEY` to a funded testnet key; add the four `PRIVY_*` variables to turn on the Privy features; encrypted policy vaults persist at `BLOB_STORE_PATH` (attach a disk at `/app/data` to keep them across redeploys). WebAuthn needs HTTPS with `rpId` equal to the hostname, which the UI derives at runtime. Copy `.env.example` files locally; every `.env` is gitignored.
