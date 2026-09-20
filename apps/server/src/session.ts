// Browser sessions bound to a principal account. A session is opened by proving control of the account
// (ERC-1271 `isValidSignature` over a fresh challenge) and then carried as a bearer token. Agent-control routes
// require the token's account to be the agent's principal, so nobody can drive, stop or claim someone else's agent.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { chain, publicClient } from "./chain.js";

const SECRET = randomBytes(32); // per process: restarting the server invalidates sessions, which is fine
const TTL_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 5 * 60 * 1000;
const ERC1271_MAGIC = "0x1626ba7e";
const erc1271 = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/** What the principal signs to open a session: bound to this chain, this account and a timestamp. */
export function sessionDigest(account: Address, issuedAt: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], ["mandate:session:v1", BigInt(chain.id), account, BigInt(issuedAt)]));
}

const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function mintSession(account: Address): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${account.toLowerCase()}.${expiresAt}`;
  return { token: `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`, expiresAt };
}

export function verifySession(token: string | undefined): Address | null {
  if (!token) return null;
  const [p, mac] = token.split(".");
  if (!p || !mac) return null;
  const payload = Buffer.from(p, "base64url").toString();
  const expected = sign(payload);
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  const [account, exp] = payload.split(".");
  if (!account || !exp || Number(exp) < Date.now()) return null;
  return account as Address;
}

/** Open a session by verifying an ERC-1271 signature from the account over `sessionDigest(account, issuedAt)`. */
export async function openSession(input: { account: Address; issuedAt: number; signature: Hex }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.account)) throw Object.assign(new Error("account must be an address"), { status: 400 });
  if (!Number.isFinite(input.issuedAt) || Math.abs(Date.now() - input.issuedAt) > CHALLENGE_WINDOW_MS) {
    throw Object.assign(new Error("session challenge expired; retry"), { status: 400 });
  }
  let magic: Hex;
  try {
    magic = await publicClient.readContract({ address: input.account, abi: erc1271, functionName: "isValidSignature", args: [sessionDigest(input.account, input.issuedAt), input.signature] });
  } catch {
    throw Object.assign(new Error("account did not accept the session signature"), { status: 401 });
  }
  if (magic.toLowerCase() !== ERC1271_MAGIC) throw Object.assign(new Error("invalid session signature"), { status: 401 });
  return mintSession(input.account);
}

export const sessionAccount = (req: Request): Address | null => verifySession(req.headers.authorization?.replace(/^Bearer\s+/i, ""));

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const account = sessionAccount(req);
  if (!account) {
    res.status(401).json({ error: "SessionRequired", message: "Open a session with your principal first (POST /api/session)" });
    return;
  }
  (req as Request & { account: Address }).account = account;
  next();
}

/** True when `account` may control an agent: it is the agent's principal, or the wallet that funded it. */
export function ownsAgent(account: Address | null, agent: { principal?: Address; fundedBy: Address }, relayer: Address): boolean {
  if (!account) return false;
  const a = account.toLowerCase();
  if (agent.principal && agent.principal.toLowerCase() === a) return true;
  if (!agent.principal && agent.fundedBy.toLowerCase() !== relayer.toLowerCase() && agent.fundedBy.toLowerCase() === a) return true;
  return false;
}

// ------------------------------------------------------------------ rate limiting (per IP, sliding window, no deps)

const buckets = new Map<string, number[]>();
export function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}|${max}|${windowMs}`;
    const now = Date.now();
    const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.status(429).json({ error: "RateLimited", message: `Too many requests; try again in ${Math.ceil((arr[0]! + windowMs - now) / 1000)}s` });
      return;
    }
    arr.push(now);
    buckets.set(key, arr);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}
