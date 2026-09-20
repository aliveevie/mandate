import { writeFileSync } from "node:fs";
/**
 * One-time Privy setup for a Mandate deployment. Given an app id and secret, generates a P-256 authorization
 * key locally, registers it with Privy as a key quorum, and prints the four env values the server needs.
 *
 *   PRIVY_APP_ID=… PRIVY_APP_SECRET=… node scripts/privy-setup.mjs
 *
 * The private key is printed once and never sent anywhere except as a signature over API requests.
 */
import { PrivyClient, generateP256KeyPair } from "@privy-io/node";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!appId || !appSecret) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");

const privy = new PrivyClient({ appId, appSecret });
const { publicKey, privateKey } = await generateP256KeyPair();
const quorum = await privy.keyQuorums().create({ public_keys: [publicKey], display_name: "mandate-server", authorization_threshold: 1 });

console.log("# Add to apps/server/.env (never commit):");
console.log(`PRIVY_APP_ID=${appId}`);
console.log(`PRIVY_APP_SECRET=${appSecret.slice(0, 6)}… (already in your env; not printed)`);
writeFileSync(".privy-authorization-key.env", `PRIVY_AUTHORIZATION_KEY=${privateKey}\n`, { mode: 0o600 });
console.log("PRIVY_AUTHORIZATION_KEY written to .privy-authorization-key.env (gitignored, mode 600); copy it into .env and delete the file");
console.log(`PRIVY_KEY_QUORUM_ID=${quorum.id}`);
console.log(`\n# Public key registered with Privy (key quorum ${quorum.id}):\n# ${publicKey}`);
