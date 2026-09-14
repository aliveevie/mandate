import { useEffect, useState } from "react";
import type { Principal } from "@ibxlab/mandate";
import { api, type AgentView, type PublicConfig } from "./lib/api";
import { getClient } from "./lib/client";
import Onboard from "./screens/Onboard";
import Grant from "./screens/Grant";
import AgentScreen from "./screens/Agent";
import Reputation from "./screens/Reputation";
import { Notice } from "./components/ui";

type Screen = "onboard" | "grant" | "agent" | "reputation";
const SCREENS: { id: Screen; label: string; n: number }[] = [
  { id: "onboard", label: "Onboard", n: 1 },
  { id: "grant", label: "Grant", n: 2 },
  { id: "agent", label: "Agent", n: 3 },
  { id: "reputation", label: "Reputation", n: 4 },
];

export interface Session {
  cfg: PublicConfig;
  principal: Principal | null;
  setPrincipal: (p: Principal | null) => void;
  agent: AgentView | null;
  setAgent: (a: AgentView | null) => void;
  mandateHash: `0x${string}` | null;
  setMandateHash: (h: `0x${string}` | null) => void;
  go: (s: Screen) => void;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("onboard");
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [mandateHash, setMandateHash] = useState<`0x${string}` | null>(() => (localStorage.getItem("mandate.lastHash") as `0x${string}`) || null);

  useEffect(() => {
    api<PublicConfig>("/api/config")
      .then(async (c) => {
        setCfg(c);
        const p = await getClient(c).passkey.load();
        if (p) setPrincipal(p);
        const agents = await api<AgentView[]>("/api/agents");
        const savedAgent = localStorage.getItem("mandate.agentId");
        const found = agents.find((a) => a.id === savedAgent) ?? agents[agents.length - 1] ?? null;
        if (found) setAgent(found);
      })
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (mandateHash) localStorage.setItem("mandate.lastHash", mandateHash);
  }, [mandateHash]);
  useEffect(() => {
    if (agent) localStorage.setItem("mandate.agentId", agent.id);
  }, [agent]);

  if (err) return <div className="p-8"><Notice kind="error">Server unreachable: {err}</Notice></div>;
  if (!cfg) return <div className="p-8 text-zinc-400">Loading…</div>;

  const session: Session = { cfg, principal, setPrincipal, agent, setAgent, mandateHash, setMandateHash, go: setScreen };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mandate <span className="text-zinc-500">reference app</span></h1>
          <p className="mt-1 text-sm text-zinc-400">Scoped, revocable, passkey-signed delegations for AI agents on Monad testnet. Every action below is one SDK call.</p>
        </div>
        <div className="text-right text-xs text-zinc-500">
          <div>chain {cfg.chainId} · relayer <span className="mono">{cfg.relayer.address.slice(0, 8)}…</span></div>
          <div>registry <span className="mono">{cfg.addresses.registry.slice(0, 10)}…</span></div>
        </div>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2">
        {SCREENS.map((s) => (
          <button key={s.id} onClick={() => setScreen(s.id)} className={`rounded-lg px-3 py-1.5 text-sm ${screen === s.id ? "bg-violet-600 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}>
            <span className="mr-1.5 text-xs opacity-60">{s.n}</span>{s.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          {principal && <span>principal <span className="mono text-zinc-300">{principal.address.slice(0, 8)}…</span></span>}
          {agent && <span>agent #{agent.agentId}</span>}
          {mandateHash && <span>mandate <span className="mono text-zinc-300">{mandateHash.slice(0, 8)}…</span></span>}
        </div>
      </nav>

      {screen === "onboard" && <Onboard s={session} />}
      {screen === "grant" && <Grant s={session} />}
      {screen === "agent" && <AgentScreen s={session} />}
      {screen === "reputation" && <Reputation s={session} />}

      <footer className="mt-12 text-xs text-zinc-600">
        Built on the <a className="underline" href="https://github.com/aliveevie/mandate" target="_blank" rel="noreferrer">@ibxlab/mandate</a> SDK. Passkeys never leave your device; the server only pays gas.
      </footer>
    </div>
  );
}
