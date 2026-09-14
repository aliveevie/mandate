/**
 * Real-browser proof of the passkey path. Drives the reference app in Chrome with a CDP virtual
 * authenticator (CTAP2, internal transport, user verification on), so navigator.credentials.create/get
 * run for real and every signature is verified on-chain through the P256 precompile.
 *
 *   APP_URL=http://localhost:8787 node e2e/webauthn.mjs        # server must be running (pnpm --filter server start)
 */
import { chromium } from "playwright-core";
const URL = process.env.APP_URL ?? "http://localhost:8787";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const t0 = Date.now(); const lap = (m) => console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s] ${m}`);
const waitText = async (re, timeout = 120_000) => {
  try { await page.waitForFunction((s) => new RegExp(s, "i").test(document.body.innerText), re.source, { timeout }); }
  catch (e) { const errs = await page.locator(".text-rose-200").allInnerTexts(); console.log("UI error notices:", JSON.stringify(errs)); await page.screenshot({ path: "e2e/fail.png", fullPage: true }); throw e; }
};

await page.goto(URL); await page.waitForSelector("text=Create passkey");
// ---- 1. Onboard: real WebAuthn create (the software checkbox is off because PublicKeyCredential exists)
const cb = page.locator('input[type=checkbox]'); if (await cb.isChecked()) await cb.uncheck();
await page.click("text=Create passkey + account");
await waitText(/PasskeyAccount/); await waitText(/kind: webauthn/);
const address = (await page.locator("code").first().innerText()).trim();
lap(`WebAuthn passkey created in Chrome; account ${address}`);
const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
lap(`virtual authenticator holds ${creds.credentials.length} credential(s), rpId=${creds.credentials[0]?.rpId}`);
// ---- approve venue with a WebAuthn assertion
await page.click("text=Approve venue with passkey");
await waitText(/Venue approved by passkey-signed owner tx/, 180_000);
lap("owner tx (approve) signed by WebAuthn assertion and relayed");
// ---- 2. Grant
await page.click("text=Next: grant a mandate");
const before = await page.locator("text=/ERC-8004 #\\d+/").count() ? (await page.locator("text=/ERC-8004 #\\d+/").innerText()).replace(/\D/g, "") : null;
await page.click(before ? "text=Provision another" : "text=Provision agent");
await page.waitForFunction((b) => { const m = document.body.innerText.match(/ERC-8004 #(\d+)/); return m && m[1] !== b; }, before, { timeout: 180_000 });
const agentId = (await page.locator("text=/ERC-8004 #\\d+/").innerText()).match(/#(\d+)/)[1];
lap(`agent provisioned #${agentId}`);
await page.fill('input[value="500"]', "300"); await page.fill('input[value="2000"]', "1500");
await page.click("text=Sign with passkey + grant");
await waitText(/Mandate granted/, 90_000);
const mandateHash = (await page.locator("text=/0x[0-9a-f]{64}/").first().innerText()).trim();
lap(`mandate granted ${mandateHash.slice(0, 12)} (EIP-712 digest signed via WebAuthn)`);
// ---- 3. Agent: run until breaker trips or cap reached
await page.click("text=run the agent");
await page.click("button:has-text('Run')");
await waitText(/executed/, 60_000); lap("first execution in feed");
await waitText(/Frozen by Tripped|Lifetime spend cap reached|Tripped/, 240_000);
const bodyNow = await page.locator("body").innerText();
await page.waitForTimeout(1500); // let the final feed items render
lap(`agent outcome: ${(await body()).match(/Frozen by Tripped|Lifetime spend cap reached/)?.[0]}`);
await page.click("text=Force out-of-bounds call"); await waitText(/Blocked before sending/, 60_000);
lap("out-of-bounds call blocked before sending: " + (await page.locator("text=/Blocked before sending/").innerText()).slice(0, 120));
await page.click("text=Revoke (passkey)"); await waitText(/revoked/, 120_000);
await page.waitForFunction(() => /mandate\s*revoked/i.test(document.body.innerText), null, { timeout: 60_000 });
lap("revoked via WebAuthn assertion");
// ---- 4. Reputation
await page.click("text=Reputation"); await page.click("text=demo agent 1831"); await waitText(/attestation/i, 60_000);
lap("reputation screen: " + (await page.locator("text=/\\d+ attestation/").first().innerText()));
await page.screenshot({ path: "e2e/final.png", fullPage: true });
await browser.close();
console.log("BROWSER WEBAUTHN FLOW OK", JSON.stringify({ address, agentId, mandateHash }));
