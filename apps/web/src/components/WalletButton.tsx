import { useEffect, useRef, useState } from "react";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { Button, Address } from "./primitives";
import { useToast } from "../lib/toast";
import { friendlyError } from "../lib/errors";

const MONAD_TESTNET = 10143 as const;
const CONNECT_TIMEOUT_MS = 25_000;

export function WalletButton({ chainId: _chainId }: { chainId: number }) {
  const chainId = MONAD_TESTNET;
  const { address, isConnected, chain } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: bal } = useBalance({ address, chainId, query: { enabled: !!address } });
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Prefer wallets announced via EIP-6963 (they carry a name and icon); fall back to the generic injected one.
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const options: readonly Connector[] = announced.length > 0 ? announced : connectors;

  const connectWith = async (c: Connector) => {
    setOpen(false);
    setBusy(c.name);
    try {
      await Promise.race([
        connectAsync({ connector: c, chainId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${c.name} did not respond. Open the extension, unlock it, or reload the page.`)), CONNECT_TIMEOUT_MS)),
      ]);
    } catch (e) {
      const f = friendlyError(e);
      toast.push({ kind: f.cancelled ? "info" : "error", title: f.cancelled ? f.title : `Could not connect ${c.name}`, detail: f.detail ?? f.title });
    } finally {
      setBusy(null);
    }
  };

  if (!isConnected || !address) {
    if (options.length === 0) {
      return <Button kind="ghost" size="sm" icon={<Wallet className="h-4 w-4" />} disabled>No wallet found</Button>;
    }
    return (
      <div className="relative" ref={menuRef}>
        <Button kind="ghost" size="sm" icon={<Wallet className="h-4 w-4" />} busy={!!busy} onClick={() => (options.length === 1 ? connectWith(options[0]!) : setOpen((v) => !v))} className="whitespace-nowrap">
          {busy ? `Connecting ${busy}…` : "Connect wallet"}{options.length > 1 && !busy && <ChevronDown className="h-3.5 w-3.5 opacity-60" />}
        </Button>
        {open && (
          <div className="glass glass-strong absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl p-1">
            {options.map((c) => (
              <button key={c.uid} onClick={() => connectWith(c)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/[.08]">
                {c.icon ? <img src={c.icon} alt="" className="h-5 w-5 rounded" /> : <Wallet className="h-4 w-4 text-white/50" />}
                <span className="truncate">{c.name}</span>
              </button>
            ))}
            <div className="px-3 pb-1.5 pt-2 text-[10px] text-white/35">Wallets announced by your browser. Pick one that is unlocked.</div>
          </div>
        )}
      </div>
    );
  }
  const wrong = chain?.id !== chainId;
  return (
    <div className="flex items-center gap-2">
      {wrong ? (
        <Button kind="danger" size="sm" busy={switching} onClick={() => switchChain({ chainId })}>Switch to Monad testnet</Button>
      ) : (
        <span className="glass hidden items-center gap-2 rounded-xl px-3 py-1.5 sm:inline-flex">
          <span className="h-2 w-2 rounded-full bg-ok live-dot" />
          <Address value={address} chars={4} className="text-white/85" />
          {bal && <span className="mono text-[11px] text-white/45">{Number(bal.formatted).toFixed(3)} MON</span>}
        </span>
      )}
      <button className="rounded-lg p-1.5 text-white/40 hover:bg-white/[.06] hover:text-white" title="disconnect" onClick={() => disconnect()}><LogOut className="h-4 w-4" /></button>
    </div>
  );
}
