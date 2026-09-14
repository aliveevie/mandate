import { useMemo, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import { ERC8004IdentityRegistryAbi } from "@ibxlab/mandate";
import { parseAbi, parseEventLogs, type Address as Addr, type Hex } from "viem";
import { ArrowRight, Bot, Fingerprint, ShieldCheck } from "lucide-react";
import type { Session } from "../App";
import { api, type AgentView } from "../lib/api";
import { getClient } from "../lib/client";
import { useToast } from "../lib/toast";
import { Address, Button, Card, Field, inputCls, Notice, Pill, Stat, TxLink } from "../components/primitives";

const SELECTORS = ["buy(address,uint256)", "noop()"];

export default function Grant({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spendCap, setSpendCap] = useState(300);
  const [perBlockCap, setPerBlockCap] = useState(150);
  const [drawdown, setDrawdown] = useState(15);
  const [hours, setHours] = useState(24);
  const [selected, setSelected] = useState<string[]>(SELECTORS);
  const [result, setResult] = useState<{ mandateHash: `0x${string}`; tx: string } | null>(null);

  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const provision = async () => {
    setErr(null); setBusy("provision");
    try {
      let a: AgentView;
      if (s.tx.mode.kind === "wallet" && walletClient?.account && publicClient) {
        // Wallet mode: the server only mints a key; your wallet registers the ERC-8004 identity and funds the key.
        const { agentKey } = await api<{ agentKey: Addr }>("/api/agents/prepare", { json: {} });
        const identity = s.cfg.addresses.erc8004Identity as Addr;
        const registerTx = await walletClient.writeContract({ address: identity, abi: ERC8004IdentityRegistryAbi, functionName: "register", args: [`https://mandate.ibxlab.xyz/agents/${agentKey}.json`], account: walletClient.account, chain: walletClient.chain });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: registerTx });
        const transfer = parseEventLogs({ abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]), logs: receipt.logs })[0];
        if (!transfer) throw new Error("ERC-8004 register emitted no Transfer");
        const fundTx = await walletClient.sendTransaction({ to: agentKey, value: BigInt(s.cfg.demo.agentGas), account: walletClient.account, chain: walletClient.chain });
        await publicClient.waitForTransactionReceipt({ hash: fundTx });
        a = await api<AgentView>("/api/agents/activate", { json: { agentKey, agentId: transfer.args.tokenId.toString(), registerTx, fundTx: fundTx as Hex, fundedBy: walletClient.account.address } });
      } else {
        a = await api<AgentView>("/api/agents", { json: { label: "reference" } });
      }
      s.setAgent(a);
      toast.push({ kind: "ok", title: `Agent #${a.agentId} registered in ERC-8004`, link: { href: `${s.cfg.explorer}/tx/${a.registerTx}`, label: "Registration tx" } });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const grant = async () => {
    if (!s.principal || !s.agent) return;
    setErr(null); setResult(null); setBusy("sign");
    try {
      const draft = client.mandate.build({
        agentId: BigInt(s.agent.agentId), agentKey: s.agent.agentKey,
        targets: [{ address: s.cfg.demo.venue, selectors: selected }],
        asset: s.cfg.demo.asset,
        spendCap: BigInt(spendCap) * 10n ** 18n, perBlockCap: BigInt(perBlockCap) * 10n ** 18n,
        maxDrawdownBps: drawdown * 100, validUntil: new Date(Date.now() + hours * 3600_000),
      });
      const signed = await client.mandate.sign(draft, s.principal);
      setBusy(s.tx.mode.kind === "wallet" ? "wallet" : "relay");
      const out = await s.tx.grant(signed);
      setResult({ mandateHash: out.mandateHash, tx: out.hash });
      s.setMandateHash(out.mandateHash);
      toast.push({ kind: "ok", title: "Mandate granted", detail: out.mandateHash, link: { href: `${s.cfg.explorer}/tx/${out.hash}`, label: "Grant transaction" } });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const summary = useMemo(() => [
    `May call ${selected.length} function${selected.length === 1 ? "" : "s"} on the demo venue and nothing else`,
    `May spend at most ${spendCap} tokens in total, ${perBlockCap} per block`,
    `Is frozen automatically if drawdown from peak exceeds ${drawdown}%`,
    `Expires in ${hours}h · revocable by your passkey at any time`,
  ], [selected, spendCap, perBlockCap, drawdown, hours]);

  const busyLabel = busy === "sign" ? "Waiting for your passkey…" : busy === "wallet" ? "Confirm in your wallet…" : busy === "relay" ? "Relaying grant…" : null;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <Card title="Agent" icon={<Bot className="h-4 w-4" />} right={s.agent && <Pill tone="brand">ERC-8004 #{s.agent.agentId}</Pill>} className="rise rise-1">
          {!s.agent ? (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-white/65">Provision a demo agent: a fresh executing key funded for gas and registered as an ERC-8004 identity. {s.tx.mode.kind === "wallet" ? "Your wallet registers the identity (you own it) and funds the key with 0.3 MON; unspent gas is swept back to you when the agent stops." : "The relayer funds and registers it."} In production this is your agent's own key.</p>
              <Button onClick={provision} busy={busy === "provision"} icon={<Bot className="h-4 w-4" />}>{busy === "provision" ? (s.tx.mode.kind === "wallet" ? "Confirm register + fund in your wallet…" : "Registering ERC-8004 identity…") : "Provision agent"}</Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat label="Executing key" value={<Address value={s.agent.agentKey} chars={6} className="text-sm text-white" explorer={`${s.cfg.explorer}/address/${s.agent.agentKey}`} />} sub="signs agent transactions" />
              <Stat label="ERC-8004 registration" value={<TxLink hash={s.agent.registerTx} explorer={s.cfg.explorer} />} sub={<button className="hover:text-white" onClick={provision}>{busy === "provision" ? "provisioning…" : "provision another"}</button>} />
            </div>
          )}
        </Card>

        <Card title="Mandate terms" icon={<ShieldCheck className="h-4 w-4" />} className="rise rise-2">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Lifetime spend cap" right={<span className="mono text-white">{spendCap} tokens</span>}>
              <input type="range" min={50} max={1000} step={10} value={spendCap} onChange={(e) => setSpendCap(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label="Per-block cap" right={<span className="mono text-white">{perBlockCap} tokens</span>}>
              <input type="range" min={10} max={500} step={10} value={perBlockCap} onChange={(e) => setPerBlockCap(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label="Max drawdown before the breaker trips" right={<span className="mono text-white">{drawdown}%</span>} hint="Equity is the account's token balance in this demo, so every buy counts as drawdown. Lower = trips sooner.">
              <input type="range" min={5} max={100} step={1} value={drawdown} onChange={(e) => setDrawdown(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label="Valid for" right={<span className="mono text-white">{hours}h</span>}>
              <input type="range" min={1} max={168} step={1} value={hours} onChange={(e) => setHours(Number(e.target.value))} className="w-full" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Allowed functions on the demo venue" hint={<span className="mono">{s.cfg.demo.venue}</span>}>
                <div className="flex flex-wrap gap-2">
                  {SELECTORS.map((sel) => {
                    const on = selected.includes(sel);
                    return <button key={sel} onClick={() => setSelected(on ? selected.filter((x) => x !== sel) : [...selected, sel])} className={`mono rounded-lg px-3 py-1.5 text-xs ring-1 transition ${on ? "bg-brand/20 text-violet-100 ring-brand/50" : "bg-white/[.04] text-white/50 ring-white/10 hover:bg-white/[.08]"}`}>{sel}</button>;
                  })}
                  <span className="mono rounded-lg px-3 py-1.5 text-xs text-white/30 ring-1 ring-dashed ring-white/10">forbidden() · not allowed</span>
                </div>
              </Field>
            </div>
          </div>
        </Card>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <Card title="What you are signing" className="rise rise-3">
          <ul className="space-y-2.5">
            {summary.map((line) => (
              <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-white/75"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />{line}</li>
            ))}
          </ul>
          <div className="mt-5 space-y-3">
            <Button size="lg" className="w-full" onClick={grant} disabled={!s.principal || !s.agent || selected.length === 0} busy={!!busyLabel} icon={<Fingerprint className="h-5 w-5" />}>{busyLabel ?? "Sign with passkey & grant"}</Button>
            {!s.principal && <Notice kind="warn">Create a passkey principal first.</Notice>}
            {s.principal && !s.approved && <Notice kind="warn">The venue is not approved yet; the agent's first trade will fail until you approve it on the Passkey step.</Notice>}
            <div className="text-center text-[11px] text-white/40">EIP-712 typed data · domain Mandate v1 · bound to chain {s.cfg.chainId} and the registry</div>
          </div>
        </Card>
        {result && (
          <Notice kind="ok" className="rise">
            <div className="font-semibold">Mandate granted</div>
            <div className="mono mt-1 break-all text-[11px] text-white/70">{result.mandateHash}</div>
            <div className="mt-2 flex items-center gap-3"><TxLink hash={result.tx} explorer={s.cfg.explorer} /><button className="inline-flex items-center gap-1 text-xs font-semibold text-white hover:underline" onClick={() => s.go("agent")}>Run the agent <ArrowRight className="h-3 w-3" /></button></div>
          </Notice>
        )}
        {err && <Notice kind="error"><span className="font-semibold">Grant failed.</span> <span className="mono text-xs">{err}</span></Notice>}
      </div>
    </div>
  );
}
