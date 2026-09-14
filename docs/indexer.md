# Indexer

An Envio HyperIndex in `indexer/` follows the Mandate contracts on Monad testnet through HyperSync and exposes GraphQL. The reference app and the reputation workflow both read from it.

## Entities

| Entity | Key | What it answers |
|---|---|---|
| `Principal` | account address | mandates by principal, active count |
| `Agent` | ERC-8004 id | mandates, executions, attestations, trip count, latest score |
| `Mandate` | mandate hash | full terms, spend, execution count, breaker phase, revoked |
| `Execution` | `tx-logIndex` | one row per `MandateExecuted` |
| `BreakerEvent` | `tx-logIndex` | `Armed`, `Tripped`, `CooldownEntered`, `Rearmed`, `PeakReset` |
| `Attestation` | `tx-logIndex` | one row per `ReputationAttested`, with the evidence hash |

## Queries

Mandates by principal:

```graphql
query MandatesByPrincipal($principal: String!) {
  Mandate(where: { principal_id: { _eq: $principal } }, order_by: { grantedAt: desc }) {
    id agentKey asset spendCap perBlockCap maxDrawdownBps validUntil
    spent executionCount tripCount breakerPhase revoked grantedTx
  }
}
```

Executions by mandate:

```graphql
query Executions($hash: String!) {
  Execution(where: { mandate_id: { _eq: $hash } }, order_by: { block: asc }) {
    target selector declaredAmount spent phaseAfter block timestamp tx
  }
}
```

Reputation history by agent:

```graphql
query Reputation($agentId: String!) {
  Agent_by_pk(id: $agentId) { latestScore attestationCount tripCount executionCount totalSpent }
  Attestation(where: { agent_id: { _eq: $agentId } }, order_by: { windowEnd: desc }) {
    complianceScore tripCount executedCount realisedPnlBps windowStart windowEnd evidenceHash mirrored tx
  }
}
```

## Running

```bash
cd indexer
pnpm install
pnpm codegen        # regenerates .envio/types.d.ts from config.yaml and schema.graphql
pnpm typecheck
pnpm dev            # local Postgres + Hasura via Docker, GraphQL at http://localhost:8080
```

Production runs on Envio Cloud: connect the repository at [envio.dev](https://envio.dev), point it at `indexer/`, and set `ENVIO_GRAPHQL_URL` in the app and workflow environments to the hosted endpoint.

The start block is the registry's deployment block on Monad testnet. Handlers are in `indexer/src/EventHandlers.ts`.
