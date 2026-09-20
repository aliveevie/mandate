// A browser session bound to the principal: one passkey signature over a chain-bound challenge, verified by the
// server through the account's ERC-1271 `isValidSignature`, then a bearer token. Agent-control calls carry it.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { Principal } from "@ibxlab/mandate";

const KEY = "mandate.session";

export interface StoredSession { account: Address; token: string; expiresAt: number }

export function currentSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    return s.expiresAt > Date.now() + 60_000 ? s : null;
  } catch { return null; }
}

export function storeSession(s: StoredSession) {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage optional */ }
}

export function clearSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function sessionDigest(chainId: number, account: Address, issuedAt: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], ["mandate:session:v1", BigInt(chainId), account, BigInt(issuedAt)]));
}

/** Returns a valid session for the principal, opening one (a single passkey prompt) if there is none. */
export async function ensureSession(principal: Principal, chainId: number): Promise<StoredSession> {
  const have = currentSession();
  if (have && have.account.toLowerCase() === principal.address.toLowerCase()) return have;
  if (principal.kind === "signer") throw new Error("Your Privy session expired. Sign in again on the Passkey step.");
  const issuedAt = Date.now();
  const signature = await principal.signChallenge(sessionDigest(chainId, principal.address, issuedAt));
  const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: principal.address, issuedAt, signature }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? "Could not open a session");
  const s: StoredSession = { account: principal.address, token: data.token, expiresAt: data.expiresAt };
  storeSession(s);
  return s;
}
