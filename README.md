# Mandate

**Mandate is a delegation and trust primitive for the agent economy on Monad.** Humans issue scoped, revocable, privately-executed *mandates* to ERC-8004 agents from a passkey. Agents accumulate portable onchain reputation for how they honour them. Any app that lets an AI agent touch a wallet integrates Mandate instead of rolling its own session keys.

See `MANDATE_PROTOCOL_BUILD_SPEC.md` for the build plan.

## Status

| Piece | State |
|---|---|
| Contracts (`contracts/`) | Live on Monad testnet. Addresses and tx hashes in `contracts/deployments/monad-testnet.json` |
| SDK `@ibxlab/mandate` (`sdk/`) | Quickstart runs end to end against testnet: `cd sdk && pnpm quickstart` |
| Indexer, docs site, reference app, bounty PRs | Next phases |

**Private execution mode:** the testnet `PrivateSubmitter` is deployed in **BTX mode**, which routes mandated calls through Monad's encrypted mempool so strategy and policy are not observable before inclusion. The same contract ships a commit-reveal mode behind the same `IPrivateSubmit` interface; redeploying with `SUBMITTER_MODE=1` switches to it. BTX is the production target.

Copy `.env.example` → `.env` / `.env.local` and fill values locally. Those files are gitignored.
