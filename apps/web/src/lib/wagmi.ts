import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet } from "viem/chains";

/**
 * Injected wallets on Monad testnet. EIP-6963 discovery lists every extension the browser announces so the
 * user can pick a working one; the generic connector is the fallback for wallets that only set window.ethereum.
 * shimDisconnect is off: it makes wagmi call wallet_requestPermissions, which several wallets do not implement.
 */
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected({ shimDisconnect: false })],
  multiInjectedProviderDiscovery: true,
  transports: { [monadTestnet.id]: http(undefined, { batch: true }) },
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
