import { createWalletClient, http, type Account, type Chain, type Transport, type WalletClient } from "viem";
import type { MandatePublicClient, Signer, TxResult } from "./types.js";

export type ResolvedWallet = WalletClient<Transport, Chain | undefined, Account>;

/** Accept a viem local Account or an existing WalletClient and return a WalletClient with an account. */
export function resolveWallet(signer: Signer | undefined, publicClient: MandatePublicClient, rpcUrl?: string): ResolvedWallet {
  if (!signer) {
    throw new Error("No signer configured. Pass `signer` to createMandateClient or to this call.");
  }
  if ("writeContract" in signer && typeof signer.writeContract === "function") {
    if (!signer.account) throw new Error("WalletClient has no account attached.");
    return signer as ResolvedWallet;
  }
  return createWalletClient({
    account: signer as Account,
    chain: publicClient.chain,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });
}

export async function waitTx(publicClient: MandatePublicClient, hash: `0x${string}`): Promise<TxResult> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted on-chain`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}
