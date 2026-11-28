import { afterEach, describe, expect, it, vi } from "vitest";
import { createWalletClient } from "viem";
import { filecoinCalibration } from "viem/chains";
import { isWalletMethod, walletWithPublicReads } from "../src/split-transport.js";

afterEach(() => vi.unstubAllGlobals());

describe("wallet transport with public reads (MetaMask -32603 regression)", () => {
  it("chain reads skip the wallet, so a wallet that answers -32603 cannot stall onboarding", async () => {
    const walletCalls: string[] = [];
    const wallet = {
      request: async ({ method }: { method: string }) => {
        walletCalls.push(method);
        if (method === "eth_accounts") return ["0x0000000000000000000000000000000000000001"];
        throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603, data: {} });
      },
    };
    const rpcCalls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      rpcCalls.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" + "00".repeat(31) + "2a" }), { headers: { "content-type": "application/json" } });
    });
    const client = createWalletClient({ account: "0x0000000000000000000000000000000000000001", chain: filecoinCalibration, transport: walletWithPublicReads(wallet, "https://rpc.test/") });
    const out = await client.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000002", data: "0x" }, "latest"] } as never);
    expect(out).toMatch(/2a$/);
    expect(rpcCalls).toEqual(["eth_call"]);
    expect(walletCalls).toEqual([]);
    expect(await client.request({ method: "eth_accounts" } as never)).toHaveLength(1);
    expect(walletCalls).toEqual(["eth_accounts"]);
  });

  it("signing and sending still go to the wallet", () => {
    for (const m of ["eth_sendTransaction", "eth_signTypedData_v4", "personal_sign", "eth_requestAccounts", "wallet_switchEthereumChain"]) expect(isWalletMethod(m)).toBe(true);
    for (const m of ["eth_call", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_chainId", "eth_estimateGas"]) expect(isWalletMethod(m)).toBe(false);
  });
});
