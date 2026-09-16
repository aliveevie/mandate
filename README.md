# Mandate

**Mandate is a delegation and trust primitive for the agent economy on Monad.** Humans issue scoped, revocable, privately-executed *mandates* to ERC-8004 agents from a passkey. Agents accumulate portable onchain reputation for how they honour them. Any app that lets an AI agent touch a wallet integrates Mandate instead of rolling its own session keys.

See `MANDATE_PROTOCOL_BUILD_SPEC.md` for the build plan.

## Status

| Piece | State |
|---|---|
| Contracts (`contracts/`) | Live on Monad testnet. Addresses and tx hashes in `contracts/deployments/monad-testnet.json` |
| SDK `@ibxlab/mandate` (`sdk/`) | Quickstart runs end to end against testnet: `cd sdk && pnpm quickstart` |
| Indexer (`indexer/`) | Envio HyperIndex, verified locally against testnet; deploy on Envio Cloud |
| Docs (`docs/`) | mkdocs-material site, builds with `--strict`; published by the Pages workflow |
| Reference app (`apps/`) | Vite UI + Express server, Dockerised; `docker build . && docker run -p 8787:8787 -e DEMO_AGENT_DEPLOYER_KEY=… mandate-reference` |
| Chainlink CRE (`cre/`) | `mandate-reputation-attestor` workflow is the only reputation writer; receiver live on Monad testnet, simulation logs committed (`cre/simulation*.log`) |
| Bounty PRs | Privy ✔ · Chainlink CRE ✔ · Mera PRF next |

**Private execution mode:** the testnet `PrivateSubmitter` is deployed in **BTX mode**, which routes mandated calls through Monad's encrypted mempool so strategy and policy are not observable before inclusion. The same contract ships a commit-reveal mode behind the same `IPrivateSubmit` interface; redeploying with `SUBMITTER_MODE=1` switches to it. BTX is the production target.

## Run the reference app

```bash
pnpm install
pnpm --filter @ibxlab/mandate build
# terminal 1: API + agent runner (needs a funded Monad testnet key; it only pays gas)
cd apps/server && DEMO_AGENT_DEPLOYER_KEY=0x… pnpm dev
# terminal 2: UI with a proxy to the server
cd apps/web && pnpm dev            # http://localhost:5173
```

Four screens: **Passkey** (create a passkey; its smart account is deployed and seeded with demo tokens), **Grant** (provision an ERC-8004 agent, sign a scoped mandate with the passkey), **Agent** (run the demo agent, watch spend vs caps and the breaker gauge, force an out-of-bounds call, revoke), **Reputation** (ERC-8004 score ring and attestation history).

**Two ways to pay gas, one way to authorise.** The passkey always authorises. With a wallet connected (MetaMask, Rabby, Phantom on Monad testnet) your wallet signs and pays every principal transaction, and it registers and funds your own ERC-8004 agent, so the relayer is not involved. Without a wallet the app runs in gasless demo mode and the server's relayer pays. Unspent agent gas is swept back to whoever funded the agent when it stops.

Proofs that run against the live app: `pnpm --filter server e2e` drives the whole flow through the API with a software passkey; `pnpm --filter web e2e` does the same in real Chrome with a WebAuthn virtual authenticator, so `navigator.credentials` and on-chain P256 verification are exercised for real; `WALLET_KEY=0x… node apps/web/e2e/wallet.mjs` runs wallet mode with an injected signing provider and asserts the relayer sent nothing for the principal.

## Privy

With `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` and `PRIVY_KEY_QUORUM_ID` set on the server, agent keys become Privy server wallets, every granted mandate is mirrored as a wallet policy on the agent wallet (deny-all after revocation), and users without a passkey device can sign in with Privy and delegate a scoped session signer so granting and revoking never prompt. See `docs/integrations.md#privy`. `pnpm --filter server e2e:privy` proves all of it against the live server.

## Security and CI

`docs/security.md` holds the threat model, the seven tested properties and the Slither triage. CI (`.github/workflows/ci.yml`) runs the Foundry suite with invariants at the CI profile, the SDK anvil e2e, indexer codegen and typecheck, web and server builds, the Docker image, gitleaks over history, Slither with the triaged config, and a strict docs build.

### Deploy to Render

`render.yaml` is a Blueprint: in the Render dashboard choose **New → Blueprint**, pick this repository, and set `DEMO_AGENT_DEPLOYER_KEY` to a funded Monad testnet key when prompted. The Docker image serves the UI and API on one service with `/healthz` for health checks. WebAuthn needs HTTPS and an `rpId` equal to the hostname; the UI always uses `window.location.hostname`, so the Render domain works with no build-time configuration. The free plan sleeps when idle: first load can take about 30 seconds.

Copy `.env.example` → `.env` / `.env.local` and fill values locally. Those files are gitignored.
