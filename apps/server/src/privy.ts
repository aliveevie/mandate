/**
 * Privy wiring for the reference server. Present only when PRIVY_APP_ID, PRIVY_APP_SECRET,
 * PRIVY_AUTHORIZATION_KEY and PRIVY_KEY_QUORUM_ID are set; everything degrades to local demo keys otherwise.
 *
 *  - Agent keys become Privy server wallets owned by our key quorum: no private key on this server.
 *  - Every granted mandate is mirrored into a wallet policy on the agent's wallet; revocation turns it deny-all.
 *  - Principals without a passkey device sign in with Privy, delegate a scoped session signer to our key
 *    quorum, and grant / revoke through a SignerAccount without further prompts.
 */
import { createPrivyIntegration, type PrivyIntegration } from "@ibxlab/mandate/privy";
import type { Address } from "viem";
import { chain, mandateAddresses } from "./chain.js";

const env = (k: string) => process.env[k]?.trim() || undefined;

export const privyEnv = {
  appId: env("PRIVY_APP_ID"),
  appSecret: env("PRIVY_APP_SECRET"),
  authorizationKey: env("PRIVY_AUTHORIZATION_KEY"),
  keyQuorumId: env("PRIVY_KEY_QUORUM_ID"),
};

export const privyEnabled = !!(privyEnv.appId && privyEnv.appSecret && privyEnv.authorizationKey && privyEnv.keyQuorumId);

export const privy: PrivyIntegration | null = privyEnabled
  ? await createPrivyIntegration({
      appId: privyEnv.appId!,
      appSecret: privyEnv.appSecret!,
      authorizationKey: privyEnv.authorizationKey!,
      keyQuorumId: privyEnv.keyQuorumId!,
      chainId: chain.id,
      addresses: mandateAddresses,
    })
  : null;

/** Session-signer principals created through Privy, keyed by SignerAccount address. */
export interface PrivyPrincipal {
  account: Address;
  owner: Address;
  walletId: string;
  userId: string;
  scopePolicyId: string;
  createdAt: number;
}

const principals = new Map<string, PrivyPrincipal>();
const byUser = new Map<string, PrivyPrincipal>();

export function rememberPrincipal(p: PrivyPrincipal) {
  principals.set(p.account.toLowerCase(), p);
  byUser.set(p.userId, p);
}
export function principalByAccount(account: Address) {
  return principals.get(account.toLowerCase());
}
export function principalByUser(userId: string) {
  return byUser.get(userId);
}

export function publicPrivyConfig() {
  return { enabled: privyEnabled, appId: privyEnv.appId ?? null, signerId: privyEnv.keyQuorumId ?? null };
}
