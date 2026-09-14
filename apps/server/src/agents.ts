import { MandateError, type Agent, type MandateState } from "@ibxlab/mandate";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { config } from "./config.js";
import { deployerWallet, publicClient, registerAgentIdentity, sdk, wait } from "./chain.js";

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
  createdAt: number;
  running: boolean;
  mandateHash?: Hex;
  stopReason?: string;
  feed: FeedItem[];
  /** In-memory demo key. PR-2 replaces this with a Privy server wallet. */
  account: PrivateKeyAccount;
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
    createdAt: a.createdAt,
    running: a.running,
    mandateHash: a.mandateHash,
    stopReason: a.stopReason,
    feed: feed.slice(-50),
  };
}

/** Provision: fresh executing key, funded for gas, registered as an ERC-8004 identity. */
export async function provisionAgent(label = "demo-agent"): Promise<DemoAgent> {
  const account = privateKeyToAccount(generatePrivateKey());
  const fundTx = await deployerWallet.sendTransaction({ to: account.address, value: config.demo.agentGas });
  await wait(fundTx);
  const { agentId, tx } = await registerAgentIdentity(`https://mandate.ibxlab.xyz/agents/${label}-${Date.now()}.json`);
  const agent: DemoAgent = {
    id: agentId.toString(),
    agentId,
    agentKey: account.address,
    registerTx: tx,
    fundTx,
    createdAt: Date.now(),
    running: false,
    feed: [{ at: Date.now(), kind: "info", message: `Agent ${agentId} registered in ERC-8004 and funded with gas` }],
    account,
  };
  agents.set(agent.id, agent);
  return agent;
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
}

const TERMINAL = new Set(["Tripped", "MandateRevoked", "MandateExpired", "MandateNotFound", "NotAgentKey"]);

/** Keep the demo agent's gas topped up from the relayer. Production agents pay their own gas. */
async function refuel(a: DemoAgent) {
  const bal = await publicClient.getBalance({ address: a.agentKey });
  if (bal >= config.demo.agentGasMin) return;
  const tx = await deployerWallet.sendTransaction({ to: a.agentKey, value: config.demo.agentGasTopUp });
  await wait(tx);
  push(a, { at: Date.now(), kind: "info", message: `Refuelled agent gas (+${fmt(config.demo.agentGasTopUp)} MON)`, tx });
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
