import { useMemo, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import { ERC8004IdentityRegistryAbi, MandateRegistryAbi } from "@ibxlab/mandate";
import { parseAbi, parseEventLogs, type Address as Addr, type Hex } from "viem";
import { ArrowRight, Bot, Fingerprint, ShieldCheck, LockKeyhole, Landmark, KeyRound } from "lucide-react";
import type { Session } from "../App";
import { friendlyError, type FriendlyError } from "../lib/errors";
import { api, type AgentView } from "../lib/api";
import { getClient, getPublicClient } from "../lib/client";
import { claimIdentity, defaultPolicy, sealPolicy, storeVault, type AgentPolicy } from "../lib/prf";
import { ensureSession } from "../lib/session";
import { useToast } from "../lib/toast";
import { Address, Button, Card, Field, inputCls, Notice, Pill, Stat, TxLink, ErrorNotice } from "../components/primitives";

const SELECTORS = ["buy(address,uint256)", "noop()"];

export default function Grant({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [spendCap, setSpendCap] = useState(300);
  const [perBlockCap, setPerBlockCap] = useState(150);
  const [drawdown, setDrawdown] = useState(15);
  const [hours, setHours] = useState(24);
  const [selected, setSelected] = useState<string[]>(SELECTORS);
  const [result, setResult] = useState<{ mandateHash: `0x${string}`; tx: string; policy?: { policyId: string; rules: { name: string; action: string; method: string }[] } | { error: string } | null; policyHash?: `0x${string}` } | null>(null);
  // Mera PRF: the passkey encrypts the agent's strategy and owns the agent's ERC-8004 identity. Both are non-wallet jobs.
  const prfCapable = s.principal?.kind === "webauthn";
  const [strategy, setStrategy] = useState<AgentPolicy>(defaultPolicy());
  const [encryptPolicy, setEncryptPolicy] = useState(true);
  const [claim, setClaim] = useState<{ address: string; namespace: string; tx: string | null } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const pc = getPublicClient(s.cfg);

  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const provision = async () => {
    setErr(null); setBusy("provision");
    try {
      if (s.principal) await ensureSession(s.principal, s.cfg.chainId);
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
      setClaim(null);
      toast.push({ kind: "ok", title: `Agent #${a.agentId} registered in ERC-8004`, link: { href: `${s.cfg.explorer}/tx/${a.registerTx}`, label: "Registration tx" } });
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(null); }
  };

  const claimAgentIdentity = async () => {
    if (!s.agent || !prfCapable || s.principal?.kind !== "webauthn") return;
    setErr(null); setClaiming(true);
    try {
      await ensureSession(s.principal, s.cfg.chainId);
      const out = await claimIdentity(s.agent.agentId, s.principal.credentialId);
      setClaim({ address: out.address, namespace: out.namespace, tx: out.tx });
      s.setAgent({ ...s.agent, identityOwner: out.owner, identityClaimTx: out.tx ?? undefined });
      toast.push({ kind: "ok", title: out.alreadyOwned ? "Identity already owned by your passkey-derived key" : `ERC-8004 #${s.agent.agentId} now owned by a key only your passkey can re-derive`, detail: out.address, link: out.tx ? { href: `${s.cfg.explorer}/tx/${out.tx}`, label: "Transfer tx" } : undefined });
    } catch (e) { setErr(friendlyError(e)); } finally { setClaiming(false); }
  };

  const grant = async () => {
    if (!s.principal || !s.agent) return;
    setErr(null); setResult(null); setBusy("sign");
    try {
      if (s.privyPrincipal) {
        // Session signer: the server signs the Mandate typed data on the embedded wallet and relays. No prompt.
        setBusy("relay");
        const out = await api<{ hash: string; mandateHash: `0x${string}`; policy: { policyId: string; rules: { name: string; action: string; method: string }[] } | { error: string } | null }>("/api/privy/grant", {
          json: { identityToken: s.privyPrincipal.identityToken(), account: s.privyPrincipal.account, draft: {
            agentId: s.agent.agentId, agentKey: s.agent.agentKey, targets: [{ address: s.cfg.demo.venue, selectors: selected }], asset: s.cfg.demo.asset,
            spendCap: (BigInt(spendCap) * 10n ** 18n).toString(), perBlockCap: (BigInt(perBlockCap) * 10n ** 18n).toString(), maxDrawdownBps: drawdown * 100,
            validUntil: Math.floor(Date.now() / 1000) + hours * 3600,
          } },
        });
        setResult({ mandateHash: out.mandateHash, tx: out.hash, policy: out.policy });
        s.setMandateHash(out.mandateHash);
        toast.push({ kind: "ok", title: "Mandate granted via the session signer (no prompt)", detail: out.mandateHash, link: { href: `${s.cfg.explorer}/tx/${out.hash}`, label: "Grant transaction" } });
        return;
      }
      // Mera PRF: encrypt the strategy to PRF(mandate:policy:<principal>:<nonce>) so the mandate commits to it.
      let sealed: { vault: Awaited<ReturnType<typeof sealPolicy>>["vault"]; policyHash: `0x${string}` } | null = null;
      if (encryptPolicy && s.principal.kind === "webauthn") {
        setBusy("seal");
        const nonce = await pc.readContract({ address: s.cfg.addresses.registry as Addr, abi: MandateRegistryAbi, functionName: "nonces", args: [s.principal.address] });
        sealed = await sealPolicy({ principal: s.principal.address, nonce, credentialId: s.principal.credentialId, policy: strategy });
        setBusy("sign");
      }
      const draft = client.mandate.build({
        agentId: BigInt(s.agent.agentId), agentKey: s.agent.agentKey,
        targets: [{ address: s.cfg.demo.venue, selectors: selected }],
        asset: s.cfg.demo.asset,
        spendCap: BigInt(spendCap) * 10n ** 18n, perBlockCap: BigInt(perBlockCap) * 10n ** 18n,
        maxDrawdownBps: drawdown * 100, validUntil: new Date(Date.now() + hours * 3600_000),
        policyHash: sealed?.policyHash,
      });
      const signed = await client.mandate.sign(draft, s.principal);
      setBusy(s.tx.mode.kind === "wallet" ? "wallet" : "relay");
      const out = await s.tx.grant(signed);
      // Wallet mode grants on the client; ask the server to mirror the policy onto a Privy-held agent key.
      let policy: { policyId: string; rules: { name: string; action: string; method: string }[] } | { error: string } | null = (out as { policy?: never }).policy ?? null;
      if (s.cfg.privy.enabled && s.agent.custody === "privy" && s.tx.mode.kind === "wallet") {
        policy = (await api<{ policy: typeof policy }>(`/api/mandates/${out.mandateHash}/mirror`, { json: {} }).catch((e) => ({ policy: { error: (e as Error).message } }))).policy;
      }
      // The ciphertext goes to a dumb blob store keyed by policyHash; the server cannot read or alter it.
      if (sealed) await storeVault(sealed.vault, sealed.policyHash).catch(() => { /* local copy below still works */ });
      if (sealed) try { localStorage.setItem(`mandate.vault.${sealed.policyHash}`, JSON.stringify(sealed.vault)); } catch { /* storage optional */ }
      setResult({ mandateHash: out.mandateHash, tx: out.hash, policy, policyHash: sealed?.policyHash });
      s.setMandateHash(out.mandateHash);
      toast.push({ kind: "ok", title: sealed ? "Mandate granted with a passkey-encrypted policy" : "Mandate granted", detail: out.mandateHash, link: { href: `${s.cfg.explorer}/tx/${out.hash}`, label: "Grant transaction" } });
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(null); }
  };

  const summary = useMemo(() => [
    `May call ${selected.length} function${selected.length === 1 ? "" : "s"} on the demo venue and nothing else`,
    `May spend at most ${spendCap} tokens in total, ${perBlockCap} per block`,
    `Is frozen automatically if drawdown from peak exceeds ${drawdown}%`,
    `Expires in ${hours}h · revocable by your passkey at any time`,
  ], [selected, spendCap, perBlockCap, drawdown, hours]);

  const busyLabel = busy === "seal" ? "Passkey PRF: encrypting your policy…" : busy === "sign" ? "Waiting for your passkey…" : busy === "wallet" ? "Confirm in your wallet…" : busy === "relay" ? "Relaying grant…" : null;

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
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Executing key" value={<Address value={s.agent.agentKey} chars={6} className="text-sm text-white" explorer={`${s.cfg.explorer}/address/${s.agent.agentKey}`} />} sub={s.agent.custody === "privy" ? `Privy server wallet ${s.agent.privyWalletId?.slice(0, 10)}…` : "signs agent transactions"} />
                <Stat label="ERC-8004 registration" value={<TxLink hash={s.agent.registerTx} explorer={s.cfg.explorer} />} sub={<button className="hover:text-white" onClick={provision}>{busy === "provision" ? "provisioning…" : "provision another"}</button>} />
              </div>
              {prfCapable && s.tx.mode.kind !== "wallet" && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <div className="mb-1 flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-brand-2" /> Identity owner: a key only your passkey can re-derive</div>
                  <p className="mb-3 text-xs leading-relaxed text-white/55">Mera PRF namespace <span className="mono">mandate:agent-id:{s.agent.agentId}</span> derives a secp256k1 key that never touches disk. It becomes the owner of ERC-8004 #{s.agent.agentId}: unlinkable to your other agents, reconstructible from the passkey on any device.</p>
                  {s.agent.identityOwner || claim ? (
                    <div className="space-y-1 text-xs">
                      <div className="flex flex-wrap items-center gap-2"><Pill tone="ok" dot>owned by your passkey-derived key</Pill><Address value={claim?.address ?? s.agent.identityOwner!} chars={8} className="text-white" explorer={`${s.cfg.explorer}/address/${claim?.address ?? s.agent.identityOwner}`} /></div>
                      {(claim?.tx ?? s.agent.identityClaimTx) && <TxLink hash={(claim?.tx ?? s.agent.identityClaimTx)!} explorer={s.cfg.explorer} label="identity transfer" />}
                    </div>
                  ) : (
                    <Button kind="ghost" size="sm" onClick={claimAgentIdentity} busy={claiming} icon={<Fingerprint className="h-4 w-4" />}>{claiming ? "Passkey PRF: deriving identity…" : "Own this identity with my passkey"}</Button>
                  )}
                </div>
              )}
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

        <Card title="Agent strategy, encrypted with your passkey" icon={<LockKeyhole className="h-4 w-4" />} className="rise rise-3" right={prfCapable ? <Pill tone="brand" dot>Mera PRF</Pill> : <Pill tone="neutral">passkey principals only</Pill>}>
          <p className="mb-4 text-xs leading-relaxed text-white/55">
            The strategy parameters are the agent's private memory. They are encrypted with AES-256-GCM under a key HKDF-derived from your passkey's PRF output for namespace <span className="mono">mandate:policy:&lt;principal&gt;:&lt;nonce&gt;</span>, stored as ciphertext in a dumb blob store, and the mandate's <span className="mono">policyHash</span> commits to them. No server, disk or wallet ever sees the key or the plaintext.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Strategy"><input className={inputCls} value={strategy.strategy} onChange={(e) => setStrategy({ ...strategy, strategy: e.target.value })} /></Field>
            <Field label="Max slippage (bps)"><input className={inputCls} type="number" min={1} max={1000} value={strategy.maxSlippageBps} onChange={(e) => setStrategy({ ...strategy, maxSlippageBps: Number(e.target.value) })} /></Field>
            <div className="sm:col-span-2"><Field label="Operator note (private)"><input className={inputCls} value={strategy.note} onChange={(e) => setStrategy({ ...strategy, note: e.target.value })} /></Field></div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-xs text-white/60">
            <input type="checkbox" className="accent-brand" checked={encryptPolicy && prfCapable} disabled={!prfCapable} onChange={(e) => setEncryptPolicy(e.target.checked)} />
            Encrypt with my passkey (Mera PRF) and commit the ciphertext hash in the mandate
          </label>
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
            <Button size="lg" className="w-full" onClick={grant} disabled={!s.principal || !s.agent || selected.length === 0} busy={!!busyLabel} icon={s.privyPrincipal ? <LockKeyhole className="h-5 w-5" /> : <Fingerprint className="h-5 w-5" />}>{busyLabel ?? (s.privyPrincipal ? "Grant via session signer (no prompt)" : "Sign with passkey & grant")}</Button>
            {!s.principal && <Notice kind="warn">Create a passkey principal first.</Notice>}
            {s.principal && !s.approved && <Notice kind="warn">The venue is not approved yet; the agent's first trade will fail until you approve it on the Passkey step.</Notice>}
            <div className="text-center text-[11px] text-white/40">EIP-712 typed data · domain Mandate v1 · bound to chain {s.cfg.chainId} and the registry</div>
          </div>
        </Card>
        {result && (
          <Notice kind="ok" className="rise">
            <div className="font-semibold">Mandate granted</div>
            <div className="mono mt-1 break-all text-[11px] text-white/70">{result.mandateHash}</div>
            {result.policyHash && <div className="mt-1 text-[11px] text-white/60">policy encrypted with your passkey · policyHash <span className="mono break-all">{result.policyHash}</span></div>}
            <div className="mt-2 flex items-center gap-3"><TxLink hash={result.tx} explorer={s.cfg.explorer} /><button className="inline-flex items-center gap-1 text-xs font-semibold text-white hover:underline" onClick={() => s.go("agent")}>Run the agent <ArrowRight className="h-3 w-3" /></button>{result.policyHash && <button className="text-xs font-semibold text-white hover:underline" onClick={() => s.go("onboard")}>Cross-device check</button>}</div>
          </Notice>
        )}
        {result?.policy && "policyId" in result.policy && (
          <Card title="Mirrored to the agent wallet" icon={<Landmark className="h-4 w-4" />} className="rise">
            <p className="mb-3 text-xs leading-relaxed text-white/55">The same limits now exist as a Privy wallet policy on the agent's server wallet. The chain enforces; Privy refuses to sign anything else first.</p>
            <div className="mono mb-2 text-[11px] text-white/60">policy {result.policy.policyId}</div>
            <ul className="space-y-1 text-xs">
              {result.policy.rules.map((r) => (
                <li key={r.name} className="flex items-center gap-2"><span className={`rounded px-1.5 text-[10px] font-bold ${r.action === "ALLOW" ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`}>{r.action}</span><span className="mono text-white/60">{r.method}</span><span className="text-white/75">{r.name}</span></li>
              ))}
            </ul>
          </Card>
        )}
        {result?.policy && "error" in result.policy && <Notice kind="warn">Policy mirror failed: <span className="mono text-xs">{result.policy.error}</span></Notice>}
        {err && <ErrorNotice error={err} />}
      </div>
    </div>
  );
}
