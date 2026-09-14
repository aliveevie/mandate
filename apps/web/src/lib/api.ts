export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    method: init?.method ?? (init?.json ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : init?.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message ?? data?.error ?? `${res.status} ${path}`) as Error & { data?: unknown };
    err.data = data;
    throw err;
  }
  return data as T;
}

export interface PublicConfig {
  chainId: number;
  rpcUrl: string;
  addresses: { registry: string; executor: string; breaker: string; submitter: string; reputationAdapter: string; erc8004Identity?: string; erc8004Reputation?: string };
  demo: { asset: `0x${string}`; venue: `0x${string}`; mintAmount: string; agentGas: string };
  relayer: { address: string; balance: string; min: string; low: boolean };
  explorer: string;
  envio: boolean;
}

export interface AgentView {
  id: string;
  agentId: string;
  agentKey: `0x${string}`;
  registerTx: string;
  fundTx: string;
  fundedBy?: string;
  pending?: boolean;
  createdAt: number;
  running: boolean;
  mandateHash?: `0x${string}`;
  stopReason?: string;
  feed: { at: number; kind: "executed" | "rejected" | "stopped" | "info"; message: string; tx?: string; amount?: string; error?: { name: string; args: string[] } }[];
}

export interface AgentState {
  agent: AgentView;
  mandateHash?: `0x${string}`;
  mandate?: { spendCap: string; perBlockCap: string; maxDrawdownBps: string; validUntil: string; asset: string };
  state?: {
    spent: string; remaining: string; spentThisBlock: string; remainingThisBlock: string; lastBlock: string;
    revoked: boolean; active: boolean; breaker: "Armed" | "Tripped" | "Cooldown"; drawdownBps: string;
  };
}
