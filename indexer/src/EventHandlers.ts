/**
 * Mandate protocol handlers. Every entity is keyed so the reference app and the CRE workflow can ask:
 *   mandates by principal, executions by mandate, reputation history by agent.
 */
import { indexer, type Agent, type Mandate, type Principal } from "envio";

const PHASES = ["Armed", "Tripped", "Cooldown"] as const;
type Phase = (typeof PHASES)[number];
const phaseOf = (n: bigint | number): Phase => PHASES[Number(n)] ?? "Armed";
const rowId = (txHash: string, logIndex: number) => `${txHash}-${logIndex}`;

async function getOrCreatePrincipal(context: any, id: string): Promise<Principal> {
  return (
    (await context.Principal.get(id)) ?? { id, mandateCount: 0, activeMandateCount: 0 }
  );
}

async function getOrCreateAgent(context: any, id: string, agentKey: string): Promise<Agent> {
  return (
    (await context.Agent.get(id)) ?? {
      id,
      agentKey,
      mandateCount: 0,
      executionCount: 0,
      tripCount: 0,
      totalSpent: 0n,
      latestScore: undefined,
      attestationCount: 0,
      lastAttestedAt: undefined,
    }
  );
}

// ------------------------------------------------------------------ MandateRegistry

indexer.onEvent(
  { contract: "MandateRegistry", event: "MandateGranted", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const m = event.params.mandate;
    const principalId = event.params.principal;
    const agentId = event.params.agentId.toString();

    const principal = await getOrCreatePrincipal(context, principalId);
    context.Principal.set({
      ...principal,
      mandateCount: principal.mandateCount + 1,
      activeMandateCount: principal.activeMandateCount + 1,
    });

    const agent = await getOrCreateAgent(context, agentId, event.params.agentKey);
    context.Agent.set({ ...agent, agentKey: event.params.agentKey, mandateCount: agent.mandateCount + 1 });

    context.Mandate.set({
      id: event.params.mandateHash,
      principal_id: principalId,
      agent_id: agentId,
      agentKey: event.params.agentKey,
      targets: [...m.targets],
      selectors: [...m.selectors],
      asset: m.asset,
      spendCap: m.spendCap,
      perBlockCap: m.perBlockCap,
      maxDrawdownBps: m.maxDrawdownBps,
      validAfter: m.validAfter,
      validUntil: m.validUntil,
      nonce: m.nonce,
      policyHash: m.policyHash,
      spent: 0n,
      executionCount: 0,
      tripCount: 0,
      breakerPhase: "Armed",
      peakEquity: 0n,
      revoked: false,
      revokedAt: undefined,
      revokedTx: undefined,
      grantedAt: BigInt(event.block.timestamp),
      grantedBlock: BigInt(event.block.number),
      grantedTx: event.transaction.hash,
    });
  },
);

indexer.onEvent(
  { contract: "MandateRegistry", event: "Revoked", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const mandate = await context.Mandate.get(event.params.mandateHash);
    if (!mandate) return;
    context.Mandate.set({
      ...mandate,
      revoked: true,
      revokedAt: BigInt(event.block.timestamp),
      revokedTx: event.transaction.hash,
    });
    const principal = await context.Principal.get(mandate.principal_id);
    if (principal) {
      context.Principal.set({ ...principal, activeMandateCount: Math.max(0, principal.activeMandateCount - 1) });
    }
  },
);

indexer.onEvent({ contract: "MandateRegistry", event: "ExecutionRecorded" }, async ({ event, context }) => {
  const mandate = await context.Mandate.get(event.params.mandateHash);
  if (!mandate) return;
  context.Mandate.set({ ...mandate, spent: event.params.totalSpent });
});

// ------------------------------------------------------------------ MandateExecutor

indexer.onEvent(
  { contract: "MandateExecutor", event: "MandateExecuted", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const mandateId = event.params.mandateHash;
    const agentId = event.params.agentId.toString();
    const phase = phaseOf(event.params.phaseAfter);

    context.Execution.set({
      id: rowId(event.transaction.hash, event.logIndex),
      mandate_id: mandateId,
      agent_id: agentId,
      agentKey: event.params.agentKey,
      target: event.params.target,
      selector: event.params.selector,
      declaredAmount: event.params.declaredAmount,
      spent: event.params.spent,
      phaseAfter: phase,
      block: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
      tx: event.transaction.hash,
    });

    const mandate = await context.Mandate.get(mandateId);
    if (mandate) {
      context.Mandate.set({ ...mandate, executionCount: mandate.executionCount + 1, breakerPhase: phase });
    }
    const agent = await getOrCreateAgent(context, agentId, event.params.agentKey);
    context.Agent.set({
      ...agent,
      executionCount: agent.executionCount + 1,
      totalSpent: agent.totalSpent + event.params.spent,
    });
  },
);

// ------------------------------------------------------------------ RiskBreaker

type BreakerKind = "Armed" | "Tripped" | "CooldownEntered" | "Rearmed" | "PeakReset";

async function recordBreaker(
  context: any,
  event: { params: { mandateHash: string }; block: { number: number; timestamp: number }; transaction: { hash: string }; logIndex: number },
  kind: BreakerKind,
  phase: Phase,
  extra: { drawdownBps?: bigint; peakEquity?: bigint },
) {
  const mandate: Mandate | undefined = await context.Mandate.get(event.params.mandateHash);
  if (!mandate) return;
  context.BreakerEvent.set({
    id: rowId(event.transaction.hash, event.logIndex),
    mandate_id: mandate.id,
    agent_id: mandate.agent_id,
    kind,
    drawdownBps: extra.drawdownBps,
    peakEquity: extra.peakEquity,
    block: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    tx: event.transaction.hash,
  });
  context.Mandate.set({
    ...mandate,
    breakerPhase: phase,
    peakEquity: extra.peakEquity ?? mandate.peakEquity,
    tripCount: kind === "Tripped" ? mandate.tripCount + 1 : mandate.tripCount,
  });
  if (kind === "Tripped") {
    const agent = await context.Agent.get(mandate.agent_id);
    if (agent) context.Agent.set({ ...agent, tripCount: agent.tripCount + 1 });
  }
}

const breakerFields = { transaction: ["hash"] } as const;

indexer.onEvent({ contract: "RiskBreaker", event: "Armed", fields: { transaction: ["hash"], block: ["timestamp"] } }, async ({ event, context }) => {
  await recordBreaker(context, event, "Armed", "Armed", { peakEquity: event.params.peakEquity });
});

indexer.onEvent({ contract: "RiskBreaker", event: "Tripped", fields: { transaction: ["hash"], block: ["timestamp"] } }, async ({ event, context }) => {
  await recordBreaker(context, event, "Tripped", "Tripped", { drawdownBps: event.params.drawdownBps });
});

indexer.onEvent({ contract: "RiskBreaker", event: "CooldownEntered", fields: { transaction: ["hash"], block: ["timestamp"] } }, async ({ event, context }) => {
  await recordBreaker(context, event, "CooldownEntered", "Cooldown", {});
});

indexer.onEvent({ contract: "RiskBreaker", event: "Rearmed", fields: { transaction: ["hash"], block: ["timestamp"] } }, async ({ event, context }) => {
  await recordBreaker(context, event, "Rearmed", "Armed", { peakEquity: event.params.peakEquity });
});

indexer.onEvent({ contract: "RiskBreaker", event: "PeakReset", fields: { transaction: ["hash"], block: ["timestamp"] } }, async ({ event, context }) => {
  await recordBreaker(context, event, "PeakReset", "Armed", { peakEquity: event.params.peakEquity });
});

// ------------------------------------------------------------------ ERC8004ReputationAdapter

indexer.onEvent(
  { contract: "ERC8004ReputationAdapter", event: "ReputationAttested", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const ts = BigInt(event.block.timestamp);
    context.Attestation.set({
      id: rowId(event.transaction.hash, event.logIndex),
      agent_id: agentId,
      attestor: event.params.attestor,
      complianceScore: Number(event.params.complianceScore),
      tripCount: Number(event.params.tripCount),
      executedCount: Number(event.params.executedCount),
      realisedPnlBps: event.params.realisedPnlBps,
      windowStart: event.params.windowStart,
      windowEnd: event.params.windowEnd,
      evidenceHash: event.params.evidenceHash,
      mirrored: event.params.mirrored,
      block: BigInt(event.block.number),
      timestamp: ts,
      tx: event.transaction.hash,
    });
    const agent = await getOrCreateAgent(context, agentId, "0x0000000000000000000000000000000000000000");
    context.Agent.set({
      ...agent,
      latestScore: Number(event.params.complianceScore),
      attestationCount: agent.attestationCount + 1,
      lastAttestedAt: ts,
    });
  },
);
