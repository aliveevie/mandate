import { useEffect, useRef, useState } from "react";
import { Award, Search, ShieldCheck, Sparkles } from "lucide-react";
import type { Session } from "../App";
import { api } from "../lib/api";
import { Address, Button, Card, inputCls, Notice, Pill, Ring, Stat, TxLink } from "../components/primitives";

interface Rep {
  agentId: string; score: number | null; trips: number; executed: number; pnlBps: string; attestations: number;
  window: { start: string; end: string } | null; evidenceHash: string | null;
  erc8004: { count: string; value: string; decimals: number } | null;
  history: { complianceScore: number; tripCount: number; executedCount: number; realisedPnlBps: string; windowStart: string; windowEnd: string; evidenceHash: string }[];
  indexed: { Attestation?: { tx: string; complianceScore: number; evidenceHash: string; mirrored: boolean }[] } | null;
}

export default function Reputation({ s }: { s: Session }) {
  const [agentId, setAgentId] = useState(s.agent?.agentId ?? "1831");
  const [rep, setRep] = useState<Rep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = async (id = agentId) => {
    const mine = ++seq.current; setErr(null); setLoading(true);
    try { const r = await api<Rep>(`/api/reputation/${id}`); if (mine === seq.current) setRep(r); }
    catch (e) { if (mine === seq.current) setErr((e as Error).message); }
    finally { if (mine === seq.current) setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const pick = (id: string) => { setAgentId(id); void load(id); };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="ERC-8004 reputation" icon={<Award className="h-4 w-4" />} className="rise rise-1 lg:col-span-2">
          <div className="space-y-3">
            <div className="flex gap-2">
              <input className={`${inputCls} mono`} value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent id" />
              <Button onClick={() => load()} busy={loading} icon={<Search className="h-4 w-4" />}>Load</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {s.agent && <Button kind="subtle" size="sm" onClick={() => pick(s.agent!.agentId)}>my agent #{s.agent.agentId}</Button>}
              <Button kind="subtle" size="sm" onClick={() => pick("1831")}>demo agent #1831</Button>
            </div>
            {err && <Notice kind="error"><span className="mono text-xs">{err}</span></Notice>}
            <p className="text-xs leading-relaxed text-white/50">Only the attestor (the Chainlink CRE workflow in production) can write. It computes compliance from indexed executions, breaker trips and PnL, commits its inputs in an <span className="mono">evidenceHash</span>, and the adapter mirrors the score into the ERC-8004 Reputation Registry. Agents cannot self-attest.</p>
          </div>
        </Card>

        <Card className="rise rise-2 lg:col-span-3" title={`Agent #${rep?.agentId ?? agentId}`} icon={<Sparkles className="h-4 w-4" />} right={rep?.erc8004 && Number(rep.erc8004.count) > 0 ? <Pill tone="ok" dot>mirrored to ERC-8004</Pill> : <Pill>no ERC-8004 feedback yet</Pill>}>
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <Ring value={rep?.score ?? null} />
            <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Trips" value={rep?.trips ?? "—"} />
              <Stat label="Executed" value={rep?.executed ?? "—"} />
              <Stat label="PnL" value={rep ? `${(Number(rep.pnlBps) / 100).toFixed(2)}%` : "—"} sub="realised, bps → %" />
              <Stat label="Attestations" value={rep?.attestations ?? "—"} sub="by the attestor" />
              <Stat label="ERC-8004 feedback" value={rep?.erc8004 ? rep.erc8004.count : "—"} sub={rep?.erc8004 ? `value ${rep.erc8004.value}` : "registry read"} />
              <Stat label="Window" value={rep?.window ? `${Math.round((Number(rep.window.end) - Number(rep.window.start)) / 60)} min` : "—"} sub={rep?.window ? new Date(Number(rep.window.end) * 1000).toLocaleString() : ""} />
            </div>
          </div>
        </Card>
      </div>

      <Card title="Attestation history" icon={<ShieldCheck className="h-4 w-4" />} className="rise rise-3">
        {rep && rep.history.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-white/40"><tr><th className="py-2 pr-4">window</th><th className="pr-4">score</th><th className="pr-4">trips</th><th className="pr-4">executed</th><th className="pr-4">PnL bps</th><th>evidence hash</th></tr></thead>
              <tbody>
                {[...rep.history].reverse().map((h, i) => (
                  <tr key={i} className="border-t border-white/[.06]">
                    <td className="py-2.5 pr-4 text-white/70">{new Date(Number(h.windowStart) * 1000).toLocaleString()} → {new Date(Number(h.windowEnd) * 1000).toLocaleTimeString()}</td>
                    <td className="pr-4 font-semibold text-white">{h.complianceScore}</td><td className="pr-4">{h.tripCount}</td><td className="pr-4">{h.executedCount}</td><td className="pr-4">{h.realisedPnlBps}</td>
                    <td><Address value={h.evidenceHash} chars={8} className="text-white/70" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="py-6 text-center text-sm text-white/40">No attestations for this agent yet. The attestor writes after a behaviour window closes.</div>}
        {rep?.indexed?.Attestation && rep.indexed.Attestation.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-white/40">from the indexer: {rep.indexed.Attestation.map((a, i) => <TxLink key={i} hash={a.tx} explorer={s.cfg.explorer} />)}</div>
        )}
      </Card>
    </div>
  );
}
