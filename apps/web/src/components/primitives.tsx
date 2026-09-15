import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";

export function Card({ title, children, right, className = "", icon }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <section className={`glass rounded-2xl p-5 md:p-6 ${className}`}>
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-white/55">{icon}{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, onClick, disabled, kind = "brand", busy, size = "md", className = "", icon }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: "brand" | "ghost" | "danger" | "subtle"; busy?: boolean; size?: "sm" | "md" | "lg"; className?: string; icon?: ReactNode }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40";
  const sz = size === "lg" ? "px-6 py-3.5 text-[15px]" : size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm";
  const st = kind === "brand" ? "btn-brand text-white" : kind === "danger" ? "bg-bad/15 text-bad ring-1 ring-bad/40 hover:bg-bad/25" : kind === "subtle" ? "bg-white/[.06] text-white/80 hover:bg-white/[.1]" : "ring-1 ring-white/15 text-white/85 hover:bg-white/[.06]";
  return (
    <button className={`${base} ${sz} ${st} ${className}`} onClick={onClick} disabled={disabled || busy}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Field({ label, children, hint, right }: { label: string; children: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-white/60">{label}{right}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-white/40">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-brand/70 focus:ring-2 focus:ring-brand/20 placeholder:text-white/25";

export function Address({ value, chars = 6, className = "", explorer }: { value: string; chars?: number; className?: string; explorer?: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > chars * 2 + 2 ? `${value.slice(0, chars + 2)}…${value.slice(-chars)}` : value;
  return (
    <span className={`mono inline-flex items-center gap-1.5 text-xs ${className}`}>
      <span title={value}>{short}</span>
      <button className="text-white/35 hover:text-white" onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }} title="copy">
        {copied ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
      </button>
      {explorer && <a className="text-white/35 hover:text-brand-2" href={explorer} target="_blank" rel="noreferrer" title="open in explorer"><ExternalLink className="h-3 w-3" /></a>}
    </span>
  );
}

export function TxLink({ hash, explorer, label }: { hash: string; explorer: string; label?: string }) {
  return (
    <a className="mono inline-flex items-center gap-1 text-xs text-brand-2/90 hover:underline" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? `${hash.slice(0, 10)}…${hash.slice(-6)}`} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

export function Notice({ kind, children, className = "" }: { kind: "info" | "error" | "ok" | "warn"; children: ReactNode; className?: string }) {
  const c = kind === "error" ? "border-bad/40 bg-bad/10 text-rose-100" : kind === "ok" ? "border-ok/40 bg-ok/10 text-emerald-100" : kind === "warn" ? "border-warn/40 bg-warn/10 text-amber-100" : "border-white/10 bg-white/[.04] text-white/80";
  return <div className={`rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed ${c} ${className}`}>{children}</div>;
}

/** Human-readable error with the raw text behind a disclosure. */
export function ErrorNotice({ error, className = "" }: { error: import("../lib/errors").FriendlyError; className?: string }) {
  const kind = error.cancelled ? "warn" : "error";
  return (
    <Notice kind={kind} className={className}>
      <div className="font-semibold">{error.title}</div>
      {error.detail && <div className="mt-0.5 text-xs opacity-90">{error.detail}</div>}
      {!error.cancelled && error.raw && error.raw !== error.title && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] opacity-60 hover:opacity-100">technical details</summary>
          <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed opacity-70">{error.raw.slice(0, 2000)}</pre>
        </details>
      )}
    </Notice>
  );
}

export function Pill({ children, tone = "neutral", dot }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "brand"; dot?: boolean }) {
  const c = tone === "ok" ? "bg-ok/10 text-ok ring-ok/30" : tone === "warn" ? "bg-warn/10 text-warn ring-warn/30" : tone === "bad" ? "bg-bad/10 text-bad ring-bad/30" : tone === "brand" ? "bg-brand/15 text-violet-200 ring-brand/40" : "bg-white/[.06] text-white/70 ring-white/10";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${c}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${tone === "ok" ? "bg-ok live-dot" : tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-white/50"}`} />}
      {children}
    </span>
  );
}

export function Bar({ value, max, tone = "brand", height = "h-2.5" }: { value: bigint; max: bigint; tone?: "brand" | "sky" | "bad"; height?: string }) {
  const pct = max === 0n ? 0 : Math.min(100, Number((value * 10000n) / max) / 100);
  const g = tone === "sky" ? "from-cyan-400 to-sky-500" : tone === "bad" ? "from-rose-400 to-rose-600" : "from-violet-400 to-fuchsia-500";
  return (
    <div className={`${height} w-full overflow-hidden rounded-full bg-white/[.06] ring-1 ring-white/5`}>
      <div className={`h-full rounded-full bg-gradient-to-r ${g} transition-[width] duration-700 ease-out`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub, mono }: { label: string; value: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-white/[.04] px-4 py-3 ring-1 ring-white/[.06]">
      <div className="text-[11px] font-medium uppercase tracking-wider text-white/45">{label}</div>
      <div className={`mt-1 text-lg font-semibold text-white ${mono ? "mono text-base" : ""}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-white/45">{sub}</div>}
    </div>
  );
}

/** Arc gauge: value vs threshold on a 0..max scale (used for drawdown vs trip line). */
export function Gauge({ value, threshold, max = 100, label, unit = "%", tone }: { value: number; threshold: number; max?: number; label: string; unit?: string; tone: "ok" | "warn" | "bad" }) {
  const r = 54, c = Math.PI * r; // half circle
  const clamp = (x: number) => Math.max(0, Math.min(max, x));
  const vLen = (clamp(value) / max) * c;
  const tAngle = Math.PI - (clamp(threshold) / max) * Math.PI;
  const tx = 60 + r * Math.cos(tAngle), ty = 60 - r * Math.sin(tAngle);
  const color = tone === "bad" ? "#fb7185" : tone === "warn" ? "#fbbf24" : "#34d399";
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 120 66" className="w-full max-w-[220px]">
        <path d="M6 60 A54 54 0 0 1 114 60" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="10" strokeLinecap="round" />
        <path d="M6 60 A54 54 0 0 1 114 60" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${vLen} ${c}`} style={{ transition: "stroke-dasharray .7s ease" }} />
        <line x1={60 + (r - 9) * Math.cos(tAngle)} y1={60 - (r - 9) * Math.sin(tAngle)} x2={tx + 9 * Math.cos(tAngle)} y2={ty - 9 * Math.sin(tAngle)} stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <text x="60" y="54" textAnchor="middle" fill="#fff" fontSize="19" fontWeight="700">{value.toFixed(1)}{unit}</text>
      </svg>
      <div className="mt-1 text-[11px] text-white/45">{label} · trips at {threshold}{unit}</div>
    </div>
  );
}

/** Score ring 0..100. */
export function Ring({ value, size = 128 }: { value: number | null; size?: number }) {
  const r = 52, c = 2 * Math.PI * r;
  const v = value ?? 0;
  const color = value === null ? "rgba(255,255,255,.2)" : v >= 80 ? "#34d399" : v >= 50 ? "#fbbf24" : "#fb7185";
  return (
    <svg viewBox="0 0 120 120" width={size} height={size}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="10" />
      <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 60 60)" style={{ transition: "stroke-dasharray .8s ease" }} />
      <text x="60" y="66" textAnchor="middle" fill="#fff" fontSize="30" fontWeight="800">{value ?? "—"}</text>
      <text x="60" y="84" textAnchor="middle" fill="rgba(255,255,255,.45)" fontSize="9">/ 100</text>
    </svg>
  );
}

export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
      <rect width="32" height="32" rx="8" fill="url(#lg)" />
      <path d="M9 21V11l7 6 7-6v10" stroke="white" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
