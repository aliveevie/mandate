import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";

/** ERC-8004 agent id. */
export type AgentId = bigint;

/** On-chain Mandate struct, exactly as hashed under EIP-712. */
export interface Mandate {
  principal: Address;
  agentId: bigint;
  agentKey: Address;
  targets: readonly Address[];
  selectors: readonly Hex[];
  asset: Address;
  spendCap: bigint;
  perBlockCap: bigint;
  maxDrawdownBps: bigint;
  validAfter: bigint;
  validUntil: bigint;
  nonce: bigint;
  policyHash: Hex;
}

/** A whitelisted contract and the function selectors (or signatures) the agent may call on it. */
export interface TargetSpec {
  address: Address;
  /** 4-byte selectors (`0x12345678`) or human-readable signatures (`"swap(address,uint256)"`). */
  selectors: readonly (Hex | string)[];
}

/** Everything the principal decides. `principal` and `nonce` are filled in by `sign`. */
export interface MandateParams {
  agentId: bigint | number;
  agentKey: Address;
  targets: readonly TargetSpec[];
  /** Spend asset. Defaults to native MON (`0x000…000`). */
  asset?: Address;
  /** Lifetime cap in asset units. */
  spendCap: bigint;
  /** Per-block cap in asset units. */
  perBlockCap: bigint;
  /** Breaker trip threshold. 10_000 disables the breaker. Defaults to 10_000. */
  maxDrawdownBps?: number | bigint;
  /** Unix seconds or Date. Defaults to now. */
  validAfter?: number | bigint | Date;
  /** Unix seconds or Date. */
  validUntil: number | bigint | Date;
  /** Commitment to an encrypted off-chain policy blob. Defaults to zero. */
  policyHash?: Hex;
}

export type MandateDraft = Omit<Mandate, "principal" | "nonce">;

export interface SignedMandate {
  mandate: Mandate;
  /** EIP-712 struct hash. This is the `mandateHash` used across the protocol. */
  hash: Hex;
  /** EIP-712 digest the passkey signed. */
  digest: Hex;
  /** ABI-encoded WebAuthn assertion (or 65-byte ECDSA signature for EOA principals). */
  signature: Hex;
}

export type BreakerPhase = "Armed" | "Tripped" | "Cooldown";

export interface MandateState {
  spent: bigint;
  spentThisBlock: bigint;
  lastBlock: bigint;
  grantedAt: bigint;
  revoked: boolean;
  remaining: bigint;
  remainingThisBlock: bigint;
  active: boolean;
  breaker: BreakerPhase;
  drawdownBps: bigint;
}

/** A P256 key that can produce WebAuthn-shaped assertions over a 32-byte challenge. */
export interface PasskeySigner {
  readonly kind: "webauthn" | "software";
  readonly publicKey: { x: Hex; y: Hex };
  /** WebAuthn credential id (base64url). Absent for software keys. */
  readonly credentialId?: string;
  /** Returns the ABI-encoded `WebAuthnAuth` struct the PasskeyAccount verifies on-chain. */
  signChallenge(challenge: Hex): Promise<Hex>;
}

/** EIP-712 payload a signer principal is asked to sign. */
export interface TypedDataInput {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** A passkey together with its deployed PasskeyAccount. */
export interface PasskeyPrincipal extends PasskeySigner {
  /** PasskeyAccount address. */
  readonly address: Address;
  /** Serialisable form (no private material for WebAuthn keys). */
  toJSON(): StoredPrincipal;
}

/**
 * A principal whose account is a `SignerAccount` owned by a secp256k1 key: an EOA, an embedded wallet
 * (optionally with a delegated session signer), or an ERC-1271 contract. Everything it signs is EIP-712.
 */
export interface SignerPrincipal {
  readonly kind: "signer";
  /** SignerAccount address. */
  readonly address: Address;
  /** The owning key (embedded wallet or EOA). */
  readonly owner: Address;
  signTypedData(typedData: TypedDataInput): Promise<Hex>;
  toJSON(): StoredPrincipal;
}

export type Principal = PasskeyPrincipal | SignerPrincipal;

export interface StoredPrincipal {
  kind: "webauthn" | "software" | "signer";
  address: Address;
  publicKey?: { x: Hex; y: Hex };
  credentialId?: string;
  rpId?: string;
  /** Signer principals: the owning key. */
  owner?: Address;
  /** Software keys only: JWK private key. Never present for WebAuthn credentials. */
  privateJwk?: JsonWebKey;
}

export interface PrincipalStorage {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
  remove(key: string): Promise<void> | void;
}

/** Anything that can send transactions: a viem local Account or a WalletClient. */
export type Signer = Account | WalletClient<Transport, Chain | undefined, Account>;

export interface MandateAddresses {
  registry: Address;
  executor: Address;
  breaker: Address;
  submitter: Address;
  reputationAdapter: Address;
  erc8004Identity?: Address;
  erc8004Reputation?: Address;
}

export interface TxResult {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface Reputation {
  agentId: bigint;
  /** 0-100, latest attestation. `null` when no attestation exists yet. */
  score: number | null;
  trips: number;
  executed: number;
  pnlBps: bigint;
  window: { start: bigint; end: bigint } | null;
  evidenceHash: Hex | null;
  attestations: number;
  /** Aggregate as seen by the ERC-8004 Reputation Registry for the Mandate adapter as client. */
  erc8004: { count: bigint; value: bigint; decimals: number } | null;
}

export interface Attestation {
  complianceScore: number;
  tripCount: number;
  executedCount: number;
  realisedPnlBps: bigint;
  windowStart: bigint;
  windowEnd: bigint;
  evidenceHash: Hex;
}

export type MandatePublicClient = PublicClient<Transport, Chain | undefined>;
