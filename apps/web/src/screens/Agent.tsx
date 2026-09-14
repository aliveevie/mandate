import { useEffect, useState } from "react";
import type { Session } from "../App";
import { api, type AgentState, type AgentView } from "../lib/api";
import { fmtTokens, getClient } from "../lib/client";
import { Bar, Button, Card, Mono, Notice, Phase, TxLink } from "../components/ui";

export default function AgentScreen({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const [st, setSt] = useState<AgentState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forced, setForced] = useState<{ name: string; message: string } | null>(null);

  const load = async () => {
    if (!s.agent) return;
    const q = s.mandateHash ? `?mandateHash=${s.mandateHash}` : "";
    const next = await api<AgentState>(`/api/agents/${s.agent.id}/state${q}`);
    setSt(next);
    // The server answers for the agent that holds this mandate's key; keep the UI on that agent.
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
    try {
      const a = await api<AgentView>(`/api/agents/${s.agent.id}/run`, { json: { mandateHash: s.mandateHash } });
      if (a.id !== s.agent.id) s.setAgent(a); // server ran the agent that holds this mandate's key
      await load();
    } catch (e) { setErr((e as Error).message); }
  };
  const stop = async () => { if (!s.agent) return; await api(`/api/agents/${s.agent.id}/stop`, { json: {} }); await load(); };
  const force = async () => {
    if (!s.agent || !s.mandateHash) return;
    setBusy("force"); setForced(null);
    try {
      const r = await api<{ blocked: boolean; error?: { name: string; message: string } }>(`/api/agents/${s.agent.id}/force-out-of-bounds`, { json: { mandateHash: s.mandateHash } });
      if (r.blocked && r.error) setForced(r.error);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const revoke = async () => {
    if (!s.principal || !s.mandateHash) return;
    setBusy("revoke"); setErr(null);
    try {
      const digest = await client.mandate.revokeDigest(s.principal.address, s.mandateHash);
      const signature = await s.principal.signChallenge(digest); // Face ID
      await api("/api/relay/revoke", { json: { account: s.principal.address, mandateHash: s.mandateHash, signature } });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  if (!s.agent || !s.mandateHash) return <Notice kind="info">Provision an agent and grant a mandate first.</Notice>;

  const m = st?.mandate; const x = st?.state; const a = st?.agent;
  const spent = BigInt(x?.spent ?? 0), cap = BigInt(m?.spendCap ?? 1), blockSpent = BigInt(x?.spentThisBlock ?? 0), blockCap = BigInt(m?.perBlockCap ?? 1);
  const canRun = !!x && x.active && !a?.running;

  return (
    <div className="grid gap-5 md:grid-cols-3">
      <Card title="3 · Agent runner" right={a?.running ? <span className="text-xs text-emerald-400">● running</span> : <span className="text-xs text-zinc-500">stopped{a?.stopReason ? ` · ${a.stopReason}` : ""}</span>}>
        <div className="space-y-3 text-sm">
          <div><span className="text-zinc-500">mandate</span><br /><Mono>{s.mandateHash}</Mono></div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={!canRun}>Run</Button>
            <Button kind="ghost" onClick={stop} disabled={!a?.running}>Stop</Button>
            <Button kind="ghost" onClick={force} busy={busy === "force"}>Force out-of-bounds call</Button>
            <Button kind="danger" onClick={revoke} busy={busy === "revoke"} disabled={!s.principal || x?.revoked}>Revoke (passkey)</Button>
          </div>
          {forced && <Notice kind="error">Blocked before sending: <span className="mono">{forced.message}</span></Notice>}
          {err && <Notice kind="error">{err}</Notice>}
        </div>
      </Card>

      <Card title="Spend vs cap">
        <div className="space-y-3 text-sm">
          <div className="flex justify-between"><span>lifetime</span><span>{fmtTokens(spent)} / {fmtTokens(cap, 0)}</span></div>
          <Bar value={spent} max={cap} />
          <div className="flex justify-between"><span>this block</span><span>{fmtTokens(blockSpent)} / {fmtTokens(blockCap, 0)}</span></div>
          <Bar value={blockSpent} max={blockCap} color="bg-sky-500" />
          <div className="text-xs text-zinc-500">last execution block {x?.lastBlock ?? "—"}</div>
        </div>
      </Card>

      <Card title="Breaker">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between"><span>state</span>{x ? <Phase phase={x.breaker} /> : "—"}</div>
          <div className="flex justify-between"><span>drawdown</span><span>{x ? `${(Number(x.drawdownBps) / 100).toFixed(2)}%` : "—"}</span></div>
          <div className="flex justify-between"><span>trip threshold</span><span>{m ? `${Number(m.maxDrawdownBps) / 100}%` : "—"}</span></div>
          <div className="flex justify-between"><span>mandate</span><span>{x?.revoked ? "revoked" : x?.active ? "active" : "inactive"}</span></div>
          <p className="text-xs text-zinc-500">Equity is the account's token balance, so every buy is a drawdown. Watch the breaker trip once spend crosses the threshold, then the agent freezes.</p>
        </div>
      </Card>

      <div className="md:col-span-3">
        <Card title="Executions feed">
          <ul className="max-h-80 space-y-1 overflow-auto text-sm">
            {[...(a?.feed ?? [])].reverse().map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 border-b border-zinc-800/60 py-1.5">
                <span className="w-16 text-xs text-zinc-500">{new Date(f.at).toLocaleTimeString()}</span>
                <span className={`rounded px-1.5 text-xs ${f.kind === "executed" ? "bg-emerald-900/50 text-emerald-300" : f.kind === "rejected" ? "bg-rose-900/50 text-rose-300" : f.kind === "stopped" ? "bg-amber-900/50 text-amber-300" : "bg-zinc-800 text-zinc-300"}`}>{f.kind}</span>
                <span className="mono text-xs">{f.message}</span>
                {f.tx && <TxLink hash={f.tx} explorer={s.cfg.explorer} />}
              </li>
            ))}
            {(a?.feed?.length ?? 0) === 0 && <li className="text-zinc-500">No activity yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
