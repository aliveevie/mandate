# @ibxlab/mandate-indexer

Envio HyperIndex (v3) for the Mandate protocol on Monad testnet. Indexes `MandateGranted`, `Revoked`, `ExecutionRecorded`, `MandateExecuted`, the five `RiskBreaker` events and `ReputationAttested`, and exposes GraphQL for mandates by principal, executions by mandate and reputation history by agent.

```bash
pnpm install
pnpm codegen      # regenerate .envio/types.d.ts after editing config.yaml or schema.graphql
pnpm typecheck
pnpm dev          # local run: needs Docker (Postgres + Hasura). GraphQL at http://localhost:8080
```

## Deploy to Envio Cloud

1. Sign in at https://envio.dev with the GitHub account that owns this repository.
2. Add a new indexer, pick this repository and set the root directory to `indexer/`.
3. Deploy. Envio runs `codegen` and starts syncing from block `62423200` on Monad testnet (chain id 10143) over HyperSync.
4. Copy the hosted GraphQL endpoint into `ENVIO_GRAPHQL_URL` for `apps/server` and the CRE workflow.

Example queries are in `docs/indexer.md`.
