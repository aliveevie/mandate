import type { ReactNode } from "react";

export function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Button({ children, onClick, disabled, kind = "primary", busy }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: "primary" | "ghost" | "danger"; busy?: boolean }) {
  const base = "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const style = kind === "primary" ? "bg-violet-600 text-white hover:bg-violet-500" : kind === "danger" ? "bg-rose-600 text-white hover:bg-rose-500" : "border border-zinc-700 text-zinc-200 hover:bg-zinc-800";
  return (
    <button className={`${base} ${style}`} onClick={onClick} disabled={disabled || busy}>
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500";

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <code className={`mono break-all text-xs text-zinc-300 ${className}`}>{children}</code>;
}

export function TxLink({ hash, explorer, label }: { hash: string; explorer: string; label?: string }) {
  return (
    <a className="mono text-xs text-violet-400 underline-offset-2 hover:underline" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? `${hash.slice(0, 10)}…${hash.slice(-6)}`}
    </a>
  );
}

export function Notice({ kind, children }: { kind: "info" | "error" | "ok"; children: ReactNode }) {
  const c = kind === "error" ? "border-rose-800 bg-rose-950/50 text-rose-200" : kind === "ok" ? "border-emerald-800 bg-emerald-950/50 text-emerald-200" : "border-zinc-700 bg-zinc-900 text-zinc-300";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${c}`}>{children}</div>;
}

export function Bar({ value, max, color = "bg-violet-500" }: { value: bigint; max: bigint; color?: string }) {
  const pct = max === 0n ? 0 : Math.min(100, Number((value * 10000n) / max) / 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Phase({ phase }: { phase: "Armed" | "Tripped" | "Cooldown" }) {
  const c = phase === "Armed" ? "bg-emerald-600/20 text-emerald-300 border-emerald-700" : phase === "Tripped" ? "bg-rose-600/20 text-rose-300 border-rose-700" : "bg-amber-600/20 text-amber-300 border-amber-700";
  return <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${c}`}>{phase}</span>;
}
