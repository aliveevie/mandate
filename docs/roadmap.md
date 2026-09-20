# Roadmap

What exists today is a working testnet protocol with an SDK, an indexer, a reference app and three partner
integrations. The plan from here is about integrations first and features second.

## Next 30 days

- **npm release of `@ibxlab/mandate` 0.1.0** with the quickstart, the agent runner and the LLM tool example.
- **Hosted indexer** on Envio Cloud, wired into the reference app and the CRE workflow's `indexerUrl`.
- **CRE workflow deployed to a DON** (production target and forwarder are already in `cre/project.yaml`), replacing the simulator runs; the LLM leg enabled with a hosted key.
- **Integration reviews**: the first five integrators get an IBX Lab review of their mandate parameters and agent loop.

## Next 90 days

- **Wallet-side integrations.** A MetaMask agent-wallet plugin and a native Mera wallet capability that issue mandates from the wallet UI, so agent platforms do not need their own principal screen.
- **Framework adapters.** Published tool definitions for the common agent runtimes (the `execute_under_mandate` tool in the SDK examples is the template), so an agent gains mandate-bounded execution by adding one tool.
- **More venues.** Real DEX and perp venues as targets, with venue-specific `amount` measurement hints.
- **Reputation consumers.** A reference "choose an agent" query over ERC-8004 plus Mandate evidence for marketplaces and routers.
- **Mainnet deployment** of the contracts once two external integrations are live on testnet.

## Protocol work under consideration

- Allowance-aware spend: optional per-target allowance caps set at grant time, closing the out-of-band pull path described in [Security → Scope notes](security.md#scope-notes-what-the-caps-do-and-do-not-bound).
- Multi-principal mandates (a DAO or a multisig as principal) using the existing ERC-1271 path.
- Mandate templates: signed, reusable parameter sets that a wallet can offer as presets.

## What will not change

The registry enforces; agents cannot self-attest; passkeys never leave the device; policies are ciphertext to everyone
but the principal; and any of the pieces around the contracts can be replaced by an integrator.
