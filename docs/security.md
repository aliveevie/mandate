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

## Static analysis: Slither triage

Slither 0.11 locally and the current release in CI over `contracts/src` (libraries, tests and scripts excluded): 25 distinct results, 0 exploitable. Every finding below is either the protocol working as designed or informational. CI runs Slither with these detectors excluded (`contracts/slither.config.json`) and fails on anything new at medium severity or above.

| Detector | Impact | Where | Verdict |
|---|---|---|---|
| `arbitrary-send-eth` | High | `PasskeyAccount._call` | **Accepted, by design.** `_call` is reachable only from `execute` (authorised by a fresh WebAuthn assertion over a nonce-bound digest) and `executeFromExecutor` (callable only by the immutable trusted executor, which has already passed `MandateRegistry.validate`). Sending value to an arbitrary target is the account's purpose. |
| `incorrect-equality` | Medium | `MandateRegistry.remainingBlockSpend` (`lastBlock == block.number`) | **Accepted.** The per-block cap is defined by block-number equality; any other block starts a fresh budget. This is the intended Monad-native semantics. |
| `incorrect-equality` | Medium | `RiskBreaker.checkpoint` (Cooldown re-arm) | **Accepted.** The flagged expression is `phase == Cooldown && drawdown <= threshold`, an enum equality guarding a `<=` comparison. |
| `uninitialized-local` | Medium | `ERC8004ReputationAdapter.attest` (`mirrored`) | **Accepted.** Solidity zero-initialises locals; `mirrored` is `false` unless the try branch sets it, which is the intended semantics. |
| `missing-zero-check` | Low | constructors of `PasskeyAccount`, `MandateExecutor`, `PrivateSubmitter`, `RiskBreaker`; `setSubmitter`; `setReputationRegistry` | **Accepted.** Immutable wiring is set by `script/Deploy.s.sol` and proven by the end-to-end run; a zero address here is a deploy-time misconfiguration that fails loudly on first use, not an attack surface. `setReputationRegistry(0)` is intentionally allowed to disable mirroring. |
| `reentrancy-balance` | Medium | `MandateExecutor._callAndMeasure` | **Accepted, by design.** The executor reads the principal's asset balance, performs the mandated call, and reads it again: that is how real outflow is measured against the declared bound. The function is behind `nonReentrant`, only the whitelisted target is called, and no protocol state is written between the two reads. |
| `unindexed-event-address` | Info | admin events `AttestorSet`, `ReputationRegistrySet`, `SubmitterSet`, `Configured` | **Accepted.** One-shot or owner-only configuration events; not queried by address. |
| `reentrancy-events` | Low | `MandateRegistry.grant`, `ERC8004ReputationAdapter.attest` | **Accepted.** Events emitted after an external call to a trusted, immutable dependency (the breaker) or inside a try/catch to the ERC-8004 registry. No state is written after the call that a reentrant caller could exploit; `grant` mutates all state before calling the breaker. |
| `timestamp` | Low | validity window checks | **Accepted.** Expiry is defined in seconds; validator timestamp drift is bounded and cannot extend a mandate past `validUntil` by more than that drift. |
| `assembly`, `low-level-calls` | Info | `PasskeyAccount._call` | **Accepted.** Revert-bubbling of the target call so venue errors reach the agent verbatim. |
| `naming-convention` | Info | `DOMAIN_SEPARATOR` | **Accepted.** EIP-712 convention. |
| `cyclomatic-complexity` | Info | `MandateRegistry.grant` | **Accepted.** Input validation is deliberately exhaustive in one place. |

Reproduce: `pipx install slither-analyzer && cd contracts && slither .`

## Secret scan

`gitleaks git` over the full history reports no secrets. Three high-entropy hex values it flags (`.gitleaks.toml`) are the on-chain mandate, evidence and transaction hashes recorded in `contracts/deployments/monad-testnet.json` and the docs. Private keys are held only in Foundry keystores and untracked `.env` files; the deploy scripts sign from the keystore.
