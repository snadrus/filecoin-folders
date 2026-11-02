import { describe, expect, it } from "vitest";
import { createViemRegistry, DEFAULT_MAX_BLOCK_RANGE } from "../src/registry/viem.js";

function fakeClient(latest: bigint, logAt: bigint) {
  const ranges: [bigint, bigint][] = [];
  return {
    ranges,
    client: {
      async getBlockNumber() {
        return latest;
      },
      async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
        if (toBlock - fromBlock + 1n > 360n) throw new Error(`block range exceeds maximum of 360 (got ${toBlock - fromBlock})`);
        ranges.push([fromBlock, toBlock]);
        if (logAt < fromBlock || logAt > toBlock) return [];
        return [
          {
            args: {
              owner: "0x0000000000000000000000000000000000000001",
              ns: "0x01",
              key: "0x02",
              pieceCid: "0x0102",
              prevPieceCid: "0x",
              version: 1n,
              timestamp: 5n,
            },
            transactionHash: "0xaa",
            blockNumber: logAt,
          },
        ];
      },
    },
  };
}

describe("Committed log scan", () => {
  it("defaults to 360-block chunks and resumes from the cached last block", async () => {
    expect(DEFAULT_MAX_BLOCK_RANGE).toBe(360n);
    const store = new Map<string, string>();
    const scanCache = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const fake = fakeClient(2999n, 1500n);
    const registry = createViemRegistry({ address: "0x0000000000000000000000000000000000000009", publicClient: fake.client as never, walletClient: {} as never, fromBlock: 1000n, scanCache });
    const query = { owner: "0x0000000000000000000000000000000000000001" as const, ns: "0x01" as const };
    const first = await registry.committed(query);
    expect(first).toHaveLength(1);
    expect(first[0]?.blockNumber).toBe(1500n);
    expect(fake.ranges.every(([a, b]) => b - a + 1n <= 360n)).toBe(true);
    expect(fake.ranges[0]?.[0]).toBe(1000n);
    const again = fakeClient(3100n, 1500n);
    const reloaded = createViemRegistry({ address: "0x0000000000000000000000000000000000000009", publicClient: again.client as never, walletClient: {} as never, fromBlock: 1000n, scanCache });
    const second = await reloaded.committed(query);
    expect(second).toHaveLength(1);
    expect(second[0]?.pieceCid).toEqual(new Uint8Array([1, 2]));
    expect(again.ranges).toEqual([[3000n, 3100n]]);
  });
});
