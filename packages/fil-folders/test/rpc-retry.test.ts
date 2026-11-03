import { describe, expect, it } from "vitest";
import { createPublicClient, custom, RpcRequestError } from "viem";
import { filecoinCalibration } from "viem/chains";
import { isTransientRpcError, retryTransient, withTransientRetry } from "../src/rpc-retry.js";

const glifFuture = () =>
  new RpcRequestError({ body: { method: "eth_getBlockByNumber", params: ["0x40494b", true] }, url: "https://api.calibration.node.glif.io/rpc/v1", error: { code: -32603, message: 'requested a future epoch (beyond "latest")' } });

describe("transient RPC errors", () => {
  it("recognizes glif's future-epoch, header-not-found and null-round errors, not real failures", () => {
    expect(isTransientRpcError(glifFuture())).toBe(true);
    expect(isTransientRpcError(new Error("header not found"))).toBe(true);
    expect(isTransientRpcError(new Error("wrapped", { cause: new Error("requested epoch was a null round") }))).toBe(true);
    expect(isTransientRpcError(new Error("execution reverted"))).toBe(false);
  });

  it("a client whose node lags 3 times still gets the block", async () => {
    let calls = 0;
    const lagging = custom({
      async request({ method }) {
        if (method === "eth_getBlockByNumber" && ++calls <= 3) throw glifFuture();
        if (method === "eth_getBlockByNumber") return { number: "0x40494b", hash: "0x" + "11".repeat(32), timestamp: "0x1", transactions: [], parentHash: "0x" + "00".repeat(32), logsBloom: null, gasLimit: "0x0", gasUsed: "0x0", baseFeePerGas: null };
        throw new Error("unexpected " + method);
      },
    }, { retryCount: 0 });
    const client = createPublicClient({ chain: filecoinCalibration, transport: withTransientRetry(lagging, { sleep: async () => {} }) });
    const block = await client.getBlock({ blockNumber: 0x40494bn, includeTransactions: true });
    expect(block.number).toBe(0x40494bn);
    expect(calls).toBe(4);
  });

  it("gives up after maxWaitMs and does not retry real errors", async () => {
    let n = 0;
    await expect(retryTransient(async () => { n++; throw glifFuture(); }, { maxWaitMs: 3000, sleep: async () => {} })).rejects.toThrow(/future epoch/);
    expect(n).toBeGreaterThan(1);
    n = 0;
    await expect(retryTransient(async () => { n++; throw new Error("execution reverted"); }, { sleep: async () => {} })).rejects.toThrow(/reverted/);
    expect(n).toBe(1);
  });
});

import { makeVolume, text } from "./helpers.js";
describe("volume commit on a lagging node", () => {
  it("waits out a future-epoch commit error and still saves", async () => {
    const { volume, registry } = (await makeVolume()) as any;
    const commit = registry.commit.bind(registry);
    let fails = 1;
    registry.commit = async (input: unknown) => { if (fails-- > 0) throw glifFuture(); return commit(input); };
    await volume.put("/a.txt", text("hi"));
    expect(fails).toBe(-1);
  }, 10_000);
});
