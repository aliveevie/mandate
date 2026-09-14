import { createPublicClient, http, type Chain, type PublicClient, type Transport } from "viem";
import { monadTestnet } from "viem/chains";
import { addressesFor } from "./addresses.js";
import { createAgentModule, type AgentModule } from "./agent.js";
import { createMandateModule, type MandateModule } from "./mandate.js";
import { createPasskeyModule, type PasskeyModule } from "./passkey.js";
import { createReputationModule, type ReputationModule } from "./reputation.js";
import type { MandateAddresses, PrincipalStorage, Signer } from "./types.js";

export interface MandateClientConfig {
  /** Defaults to Monad testnet. */
  chain?: Chain;
  /** Defaults to the chain's public RPC. */
  rpcUrl?: string;
  /** Bring your own transport instead of `rpcUrl`. */
  transport?: Transport;
  /** Override the default deployment for the chain. */
  addresses?: Partial<MandateAddresses>;
  /** Pays gas for principal-side transactions (account deployment, grant, revoke). Optional for read-only use. */
  signer?: Signer;
  /** Where `passkey.create` persists the principal for `passkey.load`. Defaults to localStorage or memory. */
  storage?: PrincipalStorage;
}

export interface MandateClient {
  chain: Chain;
  addresses: MandateAddresses;
  publicClient: PublicClient<Transport, Chain>;
  /** Create / load passkey principals and their PasskeyAccounts. */
  passkey: PasskeyModule;
  /** Build, sign, grant, revoke and inspect mandates. */
  mandate: MandateModule;
  /** Agent-side execution within a mandate. */
  agent: AgentModule;
  /** Read ERC-8004 reputation written by the attestor. */
  reputation: ReputationModule;
}

export function createMandateClient(config: MandateClientConfig = {}): MandateClient {
  const chain = config.chain ?? monadTestnet;
  const transport = config.transport ?? http(config.rpcUrl);
  const publicClient: PublicClient<Transport, Chain> = createPublicClient({ chain, transport });

  const defaults = config.addresses && isComplete(config.addresses) ? undefined : addressesFor(chain.id);
  const addresses: MandateAddresses = { ...(defaults ?? ({} as MandateAddresses)), ...config.addresses } as MandateAddresses;

  const common = { publicClient, addresses, signer: config.signer, rpcUrl: config.rpcUrl };
  const mandate = createMandateModule({ ...common, chainId: chain.id });

  return {
    chain,
    addresses,
    publicClient,
    passkey: createPasskeyModule({ ...common, storage: config.storage }),
    mandate,
    agent: createAgentModule({ publicClient, addresses, mandates: mandate, rpcUrl: config.rpcUrl }),
    reputation: createReputationModule({ publicClient, addresses }),
  };
}

function isComplete(a: Partial<MandateAddresses>): a is MandateAddresses {
  return !!(a.registry && a.executor && a.breaker && a.submitter && a.reputationAdapter);
}

