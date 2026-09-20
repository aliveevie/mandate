# Contributing

Mandate is a protocol and an SDK first; the reference app exists to prove them. Contributions that make the primitive easier to build on are the most valuable: SDK ergonomics, typed errors, docs, adapters for agent frameworks, new venues.

## Ground rules

- **Never commit secrets.** `.env` files, keystores and broadcast caches are gitignored; CI runs gitleaks over history.
- **Do not add dependencies casually.** Pin exact versions, prefer packages with provenance attestations, and say in the PR how you verified the source.
- **Every change to `contracts/` needs tests** and must keep the seven security properties in `docs/security.md` green (`forge test`).
- **Every SDK change keeps the typed errors 1:1 with Solidity** (`pnpm --filter @ibxlab/mandate sync-abi` after `forge build`; CI diffs the generated ABIs).
- Keep the SDK surface small. New calls need a paragraph in `docs/sdk-reference.md`.

## Local loop

```bash
pnpm install
cd contracts && forge test            # unit + invariants
cd sdk && pnpm typecheck && pnpm test  # anvil e2e with the real P256 precompile
cd apps/server && DEMO_AGENT_DEPLOYER_KEY=0x… pnpm dev
cd apps/web && pnpm dev               # http://localhost:5173
```

## Integrating instead of contributing?

Open an issue with the **Integration** template. It gets you a review of your mandate parameters, help with the SDK, and a listing in `docs/adopters.md`.
