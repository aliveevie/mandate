import { slice, type Address, type Hex } from "viem";
import { MandateExecutorAbi } from "./abi/generated.js";
import { mandateErrorsAbi, MandateError, rethrowTyped } from "./errors.js";
import type { MandateModule } from "./mandate.js";
import { resolveWallet, waitTx } from "./signer.js";
import type { Mandate, MandateAddresses, MandatePublicClient, MandateState, Signer, TxResult } from "./types.js";

export interface AgentLoadOptions {
  mandateHash: Hex;
  /** The agent's executing key (must equal `mandate.agentKey`). */
  executor: Signer;
}

export interface ExecuteParams {
  target: Address;
  data: Hex;
  /** Upper bound on `asset` outflow this call may cause. The chain measures the real outflow. */
  amount: bigint;
}

export interface AgentModuleDeps {
  publicClient: MandatePublicClient;
  addresses: MandateAddresses;
  mandates: MandateModule;
  rpcUrl?: string;
}

export function createAgentModule(deps: AgentModuleDeps) {
  return {
    /** Bind an executing key to a mandate. Lazy: nothing is fetched until first use. */
    load(opts: AgentLoadOptions) {
      const wallet = resolveWallet(opts.executor, deps.publicClient, deps.rpcUrl);
      let cached: Promise<Mandate> | undefined;
      const mandate = () => (cached ??= deps.mandates.get(opts.mandateHash));

      /** Throws the typed MandateError the chain would revert with, without sending anything. */
      const validate = async (p: ExecuteParams): Promise<void> => {
        const m = await mandate();
        if (m.agentKey.toLowerCase() !== wallet.account.address.toLowerCase()) {
          throw new MandateError("NotAgentKey", [wallet.account.address, m.agentKey]);
        }
        const selector = p.data.length >= 10 ? slice(p.data, 0, 4) : "0x00000000";
        await deps.mandates.validate(opts.mandateHash, p.target, selector, p.amount);
      };

      return {
        hash: opts.mandateHash,
        address: wallet.account.address,
        mandate,
        state: (): Promise<MandateState> => deps.mandates.state(opts.mandateHash),
        validate,

        /**
         * Execute within the mandate. Order: typed pre-check (registry.validate) -> full simulation
         * (catches venue reverts and breaker trips) -> send -> wait. Protocol reverts surface as MandateError.
         */
        async execute(p: ExecuteParams): Promise<TxResult> {
          await validate(p);
          return rethrowTyped(async () => {
            const { request } = await deps.publicClient.simulateContract({
              address: deps.addresses.executor,
              abi: [...MandateExecutorAbi, ...mandateErrorsAbi] as unknown as typeof MandateExecutorAbi,
              functionName: "execute",
              args: [opts.mandateHash, p.target, p.data, p.amount],
              account: wallet.account,
            });
            return waitTx(deps.publicClient, await wallet.writeContract(request));
          });
        },
      };
    },
  };
}

export type AgentModule = ReturnType<typeof createAgentModule>;
export type Agent = ReturnType<AgentModule["load"]>;
