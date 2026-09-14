import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, Info, XCircle, X } from "lucide-react";

export interface Toast { id: number; kind: "ok" | "error" | "info"; title: string; detail?: string; link?: { href: string; label: string } }
interface Ctx { push: (t: Omit<Toast, "id">) => void }
const ToastCtx = createContext<Ctx>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === "error" ? 12000 : 7000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className="glass glass-strong pointer-events-auto rise flex items-start gap-3 rounded-xl p-3 text-sm">
            {t.kind === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : t.kind === "error" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-2" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t.title}</div>
              {t.detail && <div className="mono mt-0.5 break-all text-xs text-white/60">{t.detail}</div>}
              {t.link && <a className="mt-1 inline-flex items-center gap-1 text-xs text-brand-2 hover:underline" href={t.link.href} target="_blank" rel="noreferrer">{t.link.label} <ExternalLink className="h-3 w-3" /></a>}
            </div>
            <button className="text-white/40 hover:text-white" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
