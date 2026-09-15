/**
 * Real-browser proof of the passkey path. Drives the reference app in Chrome with a CDP virtual
 * authenticator (CTAP2, internal transport, user verification on), so navigator.credentials.create/get
 * run for real and every signature is verified on-chain through the P256 precompile.
 *
 *   APP_URL=http://localhost:8787 node e2e/webauthn.mjs        # server must be running
 */
import { chromium } from "playwright-core";
const URL = process.env.APP_URL ?? "http://localhost:8787";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const body = () => page.locator("body").innerText();
const shot = (n) => page.screenshot({ path: `e2e/shot-${n}.png`, fullPage: true });
const waitText = async (re, timeout = 120_000) => {
  try { await page.waitForFunction((s) => new RegExp(s, "i").test(document.body.innerText), re.source, { timeout }); }
  catch (e) { console.log("UI error text:", JSON.stringify((await body()).match(/Something failed[^\n]*|Grant failed[^\n]*/g))); await shot("fail"); throw e; }
};
const agentIdOnPage = async () => (await body()).match(/ERC-8004 #(\d+)/)?.[1] ?? null;

await page.goto(URL);
await page.waitForSelector("text=Create passkey & account");
await shot("onboard");
// 1. Passkey: real WebAuthn create
const cb = page.locator("input[type=checkbox]");
if (await cb.isChecked()) await cb.uncheck();
await page.click("text=Create passkey & account");
await waitText(/owned by your passkey/, 180_000);
const address = (await body()).match(/0x[0-9a-fA-F]{8}…[0-9a-fA-F]{8}/)?.[0];
const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
lap(`WebAuthn passkey created in Chrome (${creds.credentials.length} credential, rpId=${creds.credentials[0]?.rpId}); account ${address}`);
await page.click("text=Approve venue with passkey");
await waitText(/Venue approved/, 180_000);
lap("owner tx (approve) signed by WebAuthn assertion");
await shot("onboard-done");
// 2. Grant
await page.click("text=Next: grant a mandate");
await page.waitForSelector("text=Mandate terms");
const before = await agentIdOnPage();
await page.click(before ? "text=provision another" : "text=Provision agent");
await page.waitForFunction((b) => { const m = document.body.innerText.match(/ERC-8004 #(\d+)/); return !!m && m[1] !== b; }, before, { timeout: 180_000 });
const agentId = await agentIdOnPage();
lap(`agent provisioned #${agentId}`);
await page.click("text=Sign with passkey & grant");
await waitText(/Mandate granted/, 120_000);
const mandateHash = (await body()).match(/0x[0-9a-f]{64}/)[0];
lap(`mandate granted ${mandateHash.slice(0, 12)} (EIP-712 digest signed via WebAuthn)`);
await shot("grant");
// 3. Agent
await page.click("text=Run the agent");
await page.getByRole("button", { name: "Run", exact: true }).click();
await waitText(/buy \d/, 90_000);
lap("first execution in feed");
await waitText(/Frozen by Tripped|Lifetime spend cap reached/, 300_000);
await page.waitForTimeout(1500);
lap(`agent outcome: ${(await body()).match(/Frozen by Tripped|Lifetime spend cap reached/)?.[0]}`);
await shot("agent");
if (/privy wallet policy/i.test(await body())) {
  await page.click("text=Test the policy");
  await waitText(/Refused by Privy/, 60_000);
  lap("Privy custody: policy card shown; probe refused by Privy (policy_violation)");
  await shot("agent-privy");
}
await page.click("text=Force out-of-bounds call");
await waitText(/Blocked before sending/, 60_000);
lap("out-of-bounds: " + ((await body()).match(/TargetNotAllowed\([^)]*\)/)?.[0] ?? "blocked"));
await page.click("text=Revoke with passkey");
await waitText(/Mandate revoked/, 120_000);
lap("revoked via WebAuthn assertion");
// 4. Reputation
await page.click("text=Reputation");
await page.click("text=demo agent #1831");
await waitText(/mirrored to ERC-8004/, 60_000);
lap("reputation: agent #1831 mirrored to ERC-8004");
await shot("reputation");
await browser.close();
console.log("BROWSER WEBAUTHN FLOW OK", JSON.stringify({ address, agentId, mandateHash }));
