/**
 * Reclaim unspent gas from every Privy server wallet owned by our key quorum back to the relayer.
 * Sets each wallet's policy to the revoked (refund-only) rules first when it has one, then transfers.
 *
 *   node scripts/privy-sweep.mjs            # needs the PRIVY_* variables and DEMO_AGENT_DEPLOYER_KEY (refund target)
 */
import { createPrivyIntegration } from "@ibxlab/mandate/privy";
import { addressesFor } from "@ibxlab/mandate";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const env = process.env;
const rpc = env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const refundTo = privateKeyToAccount(env.DEMO_AGENT_DEPLOYER_KEY).address;
const privy = await createPrivyIntegration({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, authorizationKey: env.PRIVY_AUTHORIZATION_KEY, keyQuorumId: env.PRIVY_KEY_QUORUM_ID, chainId: monadTestnet.id, addresses: addressesFor(monadTestnet.id) });
const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc, { batch: true }) });
const wallets = await privy.agents.listWallets();
console.log(`${wallets.length} quorum-owned wallets`);
let total = 0n;
for (const w of wallets) {
  const bal = await pub.getBalance({ address: w.address });
  const fees = await pub.estimateFeesPerGas();
  const cost = 21_000n * (fees.maxFeePerGas ?? 0n);
  if (bal <= cost * 2n) continue;
  for (const policyId of w.policyIds) await privy.agents.setRevokedPolicy({ policyId, refundTo }).catch((e) => console.log(`  policy ${policyId}: ${e.message.slice(0, 80)}`));
  try {
    const wc = createWalletClient({ account: privy.agents.account(w), chain: monadTestnet, transport: http(rpc) });
    const hash = await wc.sendTransaction({ to: refundTo, value: bal - cost, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await pub.waitForTransactionReceipt({ hash });
    total += bal - cost;
    console.log(`  ${w.address} -> refunded ${formatEther(bal - cost)} MON (${hash.slice(0, 12)})`);
  } catch (e) {
    console.log(`  ${w.address}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
  }
}
console.log(`swept ${formatEther(total)} MON to ${refundTo}`);
