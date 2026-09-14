import { useEffect, useRef, useState } from "react";
import type { Session } from "../App";
import { api } from "../lib/api";
import { Button, Card, inputCls, Mono, Notice, TxLink } from "../components/ui";

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
  const seq = useRef(0);
  // Only the latest request may update the screen; an earlier slow response must not overwrite it.
  const load = async (id = agentId) => {
    const mine = ++seq.current;
    setErr(null);
    try {
      const r = await api<Rep>(`/api/reputation/${id}`);
      if (mine === seq.current) setRep(r);
    } catch (e) { if (mine === seq.current) setErr((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  return (
    <div className="grid gap-5 md:grid-cols-3">
      <Card title="4 · ERC-8004 reputation">
        <div className="space-y-3 text-sm">
          <label className="block text-xs text-zinc-400">agent id<input className={`${inputCls} mt-1`} value={agentId} onChange={(e) => setAgentId(e.target.value)} /></label>
          <div className="flex gap-2"><Button onClick={() => load()}>Load</Button>{s.agent && <Button kind="ghost" onClick={() => { setAgentId(s.agent!.agentId); void load(s.agent!.agentId); }}>my agent</Button>}<Button kind="ghost" onClick={() => { setAgentId("1831"); void load("1831"); }}>demo agent 1831</Button></div>
          {err && <Notice kind="error">{err}</Notice>}
        </div>
      </Card>

      <Card title="Score">
        {rep ? (
          <div className="space-y-2 text-sm">
            <div className="text-5xl font-bold">{rep.score ?? "—"}<span className="text-base font-normal text-zinc-500"> / 100</span></div>
            <div className="grid grid-cols-3 gap-2 text-xs text-zinc-400">
              <div>trips<br /><span className="text-base text-zinc-100">{rep.trips}</span></div>
              <div>executed<br /><span className="text-base text-zinc-100">{rep.executed}</span></div>
              <div>PnL bps<br /><span className="text-base text-zinc-100">{rep.pnlBps}</span></div>
            </div>
            <div className="text-xs text-zinc-500">{rep.attestations} attestation{rep.attestations === 1 ? "" : "s"} by the attestor · {rep.erc8004 ? `ERC-8004 registry: ${rep.erc8004.count} feedback, value ${rep.erc8004.value}` : "not mirrored to ERC-8004 yet"}</div>
          </div>
        ) : <div className="text-zinc-500">—</div>}
      </Card>

      <Card title="How it is written">
        <p className="text-sm text-zinc-500">Only the attestor (the Chainlink CRE workflow in production) can write. It computes compliance from indexed executions, breaker trips and PnL, hashes its inputs into <span className="mono">evidenceHash</span>, and the adapter mirrors the score into the ERC-8004 Reputation Registry. The agent cannot self-attest.</p>
      </Card>

      <div className="md:col-span-3">
        <Card title="Attestation history">
          {rep && rep.history.length > 0 ? (
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500"><tr><th className="py-1">window</th><th>score</th><th>trips</th><th>executed</th><th>PnL bps</th><th>evidence hash</th></tr></thead>
              <tbody>
                {[...rep.history].reverse().map((h, i) => (
                  <tr key={i} className="border-t border-zinc-800/60">
                    <td className="py-1.5">{new Date(Number(h.windowStart) * 1000).toLocaleString()} → {new Date(Number(h.windowEnd) * 1000).toLocaleTimeString()}</td>
                    <td>{h.complianceScore}</td><td>{h.tripCount}</td><td>{h.executedCount}</td><td>{h.realisedPnlBps}</td>
                    <td><Mono>{h.evidenceHash}</Mono></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="text-sm text-zinc-500">No attestations for this agent yet.</div>}
          {rep?.indexed?.Attestation && rep.indexed.Attestation.length > 0 && (
            <div className="mt-3 text-xs text-zinc-500">from the indexer: {rep.indexed.Attestation.map((a, i) => <span key={i} className="mr-2"><TxLink hash={a.tx} explorer={s.cfg.explorer} /></span>)}</div>
          )}
        </Card>
      </div>
    </div>
  );
}
