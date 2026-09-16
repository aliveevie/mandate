// Mera PRF ("one passkey, many keys") glue for the reference app. Everything runs in the browser: PRF outputs,
// derived keys and decrypted policies never leave the page and are never stored.
import { decryptPolicy, deriveAgentIdentity, encryptPolicy, prfSupported, type PolicyVault } from "@ibxlab/mandate/prf";
import { MandateRegistryAbi, ERC8004IdentityRegistryAbi } from "@ibxlab/mandate";
import type { Address, Hex, PublicClient } from "viem";
import { api, type PublicConfig } from "./api";
import { rpId } from "./client";

export interface AgentPolicy {
  strategy: string;
  maxSlippageBps: number;
  note: string;
}

export const defaultPolicy = (): AgentPolicy => ({ strategy: "mean-reversion", maxSlippageBps: 25, note: "keep 20% dry powder; stop if the venue is illiquid" });

export { prfSupported };

/** Encrypt the policy to PRF(mandate:policy:<principal>:<nonce>) and store the ciphertext in the blob store. */
export async function sealPolicy(input: { principal: Address; nonce: bigint; credentialId?: string; policy: AgentPolicy }) {
  const { vault, policyHash } = await encryptPolicy({ rpId: rpId(), credentialId: input.credentialId, principal: input.principal, nonce: input.nonce, policy: input.policy });
  return { vault, policyHash };
}

export async function storeVault(vault: PolicyVault, policyHash: Hex) {
  await api(`/api/blobs/${policyHash}`, { method: "PUT", json: vault });
}

/** Derive agent n's identity (no storage) and ask the relayer to hand over the ERC-8004 identity NFT. */
export async function claimIdentity(agentId: string, credentialId?: string) {
  const id = await deriveAgentIdentity({ rpId: rpId(), agentId, credentialId });
  try {
    const out = await api<{ tx: string | null; owner: Address; alreadyOwned: boolean }>(`/api/agents/${agentId}/claim`, { json: { owner: id.address } });
    return { address: id.address, namespace: id.namespace, ...out };
  } finally {
    id.end();
  }
}

export interface CrossDeviceResult {
  mandateHash: Hex;
  agentId: string;
  policyHash: Hex;
  policy: AgentPolicy | null;
  policyError?: string;
  derivedIdentity: Address;
  onchainOwner: Address | null;
  identityMatches: boolean;
  credentialId: string;
}

/**
 * The cross-device check: from nothing but a mandate hash and the passkey, fetch the vault by the mandate's onchain
 * policyHash, decrypt it, re-derive the agent's identity and compare with the ERC-8004 owner onchain.
 */
export async function crossDeviceCheck(cfg: PublicConfig, pc: PublicClient, mandateHash: Hex, credentialId?: string): Promise<CrossDeviceResult> {
  const m = await pc.readContract({ address: cfg.addresses.registry as Address, abi: MandateRegistryAbi, functionName: "getMandate", args: [mandateHash] });
  const agentId = m.agentId.toString();
  const policyHash = m.policyHash as Hex;
  let policy: AgentPolicy | null = null;
  let policyError: string | undefined;
  let credId = credentialId ?? "";
  if (/^0x0{64}$/.test(policyHash)) {
    policyError = "This mandate was granted without an encrypted policy (policyHash is zero).";
  } else {
    try {
      const vault = await api<PolicyVault>(`/api/blobs/${policyHash}`);
      const out = await decryptPolicy<AgentPolicy>({ rpId: rpId(), vault, credentialId });
      policy = out.policy;
      credId = out.credentialId;
    } catch (e) {
      policyError = (e as Error).message;
    }
  }
  const id = await deriveAgentIdentity({ rpId: rpId(), agentId, credentialId: credentialId || credId || undefined });
  id.end();
  let onchainOwner: Address | null = null;
  if (cfg.addresses.erc8004Identity) {
    try {
      onchainOwner = await pc.readContract({ address: cfg.addresses.erc8004Identity as Address, abi: ERC8004IdentityRegistryAbi, functionName: "ownerOf", args: [m.agentId] });
    } catch { /* not minted */ }
  }
  return { mandateHash, agentId, policyHash, policy, policyError, derivedIdentity: id.address, onchainOwner, identityMatches: !!onchainOwner && onchainOwner.toLowerCase() === id.address.toLowerCase(), credentialId: id.credentialId || credId };
}
