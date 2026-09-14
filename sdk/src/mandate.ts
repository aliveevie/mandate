import {
  encodeAbiParameters,
  encodePacked,
  getContract,
  isHex,
  keccak256,
  concatHex,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { MandateRegistryAbi, PasskeyAccountAbi, RiskBreakerAbi } from "./abi/generated.js";
import { rethrowTyped } from "./errors.js";
import { resolveWallet, waitTx } from "./signer.js";
import type {
  BreakerPhase,
  Mandate,
  MandateAddresses,
  MandateDraft,
  MandateParams,
  MandatePublicClient,
  MandateState,
  Principal,
  SignedMandate,
  Signer,
  TargetSpec,
  TxResult,
} from "./types.js";

// ---------------------------------------------------------------------------------------------
// EIP-712 (mirrors contracts/src/libraries/MandateLib.sol)
// ---------------------------------------------------------------------------------------------

export const MANDATE_TYPE_STRING =
  "Mandate(address principal,uint256 agentId,address agentKey,address[] targets,bytes4[] selectors,address asset,uint256 spendCap,uint256 perBlockCap,uint256 maxDrawdownBps,uint64 validAfter,uint64 validUntil,uint256 nonce,bytes32 policyHash)";
export const MANDATE_TYPEHASH = keccak256(new TextEncoder().encode(MANDATE_TYPE_STRING));
const DOMAIN_TYPEHASH = keccak256(
  new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const NAME_HASH = keccak256(new TextEncoder().encode("Mandate"));
const VERSION_HASH = keccak256(new TextEncoder().encode("1"));

/** viem-compatible typed-data description, for wallets that sign EIP-712 natively (EOA principals). */
export const mandateTypedDataTypes = {
  Mandate: [
    { name: "principal", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "agentKey", type: "address" },
    { name: "targets", type: "address[]" },
    { name: "selectors", type: "bytes4[]" },
    { name: "asset", type: "address" },
    { name: "spendCap", type: "uint256" },
    { name: "perBlockCap", type: "uint256" },
    { name: "maxDrawdownBps", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
  ],
} as const;

export function mandateDomain(chainId: number, registry: Address) {
  return { name: "Mandate", version: "1", chainId, verifyingContract: registry } as const;
}

export function domainSeparator(chainId: number, registry: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), registry],
    ),
  );
}

/** EIP-712 struct hash. Equals `MandateRegistry.hashMandate(m)` and is the protocol's `mandateHash`. */
export function hashMandate(m: Mandate): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        MANDATE_TYPEHASH,
        m.principal,
        m.agentId,
        m.agentKey,
        keccak256(encodePacked(["address[]"], [m.targets as Address[]])),
        keccak256(encodePacked(["bytes4[]"], [m.selectors as Hex[]])),
        m.asset,
        m.spendCap,
        m.perBlockCap,
        m.maxDrawdownBps,
        m.validAfter,
        m.validUntil,
        m.nonce,
        m.policyHash,
      ],
    ),
  );
}

/** Full EIP-712 digest the principal signs. Equals `MandateRegistry.digest(m)`. */
export function mandateDigest(m: Mandate, chainId: number, registry: Address): Hex {
  return keccak256(concatHex(["0x1901", domainSeparator(chainId, registry), hashMandate(m)]));
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function toSeconds(v: number | bigint | Date): bigint {
  if (v instanceof Date) return BigInt(Math.floor(v.getTime() / 1000));
  return BigInt(v);
}

export function toSelector(s: Hex | string): Hex {
  if (isHex(s) && s.length === 10) return s;
  if (isHex(s)) throw new Error(`Selector must be 4 bytes: ${s}`);
  return toFunctionSelector(s.includes("function ") ? s : `function ${s}`);
}

/** Flatten `[{address, selectors}]` into the parallel arrays the contract stores. */
export function flattenTargets(targets: readonly TargetSpec[]): { targets: Address[]; selectors: Hex[] } {
  const t: Address[] = [];
  const s: Hex[] = [];
  for (const spec of targets) {
    for (const sel of spec.selectors) {
      t.push(spec.address);
      s.push(toSelector(sel));
    }
  }
  if (t.length === 0) throw new Error("A mandate needs at least one target/selector");
  return { targets: t, selectors: s };
}

const PHASES: BreakerPhase[] = ["Armed", "Tripped", "Cooldown"];

// ---------------------------------------------------------------------------------------------
// module
// ---------------------------------------------------------------------------------------------

export interface MandateModuleDeps {
  publicClient: MandatePublicClient;
  addresses: MandateAddresses;
  chainId: number;
  signer?: Signer;
  rpcUrl?: string;
}

export function createMandateModule(deps: MandateModuleDeps) {
  const registry = getContract({ address: deps.addresses.registry, abi: MandateRegistryAbi, client: deps.publicClient });
  const breaker = getContract({ address: deps.addresses.breaker, abi: RiskBreakerAbi, client: deps.publicClient });

  async function readState(hash: Hex): Promise<MandateState> {
    const [s, remaining, remainingThisBlock, active, phase, dd] = await Promise.all([
      registry.read.getState([hash]),
      registry.read.remainingSpend([hash]),
      registry.read.remainingBlockSpend([hash]),
      registry.read.isActive([hash]),
      breaker.read.phaseOf([hash]),
      breaker.read.currentDrawdownBps([hash]),
    ]);
    return {
      spent: s.spent,
      spentThisBlock: s.spentThisBlock,
      lastBlock: s.lastBlock,
      grantedAt: BigInt(s.grantedAt),
      revoked: s.revoked,
      remaining,
      remainingThisBlock,
      active,
      breaker: PHASES[phase] ?? "Armed",
      drawdownBps: dd,
    };
  }

  return {
    /** Build the principal's side of a mandate. Pure; nothing is fetched. */
    build(params: MandateParams): MandateDraft {
      const { targets, selectors } = flattenTargets(params.targets);
      const validAfter = params.validAfter === undefined ? BigInt(Math.floor(Date.now() / 1000)) : toSeconds(params.validAfter);
      const validUntil = toSeconds(params.validUntil);
      if (validUntil <= validAfter) throw new Error("validUntil must be after validAfter");
      const maxDrawdownBps = BigInt(params.maxDrawdownBps ?? 10_000);
      if (maxDrawdownBps > 10_000n) throw new Error("maxDrawdownBps must be <= 10000");
      if (params.spendCap <= 0n || params.perBlockCap <= 0n) throw new Error("spendCap and perBlockCap must be > 0");
      return {
        agentId: BigInt(params.agentId),
        agentKey: params.agentKey,
        targets,
        selectors,
        asset: params.asset ?? zeroAddress,
        spendCap: params.spendCap,
        perBlockCap: params.perBlockCap,
        maxDrawdownBps,
        validAfter,
        validUntil,
        policyHash: params.policyHash ?? zeroHash,
      };
    },

    /** Fill in principal + nonce, hash, and sign with the passkey. Nothing is sent. */
    async sign(draft: MandateDraft, principal: Principal): Promise<SignedMandate> {
      const nonce = await registry.read.nonces([principal.address]);
      const mandate: Mandate = { ...draft, principal: principal.address, nonce };
      const hash = hashMandate(mandate);
      const digest = mandateDigest(mandate, deps.chainId, deps.addresses.registry);
      const signature = await principal.signChallenge(digest);
      return { mandate, hash, digest, signature };
    },

    /** Submit a signed mandate. Anyone can pay the gas; the signature binds the principal. */
    async grant(signed: SignedMandate, opts: { signer?: Signer } = {}): Promise<TxResult> {
      const wallet = resolveWallet(opts.signer ?? deps.signer, deps.publicClient, deps.rpcUrl);
      return rethrowTyped(async () => {
        const { request } = await deps.publicClient.simulateContract({
          address: deps.addresses.registry,
          abi: MandateRegistryAbi,
          functionName: "grant",
          args: [signed.mandate, signed.signature],
          account: wallet.account,
        });
        return waitTx(deps.publicClient, await wallet.writeContract(request));
      });
    },

    /** Revoke immediately. The passkey authorises; the signer pays gas. */
    async revoke(hash: Hex, principal: Principal, opts: { signer?: Signer } = {}): Promise<TxResult> {
      const wallet = resolveWallet(opts.signer ?? deps.signer, deps.publicClient, deps.rpcUrl);
      const account = getContract({ address: principal.address, abi: PasskeyAccountAbi, client: deps.publicClient });
      const nonce = await account.read.nonce();
      const digest = await account.read.revokeDigest([hash, nonce]);
      const signature = await principal.signChallenge(digest);
      return rethrowTyped(async () => {
        const { request } = await deps.publicClient.simulateContract({
          address: principal.address,
          abi: PasskeyAccountAbi,
          functionName: "revokeMandate",
          args: [hash, signature],
          account: wallet.account,
        });
        return waitTx(deps.publicClient, await wallet.writeContract(request));
      });
    },

    /** Read a stored mandate. Throws MandateError("MandateNotFound") if unknown. */
    async get(hash: Hex): Promise<Mandate> {
      return rethrowTyped(async () => {
        const m = await registry.read.getMandate([hash]);
        return { ...m, targets: [...m.targets], selectors: [...m.selectors] };
      });
    },

    /** Spend, caps, breaker phase and liveness in one call. */
    state: readState,

    /**
     * Dry-run a call against the registry. Resolves if allowed, otherwise throws the exact
     * MandateError the chain would revert with. This is what `agent.execute` runs before sending.
     */
    async validate(hash: Hex, target: Address, selector: Hex | string, amount: bigint): Promise<void> {
      await rethrowTyped(() => registry.read.validate([hash, target, toSelector(selector), amount]));
    },

    hash: hashMandate,
    digest: (m: Mandate) => mandateDigest(m, deps.chainId, deps.addresses.registry),
    domain: () => mandateDomain(deps.chainId, deps.addresses.registry),
    types: mandateTypedDataTypes,
  };
}

export type MandateModule = ReturnType<typeof createMandateModule>;
