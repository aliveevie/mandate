import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, parseEther, type Address, type Hex } from "viem";
import { buildMandatePolicy, buildSessionSignerPolicy, revokedPolicyRules } from "../src/privy.js";
import { MandateExecutorAbi } from "../src/abi/generated.js";

const executor = "0xbb2d989876BFdf63CDFf7bb480A667175cF12409" as Address;
const venue = "0x3eC5A0C8a382AABfD765FA574C8aCc1C02e37216" as Address;
const hash = ("0x" + "ab".repeat(32)) as Hex;

describe("Privy policy mirrors a mandate", () => {
  const policy = buildMandatePolicy({
    mandate: { targets: [venue, venue], perBlockCap: parseEther("150"), validUntil: 1_800_000_000n },
    mandateHash: hash,
    chainId: 10143,
    executor,
  });

  it("allows only MandateExecutor.execute for this mandate, on this chain, with zero value (sign and send)", () => {
    const allow = policy.rules.filter((r) => r.action === "ALLOW");
    expect(allow.map((r) => r.method).sort()).toEqual(["eth_sendTransaction", "eth_signTransaction"]);
    const c = allow[0]!.conditions;
    expect(allow[1]!.conditions).toEqual(c);
    expect(c).toContainEqual({ field_source: "ethereum_transaction", field: "to", operator: "eq", value: executor.toLowerCase() });
    expect(c).toContainEqual({ field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "10143" });
    expect(c).toContainEqual({ field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0" });
    expect(c.find((x) => x.field === "execute.mandateHash")?.value).toBe(hash);
    expect(c.find((x) => x.field === "execute.target")?.value).toEqual([venue.toLowerCase()]); // de-duplicated
    expect(c.find((x) => x.field === "execute.amount")?.value).toBe(parseEther("150").toString());
    expect(c.find((x) => x.field === "current_unix_timestamp")?.value).toBe("1800000000");
  });

  it("denies signing, raw transactions and key export explicitly", () => {
    const denied = policy.rules.filter((r) => r.action === "DENY").map((r) => r.method).sort();
    expect(denied).toEqual(["eth_signTypedData_v4", "exportPrivateKey", "personal_sign"]);
  });

  it("carries the executor ABI so Privy can decode the calldata fields it checks", () => {
    const abi = policy.rules[0]!.conditions.find((x) => x.field_source === "ethereum_calldata")!.abi!;
    const data = encodeFunctionData({ abi: MandateExecutorAbi, functionName: "execute", args: [hash, venue, "0x", 1n] });
    const decoded = decodeFunctionData({ abi: abi as typeof MandateExecutorAbi, data });
    expect(decoded.functionName).toBe("execute");
    expect((decoded.args as readonly unknown[])[0]).toBe(hash);
  });

  it("revoked rules deny everything", () => {
    expect(revokedPolicyRules()).toEqual([{ name: "Mandate revoked", method: "*", action: "DENY", conditions: [] }]);
  });

  it("with a funder, the mirror and the revoked policy allow plain transfers back to the funder only", () => {
    const funder = "0x61c780065C2F803588201F4469b2F80484da448f" as Address;
    const p = buildMandatePolicy({ mandate: { targets: [venue], perBlockCap: 1n, validUntil: 2n }, mandateHash: hash, chainId: 10143, executor, refundTo: funder });
    const refund = p.rules.filter((r) => r.name.startsWith("Return gas"));
    expect(refund.map((r) => r.method).sort()).toEqual(["eth_sendTransaction", "eth_signTransaction"]);
    expect(refund[0]!.conditions).toContainEqual({ field_source: "ethereum_transaction", field: "to", operator: "eq", value: funder.toLowerCase() });
    const revoked = revokedPolicyRules({ chainId: 10143, refundTo: funder });
    expect(revoked.filter((r) => r.action === "ALLOW")).toHaveLength(2);
    expect(revoked.filter((r) => r.action === "DENY").map((r) => r.method).sort()).toEqual(["eth_signTypedData_v4", "exportPrivateKey", "personal_sign"]);
  });
});

describe("Session signer scope policy", () => {
  it("permits typed data only for the registry and the principal's account on this chain", () => {
    const account = "0x1111111111111111111111111111111111111111" as Address;
    const registry = "0x46441BC77a4dDbaE7004943E0ab9cB01c76092fA" as Address;
    const p = buildSessionSignerPolicy({ chainId: 10143, registry, account });
    const allow = p.rules.find((r) => r.action === "ALLOW")!;
    expect(allow.method).toBe("eth_signTypedData_v4");
    expect(allow.conditions).toContainEqual({ field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "10143" });
    expect(allow.conditions.find((c) => c.field === "verifyingContract")?.value).toEqual([registry.toLowerCase(), account.toLowerCase()]);
    expect(p.rules.filter((r) => r.action === "DENY").map((r) => r.method)).toContain("eth_sendTransaction");
  });
});
