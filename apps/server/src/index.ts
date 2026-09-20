import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { MandateError, type SignedMandate } from "@ibxlab/mandate";
import { BlobStore } from "./blobs.js";
import { mintSession, openSession, ownsAgent, rateLimit, requireSession, sessionAccount } from "./session.js";
import { config } from "./config.js";
import { chain, deployAccount, deployer, explorerTx, mandateAddresses, publicClient, relayExecute, relayerBalance, sdk } from "./chain.js";
import { activateAgent, agentForMandate, agentState, claimAgentIdentity, forceOutOfBounds, getAgent, listAgents, prepareAgent, provisionAgent, publicView, startAgent, stopAgent, sweepAll } from "./agents.js";
import { fetchAttestations } from "./envio.js";
import { privy, publicPrivyConfig, principalByAccount, principalByUser, rememberPrincipal } from "./privy.js";
import { mirrorPolicy, probePolicy, revokePolicy } from "./agents.js";
import { executeTypedData, SignerAccountAbi, type Mandate } from "@ibxlab/mandate";
import { deployerWallet, erc20Abi } from "./chain.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));
// Everything that costs the relayer gas or creates state is rate limited per IP; reads are generous.
const writeLimit = rateLimit(30, 60_000);
const spendLimit = rateLimit(6, 60_000);
app.use((req, res, next) => (req.method === "GET" ? rateLimit(240, 60_000)(req, res, next) : writeLimit(req, res, next)));

const json = (res: Response, body: unknown, status = 200) =>
  res.status(status).type("application/json").send(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res, next).catch(next);

// ------------------------------------------------------------------ health + public config

app.get("/healthz", (_req, res) => res.json({ ok: true, chainId: chain.id, relayer: deployer.address }));

app.get(
  "/api/config",
  wrap(async (_req, res) => {
    const balance = await relayerBalance();
    json(res, {
      chainId: chain.id,
      rpcUrl: config.rpcUrl,
      addresses: mandateAddresses,
      demo: { asset: config.demo.asset, venue: config.demo.venue, mintAmount: config.demo.mintAmount, agentGas: config.demo.agentGas },
      relayer: { address: deployer.address, balance, min: config.demo.relayerMin, low: balance < config.demo.relayerMin },
      explorer: "https://testnet.monadexplorer.com",
      envio: !!config.envioUrl,
      privy: publicPrivyConfig(),
    });
  }),
);

// ------------------------------------------------------------------ relay (server pays gas; passkey authorises)

const requireFunds = wrap(async (_req, res, next) => {
  const balance = await relayerBalance();
  if (balance < config.demo.relayerMin) {
    return json(res, { error: "RelayerLowFunds", message: `The gasless relayer holds ${(Number(balance) / 1e18).toFixed(3)} MON, below its ${Number(config.demo.relayerMin) / 1e18} MON floor. Connect a wallet to pay your own gas, or fund ${deployer.address}.` }, 503);
  }
  next();
}) as unknown as (req: Request, res: Response, next: NextFunction) => void;

// ------------------------------------------------------------------ sessions (bind a browser to a principal)

app.post(
  "/api/session",
  wrap(async (req, res) => {
    const { account, issuedAt, signature } = req.body as { account: Address; issuedAt: number; signature: Hex };
    json(res, { account, ...(await openSession({ account, issuedAt: Number(issuedAt), signature })) }, 201);
  }),
);

app.post(
  "/api/relay/account",
  requireFunds,
  wrap(async (req, res) => {
    const { publicKey } = req.body as { publicKey: { x: Hex; y: Hex } };
    if (!publicKey?.x || !publicKey?.y) return json(res, { error: "publicKey {x,y} required" }, 400);
    const out = await deployAccount(publicKey);
    json(res, { address: out.address, mintTx: out.mintTx, explorer: explorerTx(out.mintTx) });
  }),
);

app.post(
  "/api/relay/execute",
  requireFunds,
  wrap(async (req, res) => {
    const { account, call, signature } = req.body as { account: Address; call: { target: Address; value: string; data: Hex }; signature: Hex };
    const hash = await relayExecute(account, { target: call.target, value: BigInt(call.value ?? "0"), data: call.data }, signature);
    json(res, { hash, explorer: explorerTx(hash) });
  }),
);

app.post(
  "/api/relay/grant",
  requireFunds,
  wrap(async (req, res) => {
    const body = req.body as { mandate: Record<string, unknown>; hash: Hex; digest: Hex; signature: Hex };
    const m = body.mandate;
    const signed: SignedMandate = {
      hash: body.hash,
      digest: body.digest,
      signature: body.signature,
      mandate: {
        principal: m.principal as Address,
        agentId: BigInt(m.agentId as string),
        agentKey: m.agentKey as Address,
        targets: m.targets as Address[],
        selectors: m.selectors as Hex[],
        asset: m.asset as Address,
        spendCap: BigInt(m.spendCap as string),
        perBlockCap: BigInt(m.perBlockCap as string),
        maxDrawdownBps: BigInt(m.maxDrawdownBps as string),
        validAfter: BigInt(m.validAfter as string),
        validUntil: BigInt(m.validUntil as string),
        nonce: BigInt(m.nonce as string),
        policyHash: m.policyHash as Hex,
      },
    };
    if (sdk.mandate.hash(signed.mandate) !== signed.hash) return json(res, { error: "hash mismatch" }, 400);
    const tx = await sdk.mandate.grant(signed);
    const policy = await mirrorPolicy(signed.hash, signed.mandate).catch((e) => ({ error: (e as Error).message }));
    json(res, { hash: tx.hash, explorer: explorerTx(tx.hash), mandateHash: signed.hash, policy });
  }),
);

app.post(
  "/api/relay/revoke",
  requireFunds,
  wrap(async (req, res) => {
    const { account, mandateHash, signature } = req.body as { account: Address; mandateHash: Hex; signature: Hex };
    const tx = await sdk.mandate.revokeWithSignature(account, mandateHash, signature);
    const a = [...listAgents()].find((x) => x.mandateHash === mandateHash);
    if (a) {
      const live = getAgent(a.id);
      if (live) stopAgent(live);
    }
    await revokePolicy(mandateHash).catch(() => undefined);
    json(res, { hash: tx.hash, explorer: explorerTx(tx.hash) });
  }),
);

// ------------------------------------------------------------------ agents

app.get("/api/agents", (_req, res) => json(res, listAgents()));

app.post(
  "/api/agents",
  spendLimit,
  requireSession,
  requireFunds,
  wrap(async (req, res) => {
    const a = await provisionAgent((req.body as { label?: string })?.label, sessionAccount(req) ?? undefined);
    json(res, { ...publicView(a), explorer: explorerTx(a.registerTx) }, 201);
  }),
);

// Wallet mode: the user's wallet registers the ERC-8004 identity and funds the key; the relayer pays nothing.
app.post("/api/agents/prepare", spendLimit, requireSession, wrap(async (_req, res) => json(res, await prepareAgent(), 201)));
app.post(
  "/api/agents/activate",
  wrap(async (req, res) => {
    const b = req.body as { agentKey: Address; agentId: string; registerTx: Hex; fundTx: Hex; fundedBy: Address };
    const a = await activateAgent({ agentKey: b.agentKey, agentId: BigInt(b.agentId), registerTx: b.registerTx, fundTx: b.fundTx, fundedBy: b.fundedBy, principal: sessionAccount(req) ?? undefined });
    json(res, publicView(a), 201);
  }),
);

app.post(
  "/api/agents/:id/run",
  requireSession,
  requireFunds,
  wrap(async (req, res) => {
    const { mandateHash } = req.body as { mandateHash?: Hex };
    if (!mandateHash) return json(res, { error: "mandateHash required" }, 400);
    // Run the agent that actually holds the mandate's executing key, even if the UI selected another.
    const holder = await agentForMandate(mandateHash);
    const a = holder ?? getAgent(req.params.id);
    if (!a) return json(res, { error: "unknown agent" }, 404);
    if (!holder) return json(res, { error: "NoAgentForMandate", message: "No provisioned agent holds this mandate's agentKey" }, 400);
    if (!requireOwner(req, res, a)) return;
    startAgent(a, mandateHash);
    json(res, publicView(a));
  }),
);

// Mera PRF: the principal's passkey-derived per-agent key takes ownership of the agent's ERC-8004 identity.
app.post(
  "/api/agents/:id/claim",
  requireSession,
  requireFunds,
  wrap(async (req, res) => {
    const a = getAgent(req.params.id);
    if (!a) return json(res, { error: "unknown agent" }, 404);
    if (!requireOwner(req, res, a)) return;
    const { owner } = req.body as { owner?: Address };
    if (!owner) return json(res, { error: "owner required" }, 400);
    json(res, { ...(await claimAgentIdentity(a, owner)), agent: publicView(a) });
  }),
);

// ------------------------------------------------------------------ policy blob store (dumb: ciphertext in, ciphertext out)
// The mandate's onchain policyHash commits to the vault; the server can neither read nor alter it. Any blob store works.
const blobs = new BlobStore(config.blobStorePath);

app.put(
  "/api/blobs/:hash",
  wrap(async (req, res) => {
    const vault = blobs.put(req.params.hash, req.body);
    json(res, { policyHash: req.params.hash.toLowerCase(), stored: true, size: blobs.size, credentialId: vault.credentialId }, 201);
  }),
);

app.get("/api/blobs/:hash", (req, res) => {
  const v = blobs.get(req.params.hash);
  if (!v) return json(res, { error: "NotFound", message: "No policy vault stored for that policyHash" }, 404);
  json(res, v);
});

app.post("/api/agents/:id/stop", requireSession, (req, res) => {
  const a = getAgent(req.params.id);
  if (!a) return json(res, { error: "unknown agent" }, 404);
  if (!requireOwner(req, res, a)) return;
  stopAgent(a);
  json(res, publicView(a));
});

/** 403 unless the session's account is the agent's principal (or the wallet that funded it). */
function requireOwner(req: Request, res: Response, a: { principal?: Address; fundedBy: Address }): boolean {
  if (ownsAgent(sessionAccount(req), a, deployer.address)) return true;
  json(res, { error: "NotYourAgent", message: "Only the principal that provisioned this agent can control it" }, 403);
  return false;
}

/** Every mandate-scoped operation acts on the agent that holds the mandate's executing key. */
async function resolveAgent(id: string, mandateHash?: Hex) {
  if (mandateHash) {
    const holder = await agentForMandate(mandateHash);
    if (holder) return holder;
  }
  return getAgent(id);
}

app.post(
  "/api/agents/:id/force-out-of-bounds",
  requireSession,
  wrap(async (req, res) => {
    const { mandateHash } = req.body as { mandateHash?: Hex };
    const a = await resolveAgent(req.params.id, mandateHash);
    if (!a) return json(res, { error: "unknown agent" }, 404);
    if (!requireOwner(req, res, a)) return;
    const hash = mandateHash ?? a.mandateHash;
    if (!hash) return json(res, { error: "mandateHash required" }, 400);
    json(res, { ...(await forceOutOfBounds(a, hash)), agent: publicView(a, hash) });
  }),
);

app.get(
  "/api/agents/:id/state",
  wrap(async (req, res) => {
    const mandateHash = req.query.mandateHash as Hex | undefined;
    const a = await resolveAgent(req.params.id, mandateHash);
    if (!a) return json(res, { error: "unknown agent" }, 404);
    json(res, await agentState(a, mandateHash));
  }),
);

app.get(
  "/api/mandates/:hash/agent",
  wrap(async (req, res) => {
    const a = await agentForMandate(req.params.hash as Hex);
    if (!a) return json(res, { error: "NoAgentForMandate" }, 404);
    json(res, publicView(a, req.params.hash as Hex));
  }),
);

// ------------------------------------------------------------------ mandates + reputation (read-only)

app.get(
  "/api/mandates/:hash",
  wrap(async (req, res) => {
    const hash = req.params.hash as Hex;
    const [m, s] = await Promise.all([sdk.mandate.get(hash), sdk.mandate.state(hash)]);
    json(res, { mandate: m, state: s });
  }),
);

app.get(
  "/api/reputation/:agentId",
  wrap(async (req, res) => {
    const id = BigInt(req.params.agentId);
    const [rep, history, indexed] = await Promise.all([
      sdk.reputation.get(id),
      sdk.reputation.history(id),
      config.envioUrl ? fetchAttestations(config.envioUrl, id).catch(() => null) : Promise.resolve(null),
    ]);
    json(res, { ...rep, history, indexed });
  }),
);

// ------------------------------------------------------------------ Privy: policy mirror for wallet-mode grants, probe

app.post(
  "/api/mandates/:hash/mirror",
  wrap(async (req, res) => {
    const hash = req.params.hash as Hex;
    const m = await sdk.mandate.get(hash);
    const policy = await mirrorPolicy(hash, m);
    json(res, { policy: policy ?? null });
  }),
);

app.post(
  "/api/mandates/:hash/revoked",
  wrap(async (req, res) => {
    const hash = req.params.hash as Hex;
    const s = await sdk.mandate.state(hash);
    if (!s.revoked) return json(res, { error: "not revoked on-chain" }, 400);
    await revokePolicy(hash);
    json(res, { ok: true });
  }),
);

app.post(
  "/api/agents/:id/policy-probe",
  wrap(async (req, res) => {
    const { mandateHash } = req.body as { mandateHash?: Hex };
    const a = await resolveAgent(req.params.id, mandateHash);
    if (!a) return json(res, { error: "unknown agent" }, 404);
    // A sink that is neither the executor nor the agent's funder: the only things the policy allows.
    json(res, await probePolicy(a, "0x000000000000000000000000000000000000dEaD"));
  }),
);

// ------------------------------------------------------------------ Privy: session-signer principals (no passkey device)

const requirePrivy = (_req: Request, res: Response, next: NextFunction) =>
  privy ? next() : json(res, { error: "PrivyNotConfigured", message: "Set PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY and PRIVY_KEY_QUORUM_ID" }, 503);

async function sessionPrincipal(identityToken: string, account?: Address) {
  const { userId, wallet } = await privy!.sessions.embeddedWallet(identityToken);
  const stored = account ? principalByAccount(account) : principalByUser(userId);
  if (!stored || stored.userId !== userId) throw Object.assign(new Error("No principal for this user"), { status: 404 });
  if (!wallet?.delegated) throw Object.assign(new Error("The embedded wallet has not delegated a session signer yet"), { status: 409 });
  return { stored, principal: privy!.sessions.principal({ walletId: stored.walletId, owner: stored.owner, account: stored.account }) };
}

/** Create (or resume) the caller's SignerAccount owned by their Privy embedded wallet, plus the signer scope policy. */
app.post(
  "/api/privy/principal",
  requirePrivy,
  requireFunds,
  wrap(async (req, res) => {
    const { identityToken } = req.body as { identityToken: string };
    const { userId, wallet } = await privy!.sessions.embeddedWallet(identityToken);
    if (!wallet) return json(res, { error: "NoEmbeddedWallet", message: "This Privy user has no Ethereum embedded wallet" }, 400);
    const existing = principalByUser(userId);
    if (existing) return json(res, { ...existing, delegated: wallet.delegated, signerId: privy!.keyQuorumId, resumed: true, session: mintSession(existing.account) });
    const account = await sdk.passkey.deploySignerAccount(wallet.address);
    const mintTx = await deployerWallet.writeContract({ address: config.demo.asset, abi: erc20Abi, functionName: "mint", args: [account, config.demo.mintAmount] });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    const scope = await privy!.sessions.createScopePolicy({ account });
    const p = { account, owner: wallet.address, walletId: wallet.walletId, userId, scopePolicyId: scope.policyId, createdAt: Date.now() };
    rememberPrincipal(p);
    // The Privy identity token authenticated this user, so the browser session for the SignerAccount is issued here.
    json(res, { ...p, delegated: wallet.delegated, signerId: privy!.keyQuorumId, scopeRules: scope.policy.rules, mintTx, resumed: false, session: mintSession(p.account) }, 201);
  }),
);

/** Owner action without a prompt: approve the demo venue, signed by the session signer as EIP-712 Execute. */
app.post(
  "/api/privy/approve",
  requirePrivy,
  requireFunds,
  wrap(async (req, res) => {
    const { identityToken, account } = req.body as { identityToken: string; account: Address };
    const { stored, principal } = await sessionPrincipal(identityToken, account);
    const call = { target: config.demo.asset, value: 0n, data: (await import("viem")).encodeFunctionData({ abi: (await import("viem")).parseAbi(["function approve(address,uint256) returns (bool)"]), functionName: "approve", args: [config.demo.venue, 2n ** 256n - 1n] }) };
    const nonce = await publicClient.readContract({ address: stored.account, abi: SignerAccountAbi, functionName: "nonce" });
    const signature = await principal.signTypedData(executeTypedData(stored.account, chain.id, call, nonce));
    const { request } = await publicClient.simulateContract({ address: stored.account, abi: SignerAccountAbi, functionName: "execute", args: [call, signature], account: deployer });
    const hash = await deployerWallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    json(res, { hash, explorer: explorerTx(hash) });
  }),
);

/** Grant without a prompt: the session signer signs the Mandate typed data, the relayer submits, the policy is mirrored. */
app.post(
  "/api/privy/grant",
  requirePrivy,
  requireFunds,
  wrap(async (req, res) => {
    const { identityToken, account, draft } = req.body as { identityToken: string; account: Address; draft: { agentId: string; agentKey: Address; targets: { address: Address; selectors: string[] }[]; asset: Address; spendCap: string; perBlockCap: string; maxDrawdownBps: number; validUntil: number } };
    const { principal } = await sessionPrincipal(identityToken, account);
    const d = sdk.mandate.build({
      agentId: BigInt(draft.agentId), agentKey: draft.agentKey, targets: draft.targets, asset: draft.asset,
      spendCap: BigInt(draft.spendCap), perBlockCap: BigInt(draft.perBlockCap), maxDrawdownBps: draft.maxDrawdownBps, validUntil: draft.validUntil,
    });
    const signed = await sdk.mandate.sign(d, principal);
    const tx = await sdk.mandate.grant(signed);
    const policy = await mirrorPolicy(signed.hash, signed.mandate as Mandate).catch((e) => ({ error: (e as Error).message }));
    json(res, { hash: tx.hash, explorer: explorerTx(tx.hash), mandateHash: signed.hash, policy });
  }),
);

/** Revoke without a prompt: EIP-712 Revoke on the SignerAccount domain, signed by the session signer. */
app.post(
  "/api/privy/revoke",
  requirePrivy,
  requireFunds,
  wrap(async (req, res) => {
    const { identityToken, account, mandateHash } = req.body as { identityToken: string; account: Address; mandateHash: Hex };
    const { principal } = await sessionPrincipal(identityToken, account);
    const tx = await sdk.mandate.revoke(mandateHash, principal);
    const holder = await agentForMandate(mandateHash).catch(() => undefined);
    if (holder) stopAgent(holder);
    await revokePolicy(mandateHash).catch(() => undefined);
    json(res, { hash: tx.hash, explorer: explorerTx(tx.hash) });
  }),
);

// ------------------------------------------------------------------ static UI (production)

const publicDir = resolve(process.cwd(), config.publicDir);
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: "index.html", maxAge: "1h" }));
  app.get(/^(?!\/api\/|\/healthz).*/, (_req, res) => res.sendFile(resolve(publicDir, "index.html")));
}

// ------------------------------------------------------------------ errors

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (MandateError.is(err)) return json(res, { error: err.name, args: err.args.map(String), message: err.message }, 422);
  const message = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status ?? 500;
  const code = (err as { code?: string })?.code;
  if (status >= 500) {
    console.error(message);
    // Never echo stack traces or provider internals to the client.
    return json(res, { error: "internal", message: "Something failed on the server; the operator has the details." }, 500);
  }
  json(res, { error: code ?? "request", message: message.slice(0, 500) }, status);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    console.log(`${sig}: sweeping idle agent gas back to funders…`);
    void sweepAll().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 20_000).unref();
  });
}

app.listen(config.port, () => {
  console.log(`mandate server on :${config.port} chain=${chain.id} relayer=${deployer.address} public=${existsSync(publicDir) ? publicDir : "(dev: vite)"}`);
});
