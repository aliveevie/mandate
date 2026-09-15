/**
 * Privy integration for Mandate: server wallets as agent keys, wallet policies that mirror a mandate,
 * and session signers that let a principal's embedded wallet grant and revoke without prompts.
 *
 *   import { createPrivyIntegration, buildMandatePolicy } from "@ibxlab/mandate/privy";
 *
 * Requires the optional peer dependency `@privy-io/node`.
 */
import type { PrivyClient } from "@privy-io/node";
import type { Account, Address, Hex } from "viem";
import { MandateExecutorAbi } from "./abi/generated.js";
import { SignerPrincipalImpl } from "./passkey.js";
import type { Mandate, MandateAddresses, SignerPrincipal, TypedDataInput } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Policy builder (pure)
// ---------------------------------------------------------------------------------------------

export type PolicyOperator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in";

export interface PolicyCondition {
  field_source: "ethereum_transaction" | "ethereum_calldata" | "ethereum_typed_data_domain" | "system";
  field: string;
  operator: PolicyOperator;
  value: string | string[];
  abi?: readonly unknown[];
}

export interface PolicyRule {
  name: string;
  method: string;
  action: "ALLOW" | "DENY";
  conditions: PolicyCondition[];
}

export interface MandatePolicy {
  version: "1.0";
  name: string;
  chain_type: "ethereum";
  rules: PolicyRule[];
}

const EXECUTE_ABI = MandateExecutorAbi.filter((i) => i.type === "function" && i.name === "execute");
/** Always-true conditions, for DENY rules on methods Privy requires to be conditioned. */
const ANY_TRANSACTION: PolicyCondition = { field_source: "ethereum_transaction", field: "value", operator: "gte", value: "0" };
const ANY_TYPED_DATA: PolicyCondition = { field_source: "system", field: "current_unix_timestamp", operator: "gte", value: "0" };

/**
 * The Privy policy that mirrors a mandate onto the agent's server wallet.
 *
 * Allowed: exactly one thing, `MandateExecutor.execute` for this mandate, on this chain, with a whitelisted
 * target and an amount within the per-block cap, carrying no native value. Everything else the key could do
 * (other contracts, raw transfers, message and typed-data signing, key export) is denied. The chain enforces
 * the same limits plus the lifetime cap and the breaker; Privy refuses to sign before a transaction exists.
 */
export function buildMandatePolicy(input: {
  mandate: Pick<Mandate, "targets" | "perBlockCap" | "validUntil">;
  mandateHash: Hex;
  chainId: number;
  executor: Address;
  name?: string;
}): MandatePolicy {
  const targets = [...new Set(input.mandate.targets.map((t) => t.toLowerCase()))];
  return {
    version: "1.0",
    name: input.name ?? `mandate ${input.mandateHash.slice(0, 10)}`,
    chain_type: "ethereum",
    rules: [
      // Server wallets used through viem sign with eth_signTransaction (then we broadcast); Privy-broadcast
      // flows use eth_sendTransaction. Both are allowed under identical conditions and nothing else is.
      ...(["eth_signTransaction", "eth_sendTransaction"] as const).map((method) => ({
        name: `Execute this mandate only (${method})`,
        method,
        action: "ALLOW" as const,
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: input.executor.toLowerCase() },
          { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(input.chainId) },
          { field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0" },
          { field_source: "ethereum_calldata", field: "execute.mandateHash", operator: "eq", value: input.mandateHash, abi: EXECUTE_ABI },
          { field_source: "ethereum_calldata", field: "execute.target", operator: "in", value: targets, abi: EXECUTE_ABI },
          { field_source: "ethereum_calldata", field: "execute.amount", operator: "lte", value: input.mandate.perBlockCap.toString(), abi: EXECUTE_ABI },
          { field_source: "system", field: "current_unix_timestamp", operator: "lte", value: input.mandate.validUntil.toString() },
        ] as PolicyCondition[],
      })),
      { name: "No message signing", method: "personal_sign", action: "DENY", conditions: [] },
      // Privy requires at least one condition on this method; an always-true condition denies everything.
      { name: "No typed-data signing", method: "eth_signTypedData_v4", action: "DENY", conditions: [ANY_TYPED_DATA] },
      { name: "No key export", method: "exportPrivateKey", action: "DENY", conditions: [] },
    ],
  };
}

/** Replacement rules once the mandate is revoked: the key can do nothing at all. */
export function revokedPolicyRules(): PolicyRule[] {
  return [{ name: "Mandate revoked", method: "*", action: "DENY", conditions: [] }];
}

/**
 * Scope for a session signer delegated to the server: it may sign EIP-712 only for the Mandate registry and
 * the principal's own SignerAccount on this chain. No messages, no transactions, no other domains.
 */
export function buildSessionSignerPolicy(input: { chainId: number; registry: Address; account: Address; name?: string }): MandatePolicy {
  return {
    version: "1.0",
    name: input.name ?? `mandate session signer ${input.account.slice(0, 10)}`,
    chain_type: "ethereum",
    rules: [
      {
        name: "Mandate typed data for this principal only",
        method: "eth_signTypedData_v4",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: String(input.chainId) },
          { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: [input.registry.toLowerCase(), input.account.toLowerCase()] },
        ],
      },
      { name: "No message signing", method: "personal_sign", action: "DENY", conditions: [] },
      { name: "No transactions", method: "eth_sendTransaction", action: "DENY", conditions: [ANY_TRANSACTION] },
      { name: "No raw transaction signing", method: "eth_signTransaction", action: "DENY", conditions: [ANY_TRANSACTION] },
      { name: "No key export", method: "exportPrivateKey", action: "DENY", conditions: [] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime integration
// ---------------------------------------------------------------------------------------------

export interface PrivyIntegrationConfig {
  appId: string;
  appSecret: string;
  /** Base64 PKCS8 P-256 authorization private key (dashboard "authorization key" or `generateP256KeyPair`). */
  authorizationKey: string;
  /** The key quorum id registered for that key. Owns agent wallets and policies; is the session signer id. */
  keyQuorumId: string;
  chainId: number;
  addresses: MandateAddresses;
}

export interface PrivyWalletRef {
  walletId: string;
  address: Address;
}

export interface PrivyIntegration {
  client: PrivyClient;
  keyQuorumId: string;
  agents: {
    /** A TEE-held server wallet owned by our key quorum. No private key ever exists on our side. */
    createWallet(input?: { label?: string }): Promise<PrivyWalletRef>;
    /** A viem account backed by the server wallet, for `client.agent.load({ executor })`. */
    account(ref: PrivyWalletRef): Account;
    /** Create the mirror policy for a granted mandate and attach it to the agent wallet. */
    mirrorMandate(input: { wallet: PrivyWalletRef; mandate: Mandate; mandateHash: Hex }): Promise<{ policyId: string; policy: MandatePolicy }>;
    /** After an on-chain revoke: the wallet's policy becomes deny-all. */
    revokeMirror(input: { policyId: string; mandateHash: Hex }): Promise<void>;
    /** Ask Privy to sign something the policy forbids. Resolves with the refusal; never lands on-chain when the policy holds. */
    probe(input: { wallet: PrivyWalletRef; to: Address }): Promise<{ blocked: boolean; reason?: string; hash?: Hex }>;
  };
  sessions: {
    /** Resolve the caller's Privy user and delegated embedded wallet from a client identity token. */
    embeddedWallet(identityToken: string): Promise<{ userId: string; wallet?: { walletId: string; address: Address; delegated: boolean } }>;
    /** Create the per-principal scope policy for the session signer (attach it client-side when adding the signer). */
    createScopePolicy(input: { account: Address }): Promise<{ policyId: string; policy: MandatePolicy }>;
    /** Sign EIP-712 on the user's embedded wallet through the delegated session signer. */
    signTypedData(input: { walletId: string; typedData: TypedDataInput }): Promise<Hex>;
    /** A SignerPrincipal whose signatures come from the session signer: grant and revoke without prompting the user. */
    principal(input: { walletId: string; owner: Address; account: Address }): SignerPrincipal;
  };
}

const jsonSafe = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(jsonSafe) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, jsonSafe(x)])) : v;

export async function createPrivyIntegration(cfg: PrivyIntegrationConfig): Promise<PrivyIntegration> {
  const mod = await import("@privy-io/node").catch(() => {
    throw new Error("@privy-io/node is required for the Privy integration: pnpm add @privy-io/node");
  });
  const viemMod = await import("@privy-io/node/viem");
  const client: PrivyClient = new mod.PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
  const authorization_context = { authorization_private_keys: [cfg.authorizationKey] };
  const caip2 = `eip155:${cfg.chainId}` as const;

  const toTypedData = (td: TypedDataInput) => ({
    domain: { ...td.domain },
    types: { ...td.types, EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ] },
    primary_type: td.primaryType,
    message: jsonSafe(td.message) as Record<string, unknown>,
  });

  const createPolicy = async (policy: MandatePolicy) => {
    const created = await client.policies().create({
      ...(policy as unknown as Record<string, unknown>),
      owner_id: cfg.keyQuorumId,
    } as never);
    return created.id as string;
  };

  return {
    client,
    keyQuorumId: cfg.keyQuorumId,
    agents: {
      async createWallet(input = {}) {
        const w = await client.wallets().create({
          chain_type: "ethereum",
          owner_id: cfg.keyQuorumId,
          display_name: input.label ?? "mandate agent",
        } as never);
        return { walletId: w.id, address: w.address as Address };
      },
      account(ref) {
        return viemMod.createViemAccount(client, { walletId: ref.walletId, address: ref.address, authorizationContext: authorization_context }) as unknown as Account;
      },
      async mirrorMandate({ wallet, mandate, mandateHash }) {
        const policy = buildMandatePolicy({ mandate, mandateHash, chainId: cfg.chainId, executor: cfg.addresses.executor });
        const policyId = await createPolicy(policy);
        await client.wallets().update(wallet.walletId, { policy_ids: [policyId], authorization_context } as never);
        return { policyId, policy };
      },
      async revokeMirror({ policyId, mandateHash }) {
        await client.policies().update(policyId, {
          name: `mandate ${mandateHash.slice(0, 10)} (revoked)`,
          rules: revokedPolicyRules() as never,
          authorization_context,
        } as never);
      },
      async probe({ wallet, to }) {
        try {
          const res = await client.wallets().ethereum().sendTransaction(wallet.walletId, {
            caip2,
            params: { transaction: { to, value: "0x0", chain_id: cfg.chainId } },
            authorization_context,
          } as never);
          return { blocked: false, hash: (res as { hash: Hex }).hash };
        } catch (e) {
          return { blocked: true, reason: (e as Error).message };
        }
      },
    },
    sessions: {
      async embeddedWallet(identityToken) {
        const user = await client.users().get({ id_token: identityToken } as never);
        const accounts = (user as { linked_accounts?: unknown[] }).linked_accounts ?? [];
        const w = accounts.find((a) => {
          const x = a as { type?: string; chain_type?: string; wallet_client_type?: string };
          return x.type === "wallet" && x.chain_type === "ethereum" && x.wallet_client_type === "privy";
        }) as { id?: string | null; address?: string; delegated?: boolean } | undefined;
        return {
          userId: (user as { id: string }).id,
          wallet: w?.id ? { walletId: w.id, address: w.address as Address, delegated: !!w.delegated } : undefined,
        };
      },
      async createScopePolicy({ account }) {
        const policy = buildSessionSignerPolicy({ chainId: cfg.chainId, registry: cfg.addresses.registry, account });
        const policyId = await createPolicy(policy);
        return { policyId, policy };
      },
      async signTypedData({ walletId, typedData }) {
        const res = await client.wallets().ethereum().signTypedData(walletId, {
          params: { typed_data: toTypedData(typedData) },
          authorization_context,
        } as never);
        return (res as { signature: Hex }).signature;
      },
      principal({ walletId, owner, account }) {
        return new SignerPrincipalImpl(account, owner, (td) => this.signTypedData({ walletId, typedData: td }));
      },
    },
  };
}
