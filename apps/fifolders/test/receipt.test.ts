import { describe, expect, it } from "vitest";
import { receiptFromRpc, receiptRpcUrls, waitForReceipt } from "../src/receipt.js";

describe("waitForReceipt", () => {
  it("keeps polling through not-found and null-round errors", async () => {
    let calls = 0;
    const client = {
      async getTransactionReceipt() {
        calls += 1;
        if (calls === 1) throw new Error("Transaction receipt not found");
        if (calls === 2) throw new Error("requested epoch was a null round (4279844)");
        return { status: "success", blockHash: "0xab", blockNumber: 1n, transactionHash: "0x01" } as never;
      },
    };
    expect((await waitForReceipt(client, "0x01", { pollMs: 1 })).status).toBe("success");
    expect(calls).toBe(3);
  });
  it("times out with the last error", async () => {
    const client = { getTransactionReceipt: async () => { throw new Error("not found"); } };
    await expect(waitForReceipt(client, "0x02", { pollMs: 1, timeoutMs: 5 })).rejects.toThrow(/timed out.*not found/);
  });
  it("finds a successful receipt via eth_getBlockReceipts when getTransactionReceipt lags", async () => {
    const hash = "0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca";
    const client = { getTransactionReceipt: async () => { throw new Error("not found"); } };
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({ result: null }));
      if (body.method === "eth_getBlockReceipts") {
        return new Response(JSON.stringify({
          result: [{
            transactionHash: hash,
            blockHash: "0x" + "ab".repeat(32),
            blockNumber: "0x10",
            status: "0x1",
            from: "0x" + "11".repeat(20),
            to: "0x" + "22".repeat(20),
            gasUsed: "0x1",
            cumulativeGasUsed: "0x1",
            effectiveGasPrice: "0x1",
            logs: [],
            logsBloom: "0x",
            type: "0x2",
            transactionIndex: "0x0",
          }],
        }));
      }
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;
    const receipt = await waitForReceipt(client, hash, { pollMs: 1, rpcUrls: ["https://rpc.example/rpc/v1"], fetch: fetchMock });
    expect(receipt.status).toBe("success");
    expect(receipt.blockNumber).toBe(16n);
    expect(receipt.transactionHash).toBe(hash);
  });
  it("returns reverted when block receipts report status 0x0", async () => {
    const hash = "0xdefdefdefdefdefdefdefdefdefdefdefdefdefdefdefdefdefdefdefdefdef0";
    const client = { getTransactionReceipt: async () => { throw new Error("not found"); } };
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "eth_getBlockReceipts") {
        return new Response(JSON.stringify({
          result: [{ transactionHash: hash, blockHash: "0x" + "cd".repeat(32), blockNumber: "0x11", status: "0x0", gasUsed: "0x1", cumulativeGasUsed: "0x1", logs: [], type: "0x2", transactionIndex: "0x0" }],
        }));
      }
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;
    const receipt = await waitForReceipt(client, hash, { pollMs: 1, rpcUrls: ["https://rpc.example/rpc/v1"], fetch: fetchMock });
    expect(receipt.status).toBe("reverted");
  });

  it("finds a receipt on latest-1 when latest has already moved on", async () => {
    const hash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const client = { getTransactionReceipt: async () => { throw new Error("not found"); } };
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown[] };
      if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x12" }));
      if (body.method === "eth_getBlockReceipts" && body.params?.[0] === "0x11") {
        return new Response(JSON.stringify({
          result: [{ transactionHash: hash, blockHash: "0x" + "ef".repeat(32), blockNumber: "0x11", status: "0x1", gasUsed: "0x1", cumulativeGasUsed: "0x1", logs: [], type: "0x2", transactionIndex: "0x0" }],
        }));
      }
      if (body.method === "eth_getBlockReceipts") return new Response(JSON.stringify({ result: [] }));
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;
    const receipt = await waitForReceipt(client, hash, { pollMs: 1, rpcUrls: ["https://rpc.example/rpc/v1"], fetch: fetchMock });
    expect(receipt.status).toBe("success");
    expect(receipt.blockNumber).toBe(17n);
  });

  it("returns a fast RPC hit without waiting for a slow second endpoint", async () => {
    const hash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const client = { getTransactionReceipt: async () => { throw new Error("not found"); } };
    let slowStarted = 0;
    let slowFinished = 0;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (href.includes("slow.example") && body.method === "eth_getTransactionReceipt") {
        slowStarted += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        slowFinished += 1;
        return new Response(JSON.stringify({ result: null }));
      }
      if (href.includes("fast.example") && body.method === "eth_getBlockReceipts") {
        return new Response(JSON.stringify({
          result: [{ transactionHash: hash, blockHash: "0x" + "aa".repeat(32), blockNumber: "0x20", status: "0x1", gasUsed: "0x1", cumulativeGasUsed: "0x1", logs: [], type: "0x2", transactionIndex: "0x0" }],
        }));
      }
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;
    const t0 = Date.now();
    const receipt = await waitForReceipt(client, hash, {
      pollMs: 1,
      rpcUrls: ["https://fast.example/rpc/v1", "https://slow.example/rpc/v1"],
      fetch: fetchMock,
    });
    const ms = Date.now() - t0;
    expect(receipt.status).toBe("success");
    expect(receipt.blockNumber).toBe(32n);
    expect(ms).toBeLessThan(150);
    expect(slowFinished).toBe(0);
    expect(slowStarted).toBeGreaterThan(0);
  });
});

describe("receiptFromRpc", () => {
  it("maps 0x1 / 0x0 status onto viem success / reverted", () => {
    expect(receiptFromRpc({ transactionHash: "0x1", blockHash: "0x2", blockNumber: "0xa", status: "0x1" }).status).toBe("success");
    expect(receiptFromRpc({ transactionHash: "0x1", blockHash: "0x2", blockNumber: 10, status: "0x0" }).status).toBe("reverted");
    expect(receiptFromRpc({ transactionHash: "0x1", blockHash: "0x2", blockNumber: "10", status: "0x1" }).blockNumber).toBe(10n);
  });
});

describe("receiptRpcUrls", () => {
  it("includes Glif, Ankr and dRPC on Calibration and de-dupes the primary", () => {
    const urls = receiptRpcUrls("calibration", "https://api.calibration.node.glif.io/rpc/v1");
    expect(urls[0]).toContain("glif.io");
    expect(urls.some((url) => url.includes("ankr.com"))).toBe(true);
    expect(urls.some((url) => url.includes("drpc.org"))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
