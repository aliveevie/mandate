/**
 * The agent side of Mandate in one file: load a mandate with the agent's executing key, check state, and execute
 * inside its bounds. Every protocol rule is enforced onchain; the SDK tells you *before* sending which rule a call
 * would break, as a typed `MandateError`.
 *
 *   export AGENT_KEY=0x...          # the mandate's agentKey (funded with a little MON for gas)
 *   export MANDATE_HASH=0x...       # a mandate granted to that key
 *   pnpm example:agent              # add --dry to only validate, never send
 */
import "dotenv/config";
import { encodeFunctionData, formatEther, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { createMandateClient, MandateError, testnetDemo } from "../src/index.js";

const agentKey = process.env.AGENT_KEY as Hex | undefined;
const mandateHash = process.env.MANDATE_HASH as Hex | undefined;
const dry = process.argv.includes("--dry");
if (!agentKey || !mandateHash) {
  console.log("Set AGENT_KEY (the mandate's executing key) and MANDATE_HASH. Run the quickstart first to create both.");
  process.exit(2);
}

const client = createMandateClient({ chain: monadTestnet, rpcUrl: process.env.MONAD_RPC_URL });
const agent = client.agent.load({ mandateHash, executor: privateKeyToAccount(agentKey) });
const venue = parseAbi(["function buy(address token, uint256 amount)", "function forbidden()"]);

// 1. What am I allowed to do? Everything the principal signed is public and readable.
const m = await agent.mandate();
const st = await agent.state();
console.log(`mandate ${mandateHash.slice(0, 12)}… for agent #${m.agentId}`);
console.log(`targets ${m.targets.join(", ")}`);
console.log(`spent ${formatEther(st.spent)} / cap ${formatEther(m.spendCap)}, per block ${formatEther(m.perBlockCap)}, breaker ${st.breaker}, active ${st.active}`);

// 2. A call inside the box. `amount` is the most `asset` this call may move; the executor measures the real outflow.
const buy = { target: testnetDemo.venue as Address, data: encodeFunctionData({ abi: venue, functionName: "buy", args: [testnetDemo.asset as Address, 10n ** 18n] }), amount: 10n ** 18n };
try {
  await agent.validate(buy);
  console.log("buy 1 token: allowed");
  if (!dry) {
    const tx = await agent.execute(buy);
    console.log(`executed https://testnet.monadexplorer.com/tx/${tx.hash}`);
  }
} catch (e) {
  if (e instanceof MandateError) console.log(`buy refused before sending: ${e.name}(${e.args.map(String).join(", ")})`);
  else throw e;
}

// 3. A call outside the box never reaches the chain.
try {
  await agent.validate({ target: testnetDemo.venue as Address, data: encodeFunctionData({ abi: venue, functionName: "forbidden" }), amount: 0n });
  console.log("forbidden(): allowed (unexpected)");
} catch (e) {
  if (e instanceof MandateError) console.log(`forbidden() refused before sending: ${e.name}(${e.args.map(String).join(", ")})`);
  else throw e;
}
