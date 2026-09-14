import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { MandateError, type SignedMandate } from "@ibxlab/mandate";
import { config } from "./config.js";
import { chain, deployAccount, deployer, explorerTx, mandateAddresses, publicClient, relayExecute, sdk } from "./chain.js";
import { agentForMandate, agentState, forceOutOfBounds, getAgent, listAgents, provisionAgent, publicView, startAgent, stopAgent } from "./agents.js";
import { fetchAttestations } from "./envio.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

const json = (res: Response, body: unknown, status = 200) =>
  res.status(status).type("application/json").send(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

// ------------------------------------------------------------------ health + public config

app.get("/healthz", (_req, res) => res.json({ ok: true, chainId: chain.id, relayer: deployer.address }));

app.get(
  "/api/config",
  wrap(async (_req, res) => {
    const balance = await publicClient.getBalance({ address: deployer.address });
    json(res, {
      chainId: chain.id,
      rpcUrl: config.rpcUrl,
      addresses: mandateAddresses,
      demo: { asset: config.demo.asset, venue: config.demo.venue, mintAmount: config.demo.mintAmount },
      relayer: { address: deployer.address, balance },
      explorer: "https://testnet.monadexplorer.com",
      envio: !!config.envioUrl,
    });
  }),
);

// ------------------------------------------------------------------ relay (server pays gas; passkey authorises)

app.post(
  "/api/relay/account",
  wrap(async (req, res) => {
    const { publicKey } = req.body as { publicKey: { x: Hex; y: Hex } };
    if (!publicKey?.x || !publicKey?.y) return json(res, { error: "publicKey {x,y} required" }, 400);
    const out = await deployAccount(publicKey);
    json(res, { address: out.address, mintTx: out.mintTx, explorer: explorerTx(out.mintTx) });
  }),
);

app.post(
  "/api/relay/execute",
  wrap(async (req, res) => {
    const { account, call, signature } = req.body as { account: Address; call: { target: Address; value: string; data: Hex }; signature: Hex };
    const hash = await relayExecute(account, { target: call.target, value: BigInt(call.value ?? "0"), data: call.data }, signature);
    json(res, { hash, explorer: explorerTx(hash) });
  }),
);

app.post(
  "/api/relay/grant",
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
    json(res, { hash: tx.hash, explorer: explorerTx(tx.hash), mandateHash: signed.hash });
  }),
);

app.post(
  "/api/relay/revoke",
  wrap(async (req, res) => {
    const { account, mandateHash, signature } = req.body as { account: Address; mandateHash: Hex; signature: Hex };
    const tx = await sdk.mandate.revokeWithSignature(account, mandateHash, signature);
    const a = [...listAgents()].find((x) => x.mandateHash === mandateHash);
    if (a) {
      const live = getAgent(a.id);
      if (live) stopAgent(live);
    }
    json(res, { hash: tx.hash, explorer: explorerTx(tx.hash) });
  }),
);

// ------------------------------------------------------------------ agents

app.get("/api/agents", (_req, res) => json(res, listAgents()));

app.post(
  "/api/agents",
  wrap(async (req, res) => {
    const a = await provisionAgent((req.body as { label?: string })?.label);
    json(res, { ...publicView(a), explorer: explorerTx(a.registerTx) }, 201);
  }),
);

app.post(
  "/api/agents/:id/run",
  wrap(async (req, res) => {
    const { mandateHash } = req.body as { mandateHash?: Hex };
    if (!mandateHash) return json(res, { error: "mandateHash required" }, 400);
    // Run the agent that actually holds the mandate's executing key, even if the UI selected another.
    const holder = await agentForMandate(mandateHash);
    const a = holder ?? getAgent(req.params.id);
    if (!a) return json(res, { error: "unknown agent" }, 404);
    if (!holder) return json(res, { error: "NoAgentForMandate", message: "No provisioned agent holds this mandate's agentKey" }, 400);
    startAgent(a, mandateHash);
    json(res, publicView(a));
  }),
);

app.post("/api/agents/:id/stop", (req, res) => {
  const a = getAgent(req.params.id);
  if (!a) return json(res, { error: "unknown agent" }, 404);
  stopAgent(a);
  json(res, publicView(a));
});

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
  wrap(async (req, res) => {
    const { mandateHash } = req.body as { mandateHash?: Hex };
    const a = await resolveAgent(req.params.id, mandateHash);
    if (!a) return json(res, { error: "unknown agent" }, 404);
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
  console.error(message);
  json(res, { error: "internal", message: message.slice(0, 500) }, 500);
});

app.listen(config.port, () => {
  console.log(`mandate server on :${config.port} chain=${chain.id} relayer=${deployer.address} public=${existsSync(publicDir) ? publicDir : "(dev: vite)"}`);
});
