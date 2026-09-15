import { useAccount, useBalance } from "wagmi";
import { Droplets } from "lucide-react";

export const FAUCET_URL = "https://faucet.monad.xyz";
const LOW_MON = 0.15;

/** Opens the Monad testnet faucet. Highlighted when the connected wallet cannot cover gas. */
export function FaucetButton({ chainId: _chainId }: { chainId: number }) {
  const chainId = 10143 as const;
  const { address, isConnected } = useAccount();
  const { data: bal } = useBalance({ address, chainId, query: { enabled: !!address, refetchInterval: 15_000 } });
  const low = isConnected && !!bal && Number(bal.formatted) < LOW_MON;
  return (
    <a
      href={FAUCET_URL}
      target="_blank"
      rel="noreferrer"
      title={low ? `Your wallet holds ${Number(bal!.formatted).toFixed(3)} MON. Get testnet MON to pay gas.` : "Get Monad testnet MON"}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-semibold transition ${low ? "btn-brand text-white" : "ring-1 ring-white/15 text-white/75 hover:bg-white/[.06]"}`}
    >
      <Droplets className="h-3.5 w-3.5" />
      {low ? "Low on MON · get faucet" : "Faucet"}
    </a>
  );
}
