import { createMandateClient, type MandateClient, type Principal } from "@ibxlab/mandate";
import { createPublicClient, http, type Chain } from "viem";
import { monadTestnet } from "viem/chains";
import type { PublicConfig } from "./api";

let client: MandateClient | undefined;

/** Read-only SDK client in the browser. Nothing here ever holds gas: the server relays. */
export function getClient(cfg: PublicConfig): MandateClient {
  if (client) return client;
  const chain: Chain = { ...monadTestnet, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  client = createMandateClient({ chain, rpcUrl: cfg.rpcUrl, addresses: cfg.addresses as never });
  return client;
}

export function getPublicClient(cfg: PublicConfig) {
  return createPublicClient({ chain: monadTestnet, transport: http(cfg.rpcUrl) });
}

export const rpId = () => window.location.hostname;

export const short = (s: string, n = 6) => (s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);
export const fmtTokens = (wei: string | bigint, digits = 2) => {
  const v = typeof wei === "bigint" ? wei : BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, digits);
  return digits ? `${whole}.${frac}` : whole.toString();
};

export type { Principal };
