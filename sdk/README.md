# @ibxlab/mandate

**Mandate is a delegation and trust primitive for the agent economy on Monad.** Humans issue scoped, revocable, privately-executed *mandates* to ERC-8004 agents from a passkey. Agents accumulate portable onchain reputation for how they honour them. Any app that lets an AI agent touch a wallet integrates Mandate instead of rolling its own session keys.

- **Passkey-rooted.** The principal is a P256 passkey verified on-chain through Monad's RIP-7212 precompile. No seed phrase, no browser wallet.
- **Scoped and enforced on-chain.** Whitelisted targets and selectors, lifetime and per-block spend caps, expiry, and a hysteresis drawdown breaker. Real outflow is measured, not self-reported.
- **Revocable in one block.** The passkey revokes; the agent is frozen in the same block.
- **Typed errors.** Every Solidity custom error surfaces as a `MandateError` with the same name and arguments, and `agent.execute` throws it *before* sending a transaction.
- **Portable reputation.** Compliance is attested by an authorised attestor into the ERC-8004 Reputation Registry. Agents cannot self-attest.

Live on Monad testnet (chain id 10143). Private execution runs in **BTX mode** (Monad's encrypted mempool); a commit-reveal mode ships in the same contract behind the same interface.

## Install

```bash
pnpm add @ibxlab/mandate viem
```

## 10-minute quickstart (Monad testnet)

You need a funded testnet key. Get MON from https://faucet.monad.xyz. One key plays the gas payer and the agent.

```bash
git clone https://github.com/aliveevie/mandate && cd mandate/sdk
pnpm install
export PRIVATE_KEY=0x...      # funded testnet key
pnpm quickstart
```

The script prints an explorer link for each step. This is what it does, and what you would write in your own app:

```ts
import { createMandateClient, MandateError, testnetDemo } from "@ibxlab/mandate";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const client = createMandateClient({ chain: monadTestnet, signer: privateKeyToAccount(process.env.PRIVATE_KEY) });

// Principal side ------------------------------------------------------------
// In a browser this is Face ID / Touch ID. `software: true` uses a WebCrypto key for servers and CI.
const principal = await client.passkey.create({ rpId: "yourapp.xyz" });

const mandate = client.mandate.build({
  agentId: 1831n,                       // ERC-8004 id
  agentKey: "0xAgentExecutingKey",
  targets: [{ address: testnetDemo.venue, selectors: ["buy(address,uint256)"] }],
  asset: testnetDemo.asset,
  spendCap: 500n * 10n ** 18n,          // lifetime
  perBlockCap: 300n * 10n ** 18n,       // per block
  maxDrawdownBps: 2000,                 // breaker trips at 20% drawdown
  validUntil: new Date(Date.now() + 86_400_000),
});
const signed = await client.mandate.sign(mandate, principal);   // passkey prompt
await client.mandate.grant(signed);                            // one tx, anyone can pay gas
// ...later
await client.mandate.revoke(signed.hash, principal);           // immediate

// Agent side ----------------------------------------------------------------
const agent = client.agent.load({ mandateHash: signed.hash, executor: agentSigner });
try {
  await agent.execute({ target, data, amount });   // validate -> simulate -> send
} catch (e) {
  if (MandateError.is(e, "SpendCapExceeded")) { /* [requested, remaining] */ }
  if (MandateError.is(e, "Tripped"))          { /* breaker is engaged      */ }
}
const state = await agent.state();               // spent, remaining, remainingThisBlock, breaker, active

// Anyone --------------------------------------------------------------------
const rep = await client.reputation.get(1831n);  // { score, trips, executed, pnlBps, erc8004 }
```

## API

`createMandateClient({ chain?, rpcUrl?, transport?, signer?, addresses?, storage? })`

| Namespace | Call | Does |
|---|---|---|
| `passkey` | `create({ rpId, software? })` | Creates a passkey, deploys its `PasskeyAccount`, persists the principal |
| | `load()` | Restores the persisted principal |
| | `attach(signer, address)` | Binds an existing passkey to an existing account (another device) |
| `mandate` | `build(params)` | Pure. Flattens `targets` into the on-chain parallel arrays |
| | `sign(draft, principal)` | Fetches the nonce, hashes, signs the EIP-712 digest with the passkey |
| | `grant(signed)` | Sends `MandateRegistry.grant` |
| | `revoke(hash, principal)` | Passkey-authorised revoke through the account |
| | `get(hash)` / `state(hash)` | Stored mandate / spend, caps, breaker phase, liveness |
| | `validate(hash, target, selector, amount)` | Dry run. Throws the typed error the chain would |
| `agent` | `load({ mandateHash, executor })` | Binds the executing key |
| | `agent.execute({ target, data, amount })` | Validate, simulate, send, wait |
| | `agent.validate(...)` / `agent.state()` | Pre-flight and live state |
| `reputation` | `get(agentId)` / `history(agentId)` | Latest attestation plus the ERC-8004 aggregate / full history |

`amount` is the upper bound on `asset` outflow the call may cause. The executor measures the real outflow and reverts with `SpendExceedsDeclared` if it is higher.

### Typed errors

`MandateError.name` is the Solidity error name and `MandateError.args` its decoded arguments:

`TargetNotAllowed(target, selector)` · `SpendCapExceeded(requested, remaining)` · `PerBlockCapExceeded(requested, remaining)` · `MandateExpired(validUntil)` · `MandateNotYetValid(validAfter)` · `MandateRevoked(hash)` · `Tripped(hash)` · `NotAgentKey(caller, agentKey)` · `InvalidSignature()` · `InvalidNonce(expected, provided)` · `SpendExceedsDeclared(actual, declared)` · `NotAttestor()` · `StaleReport(agentId, windowEnd, last)` and the rest of the protocol's errors, including the accounts and the CRE receiver.

### Passkeys

- **Browser:** `client.passkey.create({ rpId })` uses WebAuthn with `userVerification: "required"`. `rpId` must equal the page hostname. Only the public key and credential id are stored; the private key never leaves the authenticator.
- **Servers, CI, quickstart:** `create({ rpId, software: true })` uses a WebCrypto P-256 key and produces the same WebAuthn-shaped assertion, so the on-chain verification path is identical. The key is persisted in the configured `storage` as a JWK. Treat it like any other hot key.

### Addresses

Defaults for Monad testnet are built in (`deployments[10143]`). Pass `addresses` to point at another deployment. All addresses and deployment transaction hashes are in `contracts/deployments/monad-testnet.json`.

## Examples

| Script | What it shows |
|---|---|
| `pnpm quickstart` | The whole protocol in one run: passkey principal, grant, execute, typed refusal, revoke, reputation |
| `pnpm example:agent` | The agent side only: load a mandate with the executing key, read the bounds, execute inside them, watch an out-of-bounds call refused before it is sent (`--dry` never sends) |
| `pnpm example:tool` | Mandate as one tool for any LLM agent loop: the tool schema is generated from the mandate, the handler returns the protocol's typed refusal as the tool result |

## Entry points

- `@ibxlab/mandate` — client, typed errors, EIP-712 helpers, ABIs, addresses, policy-vault helpers.
- `@ibxlab/mandate/prf` — Mera PRF: encrypted policy vaults and per-agent identities from the principal's passkey (browser).
- `@ibxlab/mandate/privy` — Privy server wallets as agent keys, mandate-mirroring wallet policies, session signers (server).

Full signatures: [SDK reference](https://aliveevie.github.io/mandate/sdk-reference/).

## Test

```bash
pnpm test    # starts an Osaka-spec anvil (P256 precompile at 0x100), deploys the protocol, runs the full flow
```

## Security model in one paragraph

The registry, not the agent, enforces caps, whitelist, expiry and revocation. The executor is the only path from an agent to a principal's account, and it measures real asset outflow. The breaker is a permissionless-checkpoint FSM: anyone can record a market-driven trip, only the principal can re-baseline. Reputation is written by one attestor role from on-chain evidence and mirrored into ERC-8004; the adapter rejects everyone else, including the agent and the contract owner. Full threat model: `docs/security.md`.

## License

MIT · IBX Lab
