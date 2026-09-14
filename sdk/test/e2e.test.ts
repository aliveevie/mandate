import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChildProcess } from "node:child_process";
import { createMandateClient, MandateError, hashMandate, type MandateClient, type Principal } from "../src/index.js";
import { ERC8004ReputationAdapterAbi, MandateRegistryAbi } from "../src/abi/generated.js";
import { ANVIL_PK, ANVIL_PK_1, ANVIL_RPC, startAnvil, type Fixture } from "./anvil.js";
import { erc20Abi, venueAbi } from "./demo-abi.js";

const anvilChain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

let proc: ChildProcess;
let fx: Fixture;
let client: MandateClient;
let principal: Principal;
const relayer = privateKeyToAccount(ANVIL_PK);
const agentKey = privateKeyToAccount(ANVIL_PK_1);
const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
const relayerWallet = createWalletClient({ account: relayer, chain: anvilChain, transport: http(ANVIL_RPC) });

async function mine(n = 1) {
  for (let i = 0; i < n; i++) {
    await fetch(ANVIL_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }),
    });
  }
}

beforeAll(async () => {
  ({ proc, fixture: fx } = await startAnvil());
  client = createMandateClient({
    chain: anvilChain,
    rpcUrl: ANVIL_RPC,
    signer: relayer,
    addresses: { ...fx },
  });
});

afterAll(() => {
  proc?.kill();
});

describe("@ibxlab/mandate end to end (anvil, osaka, real P256 precompile)", () => {
  let mandateHash: Hex;

  it("creates a software passkey and deploys its PasskeyAccount", async () => {
    principal = await client.passkey.create({ rpId: "mandate.local", software: true });
    expect(principal.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const loaded = await client.passkey.load();
    expect(loaded?.address).toBe(principal.address);
    expect(loaded?.publicKey).toEqual(principal.publicKey);
  });

  it("funds the account and approves the venue with a passkey-signed owner tx", async () => {
    await relayerWallet.writeContract({ address: fx.asset, abi: erc20Abi, functionName: "mint", args: [principal.address, parseEther("1000")] });
    // owner execute: approve(venue, max) authorised by the passkey
    const { PasskeyAccountAbi } = await import("../src/abi/generated.js");
    const call = { target: fx.asset, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [fx.venue, 2n ** 256n - 1n] }) };
    const nonce = await publicClient.readContract({ address: principal.address, abi: PasskeyAccountAbi, functionName: "nonce" });
    const digest = await publicClient.readContract({ address: principal.address, abi: PasskeyAccountAbi, functionName: "executeDigest", args: [call, nonce] });
    const sig = await principal.signChallenge(digest);
    const hash = await relayerWallet.writeContract({ address: principal.address, abi: PasskeyAccountAbi, functionName: "execute", args: [call, sig] });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  });

  it("builds, signs and grants a mandate; local hash and digest match the registry", async () => {
    const draft = client.mandate.build({
      agentId: 7,
      agentKey: agentKey.address,
      targets: [{ address: fx.venue, selectors: ["buy(address,uint256)", "noop()"] }],
      asset: fx.asset,
      spendCap: parseEther("500"),
      perBlockCap: parseEther("300"),
      maxDrawdownBps: 2000,
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const signed = await client.mandate.sign(draft, principal);
    const onchainHash = await publicClient.readContract({ address: fx.registry, abi: MandateRegistryAbi, functionName: "hashMandate", args: [signed.mandate] });
    const onchainDigest = await publicClient.readContract({ address: fx.registry, abi: MandateRegistryAbi, functionName: "digest", args: [signed.mandate] });
    expect(signed.hash).toBe(onchainHash);
    expect(signed.digest).toBe(onchainDigest);
    expect(hashMandate(signed.mandate)).toBe(onchainHash);

    const tx = await client.mandate.grant(signed);
    expect(tx.hash).toMatch(/^0x/);
    mandateHash = signed.hash;
    const state = await client.mandate.state(mandateHash);
    expect(state.active).toBe(true);
    expect(state.remaining).toBe(parseEther("500"));
    expect(state.breaker).toBe("Armed");
  });

  it("rejects a replayed grant with InvalidNonce", async () => {
    const m = await client.mandate.get(mandateHash);
    const draft = { ...m };
    const signed = await client.mandate.sign(draft, principal); // nonce is now 1
    // tamper: reuse nonce 0
    const stale = { ...signed, mandate: { ...signed.mandate, nonce: 0n } };
    await expect(client.mandate.grant(stale)).rejects.toSatisfy((e: unknown) => MandateError.is(e, "InvalidNonce"));
  });

  it("agent executes within bounds", async () => {
    const agent = client.agent.load({ mandateHash, executor: agentKey });
    const amount = parseEther("100");
    const tx = await agent.execute({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "buy", args: [fx.asset, amount] }), amount });
    expect(tx.gasUsed).toBeGreaterThan(0n);
    const state = await agent.state();
    expect(state.spent).toBe(amount);
    expect(state.breaker).toBe("Armed");
  });

  it("throws typed errors before sending: TargetNotAllowed, SpendCapExceeded, PerBlockCapExceeded", async () => {
    const agent = client.agent.load({ mandateHash, executor: agentKey });
    await expect(agent.execute({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "forbidden" }), amount: 0n }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "TargetNotAllowed"));
    await expect(agent.validate({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "buy", args: [fx.asset, parseEther("401")] }), amount: parseEther("401") }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "SpendCapExceeded") && (e as MandateError).args[1] === parseEther("400"));
    await expect(agent.validate({ target: fx.venue, data: "0x", amount: parseEther("301") }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "TargetNotAllowed"));
    await mine();
    await expect(agent.validate({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "buy", args: [fx.asset, parseEther("301")] }), amount: parseEther("301") }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "PerBlockCapExceeded"));
  });

  it("rejects a non-agent key with NotAgentKey", async () => {
    const stranger = client.agent.load({ mandateHash, executor: relayer });
    await expect(stranger.execute({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "noop" }), amount: 0n }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "NotAgentKey"));
  });

  it("breaker trips on drawdown and blocks execution with Tripped", async () => {
    const agent = client.agent.load({ mandateHash, executor: agentKey });
    await mine();
    const amount = parseEther("150"); // total 250 of 1000 = 25% > 20%
    await agent.execute({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "buy", args: [fx.asset, amount] }), amount });
    const state = await agent.state();
    expect(state.breaker).toBe("Tripped");
    expect(state.drawdownBps).toBe(2500n);
    expect(state.active).toBe(false);
    await expect(agent.execute({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "noop" }), amount: 0n }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "Tripped"));
  });

  it("principal revokes with the passkey; further calls fail with MandateRevoked", async () => {
    const tx = await client.mandate.revoke(mandateHash, principal);
    expect(tx.hash).toMatch(/^0x/);
    const state = await client.mandate.state(mandateHash);
    expect(state.revoked).toBe(true);
    const agent = client.agent.load({ mandateHash, executor: agentKey });
    await expect(agent.validate({ target: fx.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "noop" }), amount: 0n }))
      .rejects.toSatisfy((e: unknown) => MandateError.is(e, "MandateRevoked"));
  });

  it("reads reputation before and after an attestation", async () => {
    const before = await client.reputation.get(7);
    expect(before.score).toBeNull();
    expect(before.attestations).toBe(0);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const hash = await relayerWallet.writeContract({
      address: fx.reputationAdapter,
      abi: ERC8004ReputationAdapterAbi,
      functionName: "attest",
      args: [7n, { complianceScore: 88, tripCount: 1, executedCount: 2, realisedPnlBps: -2500n, windowStart: now - 600n, windowEnd: now, evidenceHash: mandateHash }],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const after = await client.reputation.get(7);
    expect(after.score).toBe(88);
    expect(after.trips).toBe(1);
    expect(after.executed).toBe(2);
    expect(after.pnlBps).toBe(-2500n);
    expect(after.evidenceHash).toBe(mandateHash);
    expect(after.erc8004?.count).toBe(1n);
    expect(after.erc8004?.value).toBe(88n);
    const history = await client.reputation.history(7);
    expect(history).toHaveLength(1);
  });

  it("agents cannot self-attest (NotAttestor)", async () => {
    const agentWallet = createWalletClient({ account: agentKey, chain: anvilChain, transport: http(ANVIL_RPC) });
    await expect(
      agentWallet.writeContract({
        address: fx.reputationAdapter,
        abi: ERC8004ReputationAdapterAbi,
        functionName: "attest",
        args: [7n, { complianceScore: 100, tripCount: 0, executedCount: 0, realisedPnlBps: 0n, windowStart: 1n, windowEnd: 2n, evidenceHash: mandateHash }],
      }),
    ).rejects.toThrow(/NotAttestor/);
  });
});
