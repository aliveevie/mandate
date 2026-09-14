import { useEffect, useState } from "react";
import { PasskeyAccountAbi } from "@ibxlab/mandate";
import { encodeFunctionData, parseAbi } from "viem";
import type { Session } from "../App";
import { api } from "../lib/api";
import { fmtTokens, getClient, getPublicClient, rpId } from "../lib/client";
import { Button, Card, Mono, Notice, TxLink } from "../components/ui";

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

export default function Onboard({ s }: { s: Session }) {
  const client = getClient(s.cfg);
  const pc = getPublicClient(s.cfg);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<{ label: string; tx?: string }[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [software, setSoftware] = useState(!window.PublicKeyCredential);

  const refresh = async () => {
    if (!s.principal) return;
    const [b, a] = await Promise.all([
      pc.readContract({ address: s.cfg.demo.asset, abi: erc20, functionName: "balanceOf", args: [s.principal.address] }),
      pc.readContract({ address: s.cfg.demo.asset, abi: erc20, functionName: "allowance", args: [s.principal.address, s.cfg.demo.venue] }),
    ]);
    setBalance(b);
    setAllowance(a);
  };
  useEffect(() => { void refresh(); }, [s.principal]);

  const create = async () => {
    setErr(null); setBusy("Creating passkey…");
    try {
      // 1. Key in the authenticator (Face ID / Touch ID). Only the public key leaves the device.
      const key = await client.passkey.createKey({ rpId: rpId(), rpName: "Mandate", userName: "principal", software });
      setBusy("Deploying your account (server pays gas)…");
      // 2. Server deploys the PasskeyAccount for this public key and seeds demo tokens.
      const out = await api<{ address: `0x${string}`; mintTx: string }>("/api/relay/account", { json: { publicKey: key.publicKey } });
      const principal = await client.passkey.attach(key, out.address);
      await client.passkey.save(principal);
      s.setPrincipal(principal);
      setLog((l) => [...l, { label: `Account deployed at ${out.address}` }, { label: "Minted 1000 demo tokens", tx: out.mintTx }]);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const approve = async () => {
    if (!s.principal) return;
    setErr(null); setBusy("Waiting for passkey…");
    try {
      const call = { target: s.cfg.demo.asset, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [s.cfg.demo.venue, 2n ** 256n - 1n] }) };
      const nonce = await pc.readContract({ address: s.principal.address, abi: PasskeyAccountAbi, functionName: "nonce" });
      const digest = await pc.readContract({ address: s.principal.address, abi: PasskeyAccountAbi, functionName: "executeDigest", args: [call, nonce] });
      const signature = await s.principal.signChallenge(digest); // Face ID
      setBusy("Relaying owner transaction…");
      const out = await api<{ hash: string }>("/api/relay/execute", { json: { account: s.principal.address, call, signature } });
      setLog((l) => [...l, { label: "Venue approved by passkey-signed owner tx", tx: out.hash }]);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const forget = async () => { await client.passkey.clear(); s.setPrincipal(null); setBalance(null); setAllowance(null); };

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card title="1 · Your passkey principal">
        {!s.principal ? (
          <div className="space-y-4">
            <p className="text-sm text-zinc-300">Create a passkey. It becomes the owner of a smart account on Monad; the P256 signature is verified on-chain through the precompile. No seed phrase, no wallet extension.</p>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={software} onChange={(e) => setSoftware(e.target.checked)} /> use a software key (no biometrics; for demos on machines without a passkey authenticator)
            </label>
            <Button onClick={create} busy={!!busy}>{busy ?? "Create passkey + account"}</Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div><span className="text-zinc-500">PasskeyAccount</span><br /><Mono>{s.principal.address}</Mono></div>
            <div><span className="text-zinc-500">P256 public key</span><br /><Mono>x {s.principal.publicKey.x}</Mono><br /><Mono>y {s.principal.publicKey.y}</Mono></div>
            <div className="text-zinc-500">kind: {s.principal.kind}{s.principal.credentialId ? ` · credential ${s.principal.credentialId.slice(0, 12)}…` : ""}</div>
            <div className="flex gap-2 pt-1"><Button kind="ghost" onClick={forget}>Forget</Button><Button kind="ghost" onClick={() => s.go("grant")}>Next: grant a mandate →</Button></div>
          </div>
        )}
      </Card>

      <Card title="Prepare the account">
        <div className="space-y-3 text-sm">
          <div className="flex justify-between"><span className="text-zinc-500">Demo token balance</span><span>{balance === null ? "—" : fmtTokens(balance)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-500">Venue allowance</span><span>{allowance === null ? "—" : allowance > 10n ** 30n ? "unlimited" : fmtTokens(allowance)}</span></div>
          <p className="text-xs text-zinc-500">The agent trades on a demo venue that pulls tokens from your account. Approving it is an <em>owner</em> action: signed by your passkey, relayed by the server.</p>
          <Button onClick={approve} disabled={!s.principal || (allowance !== null && allowance > 0n)} busy={busy === "Waiting for passkey…" || busy === "Relaying owner transaction…"}>Approve venue with passkey</Button>
        </div>
      </Card>

      {(log.length > 0 || err) && (
        <div className="md:col-span-2 space-y-2">
          {err && <Notice kind="error">{err}</Notice>}
          {log.map((l, i) => (
            <Notice key={i} kind="ok">{l.label} {l.tx && <TxLink hash={l.tx} explorer={s.cfg.explorer} />}</Notice>
          ))}
        </div>
      )}

      <Card title="Mera PRF cross-device panel">
        <p className="text-sm text-zinc-500">Lands in the Mera PRF pull request: encrypted policy blob and per-agent identities derived from this passkey, reproduced on a second device.</p>
      </Card>
    </div>
  );
}
