/**
 * Mandate as a tool for any LLM agent loop. The tool exposes exactly one capability, "execute_under_mandate", whose
 * schema tells the model what the mandate allows and whose handler refuses anything the mandate does not, with the
 * protocol's typed error as the tool result. Framework-agnostic: plug `tool.definition` into any tool-calling
 * API (Anthropic, OpenAI-style, LangChain, Vercel AI SDK) and route calls to `tool.handler`.
 *
 *   export AGENT_KEY=0x... MANDATE_HASH=0x...
 *   pnpm example:tool                 # runs two sample tool calls, one allowed and one refused
 */
import "dotenv/config";
import { encodeFunctionData, formatEther, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { createMandateClient, MandateError, testnetDemo, type Agent } from "../src/index.js";

const venue = parseAbi(["function buy(address token, uint256 amount)", "function noop()", "function forbidden()"]);

export interface ToolCall {
  /** Function on the venue the agent wants to call. */
  action: "buy" | "noop" | "forbidden";
  /** Whole tokens to buy (ignored for other actions). */
  amountTokens?: number;
  /** Dry run: validate only, never send. */
  dryRun?: boolean;
}

/** Build the tool from a loaded agent. The definition is derived from the mandate itself, so the model sees the real limits. */
export async function mandateTool(agent: Agent) {
  const m = await agent.mandate();
  const definition = {
    name: "execute_under_mandate",
    description:
      `Execute one call on the venue ${m.targets[0]} under mandate ${agent.hash.slice(0, 10)}… granted to agent #${m.agentId}. ` +
      `Allowed selectors: ${m.selectors.join(", ")}. Lifetime cap ${formatEther(m.spendCap)} tokens, per-block cap ${formatEther(m.perBlockCap)}, ` +
      `breaker trips at ${Number(m.maxDrawdownBps) / 100}% drawdown, valid until ${new Date(Number(m.validUntil) * 1000).toISOString()}. ` +
      "Calls outside these bounds are refused before they reach the chain; the refusal names the rule.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["buy", "noop", "forbidden"] },
        amountTokens: { type: "number", minimum: 0 },
        dryRun: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  } as const;

  async function handler(call: ToolCall): Promise<{ ok: boolean; result: string }> {
    const amount = BigInt(Math.max(0, Math.floor(call.amountTokens ?? 0))) * 10n ** 18n;
    const data =
      call.action === "buy"
        ? encodeFunctionData({ abi: venue, functionName: "buy", args: [testnetDemo.asset as Address, amount] })
        : encodeFunctionData({ abi: venue, functionName: call.action });
    const p = { target: testnetDemo.venue as Address, data, amount: call.action === "buy" ? amount : 0n };
    try {
      await agent.validate(p);
      if (call.dryRun) return { ok: true, result: `allowed: ${call.action}${call.action === "buy" ? ` ${call.amountTokens} tokens` : ""} (dry run)` };
      const tx = await agent.execute(p);
      const st = await agent.state();
      return { ok: true, result: `executed ${call.action} in tx ${tx.hash}; spent ${formatEther(st.spent)} of ${formatEther(m.spendCap)}; breaker ${st.breaker}` };
    } catch (e) {
      // The protocol's own error, verbatim, is the best possible feedback for the model.
      if (e instanceof MandateError) return { ok: false, result: `refused by mandate: ${e.name}(${e.args.map(String).join(", ")})` };
      throw e;
    }
  }

  return { definition, handler };
}

// ---- demo: two calls the way a model would make them
if (import.meta.url === `file://${process.argv[1]}`) {
  const agentKey = process.env.AGENT_KEY as Hex | undefined;
  const mandateHash = process.env.MANDATE_HASH as Hex | undefined;
  if (!agentKey || !mandateHash) {
    console.log("Set AGENT_KEY and MANDATE_HASH (see the quickstart).");
    process.exit(2);
  }
  const client = createMandateClient({ chain: monadTestnet, rpcUrl: process.env.MONAD_RPC_URL });
  const tool = await mandateTool(client.agent.load({ mandateHash, executor: privateKeyToAccount(agentKey) }));
  console.log("tool definition the model sees:\n" + JSON.stringify(tool.definition, null, 2));
  console.log("\ncall 1:", await tool.handler({ action: "buy", amountTokens: 1, dryRun: true }));
  console.log("call 2:", await tool.handler({ action: "forbidden", dryRun: true }));
}
