# Mandate Protocol — End-to-End Build Spec

Track: **Trust, Identity & AI Infrastructure** (Monad Metropolis, deadline 14 Oct 2026 04:59 GMT+1)
Bounties: **Privy**, **Chainlink CRE**, **Mera PRF** (each in its own PR)
Team: IBX Lab (aliveevie / iabdulkarim.eth)

This document is written for an autonomous coding agent. Follow it top to bottom. Every section that says **GATE** must pass before moving on. Do not add features not listed here; the judged score comes from doing fewer things correctly.

---

## 0. One-liner and positioning (memorise this — it goes in every README, video, and pitch)

> **Mandate is a delegation and trust primitive for the agent economy on Monad.** Humans issue scoped, revocable, privately-executed *mandates* to ERC-8004 agents from a passkey. Agents accumulate portable onchain reputation for how they honour them. Any app that lets an AI agent touch a wallet integrates Mandate instead of rolling its own session keys.

Track fit statement (say verbatim in the pitch): *"Mandate is a primitive, not a product. Our reference app exists only to prove the SDK works; the customers are the trading-agent and consumer-agent teams in Tracks 1 and 2 who otherwise hand-roll session keys and self-reported leaderboards."*

The three Monad building blocks the track names, and how we use each:

| Building block | Use in Mandate |
|---|---|
| P256 precompile / WebAuthn | Passkey-rooted `PasskeyAccount`; mandates are signed by the passkey and verified onchain via the precompile |
| ERC-8004 agent registry | Every agent is an ERC-8004 identity; reputation is written by the CRE workflow from verified compliance, not self-reported |
| BTX encrypted mempool | Mandated agent txs are submitted encrypted so strategy and policy are not observable pre-inclusion |

**BTX caveat:** verify current BTX availability on Monad testnet in week 1 (docs.monad.xyz). If it is not usable, implement a commit-reveal execution path behind the same interface and state in the README that BTX is the production target. Judges reward honesty over a faked integration.

---

## 1. Machine constraints (read before running anything)

Dev machine: MacBook Air, 8GB RAM.
- Never run more than two heavy processes at once (e.g. `forge test` + `next dev` is the maximum; never add an indexer or a browser with 20 tabs on top).
- Use `forge test --match-path` for targeted runs; run the full suite only before opening a PR.
- Fuzz with `runs = 256` locally; set `runs = 2000` only in CI (GitHub Actions).
- Envio indexer runs in Envio Cloud (free for teams), not locally.
- CRE workflow simulation via CLI is lightweight; run it alone.
- Prefer Quicknode/Tenderly free tiers over any local node.

---

## 2. Repository layout (monorepo)

```
mandate/
├── contracts/                 # Foundry
│   ├── src/
│   │   ├── MandateRegistry.sol
│   │   ├── PasskeyAccount.sol
│   │   ├── modules/RiskBreaker.sol
│   │   ├── adapters/ERC8004ReputationAdapter.sol
│   │   ├── execution/MandateExecutor.sol
│   │   ├── execution/PrivateSubmitter.sol   # BTX or commit-reveal
│   │   ├── interfaces/*.sol
│   │   └── libraries/MandateLib.sol         # EIP-712 hashing
│   ├── test/
│   │   ├── unit/
│   │   ├── invariant/
│   │   └── BaseTest.sol
│   └── script/Deploy.s.sol
├── sdk/                       # @ibxlab/mandate (TypeScript, viem)
│   ├── src/
│   │   ├── index.ts
│   │   ├── mandate.ts         # build/sign/submit mandates
│   │   ├── agent.ts           # agent-side: load mandate, execute within bounds
│   │   ├── passkey.ts         # WebAuthn create/sign (P256)
│   │   ├── prf.ts             # Mera PRF namespaces (PR-4)
│   │   ├── privy.ts           # Privy server-wallet + session signer glue (PR-2)
│   │   └── reputation.ts      # read ERC-8004 reputation
│   └── README.md              # the 10-minute quickstart
├── indexer/                   # Envio HyperIndex config + handlers
├── cre/                       # Chainlink CRE workflow (PR-3)
├── apps/web/                  # Vite + React UI (reference integration)
├── apps/server/               # Express API + agent runner (serves the built UI)
├── Dockerfile                 # single image: builds web, runs server
├── render.yaml                # Render blueprint
├── docs/                      # docs site (mkdocs or Nextra) — DX is 20% of score
│   ├── quickstart.md
│   ├── concepts.md
│   ├── security.md            # threat model + what we DON'T protect
│   └── integrations.md        # Privy / CRE / Mera how-tos
└── .github/workflows/ci.yml
```

---

## 3. Protocol design

### 3.1 Roles
- **Principal**: human. Controls a `PasskeyAccount` (P256). Issues mandates.
- **Agent**: ERC-8004 registered identity with its own executing key (a Privy server wallet in PR-2; a plain EOA in core).
- **Venue**: any contract the mandate whitelists (Kuru/Perpl in the reference app; a mock DEX in tests).
- **Attestor**: the CRE workflow's onchain identity, authorised to write reputation via the adapter.

### 3.2 Mandate (EIP-712 typed struct)

```solidity
struct Mandate {
    address principal;      // PasskeyAccount
    uint256 agentId;        // ERC-8004 id
    address agentKey;       // executing key
    address[] targets;      // allowed contracts
    bytes4[]  selectors;    // allowed function selectors per target (parallel array or bitmap)
    address   asset;        // spend asset
    uint256   spendCap;     // lifetime cap
    uint256   perBlockCap;  // max spend per block (Monad-native: per-block enforcement)
    uint256   maxDrawdownBps;
    uint64    validAfter;
    uint64    validUntil;
    uint256   nonce;
    bytes32   policyHash;   // hash of encrypted off-chain policy blob (PR-4)
}
```

EIP-712 domain: `name="Mandate", version="1", chainId, verifyingContract=MandateRegistry`.

### 3.3 Contracts

**PasskeyAccount.sol**
- Minimal smart account. Owner = P256 public key (x, y).
- `isValidSignature` verifies WebAuthn assertion through the Monad P256 precompile. Reuse an audited WebAuthn verifier lib if one exists for Monad; otherwise implement clientDataJSON challenge check + authenticatorData flags check + precompile call. **Do not hand-roll P256 math.**
- Supports `execute(target, value, data)` from owner, and `grantMandate(mandate, sig)` which forwards to the registry.

**MandateRegistry.sol**
- `grant(Mandate m, bytes sig)`: verifies principal signature via `PasskeyAccount.isValidSignature`, stores `keccak(m)` → `MandateState{spent, spentThisBlock, lastBlock, revoked, peakEquity}`.
- `revoke(bytes32 mandateHash)`: principal only. Immediate.
- `validate(bytes32 mandateHash, address target, bytes4 selector, uint256 amount)`: view; reverts with typed errors (`TargetNotAllowed`, `SpendCapExceeded`, `PerBlockCapExceeded`, `MandateExpired`, `MandateRevoked`, `Tripped`).
- Nonce per principal; replay-safe; expiry checks.

**RiskBreaker.sol** (module)
- Hysteresis FSM: `Armed → Tripped` when drawdown > `maxDrawdownBps`; `Tripped → Cooldown → Armed` only after N blocks *and* equity recovers above a re-arm threshold (lower than trip threshold — hysteresis prevents flapping).
- Emits `Tripped(mandateHash, agentId, drawdownBps, block)`. This event is a reputation input.

**MandateExecutor.sol**
- `execute(bytes32 mandateHash, address target, bytes data, uint256 amount)`: callable only by `mandate.agentKey`. Calls `validate`, applies breaker, performs the call, updates state, emits `MandateExecuted(...)`.

**PrivateSubmitter.sol**
- Interface `IPrivateSubmit`. Implementation A: BTX encrypted submission (if available). Implementation B: commit-reveal (`commit(hash)` then `reveal(calldata)` ≥1 block later). Same interface; selected at deploy time; README states which is live.

**ERC8004ReputationAdapter.sol**
- Writes reputation feedback into the ERC-8004 Reputation Registry on behalf of the Attestor role only.
- Schema: `{complianceScore 0-100, tripCount, executedCount, realisedPnlBps, windowStart, windowEnd, evidenceHash}`.
- `evidenceHash` = hash of the CRE workflow's computed inputs (verifiable off-chain).

### 3.4 Security properties (write these in `docs/security.md` and prove in tests)
1. An agent can never spend more than `spendCap` lifetime or `perBlockCap` per block. (invariant)
2. An agent can never call a non-whitelisted target/selector. (invariant)
3. Revocation takes effect in the same block it is mined; no pending mandate survives. (unit)
4. Breaker tripped ⇒ zero executions until re-armed. (invariant)
5. A mandate signature is bound to chainId + registry; replay across chains/contracts fails. (unit)
6. Only the Attestor can write reputation; agents cannot self-attest. (unit)
7. No secret (passkey private key, PRF outputs, Privy keys) ever appears in a contract, log, env-committed file, or server DB. (review checklist)

**GATE (core):** all 7 properties have tests; `forge test` green; invariant suite green at 256 runs; Slither/ack3 scan run with findings triaged in `docs/security.md`.

---

## 4. SDK — `@ibxlab/mandate` (this is where Design & Craft is won)

Public API (keep it this small):

```ts
import { createMandateClient } from "@ibxlab/mandate";

const client = createMandateClient({ chain: monadTestnet, rpcUrl });

// Principal side
const principal = await client.passkey.create({ rpId: "yourapp.xyz" }); // or .load()
const mandate = client.mandate.build({ agentId, agentKey, targets, spendCap, perBlockCap, maxDrawdownBps, validUntil });
const signed  = await client.mandate.sign(mandate, principal);
await client.mandate.grant(signed);
await client.mandate.revoke(signed.hash, principal);

// Agent side
const agent = client.agent.load({ mandateHash, executor: agentSigner });
await agent.execute({ target, data, amount });      // throws typed MandateError before sending
const rep = await client.reputation.get(agentId);   // { score, trips, executed, pnlBps }
```

Requirements:
- Full TypeScript types; typed errors mirror Solidity custom errors 1:1.
- `README.md` = 10-minute quickstart: install → create passkey → grant mandate → agent executes → read reputation. Must be runnable end-to-end against testnet by a stranger.
- `docs/concepts.md` explains mandates, breaker, reputation in <800 words with one diagram.
- Publish to npm before submission (scoped package, version `0.1.0`).

**GATE (SDK):** a person who has never seen the repo completes the quickstart in ≤10 minutes on testnet. Record it — this doubles as traction evidence.

---

## 5. Indexer (Envio)
- Index `MandateGranted`, `MandateExecuted`, `MandateRevoked`, `Tripped`, `ReputationAttested`.
- Expose GraphQL: mandates by principal, executions by mandate, reputation history by agent.
- Hosted on Envio Cloud. The reference app and the CRE workflow both read from it.

---

## 6. UI + server — Vite reference app, Dockerised for Render

Purpose: a live, judge-clickable product link (mandatory deliverable) that proves the SDK end to end. It is a reference integration, not the product; keep it to the screens listed.

### 6.1 Stack
- **UI:** Vite + React + TypeScript, wagmi/viem, `@ibxlab/mandate` consumed as a workspace package. Tailwind for layout. WebAuthn/passkey and Mera PRF calls run in the browser (they must — the passkey never leaves the device).
- **Server:** Node 20 + Express + TypeScript (`apps/server`). Responsibilities:
  1. Serve the built Vite bundle from `/` in production (single deployable).
  2. `POST /api/agents` — provision an agent: Privy server wallet + ERC-8004 registration (PR-2).
  3. `POST /api/agents/:id/run` and `/stop` — start/stop the demo agent loop that trades on Kuru/Perpl within its mandate.
  4. `GET /api/agents/:id/state` — spend vs cap, per-block usage, breaker state (reads chain + Envio GraphQL).
  5. `GET /api/reputation/:agentId` — ERC-8004 reputation history.
  6. `GET /healthz` — for Render health checks.
- Server holds **no user secrets**. Only its own deployer key (for demo agent gas) and Privy/Envio API keys, all via env vars.
- Dev: `pnpm dev` runs Vite on :5173 with a proxy to Express on :8787 (one process each — respects the 8GB limit).

### 6.2 Screens (exactly four)
1. **Onboard** — create/load passkey (Face ID/Touch ID). Shows the derived `PasskeyAccount` address. Mera PRF cross-device panel lives here (PR-4).
2. **Grant** — build a mandate with a form (agent, targets, spend cap, per-block cap, drawdown, expiry) → sign with passkey → grant tx. Shows the Privy policy that was mirrored (PR-2).
3. **Agent** — Run/Stop the agent. Live panel: executions feed, spend vs cap bar, per-block cap gauge, breaker state (Armed / Tripped / Cooldown). Buttons: "Force out-of-bounds call" (shows typed revert) and "Revoke" (kills the agent mid-run).
4. **Reputation** — ERC-8004 score for the agent, attestation history from CRE, evidence hashes (PR-3).

### 6.3 Docker
Single multi-stage image at repo root:
```dockerfile
# ---- build ----
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY sdk ./sdk
COPY apps/web ./apps/web
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ibxlab/mandate build \
 && pnpm --filter web build \
 && pnpm --filter server build

# ---- run ----
FROM node:20-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/sdk/dist ./node_modules/@ibxlab/mandate/dist
EXPOSE 8787
CMD ["node", "dist/index.js"]
```
Express serves `./public` statically with SPA fallback to `index.html`, and mounts `/api/*` and `/healthz`.

### 6.4 Render deployment
`render.yaml` at repo root:
```yaml
services:
  - type: web
    name: mandate-reference
    runtime: docker
    plan: free
    dockerfilePath: ./Dockerfile
    healthCheckPath: /healthz
    envVars:
      - key: PORT
        value: "8787"
      - key: MONAD_RPC_URL
        sync: false
      - key: MONAD_CHAIN_ID
        sync: false
      - key: MANDATE_REGISTRY
        sync: false
      - key: MANDATE_EXECUTOR
        sync: false
      - key: ERC8004_IDENTITY_REGISTRY
        sync: false
      - key: ERC8004_REPUTATION_ADAPTER
        sync: false
      - key: ENVIO_GRAPHQL_URL
        sync: false
      - key: PRIVY_APP_ID
        sync: false
      - key: PRIVY_APP_SECRET
        sync: false
      - key: DEMO_AGENT_DEPLOYER_KEY
        sync: false
      - key: VITE_RP_ID
        sync: false   # must equal the Render hostname for WebAuthn
```
Notes:
- `VITE_*` vars must be present at **build** time; pass them as Docker build args from Render (or hardcode the public ones in `.env.production`).
- WebAuthn `rpId` must match the deployed hostname (`mandate-reference.onrender.com` or your custom domain), and the site must be HTTPS — Render provides both.
- Free plan sleeps on idle; add a note in the submission ("first load may take ~30s") or use a paid plan for judging week.
- Demo credentials for judges: none needed for the passkey path; provide a pre-funded demo agent id in the access instructions.

**GATE (UI):** Render URL loads, all four screens work against testnet, `/healthz` returns 200, `docker build . && docker run -p 8787:8787` reproduces it locally.

---

## 7. Bounty PRs

### PR-1 `core` — everything in sections 3–6 above (no bounty code). Merge to `main` first.

### PR-2 `feat/privy` — Privy bounty ($5,000) — "beyond authentication"
Integrate at least three Privy features so the demo clearly shows Privy-powered functionality:
1. **Server wallets as agent keys.** Every agent's `agentKey` is a Privy server wallet. The SDK (`privy.ts`) provisions it via the Privy server SDK.
2. **Privy wallet policies mirroring the mandate.** When a mandate is granted, the SDK writes a matching Privy policy (allowed contracts, max value, expiry) onto the agent's server wallet. This is defense-in-depth: the onchain registry enforces, Privy pre-blocks — explain this framing on camera.
3. **Session signers for principals.** Principal's embedded wallet (for users without a passkey device) gets a scoped session signer so granting/revoking doesn't prompt every time.
4. (Optional) **Privy authorization keys** to sign mandate grants server-side for automated principals (DAO treasuries).
Demo beat: show the Privy dashboard policy appearing at grant time, and a policy-blocked tx when the agent tries to exceed it.
Deliverable: `docs/integrations.md#privy`, demo clip, PR description listing each feature used.

### PR-3 `feat/cre` — Chainlink CRE bounty ($3,000) — orchestration layer
Workflow `mandate-reputation-attestor`:
- **Trigger:** cron (every N minutes) or onchain event `MandateExecuted` (use whichever CRE trigger type is supported on Monad at build time).
- **Fetch:** executions from the Envio GraphQL endpoint (external data source), venue fill data from the Kuru/Perpl API (external API), and an LLM call (any provider) that returns a short structured risk note on the agent's behaviour window (LLM integration — satisfies "external API/LLM/AI agent").
- **Compute:** `complianceScore` from executions vs mandate bounds, trip count, realised PnL. Hash the inputs → `evidenceHash`.
- **Write:** call `ERC8004ReputationAdapter.attest(...)` on Monad via the workflow's onchain identity.
- **Deliverable:** successful `cre simulate` run recorded (mandatory), live deployment if the network supports Monad targets. Include the simulation log in the repo.
This is the single most defensible "meaningful orchestration" story: the workflow is the only party allowed to write reputation, so the entire trust layer depends on it.

### PR-4 `feat/mera-prf` — Mera "One Passkey, Many Keys" bounty ($2,500) — NOT wallet signing
Use Mera's PRF output with namespaced salts for two non-account jobs:
1. **Encrypted agent memory / policy blob.** Salt namespace `mandate:policy:<mandateHash>` → HKDF → AES-GCM key. The agent's strategy parameters and running context are encrypted to this key, stored on any dumb blob store (IPFS/Arweave/S3 — doesn't matter, it's ciphertext). `policyHash` in the onchain mandate commits to it. Only the principal's passkey can decrypt; nothing sensitive is persisted anywhere.
2. **Per-agent isolated identities.** Salt namespace `mandate:agent-id:<n>` → derives a deterministic P256/secp256k1 keypair used as the *ERC-8004 identity owner* for agent n. Unlinkable across agents, reconstructible from the passkey alone.
**Cross-device test (mandatory, on camera):** open the app in a fresh browser profile, authenticate with the same passkey, decrypt the same policy blob and re-derive the same agent identity address. Show both addresses match.
Correctness rules: derivation ≠ encryption (HKDF for keys, AES-GCM for data), salts genuinely namespaced, zero secrets on disk or server. Document in `docs/integrations.md#mera`.

Dropped: Cleanverse ($2k). A centralised KYC issuer gating asset movement contradicts the track's "not capturable by a single platform" criterion. Only add as an opt-in compliance module if the core and three PRs are done with a week to spare.

---

## 8. Execution phases (agent protocol)

The agent works one phase at a time. At the end of every phase it **stops, reports what was built, what passed, what is uncertain, and waits for the next instruction.** It never starts the next phase on its own.

Report format at each stop:
```
PHASE n DONE
Built:      <files/contracts/features>
Verified:   <tests run, results, deployed addresses/tx hashes>
Uncertain:  <anything assumed, e.g. BTX availability, registry address>
Next:       Phase n+1 — <one line>. Awaiting go-ahead.
```

| Phase | Do | Verify before stopping |
|---|---|---|
| 0 | Recon: confirm on Monad testnet the P256 precompile address, the ERC-8004 identity/reputation registry addresses, and BTX availability. Scaffold the monorepo (section 2). | Precompile responds to a test call; registry addresses recorded in `contracts/script/Addresses.sol`; BTX decision (A or B) written in README |
| 1 | Main contracts: `MandateLib`, `MandateRegistry`, `PasskeyAccount`, `RiskBreaker`, `MandateExecutor`, `PrivateSubmitter`, `ERC8004ReputationAdapter`. | Unit + invariant tests for all 7 security properties green (`forge test`, 256 runs) |
| 2 | Deploy to testnet. Run one real end-to-end flow with a script: create passkey → grant → agent executes → out-of-bounds revert → breaker trip → revoke. | Every step has a tx hash on the explorer; script committed as `script/E2E.s.sol` |
| 3 | SDK `@ibxlab/mandate` + README quickstart + typed errors. | Quickstart runs end-to-end against the deployed contracts from a clean clone |
| 4 | Envio indexer + docs site. | GraphQL returns mandates/executions/reputation for the Phase 2 run; docs build with no broken links |
| 5 | UI + server (Vite + Express, four screens), Dockerfile, `render.yaml`, deploy to Render. | Render URL live on testnet; `docker run` reproduces locally; `/healthz` 200 |
| 6 | PR-2 Privy (server wallets, policies, session signers). | Policy visible in Privy dashboard at grant; policy-blocked tx demonstrated |
| 7 | PR-3 CRE workflow. | `cre simulate` log committed; attestation tx lands; ERC-8004 score changes |
| 8 | PR-4 Mera PRF (encrypted policy blob + per-agent identities). | Cross-device re-derivation reproduces same key and same agent address |
| 9 | Hardening: Slither/ack3 triage, `security.md`, secret scan of git history, npm publish, CI. | Zero secrets in history; full suite green in CI |
| 10 | Submission assets: videos, logo, submission form, external integration evidence. | Section 9 checklist fully ticked |

Hard deadline: submission closes 14 Oct 04:59 GMT+1.

## 9. Deliverables checklist (track requirements)
- [ ] Logo (PNG/WEBP ≤3MB)
- [ ] Public GitHub repo, access granted to `metropolis@hackathon.monad.xyz`
- [ ] Technical demo video ≤3 min — LIVE product only, no slides, no code walkthrough
- [ ] Pitch video ≤2 min — team, problem, why you
- [ ] Live product link on Monad testnet/mainnet + access instructions + any test credentials
- [ ] Optional 30s ad clip
- [ ] npm package published
- [ ] Docs site live

### Technical demo video script (3:00)
0:00 One sentence: what Mandate is. Show docs quickstart page.
0:20 Create passkey, grant mandate (Face ID tap). Show the tx on explorer and the Privy policy appearing.
0:50 Agent starts trading on Kuru/Perpl within bounds; live panel: spend vs cap, per-block cap ticking.
1:20 Agent attempts an out-of-bounds call → typed revert onchain + Privy policy block.
1:40 Drawdown crosses threshold → breaker trips → agent frozen. Revoke button kills the mandate.
2:00 CRE simulation log → reputation attestation lands → ERC-8004 score changes.
2:25 Mera cross-device: fresh browser, same passkey, same decrypted policy, same agent identity address.
2:50 Show second team's integration PR. End on the npm install line.

---

## 10. What judges actually score — and how we hit each line

| Criterion | Weight | What they will check | Our proof |
|---|---|---|---|
| Technical Execution | 20% | Correct WebAuthn/P256, sound key derivation, no leaked secrets | Precompile-verified passkey sigs; HKDF-namespaced PRF keys; 7 tested security properties; invariant tests; ack3 scan triaged; `security.md` threat model |
| Design & Craft (DX) | 20% | Can a dev integrate without a UI? Docs, API cleanliness | 6-call SDK surface, typed errors, 10-min quickstart proven on video, docs site, npm package |
| Originality & Track Insight | 15% | Privacy-preserving, not capturable by one platform | Reputation written from verifiable onchain evidence, not a leaderboard; policy encrypted to user's passkey; BTX/commit-reveal private execution; all three Monad primitives used |
| Founder & Market Readiness | 25% | Who adopts it and why not roll their own | Named adopters: Track 1/2 agent teams, Kuru/Perpl bounty hunters, MetaMask agent-wallet builders. "Why not roll your own": session keys + breaker + reputation is 4 weeks of security work they don't have; IBX Lab's audit track record |
| Traction & Path Forward | 20% | One other team integrating during the hackathon; post-event plan | ≥1 external integration PR; Discord thread with dev interest; plan: MetaMask Agent Wallet plugin, Mera wallet integration, DeltaV residency, IBX Lab audits of integrators |

---

## 11. Self-judging rubric (run this on 12 Oct before freezing)

Score each 0–5, multiply by weight. Anything under 4 on a 25% or 20% line is a blocker.

| Line | Weight | Score 5 looks like | Our score | Fix if <4 |
|---|---|---|---|---|
| Technical Execution | 20 | All 7 properties tested + external scan + zero secrets in repo history (`git log -p \| grep -i key`) | | |
| Design & Craft | 20 | Stranger quickstart ≤10 min on camera; docs have zero broken links | | |
| Originality | 15 | Judge can articulate in one sentence why no single platform can capture Mandate | | |
| Founder & Market | 25 | Pitch names 3 concrete adopter types and a real "why not build it yourself" | | |
| Traction | 20 | One merged/open external integration + written 90-day plan | | |

Also verify before submission:
- [ ] Every bounty PR is independently demoable and linked in the submission form
- [ ] Privy demo shows ≥3 features, none of them just login
- [ ] CRE simulation log committed; workflow touches an external API and an LLM
- [ ] Mera cross-device test is on camera; wallet is not the point
- [ ] README states honestly whether BTX or commit-reveal is live
- [ ] 8GB machine: final full test run done in CI, not locally, the night before

---

## 12. Post-event path (put this in the pitch video and README)
1. Week 1 after results: MetaMask Agent Wallet plugin wrapping the SDK.
2. Mera wallet native integration (mandates as a first-class Mera capability).
3. Apply to DeltaV residency with the integration count as the headline metric.
4. IBX Lab offers free audits to the first five integrators — turns Mandate into the audit firm's wedge.

---

## 13. Resources (agent reads these before the relevant phase)

### Main track / core (Phases 0–5)
- Build on Monad — getting started: https://docs.monad.xyz/developer-essentials/getting-started
- Monad developer portal: https://developers.monad.xyz/
- Metropolis resources hub (free RPC/Tenderly/Quicknode credits, sponsor links): https://hackathon.monad.xyz/resources
- Monad docs — search for: P256 precompile / WebAuthn verification, ERC-8004 registry addresses on testnet, BTX encrypted mempool status (Phase 0 recon)
- Mera passkeys & PRF concepts (needed for `PasskeyAccount` too): https://mera.category.xyz/concepts/passkeys-and-prf/
- Mera reference: https://mera.category.xyz/reference/
- ERC-8004 spec: the EIP text at eips.ethereum.org (search "ERC-8004 Trustless Agents")
- Envio HyperIndex docs (indexer, Phase 4): docs.envio.dev
- Kuru / Perpl API docs (reference app venue, Phase 5): linked from the Metropolis resources hub

### PR-2 — Privy bounty ($5,000)
- Privy docs: https://docs.privy.io/
- Read specifically: Server wallets, Wallet policies, Session signers, Authorization keys, Embedded wallets on Monad
- Rule: login-only does not qualify; demo must show ≥3 non-auth features

### PR-3 — Chainlink CRE bounty ($3,000)
- CRE documentation: https://docs.chain.link (CRE section)
- Chainlink Bootcamp: Intro to CRE — recording (YouTube) and gitbook (smartcontractkit.github.io) — links on the bounty page
- LinkLab: Intro to CRE (YouTube) — link on the bounty page
- CRE templates repository (GitHub) — link on the bounty page; start from the closest template (onchain event trigger + HTTP fetch + onchain write)
- Rule: must integrate a chain with an external API/LLM/agent and show a successful `cre simulate` or live deployment

### PR-4 — Mera "One Passkey, Many Keys" bounty ($2,500)
- Passkeys and PRF: https://mera.category.xyz/concepts/passkeys-and-prf/
- Secret vaults: https://mera.category.xyz/concepts/secret-vaults/
- Recipe — use an existing secret: https://mera.category.xyz/recipes/use-an-existing-secret/
- Reference: https://mera.category.xyz/reference/
- Rule: the wallet cannot be the point; ≥1 PRF namespace must do non-account work; cross-device reproduction shown live

### Dropped / optional — Cleanverse CVI/CVA bounty ($2,000)
- API reference + invitation code: https://docs.cleanverse.com/
- CCP Integration Guide for CVI Compliance (Google Drive): https://drive.google.com/file/d/19QZdU0q06AoJiM_HDe9TDGsZZKhiRVKU/view?usp=sharing
- CCP Wrapped CVA Integration Guide (Google Drive): https://drive.google.com/file/d/1Zi4i5pp5swIP52PvglHJRveuFA_L81VC/view?usp=drive_link
- CCP CVA Integration Guide (Google Drive): https://drive.google.com/file/d/1ZXDADg2z5EHhG_TIuJfPEQrZLQjpCD_E/view?usp=sharing
- App ID and API key are on the bounty page — put them in `.env` only, never commit them
- Only attempt after Phase 10 is complete, as a separate `feat/cleanverse` PR
