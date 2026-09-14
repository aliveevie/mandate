import type { Address } from "viem";
import type { MandateAddresses } from "./types.js";

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_MAINNET_CHAIN_ID = 143;

/** RIP-7212 secp256r1 precompile. Same address on Monad testnet and mainnet. */
export const P256_PRECOMPILE: Address = "0x0000000000000000000000000000000000000100";

/** Deployed Mandate contracts per chain. See contracts/deployments/*.json for tx hashes. */
export const deployments: Record<number, MandateAddresses> = {
  [MONAD_TESTNET_CHAIN_ID]: {
    registry: "0x46441BC77a4dDbaE7004943E0ab9cB01c76092fA",
    executor: "0xbb2d989876BFdf63CDFf7bb480A667175cF12409",
    breaker: "0xf4c2F2373a17e3a2122f984D512B0B2EabA26374",
    submitter: "0xC552018AA7A9001e1dEcdfe40dAe38Dd6C5ca9D9",
    reputationAdapter: "0x3b1d977C1270dF25252041D0671b6FD90dF7a757",
    erc8004Identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    erc8004Reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
};

/** Throwaway demo venue + asset on Monad testnet used by the quickstart. Anyone can mint the asset. */
export const testnetDemo = {
  asset: "0x918598c87e38A6CB6C08684712A784A2FfFD3731" as Address,
  venue: "0x3eC5A0C8a382AABfD765FA574C8aCc1C02e37216" as Address,
  agentId: 1831n,
};

export function addressesFor(chainId: number): MandateAddresses {
  const a = deployments[chainId];
  if (!a) {
    throw new Error(
      `@ibxlab/mandate has no default deployment for chain ${chainId}. Pass \`addresses\` to createMandateClient.`,
    );
  }
  return a;
}
