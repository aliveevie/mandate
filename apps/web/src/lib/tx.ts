/**
 * Principal-side transactions in two modes:
 *  - Wallet mode: a connected wallet (MetaMask etc.) signs and pays gas. The passkey still authorises.
 *  - Gasless demo mode: the server relays and pays. The passkey still authorises.
 * Same on-chain calls either way; the only difference is who pays.
 */
import { PasskeyAccountAbi, PasskeyAccountBytecode, type SignedMandate } from "@ibxlab/mandate";
import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { api, type PublicConfig } from "./api";

const erc20 = parseAbi(["function mint(address to, uint256 amount)"]);

export interface TxMode {
  kind: "wallet" | "relay";
  label: string;
  payer?: Address;
}

export interface PrincipalTx {
  mode: TxMode;
  deployAccount(publicKey: { x: Hex; y: Hex }): Promise<{ address: Address; txs: Hex[] }>;
  executeOwner(account: Address, call: { target: Address; value: bigint; data: Hex }, signature: Hex): Promise<Hex>;
  grant(signed: SignedMandate): Promise<{ hash: Hex; mandateHash: Hex; policy?: unknown }>;
  revoke(account: Address, mandateHash: Hex, signature: Hex): Promise<Hex>;
}

export function makePrincipalTx(cfg: PublicConfig, publicClient: PublicClient, wallet: WalletClient | undefined): PrincipalTx {
  const walletReady = !!wallet?.account && wallet.chain?.id === cfg.chainId;

  if (walletReady && wallet?.account) {
    const account = wallet.account;
    const chain = wallet.chain;
    const wait = async (hash: Hex) => {
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`Transaction ${hash} reverted`);
      return r;
    };
    return {
      mode: { kind: "wallet", label: "Your wallet pays gas", payer: account.address },
      async deployAccount(publicKey) {
        const h1 = await wallet.deployContract({
          abi: PasskeyAccountAbi, bytecode: PasskeyAccountBytecode as Hex, account, chain,
          args: [publicKey.x, publicKey.y, cfg.addresses.registry as Address, cfg.addresses.executor as Address],
        });
        const r = await wait(h1);
        if (!r.contractAddress) throw new Error("No contract address in receipt");
        const h2 = await wallet.writeContract({ address: cfg.demo.asset, abi: erc20, functionName: "mint", args: [r.contractAddress, BigInt(cfg.demo.mintAmount)], account, chain });
        await wait(h2);
        return { address: r.contractAddress, txs: [h1, h2] };
      },
      async executeOwner(acct, call, signature) {
        const { request } = await publicClient.simulateContract({ address: acct, abi: PasskeyAccountAbi, functionName: "execute", args: [call, signature], account });
        const h = await wallet.writeContract({ ...request, account, chain });
        await wait(h);
        return h;
      },
      async grant(signed) {
        const { request } = await publicClient.simulateContract({
          address: cfg.addresses.registry as Address, abi: (await import("@ibxlab/mandate")).MandateRegistryAbi, functionName: "grant",
          args: [signed.mandate, signed.signature], account,
        });
        const h = await wallet.writeContract({ ...request, account, chain });
        await wait(h);
        return { hash: h, mandateHash: signed.hash };
      },
      async revoke(acct, mandateHash, signature) {
        const { request } = await publicClient.simulateContract({ address: acct, abi: PasskeyAccountAbi, functionName: "revokeMandate", args: [mandateHash, signature], account });
        const h = await wallet.writeContract({ ...request, account, chain });
        await wait(h);
        return h;
      },
    };
  }

  return {
    mode: { kind: "relay", label: "Gasless demo · relayer pays", payer: cfg.relayer.address as Address },
    async deployAccount(publicKey) {
      const out = await api<{ address: Address; mintTx: Hex }>("/api/relay/account", { json: { publicKey } });
      return { address: out.address, txs: [out.mintTx] };
    },
    async executeOwner(account, call, signature) {
      const out = await api<{ hash: Hex }>("/api/relay/execute", { json: { account, call, signature } });
      return out.hash;
    },
    async grant(signed) {
      return api<{ hash: Hex; mandateHash: Hex; policy?: unknown }>("/api/relay/grant", { json: signed });
    },
    async revoke(account, mandateHash, signature) {
      const out = await api<{ hash: Hex }>("/api/relay/revoke", { json: { account, mandateHash, signature } });
      return out.hash;
    },
  };
}
