/**
 * Assay integration for Mandate: an agent may only pay for inference from hosts that open verifiers
 * grade well. A mandate bounds how much an agent spends; this bounds *who* the inference money goes to.
 *
 *   import { createInferenceGuard, guardAgent, assayHostKey } from "@ibxlab/mandate/assay";
 *
 * Grades live in Assay's VerifierRegistry on Monad. A verifier tests a host against the lab's own API
 * and posts passed/total with a 95% interval and the hash of its raw logs. The caller chooses which
 * verifiers count, so nobody can flood the registry with grades that matter. One view call, no new
 * dependencies. Spec: https://github.com/trudransh/Assay/blob/main/SPEC.md
 */
import { keccak256, stringToBytes, zeroAddress, type Address, type Hex } from "viem";
import { MONAD_TESTNET_CHAIN_ID } from "./addresses.js";
import type { Agent, ExecuteParams } from "./agent.js";
import type { TxResult } from "./types.js";

const TESTNET_REGISTRY: Address = "0x7755818dc08659D2A3A66FA3ddb1Ce636c145C91";

/** Assay's VerifierRegistry per chain. */
export const ASSAY_VERIFIER_REGISTRY: Record<number, Address> = { [MONAD_TESTNET_CHAIN_ID]: TESTNET_REGISTRY };

/** A grade is older than this → `unknown`. */
export const GRADE_MAX_AGE_SECONDS = 7n * 24n * 60n * 60n;
/** Fewer samples than this → at best `warn`. */
export const GRADE_MIN_SAMPLES = 30;

/**
 * Grades follow a host's identity, not its signing key, so rotating a key never wipes a grade.
 * Each key is keccak256 of a prefixed string (the same preimages Assay's SDK and grader pin).
 */
export const assayHostKey = {
  /** An Assay host, by its ERC-8004 identity: `erc8004:<chainId>:<agentId>`. */
  agent: (chainId: number | bigint, agentId: number | bigint): Hex => keccak256(stringToBytes(`erc8004:${BigInt(chainId)}:${BigInt(agentId)}`)),
  /** An OpenRouter endpoint, by provider tag, e.g. `deepinfra/fp8`. */
  openrouter: (tag: string): Hex => keccak256(stringToBytes(`openrouter:${tag}`)),
  /** A lab's own API, by hostname, e.g. `api.z.ai`. */
  direct: (host: string): Hex => keccak256(stringToBytes(`direct:${host}`)),
};

/** `0x…` (a bytes32 host key) or one of the spec strings `erc8004:<c>:<id>`, `openrouter:<tag>`, `direct:<host>`. */
export function hostKeyOf(host: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(host)) return host as Hex;
  if (/^(erc8004:\d+:\d+|openrouter:.+|direct:.+)$/.test(host)) return keccak256(stringToBytes(host));
  throw new Error(`host must be a bytes32 host key, erc8004:<chainId>:<agentId>, openrouter:<tag> or direct:<host>; got "${host}"`);
}

/** VerifierRegistry.Grade as viem decodes it. */
export interface InferenceGrade {
  model: Hex;
  hostKey: Hex;
  checks: Hex;
  passed: number;
  total: number;
  ciLowBps: number;
  ciHighBps: number;
  refModel: Hex;
  evidence: Hex;
  /** Unix seconds. */
  t: bigint;
}

export type GradeStatus = "pass" | "warn" | "fail" | "unknown";

export const verifierRegistryAbi = [
  {
    type: "function",
    name: "gradeOf",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }],
    outputs: [
      {
        name: "g",
        type: "tuple",
        components: [
          { name: "model", type: "bytes32" },
          { name: "hostKey", type: "bytes32" },
          { name: "checks", type: "bytes32" },
          { name: "passed", type: "uint32" },
          { name: "total", type: "uint32" },
          { name: "ciLowBps", type: "uint16" },
          { name: "ciHighBps", type: "uint16" },
          { name: "refModel", type: "bytes32" },
          { name: "evidence", type: "bytes32" },
          { name: "t", type: "uint64" },
        ],
      },
      { name: "by", type: "address" },
    ],
  },
] as const;

/**
 * `unknown`: no grade, or older than 7 days. `fail`: the host's best case (interval high) is below the
 * reference's worst case (interval low). `warn`: fewer than 30 samples. Otherwise `pass`.
 */
/** Without a reference grade, a host is held to this absolute floor on its 95% interval (80%). */
export const GRADE_FLOOR_BPS = 8000;

export function gradeStatus(grade: InferenceGrade | null | undefined, opts: { now: bigint | number; reference?: InferenceGrade | null }): GradeStatus {
  if (!grade || BigInt(opts.now) - grade.t > GRADE_MAX_AGE_SECONDS) return "unknown";
  // With a reference, fail below its worst case. Without one, a host that failed every check must not read "pass".
  const floor = opts.reference ? opts.reference.ciLowBps : GRADE_FLOOR_BPS;
  if (grade.ciHighBps < floor) return "fail";
  if (grade.total < GRADE_MIN_SAMPLES) return "warn";
  if (!opts.reference && grade.ciLowBps < GRADE_FLOOR_BPS) return "warn";
  return "pass";
}

/** Anything with viem's `readContract`, e.g. the client's `publicClient`. */
export interface GradeReader {
  readContract(args: { address: Address; abi: typeof verifierRegistryAbi; functionName: "gradeOf"; args: readonly [Hex, Hex, readonly Address[]] }): Promise<unknown>;
}

export interface InferenceGuardOptions {
  publicClient: GradeReader;
  /** Model id as the verifier graded it, e.g. `z-ai/glm-5.3`. Hashed with keccak256. */
  model: string;
  /** The inference host the agent will pay. See `hostKeyOf`. */
  host: string;
  /** Verifiers whose grades count. Ties go to the one listed first. */
  verifiers: readonly Address[];
  /** The lab's own endpoint for the same model. With it, a host clearly below the reference reads `fail`. */
  reference?: string;
  /** Statuses that may pay. Default `["pass"]`. */
  allow?: readonly GradeStatus[];
  /** Default: Assay's registry on Monad testnet. */
  registry?: Address;
  /** Unix seconds; injectable for tests. */
  now?: () => bigint;
}

export interface InferenceVerdict {
  status: GradeStatus;
  grade: InferenceGrade | null;
  /** The verifier whose grade was used. */
  by: Address | null;
}

/** Thrown before anything is sent when the host's grade isn't allowed, or can't be read (fails closed). */
export class InferenceHostRefused extends Error {
  override readonly name = "InferenceHostRefused";
  constructor(
    readonly status: GradeStatus | "error",
    readonly model: string,
    readonly host: string,
    cause?: unknown,
  ) {
    super(`inference host ${host} for ${model} is ${status}; this mandate only pays hosts graded well`, { cause });
  }
}

export function createInferenceGuard(opts: InferenceGuardOptions) {
  if (opts.verifiers.length === 0) throw new Error("createInferenceGuard: pass at least one verifier you trust");
  const registry = opts.registry ?? TESTNET_REGISTRY;
  const allow = opts.allow ?? ["pass"];
  const model = keccak256(stringToBytes(opts.model.trim()));
  const now = opts.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));

  const read = async (host: string): Promise<{ grade: InferenceGrade | null; by: Address | null }> => {
    const [grade, by] = (await opts.publicClient.readContract({
      address: registry,
      abi: verifierRegistryAbi,
      functionName: "gradeOf",
      args: [model, hostKeyOf(host), opts.verifiers],
    })) as [InferenceGrade, Address];
    return by === zeroAddress ? { grade: null, by: null } : { grade, by };
  };

  /** One view call (two with a reference). */
  const check = async (): Promise<InferenceVerdict> => {
    const [host, ref] = await Promise.all([read(opts.host), opts.reference ? read(opts.reference) : undefined]);
    return { ...host, status: gradeStatus(host.grade, { now: now(), reference: ref?.grade }) };
  };

  return {
    check,
    /** Resolves with the verdict when it's allowed; throws `InferenceHostRefused` otherwise. */
    async assert(): Promise<InferenceVerdict> {
      let verdict: InferenceVerdict;
      try {
        verdict = await check();
      } catch (e) {
        throw new InferenceHostRefused("error", opts.model, opts.host, e);
      }
      if (!allow.includes(verdict.status)) throw new InferenceHostRefused(verdict.status, opts.model, opts.host);
      return verdict;
    },
  };
}

export type InferenceGuard = ReturnType<typeof createInferenceGuard>;

/**
 * The same agent, but `validate` and `execute` first require the inference host to be graded well.
 * Order: grade check -> Mandate's typed pre-check -> simulation -> send. A refused host costs one view call.
 * `skip` lets cheap calls through without a check.
 */
export function guardAgent(agent: Agent, guard: InferenceGuard, opts: { skip?: (p: ExecuteParams) => boolean } = {}): Agent {
  const gate = async (p: ExecuteParams) => {
    if (!opts.skip?.(p)) await guard.assert();
  };
  return {
    ...agent,
    async validate(p: ExecuteParams): Promise<void> {
      await gate(p);
      return agent.validate(p);
    },
    async execute(p: ExecuteParams): Promise<TxResult> {
      await gate(p);
      return agent.execute(p);
    },
  };
}
