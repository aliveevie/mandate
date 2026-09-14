# Contracts

Foundry project in `contracts/`. Solidity 0.8.24, Solady for WebAuthn, P256 and signature checking. All addresses and transaction hashes below are also in `contracts/deployments/monad-testnet.json`.

## Monad testnet deployment

Chain id 10143. Deployer `0x61c780065C2F803588201F4469b2F80484da448f`. Private submitter in **BTX mode**.

| Contract | Address |
|---|---|
| MandateRegistry | `0x46441BC77a4dDbaE7004943E0ab9cB01c76092fA` |
| RiskBreaker | `0xf4c2F2373a17e3a2122f984D512B0B2EabA26374` |
| MandateExecutor | `0xbb2d989876BFdf63CDFf7bb480A667175cF12409` |
| PrivateSubmitter | `0xC552018AA7A9001e1dEcdfe40dAe38Dd6C5ca9D9` |
| ERC8004ReputationAdapter | `0x3b1d977C1270dF25252041D0671b6FD90dF7a757` |

External, verified on-chain:

| Dependency | Address |
|---|---|
| P256 precompile (RIP-7212) | `0x0000000000000000000000000000000000000100` |
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Demo agent (ERC-8004 id) | `1831` |

## Roles

- **Principal**: a human. Controls a `PasskeyAccount`. Issues and revokes mandates.
- **Agent**: an ERC-8004 identity with its own executing key.
- **Venue**: any contract the mandate whitelists.
- **Attestor**: the only address allowed to write reputation through the adapter.

## The Mandate struct

```solidity
struct Mandate {
    address principal;      // PasskeyAccount (or any ERC-1271 account / EOA)
    uint256 agentId;        // ERC-8004 id
    address agentKey;       // executing key
    address[] targets;      // allowed contracts
    bytes4[]  selectors;    // allowed selector per target (parallel array)
    address   asset;        // spend asset, address(0) = native
    uint256   spendCap;     // lifetime cap
    uint256   perBlockCap;  // per-block cap
    uint256   maxDrawdownBps;
    uint64    validAfter;
    uint64    validUntil;
    uint256   nonce;        // per principal
    bytes32   policyHash;   // commitment to the encrypted off-chain policy blob
}
```

EIP-712 domain: `name = "Mandate"`, `version = "1"`, `chainId`, `verifyingContract = MandateRegistry`.

## Contract by contract

**PasskeyAccount.** Minimal smart account whose owner is a P256 public key. `isValidSignature` verifies an ABI-encoded WebAuthn assertion: client data type and challenge, authenticator flags (user present and user verified), low-s, then the signature through the precompile via Solady's audited library. Owner actions (`execute`, `revokeMandate`) are authorised by an assertion over a nonce-bound digest. The trusted executor has a dedicated hook, and venue reverts bubble up unchanged.

**MandateRegistry.** `grant` verifies the principal's signature (ERC-1271 for accounts, ECDSA for EOAs), enforces the nonce and input sanity, stores the mandate and arms the breaker. `revoke` is principal-only and immediate. `validate` is a view that reverts with `TargetNotAllowed`, `SpendCapExceeded`, `PerBlockCapExceeded`, `MandateExpired`, `MandateNotYetValid`, `MandateRevoked` or `Tripped`. `recordExecution` is executor-only and re-checks the caps.

**MandateExecutor.** `execute(mandateHash, target, data, amount)` from the agent key: validate, call from the principal's account, measure real outflow, require it does not exceed `amount`, record spend, checkpoint the breaker, emit `MandateExecuted`. `executeFor` is the same path for the private submitter.

**RiskBreaker.** Per-mandate hysteresis state machine. Armed to Tripped when drawdown exceeds `maxDrawdownBps`. Tripped to Cooldown after `cooldownBlocks`. Cooldown to Armed when drawdown falls under `maxDrawdownBps × rearmFactorBps / 10000`. `checkpoint` is permissionless. Emits `Tripped(mandateHash, agentId, drawdownBps, block)`.

**PrivateSubmitter.** One contract, two modes chosen at deploy. BTX mode passes through to the executor because privacy comes from the encrypted mempool. Commit-reveal mode requires `commit(hash)` from the same key at least one block before `reveal(calldata)` and within a reveal window.

**ERC8004ReputationAdapter.** `attest(agentId, {complianceScore, tripCount, executedCount, realisedPnlBps, windowStart, windowEnd, evidenceHash})` from the attestor only. Stores the attestation, mirrors it to the ERC-8004 Reputation Registry with `giveFeedback`, and emits `ReputationAttested`. A failing mirror emits `MirrorFailed` rather than losing the record.

## Events the indexer follows

| Contract | Event |
|---|---|
| MandateRegistry | `MandateGranted`, `Revoked`, `ExecutionRecorded` |
| MandateExecutor | `MandateExecuted` |
| RiskBreaker | `Armed`, `Tripped`, `CooldownEntered`, `Rearmed`, `PeakReset` |
| ERC8004ReputationAdapter | `ReputationAttested` |

## Build and test

```bash
cd contracts
forge test                                  # 67 tests: unit + invariants at 256 runs
forge script script/Deploy.s.sol --rpc-url $MONAD_RPC_URL --account <keystore> --broadcast
forge script script/E2E.s.sol    --rpc-url $MONAD_RPC_URL --account <keystore> --broadcast
```

The tests run under the Osaka EVM so the P256 precompile is present locally and passkey signatures are verified for real.
