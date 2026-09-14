import { useState } from "react";
import type { Session } from "../App";
import { api, type AgentView } from "../lib/api";
import { getClient } from "../lib/client";
import { Button, Card, Field, inputCls, Mono, Notice, TxLink } from "../components/ui";

export default function Grant({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ spendCap: "500", perBlockCap: "300", maxDrawdownBps: "2000", hours: "24", selectors: "buy(address,uint256), noop()" });
  const [result, setResult] = useState<{ mandateHash: string; tx: string } | null>(null);

  const provision = async () => {
    setErr(null); setBusy("Provisioning agent (funding key, registering ERC-8004 identity)…");
    try {
      const a = await api<AgentView>("/api/agents", { json: { label: "reference" } });
      s.setAgent(a);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const grant = async () => {
    if (!s.principal || !s.agent) return;
    setErr(null); setResult(null); setBusy("Building mandate…");
    try {
      const draft = client.mandate.build({
        agentId: BigInt(s.agent.agentId),
        agentKey: s.agent.agentKey,
        // split on commas that are not inside a parameter list, so "buy(address,uint256), noop()" stays intact
        targets: [{ address: s.cfg.demo.venue, selectors: form.selectors.split(/,(?![^()]*\))/).map((x) => x.trim()).filter(Boolean) }],
        asset: s.cfg.demo.asset,
        spendCap: BigInt(form.spendCap) * 10n ** 18n,
        perBlockCap: BigInt(form.perBlockCap) * 10n ** 18n,
        maxDrawdownBps: Number(form.maxDrawdownBps),
        validUntil: new Date(Date.now() + Number(form.hours) * 3600_000),
      });
      setBusy("Waiting for passkey signature…");
      const signed = await client.mandate.sign(draft, s.principal); // Face ID
      setBusy("Relaying grant…");
      const out = await api<{ hash: string; mandateHash: `0x${string}` }>("/api/relay/grant", { json: signed });
      setResult({ mandateHash: out.mandateHash, tx: out.hash });
      s.setMandateHash(out.mandateHash);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card title="2 · Agent" right={s.agent && <span className="text-xs text-zinc-500">ERC-8004 #{s.agent.agentId}</span>}>
        {!s.agent ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">Provision a demo agent: a fresh executing key, funded for gas, registered as an ERC-8004 identity.</p>
            <Button onClick={provision} busy={busy?.startsWith("Provisioning")}>{busy?.startsWith("Provisioning") ? busy : "Provision agent"}</Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div><span className="text-zinc-500">agentKey</span><br /><Mono>{s.agent.agentKey}</Mono></div>
            <div><span className="text-zinc-500">ERC-8004 registration</span> <TxLink hash={s.agent.registerTx} explorer={s.cfg.explorer} /></div>
            <Button kind="ghost" onClick={provision} busy={busy?.startsWith("Provisioning")}>Provision another</Button>
          </div>
        )}
      </Card>

      <Card title="Mandate terms">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Lifetime spend cap (tokens)"><input className={inputCls} value={form.spendCap} onChange={set("spendCap")} /></Field>
          <Field label="Per-block cap (tokens)"><input className={inputCls} value={form.perBlockCap} onChange={set("perBlockCap")} /></Field>
          <Field label="Max drawdown (bps)" hint="2000 = breaker trips at 20% drawdown"><input className={inputCls} value={form.maxDrawdownBps} onChange={set("maxDrawdownBps")} /></Field>
          <Field label="Valid for (hours)"><input className={inputCls} value={form.hours} onChange={set("hours")} /></Field>
          <div className="col-span-2"><Field label="Allowed selectors on the demo venue" hint={`venue ${s.cfg.demo.venue}`}><input className={`${inputCls} mono`} value={form.selectors} onChange={set("selectors")} /></Field></div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={grant} disabled={!s.principal || !s.agent} busy={!!busy && !busy.startsWith("Provisioning")}>{busy && !busy.startsWith("Provisioning") ? busy : "Sign with passkey + grant"}</Button>
          {!s.principal && <span className="text-xs text-zinc-500">create a principal first</span>}
        </div>
      </Card>

      {err && <div className="md:col-span-2"><Notice kind="error">{err}</Notice></div>}
      {result && (
        <div className="md:col-span-2">
          <Notice kind="ok">
            Mandate granted. hash <Mono>{result.mandateHash}</Mono> · <TxLink hash={result.tx} explorer={s.cfg.explorer} /> · <button className="underline" onClick={() => s.go("agent")}>run the agent →</button>
          </Notice>
        </div>
      )}

      <Card title="Privy policy mirror">
        <p className="text-sm text-zinc-500">Lands in the Privy pull request: the same limits written as a wallet policy on the agent's server wallet at grant time. The registry enforces; Privy pre-blocks.</p>
      </Card>
    </div>
  );
}
