import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, usePublicClient, useWalletClient } from "wagmi";
import type { Principal } from "@ibxlab/mandate";
import { api, type AgentView, type PublicConfig } from "./lib/api";
import { getClient } from "./lib/client";
import { wagmiConfig } from "./lib/wagmi";
import { ToastProvider } from "./lib/toast";
import { makePrincipalTx, type PrincipalTx } from "./lib/tx";
import { Shell, type Screen } from "./components/Shell";
import { Notice } from "./components/primitives";
import Onboard from "./screens/Onboard";
import Grant from "./screens/Grant";
import AgentScreen from "./screens/Agent";
import Reputation from "./screens/Reputation";

export interface Session {
  cfg: PublicConfig;
  tx: PrincipalTx;
  principal: Principal | null;
  setPrincipal: (p: Principal | null) => void;
  agent: AgentView | null;
  setAgent: (a: AgentView | null) => void;
  mandateHash: `0x${string}` | null;
  setMandateHash: (h: `0x${string}` | null) => void;
  approved: boolean;
  setApproved: (v: boolean) => void;
  go: (s: Screen) => void;
}

const queryClient = new QueryClient();

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Inner />
        </ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Inner() {
  const [screen, setScreen] = useState<Screen>("onboard");
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [approved, setApproved] = useState(false);
  const [mandateHash, setMandateHash] = useState<`0x${string}` | null>(() => (localStorage.getItem("mandate.lastHash") as `0x${string}`) || null);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  useEffect(() => {
    api<PublicConfig>("/api/config")
      .then(async (c) => {
        setCfg(c);
        const p = await getClient(c).passkey.load();
        if (p) setPrincipal(p);
        const agents = await api<AgentView[]>("/api/agents");
        const saved = localStorage.getItem("mandate.agentId");
        setAgent(agents.find((a) => a.id === saved) ?? agents[agents.length - 1] ?? null);
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { if (mandateHash) localStorage.setItem("mandate.lastHash", mandateHash); }, [mandateHash]);
  useEffect(() => { if (agent) localStorage.setItem("mandate.agentId", agent.id); }, [agent]);

  const tx = useMemo(() => (cfg && publicClient ? makePrincipalTx(cfg, publicClient, walletClient) : null), [cfg, publicClient, walletClient]);

  if (err) return <div className="bg-ambient min-h-screen p-8"><Notice kind="error">Server unreachable: {err}</Notice></div>;
  if (!cfg || !tx) return <div className="bg-ambient flex min-h-screen items-center justify-center text-white/50">Loading…</div>;

  const session: Session = { cfg, tx, principal, setPrincipal, agent, setAgent, mandateHash, setMandateHash, approved, setApproved, go: setScreen };
  const done: Record<Screen, boolean> = { onboard: !!principal && approved, grant: !!mandateHash, agent: false, reputation: false };

  return (
    <Shell cfg={cfg} screen={screen} go={setScreen} done={done} principalAddr={principal?.address} mode={tx.mode.label}>
      <div key={screen} className="rise">
        {screen === "onboard" && <Onboard s={session} />}
        {screen === "grant" && <Grant s={session} />}
        {screen === "agent" && <AgentScreen s={session} />}
        {screen === "reputation" && <Reputation s={session} />}
      </div>
    </Shell>
  );
}
