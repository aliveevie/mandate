// "One passkey, many keys": Mera PRF with namespaced salts, for two jobs that are not wallet signing.
//
//  1. Encrypted policy blob   PRF(salt = sha256("mandate:policy:<principal>:<nonce>")) --HKDF--> AES-256-GCM key.
//                              The agent's strategy parameters are encrypted to it and stored anywhere; the
//                              mandate's onchain `policyHash` commits to the ciphertext. Only the passkey decrypts.
//  2. Per-agent identities    PRF(salt = sha256("mandate:agent-id:<n>")) --HKDF--> secp256k1 key --> address that
//                              owns agent n's ERC-8004 identity. Unlinkable across agents, reconstructible from the
//                              passkey alone, on any device the passkey syncs to. Never stored.
//
// Rules: derivation != encryption (HKDF for keys, AES-GCM for data); every namespace is a distinct PRF salt so the
// outputs are unrelated at the authenticator; no PRF output, key or plaintext is persisted by this module.
import { createSecp256k1SigningSession, getEvmAddress, getPasskeyPrfOutput, type WebAuthnClient, type Secp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { Address, Hex, LocalAccount } from "viem";
import { base64UrlDecode, base64UrlEncode, randomBytes } from "./webauthn.js";
import { PRF_NAMESPACE, type PolicyVault, POLICY_VAULT_VERSION, parsePolicyVault, policyHashOf } from "./prf-vault.js";

export { PRF_NAMESPACE, parsePolicyVault, policyHashOf, policyVaultCanonical, POLICY_VAULT_VERSION } from "./prf-vault.js";
export type { PolicyVault } from "./prf-vault.js";

const HKDF_INFO = {
  policyKey: "mandate:prf:policy-key:v1",
  agentIdentity: "mandate:prf:agent-identity:v1",
} as const;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is not available in this environment");
  return s;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const toArrayBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** 32-byte PRF salt for a namespace: `sha256(namespace)`. */
export async function prfSalt(namespace: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().digest("SHA-256", utf8(namespace)));
}

/** HKDF-SHA-256 with an empty salt: the PRF output is already uniform; `info` separates the derived keys. */
export async function hkdf(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) }, key, length * 8));
}

export interface PrfCeremonyOptions {
  /** Relying party id: the app hostname the passkey was created for. */
  rpId: string;
  /** Restrict to one passkey (base64url credential id). Omitted: the platform offers any discoverable passkey. */
  credentialId?: string;
  /** Test/embedding hook: a Mera WebAuthn client. Defaults to the browser's navigator.credentials. */
  webAuthnClient?: WebAuthnClient;
  timeout?: number;
}

export interface PrfResult {
  credentialId: string;
  /** 32 bytes. Deterministic in (credential, rpId, namespace). Treat as secret; do not store. */
  output: Uint8Array<ArrayBuffer>;
  namespace: string;
}

/** One PRF ceremony (one user-verification prompt) for a namespace. */
export async function evaluatePrf(opts: PrfCeremonyOptions & { namespace: string }): Promise<PrfResult> {
  const r = await getPasskeyPrfOutput({
    rpId: opts.rpId,
    prfSalt: await prfSalt(opts.namespace),
    ...(opts.credentialId ? { credential: { credentialId: opts.credentialId } } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    ...(opts.webAuthnClient ? { webAuthnClient: opts.webAuthnClient } : {}),
  });
  return { credentialId: r.credentialId, output: r.prfOutput, namespace: opts.namespace };
}

/** Whether this browser advertises the WebAuthn PRF extension. `null` when it cannot say (older browsers). */
export async function prfSupported(): Promise<boolean | null> {
  const pkc = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> } }).PublicKeyCredential;
  if (!pkc) return false;
  if (typeof pkc.getClientCapabilities !== "function") return null;
  try {
    const caps = await pkc.getClientCapabilities();
    return typeof caps["extension:prf"] === "boolean" ? caps["extension:prf"] : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 1. encrypted policy blob

async function policyKey(prfOutput: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const raw = await hkdf(prfOutput, HKDF_INFO.policyKey, 32);
  try {
    return await subtle().importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, usages);
  } finally {
    raw.fill(0);
  }
}

export interface EncryptPolicyOptions extends PrfCeremonyOptions {
  principal: Address;
  /** The registry nonce the mandate will be signed with; makes the namespace unique per mandate. */
  nonce: bigint | number | string;
  /** Any JSON-serialisable strategy parameters / agent memory. */
  policy: unknown;
  /** Skip the ceremony and use this PRF output (tests, or when the caller already evaluated the namespace). */
  prfOutput?: Uint8Array;
}

/** Encrypt `policy` to the passkey; returns the vault to store and the `policyHash` to put in the mandate. */
export async function encryptPolicy(opts: EncryptPolicyOptions): Promise<{ vault: PolicyVault; policyHash: Hex; credentialId: string }> {
  const namespace = PRF_NAMESPACE.policy(opts.principal, opts.nonce);
  // A caller that already holds the PRF output may not know the credential id; the vault stays parseable ("unbound").
  const prf = opts.prfOutput ? { output: opts.prfOutput, credentialId: opts.credentialId || "unbound" } : await evaluatePrf({ ...opts, namespace });
  const key = await policyKey(prf.output, ["encrypt"]);
  const iv = randomBytes(12);
  const plaintext = utf8(JSON.stringify(opts.policy));
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, plaintext));
  plaintext.fill(0);
  if (!opts.prfOutput) prf.output.fill(0);
  const vault: PolicyVault = { version: POLICY_VAULT_VERSION, namespace, credentialId: prf.credentialId, iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(ciphertext) };
  return { vault, policyHash: policyHashOf(vault), credentialId: prf.credentialId };
}

export interface DecryptPolicyOptions extends PrfCeremonyOptions {
  vault: PolicyVault | string | unknown;
  prfOutput?: Uint8Array;
}

/** Decrypt a vault with the passkey (one prompt). Throws if the ciphertext was tampered with or the key differs. */
export async function decryptPolicy<T = unknown>(opts: DecryptPolicyOptions): Promise<{ policy: T; policyHash: Hex; credentialId: string }> {
  const vault = parsePolicyVault(opts.vault);
  const prf = opts.prfOutput ? { output: opts.prfOutput, credentialId: opts.credentialId ?? vault.credentialId } : await evaluatePrf({ ...opts, namespace: vault.namespace });
  const key = await policyKey(prf.output, ["decrypt"]);
  if (!opts.prfOutput) prf.output.fill(0);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt({ name: "AES-GCM", iv: base64UrlDecode(vault.iv) }, key, base64UrlDecode(vault.ciphertext));
  } catch {
    throw new Error("Policy vault did not decrypt: wrong passkey, wrong namespace, or tampered ciphertext");
  }
  return { policy: JSON.parse(new TextDecoder().decode(plaintext)) as T, policyHash: policyHashOf(vault), credentialId: prf.credentialId };
}

// ------------------------------------------------------------------ 2. per-agent isolated identities

export interface AgentIdentity {
  agentId: bigint;
  namespace: string;
  address: Address;
  /** viem LocalAccount backed by a Mera signing session; sign ERC-8004 owner actions with it. */
  account: LocalAccount;
  session: Secp256k1SigningSession;
  credentialId: string;
  /** Zeroize the session key when done. */
  end(): void;
}

export interface DeriveAgentIdentityOptions extends PrfCeremonyOptions {
  agentId: bigint | number | string;
  prfOutput?: Uint8Array;
}

/**
 * The deterministic secp256k1 identity for one agent. HKDF(info = agent namespace) over the namespace's PRF output;
 * the scalar is re-derived with a counter in the astronomically unlikely case it is not a valid secp256k1 key.
 */
export async function deriveAgentIdentity(opts: DeriveAgentIdentityOptions): Promise<AgentIdentity> {
  const agentId = BigInt(opts.agentId);
  const namespace = PRF_NAMESPACE.agentIdentity(agentId);
  const prf = opts.prfOutput ? { output: opts.prfOutput, credentialId: opts.credentialId || "unbound" } : await evaluatePrf({ ...opts, namespace });
  let session: Secp256k1SigningSession | undefined;
  for (let counter = 0; counter < 8 && !session; counter++) {
    const privateKey = await hkdf(prf.output, `${HKDF_INFO.agentIdentity}:${agentId}${counter ? `:${counter}` : ""}`, 32);
    try {
      session = createSecp256k1SigningSession({ privateKey });
    } catch {
      // invalid scalar (probability ~2^-128): try the next counter
    } finally {
      privateKey.fill(0);
    }
  }
  if (!opts.prfOutput) prf.output.fill(0);
  if (!session) throw new Error("Could not derive a valid secp256k1 key");
  const account = toViemAccount(session);
  return { agentId, namespace, address: getEvmAddress(session.publicKey), account, session, credentialId: prf.credentialId, end: () => session!.end() };
}
