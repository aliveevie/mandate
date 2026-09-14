/**
 * @ibxlab/mandate — scoped, revocable, passkey-signed delegations for AI agents on Monad.
 *
 * Principal side:  client.passkey.create → client.mandate.build → sign → grant / revoke
 * Agent side:      client.agent.load → agent.execute (typed MandateError before anything is sent)
 * Anyone:          client.reputation.get(agentId)
 */
export { createMandateClient } from "./client.js";
export type { MandateClient, MandateClientConfig } from "./client.js";

export { MandateError, decodeMandateError, toMandateError, mandateErrorsAbi } from "./errors.js";
export type { MandateErrorName } from "./errors.js";

export { deployments, addressesFor, testnetDemo, P256_PRECOMPILE, MONAD_TESTNET_CHAIN_ID, MONAD_MAINNET_CHAIN_ID } from "./addresses.js";

export {
  hashMandate,
  mandateDigest,
  domainSeparator,
  mandateDomain,
  mandateTypedDataTypes,
  flattenTargets,
  toSelector,
  MANDATE_TYPEHASH,
  MANDATE_TYPE_STRING,
} from "./mandate.js";

export { SoftwarePasskey, WebAuthnPasskey } from "./passkey.js";
export type { CreatePrincipalOptions, WebAuthnCreateOptions } from "./passkey.js";
export type { Agent, AgentLoadOptions, ExecuteParams } from "./agent.js";

export { encodeWebAuthnAuth, normalizeS, derToRS, P256_N } from "./webauthn.js";
export type { WebAuthnAuth } from "./webauthn.js";

export {
  MandateRegistryAbi,
  MandateExecutorAbi,
  RiskBreakerAbi,
  PasskeyAccountAbi,
  PrivateSubmitterAbi,
  ERC8004ReputationAdapterAbi,
  ERC8004ReputationRegistryAbi,
  ERC8004IdentityRegistryAbi,
  PasskeyAccountBytecode,
} from "./abi/generated.js";

export type * from "./types.js";
