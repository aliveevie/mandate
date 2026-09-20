# SDK reference

`@ibxlab/mandate` is a TypeScript SDK on top of viem. Three entry points:

| Import | Contents |
|---|---|
| `@ibxlab/mandate` | `createMandateClient`, typed errors, EIP-712 helpers, ABIs, addresses, policy-vault helpers |
| `@ibxlab/mandate/prf` | Mera PRF: namespaced salts, encrypted policy vaults, per-agent identities (browser) |
| `@ibxlab/mandate/privy` | Privy server-wallet integration: agent wallets, mandate-mirroring policies, session signers (server) |

All amounts are `bigint` in asset units. All hashes and addresses are `0x`-prefixed hex strings.

## `createMandateClient(config)`

```ts
createMandateClient({
  chain?: Chain;                 // default monadTestnet
  rpcUrl?: string;               // default: the chain's public RPC
  transport?: Transport;         // bring your own instead of rpcUrl
  addresses?: Partial<MandateAddresses>;  // override the built-in deployment
  signer?: Signer;               // pays gas for principal-side txs (deploy, grant, revoke); optional for reads
  storage?: PrincipalStorage;    // where passkey.create persists the principal; default localStorage or memory
}): MandateClient
```

The client exposes `publicClient`, `addresses`, and the four modules below. Reads are batched over one
multicall-aware transport, so a screen refresh is one RPC round trip.

## `client.passkey`

| Call | Returns | Notes |
|---|---|---|
| `create({ rpId, rpName?, userName?, software? })` | `PasskeyPrincipal` | Creates the passkey (WebAuthn with the PRF extension requested, or a WebCrypto key with `software: true`), deploys its `PasskeyAccount` with `signer`, persists the principal |
| `createKey(opts)` | `PasskeySigner` | Key only, no transaction. For relayer-deployed accounts: send `publicKey` to your server, then `attach` |
| `deployAccount(signer, payer?)` | `Address` | Deploys a `PasskeyAccount` for an existing key |
| `attach(signer, address)` | `PasskeyPrincipal` | Binds a key to an already-deployed account; verifies the onchain public key matches |
| `save(principal)` / `load()` / `clear()` | | Persistence through the configured `storage` |
| `fromJSON(stored)` | `PasskeyPrincipal` | Rehydrate from `StoredPrincipal` |
| `deploySignerAccount(owner, payer?)` | `Address` | Deploys a `SignerAccount` for a secp256k1 owner (embedded wallet, EOA, ERC-1271 contract) |
| `attachSigner({ address, owner, signTypedData })` | `SignerPrincipal` | Binds a deployed `SignerAccount` to whatever signs EIP-712 for its owner |

A `Principal` is either `{ kind: "webauthn" \| "software", address, publicKey, credentialId?, signChallenge(hex) }` or
`{ kind: "signer", address, owner, signTypedData(td) }`.

## `client.mandate`

| Call | Returns | Notes |
|---|---|---|
| `build(params)` | `MandateDraft` | Pure. Flattens `targets: [{ address, selectors }]` into the onchain parallel arrays; refuses the protocol's own contracts as targets |
| `sign(draft, principal)` | `SignedMandate` | Reads the principal's registry nonce, computes `hash` and the EIP-712 `digest`, signs with the principal |
| `grant(signed, { signer? })` | `TxResult` | Sends `MandateRegistry.grant`. `signed.hash` is the mandate hash |
| `revoke(hash, principal, { signer? })` | `TxResult` | Passkey- or EIP-712-authorised revoke through the account; effective in the block it lands |
| `revokeDigest(account, hash)` | `Hex` | The digest a passkey must sign to revoke, for relayed flows |
| `revokeWithSignature(account, hash, signature)` | `TxResult` | Relay a pre-signed revoke |
| `get(hash)` | `Mandate` | The stored mandate |
| `state(hash)` | `MandateState` | `spent`, `spentThisBlock`, `remaining`, `remainingThisBlock`, `revoked`, `active`, `breaker` (`Armed`/`Tripped`/`Cooldown`), `drawdownBps` |
| `validate(hash, target, selector, amount)` | `void` | Dry run against `MandateRegistry.validate`; throws the typed error the chain would |

`MandateParams`: `agentId`, `agentKey`, `targets`, `asset?` (default: the demo asset), `spendCap`, `perBlockCap`,
`maxDrawdownBps` (`10000` disables the breaker), `validAfter?`, `validUntil` (Date or unix seconds), `policyHash?`.

## `client.agent`

```ts
const agent = client.agent.load({ mandateHash, executor: Signer });
agent.hash; agent.address;
await agent.mandate();                 // Mandate (cached)
await agent.state();                   // MandateState
await agent.validate({ target, data, amount });   // throws MandateError, sends nothing
await agent.execute({ target, data, amount });    // validate -> simulate -> send -> wait; returns TxResult
```

`amount` is the upper bound on `asset` outflow the call may cause. The executor measures the real outflow and reverts
with `SpendExceedsDeclared` if it is higher.

## `client.reputation`

| Call | Returns |
|---|---|
| `get(agentId)` | `{ agentId, score, trips, executed, pnlBps, window, evidenceHash, attestations, erc8004: { count, value, decimals } }` |
| `history(agentId)` | `Attestation[]` oldest first: `complianceScore`, `tripCount`, `executedCount`, `realisedPnlBps`, `windowStart`, `windowEnd`, `evidenceHash` |

## Typed errors

`MandateError` extends `Error`. `name` is the Solidity custom error name and `args` its decoded arguments, so
`e instanceof MandateError && e.name === "SpendCapExceeded"` narrows. Every revert from the registry, executor,
breaker, accounts, submitter, adapter and CRE receiver is decoded; `decodeMandateError(data)` and
`toMandateError(unknown)` are exported for callers that use viem directly.

`TargetNotAllowed(target, selector)` · `SpendCapExceeded(requested, remaining)` · `PerBlockCapExceeded(requested, remaining)` ·
`MandateExpired(validUntil)` · `MandateNotYetValid(validAfter)` · `MandateRevoked(hash)` · `Tripped(hash)` ·
`NotAgentKey(caller, agentKey)` · `InvalidSignature()` · `InvalidNonce(expected, provided)` · `SpendExceedsDeclared(actual, declared)` ·
`NotAttestor()` · `InvalidScore(score)` · `InvalidWindow(start, end)` · `StaleReport(agentId, windowEnd, last)` and the rest.

## EIP-712 and hashing helpers

`hashMandate(m)`, `mandateDigest(m, chainId, registry)`, `mandateTypedData(m, chainId, registry)`, `revokeTypedData(...)`,
`executeTypedData(...)`, `flattenTargets(targets)`, `toSelector("buy(address,uint256)")`, `MANDATE_TYPEHASH`,
`MANDATE_TYPE_STRING`. The SDK's hash equals `MandateRegistry.hashMandate` byte for byte; the anvil e2e asserts it.

## Addresses and ABIs

`deployments[chainId]`, `addressesFor(chainId)`, `testnetDemo` (demo asset and venue), `MONAD_TESTNET_CHAIN_ID`,
`P256_PRECOMPILE`, and every ABI: `MandateRegistryAbi`, `MandateExecutorAbi`, `RiskBreakerAbi`, `PasskeyAccountAbi`,
`SignerAccountAbi`, `PrivateSubmitterAbi`, `ERC8004ReputationAdapterAbi`, `CREAttestationReceiverAbi`,
`ERC8004IdentityRegistryAbi`, `ERC8004ReputationRegistryAbi`.

## `@ibxlab/mandate/prf`

| Call | Notes |
|---|---|
| `PRF_NAMESPACE.policy(principal, nonce)` / `.agentIdentity(agentId)` | The two namespaces; salt is `sha256(namespace)` |
| `prfSupported()` | `true` / `false` / `null` (browser cannot say) |
| `evaluatePrf({ rpId, credentialId?, namespace })` | One ceremony; returns `{ credentialId, output }` |
| `encryptPolicy({ rpId, credentialId?, principal, nonce, policy })` | `{ vault, policyHash }`; AES-256-GCM under an HKDF key from the namespace's PRF output |
| `decryptPolicy({ rpId, vault })` | `{ policy, policyHash, credentialId }`; throws on the wrong passkey or a tampered vault |
| `deriveAgentIdentity({ rpId, credentialId?, agentId })` | `{ address, account (viem LocalAccount), session, end() }` |
| `policyHashOf(vault)` / `parsePolicyVault(json)` / `policyVaultCanonical(vault)` | Also exported from the main entry for servers |

## `@ibxlab/mandate/privy`

`createPrivyIntegration({ appId, appSecret, authorizationKey, keyQuorumId, chainId, addresses })` returns
`agents.createWallet / account / mirrorMandate / revokeMirror / probe / listWallets / setRevokedPolicy` and
`sessions.embeddedWallet / createScopePolicy / signTypedData / principal`. Pure builders `buildMandatePolicy`,
`revokedPolicyRules` and `buildSessionSignerPolicy` produce the policy JSON without network calls and are unit-tested.
