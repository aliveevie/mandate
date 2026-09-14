import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { LogOut, Wallet } from "lucide-react";
import { Button, Address } from "./primitives";

const MONAD_TESTNET = 10143 as const;

export function WalletButton({ chainId: _chainId }: { chainId: number }) {
  const chainId = MONAD_TESTNET;
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: bal } = useBalance({ address, chainId, query: { enabled: !!address } });

  if (!isConnected || !address) {
    const c = connectors[0];
    return (
      <Button kind="ghost" size="sm" icon={<Wallet className="h-4 w-4" />} busy={isPending} disabled={!c} onClick={() => c && connect({ connector: c })} className="whitespace-nowrap">
        {c ? "Connect wallet" : "No wallet found"}
      </Button>
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
