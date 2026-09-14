import type { ReactNode } from "react";
import { Bot, Fingerprint, ShieldCheck, Sparkles, Check, AlertTriangle, Fuel } from "lucide-react";
import { Logo, Pill } from "./primitives";
import { WalletButton } from "./WalletButton";
import type { PublicConfig } from "../lib/api";

export type Screen = "onboard" | "grant" | "agent" | "reputation";
export const STEPS: { id: Screen; label: string; blurb: string; icon: ReactNode }[] = [
  { id: "onboard", label: "Passkey", blurb: "Create your principal", icon: <Fingerprint className="h-4 w-4" /> },
  { id: "grant", label: "Grant", blurb: "Scope a mandate", icon: <ShieldCheck className="h-4 w-4" /> },
  { id: "agent", label: "Agent", blurb: "Run inside the box", icon: <Bot className="h-4 w-4" /> },
  { id: "reputation", label: "Reputation", blurb: "Portable, attested", icon: <Sparkles className="h-4 w-4" /> },
];

export function Shell({ cfg, screen, go, done, children, principalAddr, mode }: { cfg: PublicConfig; screen: Screen; go: (s: Screen) => void; done: Record<Screen, boolean>; children: ReactNode; principalAddr?: string; mode: string }) {
  return (
    <div className="bg-ambient min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/[.06] bg-ink/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <button className="flex items-center gap-3" onClick={() => go("onboard")}>
            <Logo />
            <div className="text-left leading-tight">
              <div className="text-[15px] font-bold tracking-tight">Mandate</div>
              <div className="text-[11px] text-white/45">delegation for the agent economy</div>
            </div>
          </button>
          <div className="flex items-center gap-2 md:gap-3">
            <Pill tone="brand">Monad testnet · {cfg.chainId}</Pill>
            <span className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 lg:inline-flex ${cfg.relayer.low ? "bg-warn/10 text-warn ring-warn/30" : "bg-white/[.05] text-white/55 ring-white/10"}`} title={`relayer ${cfg.relayer.address}`}>
              <Fuel className="h-3 w-3" /> relayer {(Number(cfg.relayer.balance) / 1e18).toFixed(2)} MON
            </span>
            <span className="hidden text-[11px] text-white/45 xl:inline">{mode}</span>
            <WalletButton chainId={cfg.chainId} />
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 md:grid-cols-[240px_1fr] md:px-6 md:py-8">
        <aside className="md:sticky md:top-20 md:self-start">
          <ol className="flex gap-2 overflow-x-auto md:flex-col md:gap-1.5">
            {STEPS.map((s, i) => {
              const active = s.id === screen;
              return (
                <li key={s.id} className="shrink-0">
                  <button onClick={() => go(s.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${active ? "glass glass-strong ring-brand" : "hover:bg-white/[.04]"}`}>
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${done[s.id] ? "bg-ok/15 text-ok" : active ? "bg-brand/25 text-violet-100" : "bg-white/[.06] text-white/50"}`}>
                      {done[s.id] ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-sm font-semibold ${active ? "text-white" : "text-white/75"}`}>{s.label}</span>
                      <span className="hidden text-[11px] text-white/40 md:block">{s.blurb}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {principalAddr && (
            <div className="mt-4 hidden rounded-xl bg-white/[.04] p-3 text-[11px] text-white/50 ring-1 ring-white/[.06] md:block">
              <div className="mb-1 uppercase tracking-wider">principal</div>
              <div className="mono break-all text-white/80">{principalAddr}</div>
            </div>
          )}
        </aside>
        <main className="min-w-0">
          {cfg.relayer.low && mode.startsWith("Gasless") && (
            <div className="mb-5 flex items-start gap-3 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <div>
                <span className="font-semibold">The gasless relayer is low on testnet MON</span> ({(Number(cfg.relayer.balance) / 1e18).toFixed(3)} MON). Connect a wallet to pay your own gas, or fund the relayer at <span className="mono">{cfg.relayer.address}</span> from <a className="underline" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">faucet.monad.xyz</a>.
              </div>
            </div>
          )}
          {children}
        </main>
      </div>

      <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4 text-[11px] text-white/35 md:px-6">
        Built on <a className="text-white/60 hover:text-white" href="https://github.com/aliveevie/mandate" target="_blank" rel="noreferrer">@ibxlab/mandate</a>. Your passkey never leaves your device. Registry <span className="mono">{cfg.addresses.registry}</span>
      </footer>
    </div>
  );
}
