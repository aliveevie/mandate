import { useEffect, useState } from "react";
import { Ban, Bot, Fingerprint, Play, Square, Zap, CheckCircle2, XCircle, Info, PauseCircle } from "lucide-react";
import type { Session } from "../App";
import { api, type AgentState, type AgentView } from "../lib/api";
import { fmtTokens, getClient } from "../lib/client";
import { useToast } from "../lib/toast";
import { Bar, Button, Card, Gauge, Notice, Pill, Stat, TxLink } from "../components/primitives";

export default function AgentScreen({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const toast = useToast();
  const [st, setSt] = useState<AgentState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forced, setForced] = useState<{ name: string; message: string } | null>(null);

  const load = async () => {
    if (!s.agent) return;
    const q = s.mandateHash ? `?mandateHash=${s.mandateHash}` : "";
    const next = await api<AgentState>(`/api/agents/${s.agent.id}/state${q}`);
    setSt(next);
    if (next.agent.id !== s.agent.id) s.setAgent(next.agent);
  };
  useEffect(() => {
    void load().catch((e) => setErr(e.message));
    const t = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [s.agent?.id, s.mandateHash]);

  const run = async () => {
    if (!s.agent || !s.mandateHash) return;
    setErr(null);
    try { const a = await api<AgentView>(`/api/agents/${s.agent.id}/run`, { json: { mandateHash: s.mandateHash } }); if (a.id !== s.agent.id) s.setAgent(a); await load(); }
    catch (e) { setErr((e as Error).message); }
  };
  const stop = async () => { if (!s.agent) return; await api(`/api/agents/${s.agent.id}/stop`, { json: {} }); await load(); };
  const force = async () => {
    if (!s.agent || !s.mandateHash) return;
    setBusy("force"); setForced(null);
    try {
      const r = await api<{ blocked: boolean; error?: { name: string; message: string } }>(`/api/agents/${s.agent.id}/force-out-of-bounds`, { json: { mandateHash: s.mandateHash } });
      if (r.blocked && r.error) { setForced(r.error); toast.push({ kind: "info", title: `Blocked before sending: ${r.error.name}`, detail: r.error.message }); }
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const revoke = async () => {
    if (!s.principal || !s.mandateHash) return;
    setBusy("revoke"); setErr(null);
    try {
      const digest = await client.mandate.revokeDigest(s.principal.address, s.mandateHash);
      const signature = await s.principal.signChallenge(digest);
      const hash = await s.tx.revoke(s.principal.address, s.mandateHash, signature);
      toast.push({ kind: "ok", title: "Mandate revoked", link: { href: `${s.cfg.explorer}/tx/${hash}`, label: "Revoke transaction" } });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  if (!s.agent || !s.mandateHash) return <Notice kind="info">Provision an agent and grant a mandate first.</Notice>;

  const m = st?.mandate; const x = st?.state; const a = st?.agent;
  const spent = BigInt(x?.spent ?? 0), cap = BigInt(m?.spendCap ?? 1), blockSpent = BigInt(x?.spentThisBlock ?? 0), blockCap = BigInt(m?.perBlockCap ?? 1);
  const dd = x ? Number(x.drawdownBps) / 100 : 0, thr = m ? Number(m.maxDrawdownBps) / 100 : 100;
  const phase = x?.breaker ?? "Armed";
  const tone = phase === "Tripped" ? "bad" : phase === "Cooldown" ? "warn" : dd > thr * 0.7 ? "warn" : "ok";
  const canRun = !!x && x.active && !a?.running;
  const status = a?.running ? { tone: "ok" as const, text: "running" } : x?.revoked ? { tone: "bad" as const, text: "revoked" } : phase === "Tripped" ? { tone: "bad" as const, text: "frozen by breaker" } : { tone: "neutral" as const, text: a?.stopReason ?? "idle" };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Agent runner" icon={<Bot className="h-4 w-4" />} right={<Pill tone={status.tone} dot={status.tone === "ok"}>{status.text}</Pill>} className="rise rise-1 lg:col-span-1">
          <div className="space-y-4">
            <Stat label="Mandate" value={<span className="mono break-all text-[11px] font-normal leading-relaxed text-white/80">{s.mandateHash}</span>} />
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={run} disabled={!canRun} icon={<Play className="h-4 w-4" />}>Run</Button>
              <Button kind="ghost" onClick={stop} disabled={!a?.running} icon={<Square className="h-4 w-4" />}>Stop</Button>
              <Button kind="subtle" onClick={force} busy={busy === "force"} icon={<Ban className="h-4 w-4" />} className="col-span-2">Force out-of-bounds call</Button>
              <Button kind="danger" onClick={revoke} busy={busy === "revoke"} disabled={!s.principal || x?.revoked} icon={<Fingerprint className="h-4 w-4" />} className="col-span-2">Revoke with passkey</Button>
            </div>
            {forced && <Notice kind="warn"><div className="font-semibold">Blocked before sending</div><div className="mono mt-1 text-[11px] text-white/75">{forced.message}</div><div className="mt-1 text-[11px] text-white/50">The SDK ran the registry's validate and raised the typed error. No transaction was sent.</div></Notice>}
            {err && <Notice kind="error"><span className="mono text-xs">{err}</span></Notice>}
          </div>
        </Card>

        <Card title="Breaker" icon={<Zap className="h-4 w-4" />} right={<Pill tone={phase === "Armed" ? "ok" : phase === "Tripped" ? "bad" : "warn"} dot={phase === "Armed"}>{phase}</Pill>} className={`rise rise-2 ${phase === "Tripped" ? "glow-bad" : phase === "Cooldown" ? "glow-warn" : ""}`}>
          <Gauge value={dd} threshold={thr} label="drawdown from peak" tone={tone} />
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <Stat label="Trips" value={a?.feed.filter((f) => f.kind === "stopped" && /Tripped/.test(f.message)).length ?? 0} />
            <Stat label="Liveness" value={x?.revoked ? "revoked" : x?.active ? "active" : "blocked"} />
          </div>
        </Card>

        <Card title="Spend vs caps" className="rise rise-3">
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-end justify-between text-sm"><span className="text-white/60">Lifetime</span><span className="mono">{fmtTokens(spent, 1)} <span className="text-white/40">/ {fmtTokens(cap, 0)}</span></span></div>
              <Bar value={spent} max={cap} />
            </div>
            <div>
              <div className="mb-1.5 flex items-end justify-between text-sm"><span className="text-white/60">This block</span><span className="mono">{fmtTokens(blockSpent, 1)} <span className="text-white/40">/ {fmtTokens(blockCap, 0)}</span></span></div>
              <Bar value={blockSpent} max={blockCap} tone="sky" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Remaining" value={fmtTokens(BigInt(x?.remaining ?? 0), 0)} />
              <Stat label="Last block" value={<span className="mono text-sm">{x?.lastBlock === "0" ? "—" : x?.lastBlock ?? "—"}</span>} />
            </div>
          </div>
        </Card>
      </div>

      <Card title="Executions" icon={<Zap className="h-4 w-4" />} right={<span className="text-[11px] text-white/40">live · refreshes every 3s</span>} className="rise rise-4">
        <ul className="scroll-thin max-h-[380px] space-y-1 overflow-auto pr-1">
          {[...(a?.feed ?? [])].reverse().map((f, i) => (
            <li key={i} className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 odd:bg-white/[.03]">
              <span className="mono w-[68px] shrink-0 text-[11px] text-white/40">{new Date(f.at).toLocaleTimeString()}</span>
              {f.kind === "executed" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : f.kind === "rejected" ? <XCircle className="h-4 w-4 text-bad" /> : f.kind === "stopped" ? <PauseCircle className="h-4 w-4 text-warn" /> : <Info className="h-4 w-4 text-brand-2" />}
              <span className={`mono min-w-0 flex-1 truncate text-xs ${f.kind === "rejected" ? "text-rose-200" : "text-white/85"}`} title={f.message}>{f.message}</span>
              {f.tx && <TxLink hash={f.tx} explorer={s.cfg.explorer} />}
            </li>
          ))}
          {(a?.feed?.length ?? 0) === 0 && <li className="px-3 py-6 text-center text-sm text-white/40">No activity yet. Press Run.</li>}
        </ul>
      </Card>
    </div>
  );
}
