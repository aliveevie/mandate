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
| Bounty PRs | Next phases |

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

Four screens: **Onboard** (create a passkey, the server deploys its account and seeds demo tokens), **Grant** (provision an ERC-8004 agent, sign a scoped mandate with the passkey), **Agent** (run the demo agent, watch spend vs caps and the breaker, force an out-of-bounds call, revoke), **Reputation** (ERC-8004 score and attestation history).

Proofs that run against the live app: `pnpm --filter server e2e` drives the whole flow through the API with a software passkey; `pnpm --filter web e2e` does the same in real Chrome with a WebAuthn virtual authenticator, so `navigator.credentials` and on-chain P256 verification are exercised for real.

### Deploy to Render

`render.yaml` is a Blueprint: in the Render dashboard choose **New → Blueprint**, pick this repository, and set `DEMO_AGENT_DEPLOYER_KEY` to a funded Monad testnet key when prompted. The Docker image serves the UI and API on one service with `/healthz` for health checks. WebAuthn needs HTTPS and an `rpId` equal to the hostname; the UI always uses `window.location.hostname`, so the Render domain works with no build-time configuration. The free plan sleeps when idle: first load can take about 30 seconds.

Copy `.env.example` → `.env` / `.env.local` and fill values locally. Those files are gitignored.
