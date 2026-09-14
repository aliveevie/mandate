/**
 * Wallet-mode proof. Injects a minimal EIP-1193 provider into the page that forwards signing to a
 * viem local account on this side (a stand-in for MetaMask), connects it through wagmi, and runs the
 * passkey flow where the WALLET pays gas: account deployment, mint, passkey-signed approve, grant, revoke.
 *
 *   WALLET_KEY=0x… APP_URL=http://localhost:8787 node e2e/wallet.mjs
 */
import { chromium } from "playwright-core";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const URL = process.env.APP_URL ?? "http://localhost:8787";
const key = process.env.WALLET_KEY;
if (!key) throw new Error("WALLET_KEY required (funded Monad testnet key)");
const account = privateKeyToAccount(key);
const rpc = "https://testnet-rpc.monad.xyz";
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
// Node-side handler for the page's provider requests.
await page.exposeFunction("__walletRpc", async (method, params) => {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts": return [account.address];
    case "eth_chainId": return `0x${monadTestnet.id.toString(16)}`;
    case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
    case "eth_sendTransaction": {
      const tx = params[0];
      const hash = await wallet.sendTransaction({
        to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
      return hash;
    }
    case "personal_sign": return account.signMessage({ message: { raw: params[0] } });
    case "eth_signTypedData_v4": { const td = JSON.parse(params[1]); return account.signTypedData({ ...td, primaryType: td.primaryType }); }
    default: return pub.request({ method, params });
  }
});
await context.addInitScript(() => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    request: ({ method, params }) => window.__walletRpc(method, params ?? []),
    on: (e, f) => { (listeners[e] ??= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
});
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const body = () => page.locator("body").innerText();
const waitText = async (re, timeout = 180_000) => {
  try { await page.waitForFunction((s) => new RegExp(s, "i").test(document.body.innerText), re.source, { timeout }); }
  catch (e) { console.log("UI error text:", JSON.stringify((await body()).match(/Something failed[^\n]*|Grant failed[^\n]*/g))); await page.screenshot({ path: "e2e/shot-wallet-fail.png", fullPage: true }); throw e; }
};
const relayerNonceBefore = await pub.getTransactionCount({ address: (await (await fetch(`${URL}/api/config`)).json()).relayer.address });

await page.goto(URL);
await page.click("text=Connect wallet");
await waitText(/Your wallet pays gas/);
lap(`wallet connected: ${account.address} — UI switched to wallet mode`);
const cb = page.locator("input[type=checkbox]"); if (await cb.isChecked()) await cb.uncheck();
await page.click("text=Create passkey & account");
await waitText(/owned by your passkey/);
lap("account deployed + demo tokens minted by the WALLET (two wallet txs)");
await page.click("text=Approve venue with passkey");
await waitText(/Venue approved/);
lap("passkey-signed approve sent by the wallet");
await page.click("text=Next: grant a mandate");
await page.waitForSelector("text=Mandate terms");
const before = (await body()).match(/ERC-8004 #(\d+)/)?.[1] ?? null;
await page.click(before ? "text=provision another" : "text=Provision agent");
await page.waitForFunction((b) => { const m = document.body.innerText.match(/ERC-8004 #(\d+)/); return !!m && m[1] !== b; }, before, { timeout: 180_000 });
await page.click("text=Sign with passkey & grant");
await waitText(/Mandate granted/);
const mandateHash = (await body()).match(/0x[0-9a-f]{64}/)[0];
lap(`mandate granted by the WALLET ${mandateHash.slice(0, 12)}`);
await page.click("text=Run the agent");
await page.getByRole("button", { name: "Run", exact: true }).click();
await waitText(/buy \d/, 90_000);
lap("agent executing (agent key pays its own gas)");
await page.click("text=Revoke with passkey");
await waitText(/Mandate revoked/);
lap("revoked: passkey signed, WALLET paid");
await page.screenshot({ path: "e2e/shot-wallet.png", fullPage: true });

const relayerNonceAfter = await pub.getTransactionCount({ address: (await (await fetch(`${URL}/api/config`)).json()).relayer.address });
lap(`relayer transactions during this run: ${relayerNonceAfter - relayerNonceBefore} (expected: only agent provisioning/funding, none for the principal)`);
await browser.close();
console.log("WALLET MODE FLOW OK", JSON.stringify({ wallet: account.address, mandateHash }));
