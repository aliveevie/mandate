import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import {
  assayHostKey,
  createInferenceGuard,
  gradeStatus,
  guardAgent,
  hostKeyOf,
  InferenceHostRefused,
  type GradeReader,
  type InferenceGrade,
} from "../src/assay.js";
import type { Agent } from "../src/agent.js";

const VERIFIER: Address = "0x4BaC2Be288B5931886EeC4c555895CE6BcAB19e7";
const NOW = 1_800_000_000n;
const h = (b: string) => `0x${b.repeat(32)}` as Hex;

const grade = (over: Partial<InferenceGrade> = {}): InferenceGrade => ({
  model: h("11"),
  hostKey: h("22"),
  checks: h("33"),
  passed: 32,
  total: 32,
  ciLowBps: 8930,
  ciHighBps: 10000,
  refModel: h("44"),
  evidence: h("55"),
  t: NOW - 60n,
  ...over,
});

/** gradeOf answers per host key; anything else reads as "nobody graded it". */
function reader(byHost: Record<string, InferenceGrade>): GradeReader & { calls: number } {
  const r = {
    calls: 0,
    async readContract({ args }: { args: readonly [Hex, Hex, readonly Address[]] }) {
      r.calls++;
      const g = byHost[args[1]];
      return g ? [g, VERIFIER] : [grade(), zeroAddress];
    },
  };
  return r;
}

describe("host keys", () => {
  // Same vectors as Assay's SDK (sdk/test/hostKey.test.ts) and grader; from `cast keccak "<string>"`.
  it("matches Assay's pinned preimages", () => {
    expect(assayHostKey.agent(10143, 1962)).toBe("0xbc6bc5b79f83de1bb4e63bacbdb8d82c8a38e1c9caa38043f8b6ba33ffb33e6c");
    expect(assayHostKey.openrouter("qwen/qwen3.8-27b:free@chutes")).toBe("0xf684de88c6aa5f740fbbca95bd9c39eff5d015695548bdd967a92ac38d80d1db");
    expect(assayHostKey.direct("generativelanguage.googleapis.com")).toBe("0xd0fe1e8708e22bc3fe3b101f9ab21a41052eb11b27d4d994f91cccca881927c7");
  });

  it("parses spec strings and raw keys, rejects anything else", () => {
    expect(hostKeyOf("erc8004:10143:1962")).toBe(assayHostKey.agent(10143, 1962));
    expect(hostKeyOf(h("ab"))).toBe(h("ab"));
    expect(() => hostKeyOf("deepinfra")).toThrow(/openrouter:<tag>/);
  });
});

describe("gradeStatus", () => {
  it("is unknown without a grade or after 7 days", () => {
    expect(gradeStatus(null, { now: NOW })).toBe("unknown");
    expect(gradeStatus(grade({ t: NOW - 8n * 86400n }), { now: NOW })).toBe("unknown");
  });

  it("without a reference, 0/32 fails and a low lower bound only warns", () => {
    expect(gradeStatus(grade({ passed: 0, total: 32, ciLowBps: 0, ciHighBps: 1072 }), { now: NOW })).toBe("fail");
    expect(gradeStatus(grade({ passed: 28, total: 32, ciLowBps: 7193, ciHighBps: 9504 }), { now: NOW })).toBe("warn");
  });

  it("warns under 30 samples, fails only when clearly below the reference", () => {
    expect(gradeStatus(grade({ passed: 6, total: 6 }), { now: NOW })).toBe("warn");
    expect(gradeStatus(grade({ ciHighBps: 8000 }), { now: NOW, reference: grade({ ciLowBps: 8500 }) })).toBe("fail");
    expect(gradeStatus(grade({ ciHighBps: 9000 }), { now: NOW, reference: grade({ ciLowBps: 8500 }) })).toBe("pass");
  });
});

describe("inference guard", () => {
  const host = "erc8004:10143:1962";
  const opts = (publicClient: GradeReader) => ({ publicClient, model: "z-ai/glm-5.3", host, verifiers: [VERIFIER], now: () => NOW });

  it("allows a host graded pass", async () => {
    const v = await createInferenceGuard(opts(reader({ [hostKeyOf(host)]: grade() }))).assert();
    expect(v).toMatchObject({ status: "pass", by: VERIFIER });
  });

  it("refuses an ungraded or warn host with a typed error", async () => {
    await expect(createInferenceGuard(opts(reader({}))).assert()).rejects.toMatchObject({ name: "InferenceHostRefused", status: "unknown" });
    const warn = reader({ [hostKeyOf(host)]: grade({ total: 6, passed: 6 }) });
    await expect(createInferenceGuard(opts(warn)).assert()).rejects.toBeInstanceOf(InferenceHostRefused);
  });

  it("fails closed when the grade can't be read", async () => {
    const broken: GradeReader = { readContract: async () => { throw new Error("rpc down"); } };
    await expect(createInferenceGuard(opts(broken)).assert()).rejects.toMatchObject({ status: "error" });
  });

  it("needs at least one trusted verifier", () => {
    expect(() => createInferenceGuard({ ...opts(reader({})), verifiers: [] })).toThrow(/verifier/);
  });
});

describe("guardAgent", () => {
  const params = { target: "0x000000000000000000000000000000000000dEaD" as Address, data: "0x" as Hex, amount: 10n };
  const fakeAgent = () => {
    const execute = vi.fn(async () => ({ hash: h("aa") }));
    const validate = vi.fn(async () => {});
    return { agent: { execute, validate } as unknown as Agent, execute, validate };
  };
  const guardFor = (r: GradeReader) => createInferenceGuard({ publicClient: r, model: "z-ai/glm-5.3", host: "openrouter:deepinfra/fp8", verifiers: [VERIFIER], now: () => NOW });

  it("never reaches execute when the host is refused", async () => {
    const { agent, execute } = fakeAgent();
    await expect(guardAgent(agent, guardFor(reader({}))).execute(params)).rejects.toBeInstanceOf(InferenceHostRefused);
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes after a pass, and skips the check for cheap calls", async () => {
    const r = reader({ [assayHostKey.openrouter("deepinfra/fp8")]: grade() });
    const { agent, execute } = fakeAgent();
    await guardAgent(agent, guardFor(r)).execute(params);
    expect(execute).toHaveBeenCalledOnce();

    const empty = reader({});
    await guardAgent(fakeAgent().agent, guardFor(empty), { skip: (p) => p.amount < 100n }).execute(params);
    expect(empty.calls).toBe(0);
  });
});
