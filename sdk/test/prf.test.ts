import { describe, expect, it } from "vitest";
import { getAddress, isAddress, type Address } from "viem";
import { PRF_NAMESPACE, decryptPolicy, deriveAgentIdentity, encryptPolicy, hkdf, parsePolicyVault, policyHashOf, prfSalt } from "../src/prf.js";

// Fixed "PRF outputs" stand in for the authenticator: deterministic in (credential, rpId, salt).
const prfA = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const prfB = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
const principal = "0x53B06edA0aB9C620C1883d96FC1914de9cE323E1" as Address;

describe("PRF namespaces and salts", () => {
  it("salts are sha256(namespace): 32 bytes, deterministic, distinct per namespace", async () => {
    const a = await prfSalt(PRF_NAMESPACE.policy(principal, 7n));
    const b = await prfSalt(PRF_NAMESPACE.policy(principal, 7n));
    const c = await prfSalt(PRF_NAMESPACE.policy(principal, 8n));
    const d = await prfSalt(PRF_NAMESPACE.agentIdentity(7n));
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(d))).toBe(false);
    expect(PRF_NAMESPACE.policy(principal, 7n)).toBe("mandate:policy:0x53b06eda0ab9c620c1883d96fc1914de9ce323e1:7");
    expect(PRF_NAMESPACE.agentIdentity(1869)).toBe("mandate:agent-id:1869");
  });

  it("HKDF separates keys by info", async () => {
    const k1 = await hkdf(prfA, "mandate:prf:policy-key:v1");
    const k2 = await hkdf(prfA, "mandate:prf:agent-identity:v1:1");
    const k3 = await hkdf(prfB, "mandate:prf:policy-key:v1");
    expect(k1.length).toBe(32);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
    expect(Buffer.from(k1).equals(Buffer.from(k3))).toBe(false);
  });
});

describe("encrypted policy blob", () => {
  const policy = { strategy: "mean-reversion", maxSlippageBps: 25, venues: ["kuru"], note: "keep 20% dry powder" };

  it("round-trips with the same PRF output and commits to policyHash", async () => {
    const { vault, policyHash } = await encryptPolicy({ rpId: "localhost", principal, nonce: 3n, policy, prfOutput: prfA, credentialId: "cred-a" });
    expect(vault.namespace).toBe(PRF_NAMESPACE.policy(principal, 3n));
    expect(policyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(policyHashOf(parsePolicyVault(JSON.stringify(vault)))).toBe(policyHash);
    const out = await decryptPolicy<typeof policy>({ rpId: "localhost", vault: JSON.stringify(vault), prfOutput: prfA });
    expect(out.policy).toEqual(policy);
    expect(out.policyHash).toBe(policyHash);
  });

  it("a different passkey (PRF output) cannot decrypt; tampering is detected", async () => {
    const { vault } = await encryptPolicy({ rpId: "localhost", principal, nonce: 3n, policy, prfOutput: prfA, credentialId: "cred-a" });
    await expect(decryptPolicy({ rpId: "localhost", vault, prfOutput: prfB })).rejects.toThrow(/did not decrypt/);
    const tampered = { ...vault, ciphertext: vault.ciphertext.slice(0, -2) + (vault.ciphertext.endsWith("A") ? "BB" : "AA") };
    await expect(decryptPolicy({ rpId: "localhost", vault: tampered, prfOutput: prfA })).rejects.toThrow(/did not decrypt/);
    expect(policyHashOf(tampered)).not.toBe(policyHashOf(vault));
  });

  it("encryption is randomised (fresh iv) but the key is not: two vaults of the same policy differ", async () => {
    const a = await encryptPolicy({ rpId: "localhost", principal, nonce: 3n, policy, prfOutput: prfA });
    const b = await encryptPolicy({ rpId: "localhost", principal, nonce: 3n, policy, prfOutput: prfA });
    expect(a.vault.ciphertext).not.toBe(b.vault.ciphertext);
    expect(a.policyHash).not.toBe(b.policyHash);
    // a vault sealed from a supplied PRF output (no credential id) still parses and decrypts
    expect(parsePolicyVault(JSON.stringify(a.vault)).credentialId).toBe("unbound");
    expect((await decryptPolicy<typeof policy>({ rpId: "localhost", vault: JSON.stringify(a.vault), prfOutput: prfA })).policy).toEqual(policy);
  });

  it("rejects malformed vaults at the boundary", () => {
    expect(() => parsePolicyVault({ version: 2 })).toThrow(/version/);
    expect(() => parsePolicyVault({ version: 1, namespace: "evil", credentialId: "a", iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toThrow(/namespace/);
    expect(() => parsePolicyVault({ version: 1, namespace: "mandate:policy:0xab:1", credentialId: "a", iv: "AAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toThrow(/iv/);
  });
});

describe("per-agent isolated identities", () => {
  it("is deterministic for the same passkey and agent, distinct across agents and passkeys", async () => {
    const a1 = await deriveAgentIdentity({ rpId: "localhost", agentId: 1869, prfOutput: prfA });
    const a1again = await deriveAgentIdentity({ rpId: "localhost", agentId: 1869n, prfOutput: prfA });
    const a2 = await deriveAgentIdentity({ rpId: "localhost", agentId: 1870, prfOutput: prfA });
    const b1 = await deriveAgentIdentity({ rpId: "localhost", agentId: 1869, prfOutput: prfB });
    expect(isAddress(a1.address)).toBe(true);
    expect(a1.address).toBe(getAddress(a1.address));
    expect(a1again.address).toBe(a1.address);
    expect(a2.address).not.toBe(a1.address);
    expect(b1.address).not.toBe(a1.address);
    expect(a1.namespace).toBe("mandate:agent-id:1869");
    for (const x of [a1, a1again, a2, b1]) x.end();
  });

  it("the identity is a working viem account (signs, address matches)", async () => {
    const id = await deriveAgentIdentity({ rpId: "localhost", agentId: 1, prfOutput: prfA });
    expect(id.account.address).toBe(id.address);
    const sig = await id.account.signMessage({ message: "mandate" });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    const { verifyMessage } = await import("viem");
    expect(await verifyMessage({ address: id.address, message: "mandate", signature: sig })).toBe(true);
    id.end();
  });
});
