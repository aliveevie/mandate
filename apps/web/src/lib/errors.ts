/**
 * Turn wallet, RPC, server and protocol errors into something a person can act on.
 * The full text is kept for a "details" disclosure; the headline never includes request dumps.
 */
export interface FriendlyError {
  title: string;
  detail?: string;
  /** True when the user cancelled a wallet or passkey prompt: nothing was sent, nothing is wrong. */
  cancelled: boolean;
  raw: string;
}

const CANCEL_PATTERNS = [/user rejected/i, /user denied/i, /rejected the request/i, /cancel(l)?ed/i, /NotAllowedError/i, /operation either timed out or was not allowed/i, /4001/];

export function friendlyError(e: unknown): FriendlyError {
  const err = e as { message?: string; shortMessage?: string; details?: string; code?: number; name?: string; data?: { error?: string; message?: string } };
  const raw = String(err?.message ?? e);
  const lower = raw.toLowerCase();

  if (err?.code === 4001 || CANCEL_PATTERNS.some((p) => p.test(raw))) {
    const passkey = /NotAllowedError|timed out or was not allowed|credential/i.test(raw);
    return {
      title: passkey ? "Passkey prompt cancelled" : "Wallet request cancelled",
      detail: passkey ? "No signature was produced and nothing was sent. Try again when you are ready." : "You declined the request in your wallet, so nothing was sent. Try again when you are ready.",
      cancelled: true,
      raw,
    };
  }
  if (lower.includes("insufficient funds")) {
    return { title: "Not enough MON for gas", detail: "The paying wallet cannot cover this transaction's gas on Monad testnet. Top it up at faucet.monad.xyz.", cancelled: false, raw };
  }
  if (err?.data?.error === "RelayerLowFunds") {
    return { title: "Gasless relayer is low on MON", detail: err.data.message, cancelled: false, raw };
  }
  if (/PrivyNotConfigured|NoEmbeddedWallet|NoAgentForMandate/.test(err?.data?.error ?? "")) {
    return { title: err!.data!.error!, detail: err?.data?.message, cancelled: false, raw };
  }
  // Protocol reverts arrive as "Name(args)" from the SDK or {error,args} from the server.
  const typed = raw.match(/^([A-Z][A-Za-z]+)\((.*)\)$/);
  if (typed) return { title: `Rejected by the protocol: ${typed[1]}`, detail: typed[2] ? `Arguments: ${typed[2]}` : undefined, cancelled: false, raw };

  // viem errors: the short message is the headline, everything after "Request Arguments" is noise.
  const short = err?.shortMessage ?? raw.split("\n")[0] ?? raw;
  const headline = short.replace(/\s*Request Arguments:.*$/s, "").trim().slice(0, 200);
  return { title: headline || "Something failed", detail: err?.details && err.details !== headline ? err.details.slice(0, 300) : undefined, cancelled: false, raw };
}
