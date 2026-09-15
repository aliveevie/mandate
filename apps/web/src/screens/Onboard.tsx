import { useEffect, useState } from "react";
import { PasskeyAccountAbi } from "@ibxlab/mandate";
import { encodeFunctionData, parseAbi } from "viem";
import { ArrowRight, Fingerprint, KeyRound, ShieldCheck, Cpu, Wallet, Zap, Mail, LockKeyhole } from "lucide-react";
import { usePrivySession } from "../lib/privy";
import type { Session } from "../App";
import { friendlyError, type FriendlyError } from "../lib/errors";
import { fmtTokens, getClient, getPublicClient, rpId } from "../lib/client";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import { Address, Button, Card, Notice, Pill, Stat, ErrorNotice } from "../components/primitives";

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

export default function Onboard({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const pc = getPublicClient(s.cfg);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [software, setSoftware] = useState(!window.PublicKeyCredential);
  const privy = usePrivySession(s.cfg.privy.enabled);
  const [privyStep, setPrivyStep] = useState<string | null>(null);
  const [privyInfo, setPrivyInfo] = useState<{ account: string; owner: string; scopePolicyId: string; delegated: boolean; signerId: string } | null>(null);

  const refresh = async () => {
    if (!s.principal) return;
    const [b, a] = await Promise.all([
      pc.readContract({ address: s.cfg.demo.asset, abi: erc20, functionName: "balanceOf", args: [s.principal.address] }),
      pc.readContract({ address: s.cfg.demo.asset, abi: erc20, functionName: "allowance", args: [s.principal.address, s.cfg.demo.venue] }),
    ]);
    setBalance(b); setAllowance(a); s.setApproved(a > 0n);
  };
  useEffect(() => { void refresh().catch(() => {}); }, [s.principal]);

  const create = async () => {
    setErr(null); setBusy("Waiting for your passkey…");
    try {
      const key = await client.passkey.createKey({ rpId: rpId(), rpName: "Mandate", userName: "principal", software });
      setBusy(s.tx.mode.kind === "wallet" ? "Confirm in your wallet: deploy account, then mint demo tokens…" : "Deploying your account (relayer pays gas)…");
      const out = await s.tx.deployAccount(key.publicKey);
      const principal = await client.passkey.attach(key, out.address);
      await client.passkey.save(principal);
      s.setPrincipal(principal);
      toast.push({ kind: "ok", title: "PasskeyAccount deployed", detail: out.address, link: { href: `${s.cfg.explorer}/address/${out.address}`, label: "View on explorer" } });
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(null); }
  };

  const approve = async () => {
    if (!s.principal) return;
    setErr(null); setBusy("Waiting for your passkey…");
    try {
      const call = { target: s.cfg.demo.asset, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [s.cfg.demo.venue, 2n ** 256n - 1n] }) };
      const nonce = await pc.readContract({ address: s.principal.address, abi: PasskeyAccountAbi, functionName: "nonce" });
      const digest = await pc.readContract({ address: s.principal.address, abi: PasskeyAccountAbi, functionName: "executeDigest", args: [call, nonce] });
      if (s.principal.kind === "signer") throw new Error("This principal signs through the Privy session signer");
      const signature = await s.principal.signChallenge(digest);
      setBusy(s.tx.mode.kind === "wallet" ? "Confirm in your wallet…" : "Relaying owner transaction…");
      const hash = await s.tx.executeOwner(s.principal.address, call, signature);
      toast.push({ kind: "ok", title: "Venue approved with a passkey-signed owner tx", link: { href: `${s.cfg.explorer}/tx/${hash}`, label: "View transaction" } });
      await refresh();
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(null); }
  };

  const forget = async () => { await client.passkey.clear(); s.setPrincipal(null); s.setPrivyPrincipal(null); s.setApproved(false); setBalance(null); setAllowance(null); };

  /** Privy path: sign in -> server deploys a SignerAccount owned by the embedded wallet -> user delegates a scoped signer. */
  const privyCreate = async () => {
    if (!privy) return;
    setErr(null);
    try {
      if (!privy.authenticated) { privy.login(); return; }
      if (!privy.embedded) { setErr(friendlyError(new Error("Your Privy account has no embedded wallet yet. Sign out and back in, or create one in the Privy modal."))); return; }
      const token = privy.identityToken;
      if (!token) { setErr(friendlyError(new Error("Privy identity token not ready yet; try again in a second."))); return; }
      setPrivyStep("Creating your account…");
      const info = await api<{ account: `0x${string}`; owner: `0x${string}`; scopePolicyId: string; delegated: boolean; signerId: string }>("/api/privy/principal", { json: { identityToken: token } });
      setPrivyInfo(info);
      if (!info.delegated) {
        setPrivyStep("Delegating a scoped session signer…");
        await privy.addSigners({ address: info.owner, signers: [{ signerId: info.signerId, policyIds: [info.scopePolicyId] }] });
        info.delegated = true;
      }
      const principal = await client.passkey.attachSigner({
        address: info.account, owner: info.owner,
        // Signing happens on the server through the delegated signer; the browser never signs anything itself.
        signTypedData: async () => { throw new Error("This principal signs through the Privy session signer on the server"); },
      });
      s.setPrincipal(principal);
      s.setPrivyPrincipal({ account: info.account, owner: info.owner, identityToken: () => privy.identityToken ?? null });
      toast.push({ kind: "ok", title: "Account ready; the session signer is delegated", detail: info.account, link: { href: `${s.cfg.explorer}/address/${info.account}`, label: "View on explorer" } });
    } catch (e) { setErr(friendlyError(e)); } finally { setPrivyStep(null); }
  };

  const privyApprove = async () => {
    if (!s.privyPrincipal) return;
    setErr(null); setBusy("Signing through the session signer…");
    try {
      const out = await api<{ hash: string }>("/api/privy/approve", { json: { identityToken: s.privyPrincipal.identityToken(), account: s.privyPrincipal.account } });
      toast.push({ kind: "ok", title: "Venue approved: EIP-712 signed by the session signer, no prompt", link: { href: `${s.cfg.explorer}/tx/${out.hash}`, label: "View transaction" } });
      await refresh();
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(null); }
  };
  const ready = !!s.principal && (allowance ?? 0n) > 0n;

  return (
    <div className="space-y-6">
      {!s.principal && (
        <section className="glass glass-strong rise relative overflow-hidden rounded-3xl p-7 md:p-10">
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand/30 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 left-1/3 h-56 w-56 rounded-full bg-brand-2/20 blur-3xl" />
          <Pill tone="brand" dot>Live on Monad testnet</Pill>
          <h1 className="mt-4 max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight md:text-5xl">
            Give your agent a <span className="gradient-text">mandate</span>, not your keys.
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/65">
            A passkey on your device owns a smart account on Monad. You sign a scoped, revocable mandate. The agent trades inside it, a breaker freezes it on drawdown, and its behaviour becomes portable ERC-8004 reputation. Every step below is one SDK call.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Stat label="Signature" value="P256 · WebAuthn" sub="verified via precompile 0x100" />
            <Stat label="Enforcement" value="On-chain caps" sub="lifetime · per-block · drawdown" />
            <Stat label="Identity" value="ERC-8004" sub="attested, never self-reported" />
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3 rise rise-1" title="Your principal" icon={<Fingerprint className="h-4 w-4" />} right={s.principal && <Pill tone="ok" dot>active</Pill>}>
          {!s.principal ? (
            <div className="space-y-5">
              <ol className="grid gap-3 sm:grid-cols-3">
                {[
                  { i: <KeyRound className="h-4 w-4" />, t: "Passkey", d: "Face ID / Touch ID creates a P256 key that never leaves your device." },
                  { i: <Cpu className="h-4 w-4" />, t: "Smart account", d: "A PasskeyAccount owned by that key is deployed on Monad." },
                  { i: <ShieldCheck className="h-4 w-4" />, t: "Precompile", d: "Every signature is verified on-chain through RIP-7212." },
                ].map((x) => (
                  <li key={x.t} className="rounded-xl bg-white/[.04] p-3.5 ring-1 ring-white/[.06]">
                    <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-white"><span className="text-brand-2">{x.i}</span>{x.t}</div>
                    <div className="text-xs leading-relaxed text-white/55">{x.d}</div>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-4">
                <Button size="lg" onClick={create} busy={!!busy} icon={<Fingerprint className="h-5 w-5" />}>{busy ?? "Create passkey & account"}</Button>
                <label className="flex items-center gap-2 text-xs text-white/50">
                  <input type="checkbox" className="accent-brand" checked={software} onChange={(e) => setSoftware(e.target.checked)} /> software key (no biometrics)
                </label>
              </div>
              <div className="flex items-center gap-2 text-xs text-white/45">
                {s.tx.mode.kind === "wallet" ? <Wallet className="h-3.5 w-3.5 text-brand-2" /> : <Zap className="h-3.5 w-3.5 text-brand-2" />}
                {s.tx.mode.kind === "wallet" ? "Your connected wallet will pay gas for the account deployment." : "Gasless demo: the relayer pays gas. Connect a wallet to pay your own."}
              </div>
              {privy && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <div className="mb-1 flex items-center gap-2 text-sm font-semibold"><Mail className="h-4 w-4 text-brand-2" /> No passkey device? Continue with Privy</div>
                  <p className="mb-3 text-xs leading-relaxed text-white/55">Sign in with email or Google. An embedded wallet owns your account, and you delegate a session signer that may sign <span className="mono">Mandate</span> typed data for this app and nothing else, so granting and revoking never prompt again.</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button kind="ghost" onClick={privyCreate} busy={!!privyStep} disabled={!privy.ready} icon={<LockKeyhole className="h-4 w-4" />}>
                      {privyStep ?? (privy.authenticated ? "Create account & delegate signer" : "Sign in with Privy")}
                    </Button>
                    {privy.authenticated && <span className="text-xs text-white/45">signed in{privy.embedded ? ` · wallet ${privy.embedded.address.slice(0, 8)}…` : ""} · <button className="underline" onClick={() => privy.logout()}>sign out</button></span>}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label={s.principal.kind === "signer" ? "SignerAccount" : "PasskeyAccount"} value={<Address value={s.principal.address} chars={8} className="text-sm text-white" explorer={`${s.cfg.explorer}/address/${s.principal.address}`} />} sub={s.principal.kind === "signer" ? "owned by your Privy embedded wallet" : "owned by your passkey"} />
                {s.principal.kind === "signer"
                  ? <Stat label="Session signer" value={privyInfo?.delegated || s.privyPrincipal ? "delegated" : "not delegated"} sub={privyInfo ? `scope policy ${privyInfo.scopePolicyId.slice(0, 10)}…` : "signs Mandate typed data only"} />
                  : <Stat label="Key" value={<span className="capitalize">{s.principal.kind}</span>} sub={s.principal.credentialId ? `credential ${s.principal.credentialId.slice(0, 14)}…` : "WebCrypto P-256"} />}
              </div>
              {s.principal.kind === "signer" ? (
                <div className="rounded-xl bg-black/30 p-3 ring-1 ring-white/[.06]">
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-white/40">Owner (embedded wallet)</div>
                  <div className="mono break-all text-[11px] leading-relaxed text-white/70">{s.principal.owner}</div>
                  <div className="mt-2 text-[11px] text-white/45">The delegated signer may sign only EIP-712 for the Mandate registry and this account on chain {s.cfg.chainId}. Revoke the delegation any time from your Privy account.</div>
                </div>
              ) : (
                <div className="rounded-xl bg-black/30 p-3 ring-1 ring-white/[.06]">
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-white/40">P256 public key</div>
                  <div className="mono break-all text-[11px] leading-relaxed text-white/70">x {s.principal.publicKey.x}<br />y {s.principal.publicKey.y}</div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button kind="ghost" size="sm" onClick={forget}>Forget passkey</Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2 rise rise-2" title="Prepare the account" icon={<ShieldCheck className="h-4 w-4" />}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Demo tokens" value={balance === null ? "—" : fmtTokens(balance, 0)} sub="minted on deploy" />
              <Stat label="Venue allowance" value={allowance === null ? "—" : allowance > 10n ** 30n ? "∞" : fmtTokens(allowance, 0)} sub="owner action" />
            </div>
            <p className="text-xs leading-relaxed text-white/50">The demo venue pulls tokens from your account when the agent trades. Approving it is an <em>owner</em> action: your passkey signs, {s.tx.mode.kind === "wallet" ? "your wallet pays" : "the relayer pays"}.</p>
            <Button onClick={s.privyPrincipal ? privyApprove : approve} disabled={!s.principal || ready} busy={!!busy && !!s.principal} icon={s.privyPrincipal ? <LockKeyhole className="h-4 w-4" /> : <Fingerprint className="h-4 w-4" />} className="w-full">
              {ready ? "Venue approved" : busy && s.principal ? busy : s.privyPrincipal ? "Approve venue (session signer, no prompt)" : "Approve venue with passkey"}
            </Button>
            {ready && <Button kind="subtle" className="w-full" onClick={() => s.go("grant")} icon={<ArrowRight className="h-4 w-4" />}>Next: grant a mandate</Button>}
          </div>
        </Card>
      </div>

      {err && <ErrorNotice error={err} />}
    </div>
  );
}
