import { getContract, type Hex } from "viem";
import { ERC8004ReputationAdapterAbi, ERC8004ReputationRegistryAbi } from "./abi/generated.js";
import type { Attestation, MandateAddresses, MandatePublicClient, Reputation } from "./types.js";

export interface ReputationModuleDeps {
  publicClient: MandatePublicClient;
  addresses: MandateAddresses;
}

const TAG1 = "mandate-compliance";

export function createReputationModule(deps: ReputationModuleDeps) {
  const adapter = getContract({
    address: deps.addresses.reputationAdapter,
    abi: ERC8004ReputationAdapterAbi,
    client: deps.publicClient,
  });

  async function erc8004Summary(agentId: bigint) {
    if (!deps.addresses.erc8004Reputation) return null;
    try {
      const reg = getContract({
        address: deps.addresses.erc8004Reputation,
        abi: ERC8004ReputationRegistryAbi,
        client: deps.publicClient,
      });
      const [count, value, decimals] = await reg.read.getSummary([agentId, [deps.addresses.reputationAdapter], TAG1, ""]);
      return { count: BigInt(count), value: BigInt(value), decimals: Number(decimals) };
    } catch {
      return null; // unregistered agent or registry not reachable: not an error for the reader
    }
  }

  return {
    /** Latest Mandate attestation for an agent plus the ERC-8004 aggregate. */
    async get(agentId: bigint | number): Promise<Reputation> {
      const id = BigInt(agentId);
      const [count, latest, erc8004] = await Promise.all([
        adapter.read.attestationCount([id]),
        adapter.read.latest([id]),
        erc8004Summary(id),
      ]);
      const has = count > 0n;
      return {
        agentId: id,
        score: has ? Number(latest.complianceScore) : null,
        trips: has ? Number(latest.tripCount) : 0,
        executed: has ? Number(latest.executedCount) : 0,
        pnlBps: has ? latest.realisedPnlBps : 0n,
        window: has ? { start: BigInt(latest.windowStart), end: BigInt(latest.windowEnd) } : null,
        evidenceHash: has ? (latest.evidenceHash as Hex) : null,
        attestations: Number(count),
        erc8004,
      };
    },

    /** Full attestation history, oldest first. */
    async history(agentId: bigint | number): Promise<Attestation[]> {
      const id = BigInt(agentId);
      const count = Number(await adapter.read.attestationCount([id]));
      const items = await Promise.all(
        Array.from({ length: count }, (_, i) => adapter.read.attestationAt([id, BigInt(i)])),
      );
      return items.map((a) => ({
        complianceScore: Number(a.complianceScore),
        tripCount: Number(a.tripCount),
        executedCount: Number(a.executedCount),
        realisedPnlBps: a.realisedPnlBps,
        windowStart: BigInt(a.windowStart),
        windowEnd: BigInt(a.windowEnd),
        evidenceHash: a.evidenceHash as Hex,
      }));
    },
  };
}

export type ReputationModule = ReturnType<typeof createReputationModule>;
