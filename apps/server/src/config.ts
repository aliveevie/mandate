import { addressesFor, testnetDemo, type MandateAddresses } from "@ibxlab/mandate";
import type { Address, Hex } from "viem";

const env = (k: string, d?: string) => process.env[k] ?? d;

export const config = {
  port: Number(env("PORT", "8787")),
  rpcUrl: env("MONAD_RPC_URL", "https://testnet-rpc.monad.xyz")!,
  chainId: Number(env("MONAD_CHAIN_ID", "10143")),
  /** Pays gas for account deployment, grants, revokes, agent funding and ERC-8004 registration. */
  deployerKey: env("DEMO_AGENT_DEPLOYER_KEY") as Hex | undefined,
  envioUrl: env("ENVIO_GRAPHQL_URL"),
  publicDir: env("PUBLIC_DIR", "./public")!,
  demo: {
    asset: (env("DEMO_ASSET") ?? testnetDemo.asset) as Address,
    venue: (env("DEMO_VENUE") ?? testnetDemo.venue) as Address,
    /** Demo tokens minted to every new principal account. */
    mintAmount: 1000n * 10n ** 18n,
    /** MON sent to each provisioned agent key for gas. Monad testnet gas is ~200 gwei, so one execute is ~0.03 MON. */
    agentGas: 500_000_000_000_000_000n, // 0.5 MON
    /** Refuel the agent from the relayer when its balance drops under this. */
    agentGasMin: 100_000_000_000_000_000n, // 0.1 MON
    agentGasTopUp: 300_000_000_000_000_000n, // 0.3 MON
  },
};

export function addresses(): MandateAddresses {
  const base = addressesFor(config.chainId);
  return {
    ...base,
    registry: (env("MANDATE_REGISTRY") ?? base.registry) as Address,
    executor: (env("MANDATE_EXECUTOR") ?? base.executor) as Address,
    breaker: (env("RISK_BREAKER") ?? base.breaker) as Address,
    reputationAdapter: (env("ERC8004_REPUTATION_ADAPTER") ?? base.reputationAdapter) as Address,
    erc8004Identity: (env("ERC8004_IDENTITY_REGISTRY") ?? base.erc8004Identity) as Address | undefined,
  };
}
