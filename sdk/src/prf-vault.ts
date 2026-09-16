// Policy vault format and hashing. Pure (no WebAuthn, no Mera import) so servers and blob stores can validate
// and hash vaults without a browser. The key material comes from `./prf.ts`.
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { base64UrlDecode } from "./webauthn.js";

export const POLICY_VAULT_VERSION = 1 as const;

/**
 * An agent's strategy parameters, encrypted to a key only the principal's passkey can re-derive.
 * Stored anywhere (localStorage, the reference server's blob store, IPFS…): it is ciphertext. The onchain
 * mandate's `policyHash` commits to exactly these bytes.
 */
export interface PolicyVault {
  readonly version: typeof POLICY_VAULT_VERSION;
  /** PRF namespace the key was derived from, e.g. `mandate:policy:0xprincipal:7`. */
  readonly namespace: string;
  /** Passkey credential that can decrypt it (base64url). Informational: any synced copy of the passkey works. */
  readonly credentialId: string;
  /** AES-GCM nonce, 12 bytes, base64url. */
  readonly iv: string;
  /** AES-256-GCM ciphertext + tag, base64url. */
  readonly ciphertext: string;
}

/** PRF namespaces. Salts are `sha256(namespace)`; different namespaces give unrelated PRF outputs. */
export const PRF_NAMESPACE = {
  /** Encryption key for the policy blob of the mandate `principal` signs with `nonce` (unique per mandate). */
  policy: (principal: Address, nonce: bigint | number | string) => `mandate:policy:${principal.toLowerCase()}:${nonce.toString()}`,
  /** Deterministic secp256k1 identity that owns agent `agentId`'s ERC-8004 record. */
  agentIdentity: (agentId: bigint | number | string) => `mandate:agent-id:${agentId.toString()}`,
} as const;

/** Canonical byte string that `policyHash` commits to. Field order and separators are part of the format. */
export function policyVaultCanonical(v: PolicyVault): string {
  return `mandate-policy-vault|v${v.version}|${v.namespace}|${v.credentialId}|${v.iv}|${v.ciphertext}`;
}

/** `policyHash` for the onchain mandate: keccak256 over the canonical encoding of the encrypted vault. */
export function policyHashOf(v: PolicyVault): Hex {
  return keccak256(stringToBytes(policyVaultCanonical(v)));
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Boundary for untrusted vault JSON or objects: validates shape, encodings and lengths; drops unknown fields. */
export function parsePolicyVault(value: unknown): PolicyVault {
  const o = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("Policy vault must be an object");
  if (o.version !== POLICY_VAULT_VERSION) throw new Error(`Unsupported policy vault version ${String(o.version)}`);
  const str = (k: string, re = B64URL) => {
    const s = o[k];
    if (typeof s !== "string" || s.length === 0 || !re.test(s)) throw new Error(`Policy vault field ${k} is invalid`);
    return s;
  };
  const namespace = str("namespace", /^mandate:[a-z-]+:[a-z0-9:.-]+$/i);
  const credentialId = str("credentialId");
  const iv = str("iv");
  const ciphertext = str("ciphertext");
  if (base64UrlDecode(iv).length !== 12) throw new Error("Policy vault iv must be 12 bytes");
  if (base64UrlDecode(ciphertext).length < 17) throw new Error("Policy vault ciphertext is too short");
  return { version: POLICY_VAULT_VERSION, namespace, credentialId, iv, ciphertext };
}
