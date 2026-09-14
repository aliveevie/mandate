import { createMandateClient, ERC8004IdentityRegistryAbi, PasskeyAccountAbi as AccountAbi } from "@ibxlab/mandate";
import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { addresses, config } from "./config.js";

if (!config.deployerKey) {
  throw new Error("DEMO_AGENT_DEPLOYER_KEY is required: it pays gas for the demo (never a user secret).");
}

export const chain = monadTestnet;
// nonceManager serialises nonces so concurrent relays (several users, agent provisioning) never collide.
export const deployer = privateKeyToAccount(config.deployerKey, { nonceManager });
const transport = http(config.rpcUrl, { batch: true, retryCount: 3, retryDelay: 400 });
export const publicClient = createPublicClient({ chain, transport, batch: { multicall: { wait: 16 } } });
export const deployerWallet = createWalletClient({ account: deployer, chain, transport });
export const mandateAddresses = addresses();
export const sdk = createMandateClient({ chain, rpcUrl: config.rpcUrl, signer: deployer, addresses: mandateAddresses });

export const erc20Abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export async function wait(hash: Hex) {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return r;
}

/** Deploy a PasskeyAccount for a browser-created passkey and seed it with demo tokens. */
export async function deployAccount(publicKey: { x: Hex; y: Hex }): Promise<{ address: Address; mintTx: Hex }> {
  const address = await sdk.passkey.deployAccount({ kind: "webauthn", publicKey, signChallenge: async () => "0x" });
  const mintTx = await deployerWallet.writeContract({
    address: config.demo.asset,
    abi: erc20Abi,
    functionName: "mint",
    args: [address, config.demo.mintAmount],
  });
  await wait(mintTx);
  return { address, mintTx };
}

/** Relay an owner call the passkey already authorised (e.g. approve the demo venue). */
export async function relayExecute(account: Address, call: { target: Address; value: bigint; data: Hex }, signature: Hex) {
  const { request } = await publicClient.simulateContract({
    address: account,
    abi: AccountAbi,
    functionName: "execute",
    args: [call, signature],
    account: deployer,
  });
  const hash = await deployerWallet.writeContract(request);
  await wait(hash);
  return hash;
}

/** Register a fresh ERC-8004 identity owned by the deployer; returns the agentId from the Transfer log. */
export async function registerAgentIdentity(agentURI: string): Promise<{ agentId: bigint; tx: Hex }> {
  const identity = mandateAddresses.erc8004Identity;
  if (!identity) throw new Error("No ERC-8004 identity registry configured for this chain");
  const hash = await deployerWallet.writeContract({
    address: identity,
    abi: ERC8004IdentityRegistryAbi,
    functionName: "register",
    args: [agentURI],
  });
  const receipt = await wait(hash);
  const transfer = parseEventLogs({
    abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]),
    logs: receipt.logs,
  })[0];
  if (!transfer) throw new Error("ERC-8004 register emitted no Transfer");
  return { agentId: transfer.args.tokenId, tx: hash };
}

export const explorerTx = (h: string) => `https://testnet.monadexplorer.com/tx/${h}`;
