# Security

## Threat model

Mandate assumes the agent is untrusted. It may be buggy, compromised, or adversarial. The principal's passkey and the chain are the trust anchors. The attestor is a single accountable role whose output is verifiable from on-chain evidence.

**In scope.** An agent trying to spend more than allowed, call something it should not, keep acting after revocation, keep acting through a drawdown, replay a grant on another chain or registry, or write its own reputation.

**Out of scope, deliberately.** Losses inside a whitelisted call that stay within the caps and the breaker threshold: that is the risk the principal chose. A compromised passkey: the principal's device is the root of trust. A malicious venue draining approvals outside the executor: approvals are the principal's decision, and the breaker still records the drawdown. Liveness of the attestor: a stalled attestor means stale reputation, not stolen funds.

## The seven properties, and where each is proven

| # | Property | Proof |
|---|---|---|
| 1 | An agent can never spend more than `spendCap` lifetime or `perBlockCap` per block | Invariants `invariant_lifetimeSpendWithinCap`, `invariant_perBlockSpendWithinCap`; unit tests on both caps. Spend is measured as real asset outflow and re-checked in `recordExecution` |
| 2 | An agent can never call a non-whitelisted target or selector | Invariant `invariant_onlyWhitelistedCalls`; unit tests for wrong target and wrong selector |
| 3 | Revocation takes effect in the block it is mined | Unit test: revoke via passkey, then execute and validate revert in the same block |
| 4 | Breaker tripped means zero executions until re-armed | Invariant `invariant_noExecutionWhileTripped`; unit test through trip, cooldown, hysteresis and re-arm |
| 5 | A mandate signature is bound to chain id and registry | Unit tests: same signature rejected after `vm.chainId` change and on a second registry |
| 6 | Only the attestor can write reputation | Unit test: agent, principal and owner all rejected with `NotAttestor`; SDK test repeats it live |
| 7 | No secret ever appears in a contract, log, committed file or server DB | Review checklist below |

Run them: `cd contracts && forge test` (67 tests, invariants at 256 runs under the CI profile).

## Design decisions that matter for security

- **Measured spend, not declared spend.** The agent declares an upper bound; the executor measures the principal's balance before and after and reverts `SpendExceedsDeclared` if the real outflow is higher. Caps therefore bind actual value, not the agent's word.
- **Live drawdown check in `validate`.** Even before a keeper persists a trip, a call is rejected if current drawdown already exceeds the threshold.
- **Hysteresis.** The re-arm threshold is strictly below the trip threshold, so the breaker cannot oscillate.
- **Low-s only, user verification required.** The account rejects malleable P256 signatures and assertions without the UV flag.
- **One-shot wiring.** Registry and executor configuration can be set once and never changed. There is no upgrade path and no admin that can move funds.
- **No P256 math in the repository.** Verification runs through the precompile via Solady's audited libraries.

## Secret handling checklist (property 7)

- Passkey private keys never leave the authenticator. The SDK stores only the credential id and public key.
- The software passkey used by tests and the quickstart is a WebCrypto key held in the caller's storage. It is documented as a hot key and is never written by the SDK to disk on its own.
- `.env` files, Foundry keystores and broadcast caches are gitignored. `git ls-files` contains no env, keystore or broadcast file.
- Deploy scripts sign from a Foundry keystore, not from a private key in the environment.
- Contracts emit no secret material. Events carry hashes, addresses and amounts only.

## External review

Static analysis (Slither / ack3) and triage of findings are scheduled for the hardening phase and will be recorded in this section.
