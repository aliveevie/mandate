# Quickstart

Ten minutes, Monad testnet, one funded key. You will create a passkey principal, grant a scoped mandate to an agent, watch the agent execute within bounds, see an out-of-bounds call rejected before it is sent, revoke, and read the agent's reputation.

## 0. Prerequisites

- Node 20 or later and `pnpm`
- A Monad testnet key with a little MON from [faucet.monad.xyz](https://faucet.monad.xyz). The same key pays gas and plays the agent.

## 1. Run it

```bash
git clone https://github.com/aliveevie/mandate && cd mandate/sdk
pnpm install
export PRIVATE_KEY=0x...      # your funded testnet key
pnpm quickstart
```

You will see an explorer link for every step:

```
principal account 0xaaa2…d7ba
passkey-signed approve https://testnet.monadexplorer.com/tx/0x0167…
mandate granted 0xb5e1… https://testnet.monadexplorer.com/tx/0xf7cb…
agent executed https://testnet.monadexplorer.com/tx/0xb97c…
spent 100 / cap 500, breaker Armed
typed revert before sending: TargetNotAllowed(0x3eC5…, 0x8679b0c0)
revoked true https://testnet.monadexplorer.com/tx/0xc312…
reputation { score: 100, trips: 0, executed: 0, attestations: 1, erc8004: { count: 1n, value: 100n } }
```

## 2. What the script does, in your own code

```bash
pnpm add @ibxlab/mandate viem
```

```ts
import { createMandateClient, MandateError, testnetDemo } from "@ibxlab/mandate";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const client = createMandateClient({ chain: monadTestnet, signer: privateKeyToAccount(process.env.PRIVATE_KEY) });
```

=== "Principal"

    ```ts
    // Browser: Face ID / Touch ID. Servers and CI: add `software: true`.
    const principal = await client.passkey.create({ rpId: "yourapp.xyz" });

    const draft = client.mandate.build({
      agentId: 1831n,                                   // ERC-8004 id
      agentKey: "0xAgentExecutingKey",
      targets: [{ address: testnetDemo.venue, selectors: ["buy(address,uint256)"] }],
      asset: testnetDemo.asset,
      spendCap: 500n * 10n ** 18n,
      perBlockCap: 300n * 10n ** 18n,
      maxDrawdownBps: 2000,                             // breaker trips at 20% drawdown
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const signed = await client.mandate.sign(draft, principal);   // passkey prompt
    await client.mandate.grant(signed);                           // one transaction
    // later
    await client.mandate.revoke(signed.hash, principal);          // immediate
    ```

=== "Agent"

    ```ts
    const agent = client.agent.load({ mandateHash, executor: agentSigner });
    try {
      await agent.execute({ target, data, amount });   // validate -> simulate -> send
    } catch (e) {
      if (MandateError.is(e, "SpendCapExceeded")) { /* args: [requested, remaining] */ }
      if (MandateError.is(e, "Tripped"))          { /* breaker is engaged */ }
    }
    const state = await agent.state();               // spent, remaining, remainingThisBlock, breaker, active
    ```

=== "Anyone"

    ```ts
    const rep = await client.reputation.get(1831n);
    // { score, trips, executed, pnlBps, window, evidenceHash, attestations, erc8004 }
    ```

## 3. Next

- The full API table and passkey modes are in the [SDK README](https://github.com/aliveevie/mandate/tree/main/sdk#api).
- How the pieces enforce what they enforce: [Concepts](concepts.md).
- Addresses for your own deployment go in `createMandateClient({ addresses })`. Testnet defaults are built in.
