import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";

export const ANVIL_PORT = 8555;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
/** anvil default account #0 */
export const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
/** anvil default account #1 (agent) */
export const ANVIL_PK_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export interface Fixture {
  registry: Address;
  breaker: Address;
  executor: Address;
  submitter: Address;
  reputationAdapter: Address;
  erc8004Reputation: Address;
  asset: Address;
  venue: Address;
}

const contractsDir = resolve(__dirname, "../../contracts");

export async function startAnvil(): Promise<{ proc: ChildProcess; fixture: Fixture }> {
  // Osaka spec exposes the P256 precompile at 0x100, like Monad.
  const proc = spawn("anvil", ["--hardfork", "osaka", "--port", String(ANVIL_PORT), "--silent", "--block-time", "1"], {
    stdio: "ignore",
  });
  await waitForRpc();
  execSync(
    `forge script script/LocalFixture.s.sol:LocalFixture --rpc-url ${ANVIL_RPC} --private-key ${ANVIL_PK} --broadcast --silent`,
    { cwd: contractsDir, stdio: "pipe" },
  );
  const fixture = JSON.parse(readFileSync(resolve(contractsDir, "deployments/local.json"), "utf8")) as Fixture;
  return { proc, fixture };
}

async function waitForRpc() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(ANVIL_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("anvil did not start");
}
