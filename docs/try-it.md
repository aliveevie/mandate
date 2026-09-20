# Try the reference app

The reference app is a complete client for the protocol on Monad testnet: passkey principal, mandate grant, a demo
agent that trades inside its mandate, the breaker, revocation, reputation, and the Mera PRF cross-device check. It
exists to show every SDK call working against the live deployment. Nothing in it is required to use Mandate.

## Access

- **Live link:** see the repository README for the current deployment URL.
- **No account, no credentials.** The passkey path needs a device with Face ID, Touch ID, Windows Hello or a security key, over HTTPS. There is a "software key" checkbox for browsers without a platform authenticator.
- **Gas:** by default the app runs in gasless mode and its relayer pays. Connect a wallet (MetaMask, Rabby or Phantom on Monad testnet, chain id 10143) to pay your own gas instead; the **Faucet** button in the header opens the Monad faucet.
- **Sign in with Privy** is offered when the deployment has Privy configured: email or Google, an embedded wallet owns the account, and a scoped session signer grants and revokes without prompts.

## A five-minute walk-through

1. **Passkey.** Create the passkey. The app deploys a `PasskeyAccount` owned by it and seeds demo tokens. Approve the demo venue with a passkey-signed owner transaction; the explorer link shows the P256 signature verified through the precompile.
2. **Grant.** Provision an agent (an ERC-8004 identity plus a funded executing key). Press *Own this identity with my passkey*: a key derived from your passkey under the namespace `mandate:agent-id:<n>` becomes the identity's onchain owner. Set the caps, edit the agent's strategy, and sign. The strategy is encrypted to your passkey and the mandate's `policyHash` commits to it.
3. **Agent.** Press *Run*. Watch spend against the cap and the per-block gauge, then the breaker trip on drawdown and freeze the agent. *Force out-of-bounds call* shows the typed revert (`TargetNotAllowed`) the SDK raised before anything was sent. With Privy configured, *Test the policy* shows the wallet policy refusing a call the mandate does not allow. *Revoke with passkey* kills the mandate in the block it lands.
4. **Reputation.** The demo agent's ERC-8004 score, attestation history and evidence hashes, written by the Chainlink CRE workflow.
5. **Cross-device.** On the Passkey screen, *One passkey, many keys* → paste the mandate hash (or open `/?verify=<mandateHash>` in a fresh profile or another device that has the same synced passkey). With nothing but the passkey, the app decrypts the strategy and re-derives the agent identity, and shows it equals the onchain owner.

## What is being exercised

| Step | Onchain | SDK |
|---|---|---|
| Passkey → account | `PasskeyAccount` deployment, P256 verification at `0x100` | `passkey.createKey`, `attach`, `save` |
| Approve venue | owner call through the account with a WebAuthn assertion | `principal.signChallenge`, relay or wallet |
| Grant | `MandateRegistry.grant` with an EIP-712 mandate signed by the passkey | `mandate.build/sign/grant`, `prf.encryptPolicy` |
| Identity claim | ERC-721 transfer of the ERC-8004 identity to a passkey-derived key | `prf.deriveAgentIdentity` |
| Run | `MandateExecutor.execute` with measured spend, breaker checkpoints | `agent.execute` |
| Out of bounds | `MandateRegistry.validate` typed revert, no transaction | `agent.validate` |
| Revoke | `PasskeyAccount.revokeMandate` | `mandate.revoke` |
| Reputation | `ERC8004ReputationAdapter` attestations mirrored to the ERC-8004 registry | `reputation.get/history` |
| Cross-device | `getMandate(policyHash)`, `ownerOf(agentId)` | `prf.decryptPolicy`, `prf.deriveAgentIdentity` |

## Running it yourself

```bash
pnpm install && pnpm --filter @ibxlab/mandate build
cd apps/server && DEMO_AGENT_DEPLOYER_KEY=0x… pnpm dev     # API + agent runner; the key only pays gas
cd apps/web && pnpm dev                                    # http://localhost:5173
```

Automated proofs against a running app: `pnpm --filter server e2e` (whole flow through the API with a software
passkey) and `pnpm --filter web e2e` (real Chrome with a virtual authenticator: WebAuthn create, four PRF ceremonies,
onchain P256 verification, the fresh-device check).
