import { MandateError, type Agent, type Mandate, type MandateState } from "@ibxlab/mandate";
import { createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import { privy } from "./privy.js";
import type { MandatePolicy } from "@ibxlab/mandate/privy";
import { config } from "./config.js";
import { deployer, deployerWallet, identityOwnerOf, publicClient, registerAgentIdentity, sdk, wait } from "./chain.js";

const venueAbi = parseAbi(["function buy(address token, uint256 amount)", "function forbidden()"]);

export interface FeedItem {
  at: number;
  mandateHash?: Hex;
  kind: "executed" | "rejected" | "stopped" | "info";
  message: string;
  tx?: Hex;
  amount?: string;
  error?: { name: string; args: string[] };
}

export interface DemoAgent {
  id: string;
  agentId: bigint;
  agentKey: Address;
  registerTx: Hex;
  fundTx: Hex;
  /** Who paid for this agent's gas: the relayer, or a user's wallet in wallet mode. Sweeps go back here. */
  fundedBy: Address;
  /** Wallet-mode agents are created pending and activated once the wallet has registered + funded them. */
  pending?: boolean;
  /** Who holds the executing key: an in-memory demo key, or a Privy server wallet (TEE, never exported). */
  custody: "local" | "privy";
  privyWallet?: { walletId: string; address: Address };
  /** The Privy policy currently attached to the agent wallet, mirroring the running mandate. */
  policy?: { policyId: string; mandateHash: Hex; rules: MandatePolicy["rules"]; revoked: boolean };
  createdAt: number;
  running: boolean;
  mandateHash?: Hex;
  stopReason?: string;
  feed: FeedItem[];
  /** Signs agent transactions: a local demo key, or a viem account backed by the Privy server wallet. */
  account: Account;
  timer?: NodeJS.Timeout;
  busy?: boolean;
}

const agents = new Map<string, DemoAgent>();
const TICK_MS = 4_000;
const ONE = 10n ** 18n;

export function listAgents() {
  return [...agents.values()].map((a) => publicView(a));
}

export function getAgent(id: string) {
  return agents.get(id);
}

/** The provisioned agent whose executing key the mandate names, if any. */
export async function agentForMandate(mandateHash: Hex): Promise<DemoAgent | undefined> {
  const m = await sdk.mandate.get(mandateHash);
  return [...agents.values()].find((a) => a.agentKey.toLowerCase() === m.agentKey.toLowerCase());
}

export function publicView(a: DemoAgent, mandateHash?: Hex) {
  const feed = mandateHash ? a.feed.filter((f) => !f.mandateHash || f.mandateHash === mandateHash) : a.feed;
  return {
    id: a.id,
    agentId: a.agentId.toString(),
    agentKey: a.agentKey,
    registerTx: a.registerTx,
    fundTx: a.fundTx,
    fundedBy: a.fundedBy,
    pending: !!a.pending,
    custody: a.custody,
    privyWalletId: a.privyWallet?.walletId,
    policy: a.policy,
    createdAt: a.createdAt,
    running: a.running,
    mandateHash: a.mandateHash,
    stopReason: a.stopReason,
    feed: feed.slice(-50),
  };
}

/** Provision: fresh executing key, funded for gas, registered as an ERC-8004 identity. */
/** Mint an executing key: a Privy server wallet when Privy is configured, otherwise an in-memory demo key. */
async function newAgentKey(label: string): Promise<{ account: Account; custody: "local" | "privy"; privyWallet?: { walletId: string; address: Address } }> {
  if (privy) {
    const ref = await privy.agents.createWallet({ label });
    return { account: privy.agents.account(ref), custody: "privy", privyWallet: ref };
  }
  return { account: privateKeyToAccount(generatePrivateKey()), custody: "local" };
}

export async function provisionAgent(label = "demo-agent"): Promise<DemoAgent> {
  const { account, custody, privyWallet } = await newAgentKey(label);
  // Plain transfers have been seen reverting once on Monad testnet; retry before giving up.
  let fundTx: Hex | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3 && !fundTx; attempt++) {
    try {
      const tx = await deployerWallet.sendTransaction({ to: account.address, value: config.demo.agentGas, gas: 30_000n });
      await wait(tx);
      fundTx = tx;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!fundTx) throw new Error(`Could not fund the agent key: ${(lastErr as Error)?.message?.split("\n")[0]}`);
  const { agentId, tx } = await registerAgentIdentity(`https://mandate.ibxlab.xyz/agents/${label}-${Date.now()}.json`);
  const agent: DemoAgent = {
    id: agentId.toString(),
    agentId,
    agentKey: account.address,
    registerTx: tx,
    fundTx,
    fundedBy: deployer.address,
    createdAt: Date.now(),
    running: false,
    custody,
    privyWallet,
    feed: [{ at: Date.now(), kind: "info", message: custody === "privy" ? `Agent ${agentId} registered in ERC-8004; its key is Privy server wallet ${privyWallet?.walletId}` : `Agent ${agentId} registered in ERC-8004 and funded with gas` }],
    account,
  };
  agents.set(agent.id, agent);
  return agent;
}

const pendingKeys = new Map<Address, { account: Account; custody: "local" | "privy"; privyWallet?: { walletId: string; address: Address } }>();

/** Wallet mode, step 1: mint an executing key. The user's wallet registers the identity and funds it. */
export async function prepareAgent(): Promise<{ agentKey: Address; custody: "local" | "privy" }> {
  const k = await newAgentKey("mandate agent");
  pendingKeys.set(k.account.address, k);
  return { agentKey: k.account.address, custody: k.custody };
}

/** Wallet mode, step 2: verify the wallet's work on-chain and activate the agent. */
export async function activateAgent(input: { agentKey: Address; agentId: bigint; registerTx: Hex; fundTx: Hex; fundedBy: Address }): Promise<DemoAgent> {
  const k = pendingKeys.get(input.agentKey);
  if (!k) throw new Error("Unknown pending agent key");
  const [owner, balance] = await Promise.all([identityOwnerOf(input.agentId), publicClient.getBalance({ address: input.agentKey })]);
  if (!owner) throw new Error(`ERC-8004 agent ${input.agentId} is not registered`);
  if (balance === 0n) throw new Error("Agent key has no gas");
  pendingKeys.delete(input.agentKey);
  const agent: DemoAgent = {
    id: input.agentId.toString(),
    agentId: input.agentId,
    agentKey: input.agentKey,
    registerTx: input.registerTx,
    fundTx: input.fundTx,
    fundedBy: input.fundedBy,
    createdAt: Date.now(),
    running: false,
    custody: k.custody,
    privyWallet: k.privyWallet,
    feed: [{ at: Date.now(), kind: "info", message: `Agent ${input.agentId} registered in ERC-8004 by ${input.fundedBy.slice(0, 8)}… and funded from that wallet${k.custody === "privy" ? `; key is Privy server wallet ${k.privyWallet?.walletId}` : ""}` }],
    account: k.account,
  };
  agents.set(agent.id, agent);
  return agent;
}

/** Return unspent gas to whoever funded the agent. Keeps nothing: the agent is refuelled if it runs again. */
export async function sweepAgent(a: DemoAgent): Promise<Hex | undefined> {
  try {
    const balance = await publicClient.getBalance({ address: a.agentKey });
    const fees = await publicClient.estimateFeesPerGas();
    const cost = 21_000n * (fees.maxFeePerGas ?? 0n);
    if (balance <= cost * 2n) return undefined;
    const wallet = createWalletClient({ account: a.account, chain: monadTestnet, transport: http(config.rpcUrl, { batch: true }) });
    const hash = await wallet.sendTransaction({ to: a.fundedBy, value: balance - cost, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await wait(hash);
    push(a, { at: Date.now(), kind: "info", message: `Swept ${fmt(balance - cost)} MON back to ${a.fundedBy.slice(0, 8)}…`, tx: hash, mandateHash: a.mandateHash });
    return hash;
  } catch {
    return undefined;
  }
}

/** Sweep every idle agent (used on shutdown). */
export async function sweepAll() {
  await Promise.allSettled([...agents.values()].filter((a) => !a.running).map(sweepAgent));
}

function loadSdkAgent(a: DemoAgent, mandateHash: Hex): Agent {
  return sdk.agent.load({ mandateHash, executor: a.account });
}

function push(a: DemoAgent, item: FeedItem) {
  a.feed.push(item);
  if (a.feed.length > 200) a.feed.shift();
}

function stop(a: DemoAgent, reason: string) {
  if (a.timer) clearInterval(a.timer);
  a.timer = undefined;
  a.running = false;
  a.stopReason = reason;
  push(a, { at: Date.now(), kind: "stopped", message: reason, mandateHash: a.mandateHash });
  void sweepAgent(a);
}

const TERMINAL = new Set(["Tripped", "MandateRevoked", "MandateExpired", "MandateNotFound", "NotAgentKey"]);

/** Keep the demo agent's gas topped up from the relayer. Production agents pay their own gas. */
async function refuel(a: DemoAgent) {
  const bal = await publicClient.getBalance({ address: a.agentKey });
  if (bal >= config.demo.agentGasMin) return;
  if (a.fundedBy.toLowerCase() !== deployer.address.toLowerCase()) {
    push(a, { at: Date.now(), kind: "info", message: "Agent gas is low; top up its key from your wallet to keep it running", mandateHash: a.mandateHash });
    return;
  }
  const tx = await deployerWallet.sendTransaction({ to: a.agentKey, value: config.demo.agentGasTopUp });
  await wait(tx);
  push(a, { at: Date.now(), kind: "info", message: `Refuelled agent gas (+${fmt(config.demo.agentGasTopUp)} MON)`, tx, mandateHash: a.mandateHash });
}

async function tick(a: DemoAgent) {
  if (a.busy || !a.running || !a.mandateHash) return;
  a.busy = true;
  try {
    await refuel(a);
    const agent = loadSdkAgent(a, a.mandateHash);
    const state = await agent.state();
    if (state.remaining === 0n) return stop(a, "Lifetime spend cap reached");
    // Random trade size between 5 and 40 tokens, clipped to what the caps allow right now.
    const want = (5n + BigInt(Math.floor(Math.random() * 36))) * ONE;
    const amount = min(want, state.remaining, state.remainingThisBlock);
    if (amount === 0n) return; // per-block budget used up; try next tick
    const data = encodeFunctionData({ abi: venueAbi, functionName: "buy", args: [config.demo.asset, amount] });
    const tx = await agent.execute({ target: config.demo.venue, data, amount });
    push(a, { at: Date.now(), kind: "executed", message: `buy ${fmt(amount)} tokens`, tx: tx.hash, amount: amount.toString(), mandateHash: a.mandateHash });
  } catch (e) {
    if (MandateError.is(e)) {
      const err = { name: e.name, args: e.args.map(String) };
      push(a, { at: Date.now(), kind: "rejected", message: e.message, error: err, mandateHash: a.mandateHash });
      if (TERMINAL.has(e.name)) stop(a, `Frozen by ${e.name}`);
    } else {
      const msg = (e as Error).message ?? String(e);
      push(a, { at: Date.now(), kind: "rejected", message: msg.split("\n")[0]!.slice(0, 200), mandateHash: a.mandateHash });
    }
  } finally {
    a.busy = false;
  }
}

export function startAgent(a: DemoAgent, mandateHash: Hex) {
  if (a.running) return;
  a.mandateHash = mandateHash;
  a.running = true;
  a.stopReason = undefined;
  push(a, { at: Date.now(), kind: "info", message: `Running under mandate ${mandateHash.slice(0, 10)}…`, mandateHash });
  void tick(a);
  a.timer = setInterval(() => void tick(a), TICK_MS);
}

export function stopAgent(a: DemoAgent) {
  if (a.running) stop(a, "Stopped by operator");
}

/** Try a call outside the mandate. Never sends: the SDK raises the typed error first. */
export async function forceOutOfBounds(a: DemoAgent, mandateHash: Hex) {
  const agent = loadSdkAgent(a, mandateHash);
  try {
    await agent.execute({ target: config.demo.venue, data: encodeFunctionData({ abi: venueAbi, functionName: "forbidden" }), amount: 0n });
    return { blocked: false as const };
  } catch (e) {
    if (MandateError.is(e)) {
      push(a, { at: Date.now(), kind: "rejected", message: `Out-of-bounds call blocked: ${e.message}`, error: { name: e.name, args: e.args.map(String) }, mandateHash });
      return { blocked: true as const, error: { name: e.name, args: e.args.map(String), message: e.message } };
    }
    throw e;
  }
}

const stateCache = new Map<string, { at: number; value: unknown }>();

export async function agentState(a: DemoAgent, mandateHash?: Hex) {
  const hash = mandateHash ?? a.mandateHash;
  const key = `${a.id}:${hash ?? ""}`;
  const hit = stateCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return { ...(hit.value as object), agent: publicView(a, hash) };
  const value = await computeAgentState(a, hash);
  stateCache.set(key, { at: Date.now(), value });
  return value;
}

async function computeAgentState(a: DemoAgent, hash?: Hex) {
  let state: MandateState | undefined;
  let mandate: { spendCap: string; perBlockCap: string; maxDrawdownBps: string; validUntil: string; asset: string } | undefined;
  if (hash) {
    const [s, m] = await Promise.all([sdk.mandate.state(hash), sdk.mandate.get(hash)]);
    state = s;
    mandate = {
      spendCap: m.spendCap.toString(),
      perBlockCap: m.perBlockCap.toString(),
      maxDrawdownBps: m.maxDrawdownBps.toString(),
      validUntil: m.validUntil.toString(),
      asset: m.asset,
    };
  }
  return {
    agent: publicView(a, hash),
    mandateHash: hash,
    mandate,
    state: state && {
      spent: state.spent.toString(),
      remaining: state.remaining.toString(),
      spentThisBlock: state.spentThisBlock.toString(),
      remainingThisBlock: state.remainingThisBlock.toString(),
      lastBlock: state.lastBlock.toString(),
      revoked: state.revoked,
      active: state.active,
      breaker: state.breaker,
      drawdownBps: state.drawdownBps.toString(),
    },
  };
}

function min(...xs: bigint[]) {
  return xs.reduce((a, b) => (a < b ? a : b));
}
function fmt(x: bigint) {
  return (Number(x / 10n ** 15n) / 1000).toString();
}

// ------------------------------------------------------------------ Privy policy mirror

/** After a grant lands: write the same limits as a policy on the agent's Privy wallet. No-op for local keys. */
export async function mirrorPolicy(mandateHash: Hex, mandate: Mandate): Promise<DemoAgent["policy"] | undefined> {
  const a = await agentForMandate(mandateHash);
  if (!a || !privy || !a.privyWallet) return undefined;
  const { policyId, policy } = await privy.agents.mirrorMandate({ wallet: a.privyWallet, mandate, mandateHash });
  a.policy = { policyId, mandateHash, rules: policy.rules, revoked: false };
  push(a, { at: Date.now(), kind: "info", message: `Privy policy ${policyId} now mirrors this mandate on the agent wallet`, mandateHash });
  return a.policy;
}

/** After an on-chain revoke: the wallet policy becomes deny-all. */
export async function revokePolicy(mandateHash: Hex): Promise<void> {
  const a = await agentForMandate(mandateHash).catch(() => undefined);
  if (!a || !privy || !a.policy || a.policy.mandateHash !== mandateHash || a.policy.revoked) return;
  await privy.agents.revokeMirror({ policyId: a.policy.policyId, mandateHash });
  a.policy.revoked = true;
  push(a, { at: Date.now(), kind: "info", message: `Privy policy ${a.policy.policyId} set to deny-all after revocation`, mandateHash });
}

/** Ask Privy to sign a transaction the policy forbids (a plain transfer). The refusal is the proof. */
export async function probePolicy(a: DemoAgent, to: Address) {
  if (!privy || !a.privyWallet) throw new Error("Agent key is not a Privy server wallet");
  const r = await privy.agents.probe({ wallet: a.privyWallet, to });
  push(a, {
    at: Date.now(),
    kind: r.blocked ? "rejected" : "info",
    message: r.blocked ? `Privy refused to sign a transfer outside the mandate policy: ${(r.reason ?? "").slice(0, 140)}` : `Privy signed a transfer (no policy attached) ${r.hash}`,
    mandateHash: a.mandateHash,
    tx: r.hash,
  });
  return r;
}
