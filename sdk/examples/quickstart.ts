/**
 * Mandate quickstart on Monad testnet. Runs in ~2 minutes end to end.
 *
 *   export PRIVATE_KEY=0x...        # any funded testnet key (faucet: https://faucet.monad.xyz). Pays gas, plays the agent.
 *   pnpm quickstart
 *
 * What happens: create a passkey principal -> fund it with demo tokens -> grant a scoped mandate ->
 * the agent executes within bounds -> an out-of-bounds call throws a typed error before sending ->
 * the principal revokes -> read the agent's ERC-8004 reputation.
 */
import "dotenv/config";
import { createWalletClient, encodeFunctionData, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { createMandateClient, MandateError, PasskeyAccountAbi, testnetDemo } from "../src/index.js";
import { erc20Abi, venueAbi } from "../test/demo-abi.js";

const pk = process.env.PRIVATE_KEY as Hex | undefined;
if (!pk) throw new Error("Set PRIVATE_KEY to a funded Monad testnet key");
const me = privateKeyToAccount(pk);
const explorer = (h: string) => `https://testnet.monadexplorer.com/tx/${h}`;

const rpcUrl = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const client = createMandateClient({ chain: monadTestnet, rpcUrl, signer: me }); // `signer` pays gas for principal-side txs
const wallet = client.publicClient;
const w = createWalletClient({ account: me, chain: monadTestnet, transport: http(rpcUrl) });

// 1. Principal: a passkey and its on-chain PasskeyAccount.
//    In a browser drop `software: true` and Face ID / Touch ID takes over.
const principal = (await client.passkey.load()) ?? (await client.passkey.create({ rpId: "quickstart.mandate", software: true }));
console.log("principal account", principal.address);

// 2. Fund the account with demo tokens and let it approve the demo venue (owner action, passkey-signed).
const { asset, venue } = testnetDemo;
await wallet.waitForTransactionReceipt({ hash: await w.writeContract({ address: asset, abi: erc20Abi, functionName: "mint", args: [principal.address, parseEther("1000")] }) });
const call = { target: asset, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [venue, 2n ** 256n - 1n] }) };
const nonce = await wallet.readContract({ address: principal.address, abi: PasskeyAccountAbi, functionName: "nonce" });
const digest = await wallet.readContract({ address: principal.address, abi: PasskeyAccountAbi, functionName: "executeDigest", args: [call, nonce] });
const approveTx = await w.writeContract({ address: principal.address, abi: PasskeyAccountAbi, functionName: "execute", args: [call, await principal.signChallenge(digest)] });
await wallet.waitForTransactionReceipt({ hash: approveTx });
console.log("passkey-signed approve", explorer(approveTx));

// 3. Grant: what the agent may do, how much, how fast, and when the breaker pulls the plug.
const draft = client.mandate.build({
  agentId: testnetDemo.agentId,
  agentKey: me.address,
  targets: [{ address: venue, selectors: ["buy(address,uint256)", "noop()"] }],
  asset,
  spendCap: parseEther("500"),
  perBlockCap: parseEther("300"),
  maxDrawdownBps: 2000,
  validUntil: new Date(Date.now() + 24 * 3600 * 1000),
});
const signed = await client.mandate.sign(draft, principal);
const grant = await client.mandate.grant(signed);
console.log("mandate granted", signed.hash, explorer(grant.hash));

// 4. Agent: execute within bounds.
const agent = client.agent.load({ mandateHash: signed.hash, executor: me });
const amount = parseEther("100");
const exec = await agent.execute({ target: venue, data: encodeFunctionData({ abi: venueAbi, functionName: "buy", args: [asset, amount] }), amount });
console.log("agent executed", explorer(exec.hash));
let state = await agent.state();
console.log(`spent ${formatEther(state.spent)} / cap ${formatEther(state.spent + state.remaining)}, breaker ${state.breaker}`);

// 5. Out of bounds: nothing is sent, you get the exact Solidity error.
try {
  await agent.execute({ target: venue, data: encodeFunctionData({ abi: venueAbi, functionName: "forbidden" }), amount: 0n });
} catch (e) {
  if (MandateError.is(e)) console.log("typed revert before sending:", e.message);
  else throw e;
}

// 6. Revoke with the passkey. Immediate.
const revoke = await client.mandate.revoke(signed.hash, principal);
state = await agent.state();
console.log("revoked", state.revoked, explorer(revoke.hash));

// 7. Reputation: written by the attestor, never by the agent.
const rep = await client.reputation.get(testnetDemo.agentId);
console.log("reputation", { score: rep.score, trips: rep.trips, executed: rep.executed, attestations: rep.attestations, erc8004: rep.erc8004 });
console.log("done");
