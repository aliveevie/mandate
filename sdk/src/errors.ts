import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import {
  ERC8004ReputationAdapterAbi,
  MandateExecutorAbi,
  MandateRegistryAbi,
  PasskeyAccountAbi,
  PrivateSubmitterAbi,
  RiskBreakerAbi,
  SignerAccountAbi,
  CREAttestationReceiverAbi,
} from "./abi/generated.js";

/** Every custom error the protocol can revert with, merged for decoding. */
export const mandateErrorsAbi = [
  ...MandateRegistryAbi,
  ...MandateExecutorAbi,
  ...RiskBreakerAbi,
  ...PasskeyAccountAbi,
  ...PrivateSubmitterAbi,
  ...ERC8004ReputationAdapterAbi,
  ...SignerAccountAbi,
  ...CREAttestationReceiverAbi,
].filter((item) => item.type === "error") as unknown as Abi;

/** Solidity custom error names, 1:1. */
export type MandateErrorName =
  // MandateRegistry
  | "MandateNotFound"
  | "MandateAlreadyExists"
  | "MandateRevoked"
  | "MandateExpired"
  | "MandateNotYetValid"
  | "TargetNotAllowed"
  | "SpendCapExceeded"
  | "PerBlockCapExceeded"
  | "Tripped"
  | "InvalidSignature"
  | "InvalidNonce"
  | "InvalidMandate"
  | "NotPrincipal"
  | "NotExecutor"
  | "NotOwner"
  | "AlreadyConfigured"
  | "NotConfigured"
  | "ZeroAddress"
  // MandateExecutor
  | "NotAgentKey"
  | "NotSubmitter"
  | "Reentrancy"
  | "SpendExceedsDeclared"
  // RiskBreaker
  | "NotRegistry"
  | "UnknownMandate"
  | "AlreadyArmed"
  | "InvalidRearmFactor"
  // PrivateSubmitter
  | "CommitNotRequired"
  | "CommitAlreadyExists"
  | "CommitNotFound"
  | "RevealTooEarly"
  | "RevealExpired"
  // ERC8004ReputationAdapter
  | "NotAttestor"
  | "InvalidScore"
  | "InvalidWindow"
  // CREAttestationReceiver
  | "UntrustedForwarder"
  | "MalformedMetadata"
  | "InvalidAuthor"
  | "InvalidWorkflowName"
  | "InvalidWorkflowId"
  | "WorkflowNameRequiresAuthor"
  | "StaleReport";

/**
 * A typed protocol revert. `name` is the Solidity error name and `args` its decoded arguments,
 * so `if (e instanceof MandateError && e.name === "SpendCapExceeded")` works and narrows.
 */
export class MandateError extends Error {
  override readonly name: MandateErrorName;
  readonly args: readonly unknown[];
  readonly data: Hex | undefined;

  constructor(name: MandateErrorName, args: readonly unknown[] = [], data?: Hex, cause?: unknown) {
    super(formatMessage(name, args), { cause });
    this.name = name;
    this.args = args;
    this.data = data;
  }

  static is(err: unknown, name?: MandateErrorName): err is MandateError {
    return err instanceof MandateError && (name === undefined || err.name === name);
  }
}

function formatMessage(name: string, args: readonly unknown[]): string {
  const rendered = args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
  return rendered ? `${name}(${rendered})` : `${name}()`;
}

/** Decode raw revert data into a MandateError, or return undefined if it is not a protocol error. */
export function decodeMandateError(data: Hex): MandateError | undefined {
  try {
    const decoded = decodeErrorResult({ abi: mandateErrorsAbi, data });
    return new MandateError(decoded.errorName as MandateErrorName, decoded.args ?? [], data);
  } catch {
    return undefined;
  }
}

/**
 * Convert a viem error into a MandateError when the revert is a protocol error.
 * Unknown reverts (for example a venue's own custom error) are re-thrown unchanged.
 */
export function toMandateError(err: unknown): unknown {
  if (err instanceof MandateError) return err;
  if (!(err instanceof BaseError)) return err;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | null;
  if (!reverted) return err;
  const name = reverted.data?.errorName as MandateErrorName | undefined;
  if (name && isMandateErrorName(name)) {
    return new MandateError(name, reverted.data?.args ?? [], reverted.raw, err);
  }
  if (reverted.raw) {
    const decoded = decodeMandateError(reverted.raw);
    if (decoded) return new MandateError(decoded.name, decoded.args, reverted.raw, err);
  }
  return err;
}

const KNOWN = new Set(
  (mandateErrorsAbi as readonly { type: string; name?: string }[]).map((e) => e.name ?? ""),
);

function isMandateErrorName(name: string): name is MandateErrorName {
  return KNOWN.has(name);
}

/** Run `fn` and rethrow protocol reverts as MandateError. */
export async function rethrowTyped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toMandateError(err);
  }
}
