import { afterEach, describe, expect, it, vi } from "vitest";
import { createWalletClient, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { filecoinCalibration } from "viem/chains";
import { isSponsored, liveRemovalAdapters, retryDatasetLag, sponsoredTransport } from "../src/sponsored.js";
import { EXECUTE_TYPES, executeDomain } from "../src/sponsored-abi.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
const TARGET = "0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443" as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sponsored mode", () => {
  it("is off without VITE_SPONSOR_URL", () => {
    vi.stubEnv("VITE_SPONSOR_URL", "");
    expect(isSponsored()).toBe(false);
    vi.stubEnv("VITE_SPONSOR_URL", "http://sponsor/");
    expect(isSponsored()).toBe(true);
  });

  it("turns a wallet write into a session-key-signed Execute posted to the sponsor", async () => {
    vi.stubEnv("VITE_SPONSOR_URL", "http://sponsor");
    const posted: Record<string, string>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/execute")) {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ hash: `0x${"ab".repeat(32)}` }));
      }
      // Public RPC: account.nonce() -> 7
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${(7).toString(16).padStart(64, "0")}` }));
    }));
    const wallet = createWalletClient({
      account: ACCOUNT,
      chain: filecoinCalibration,
      transport: sponsoredTransport({ rpc: "http://rpc", chainId: 314159, account: ACCOUNT, sessionKey: KEY }),
    });
    const hash = await wallet.sendTransaction({ to: TARGET, data: "0x6d70f843", chain: filecoinCalibration });
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(posted).toHaveLength(1);
    const sent = posted[0]!;
    expect(sent.account).toBe(ACCOUNT);
    expect(sent.nonce).toBe("7");
    const signer = await recoverTypedDataAddress({
      domain: executeDomain(314159, ACCOUNT),
      types: EXECUTE_TYPES,
      primaryType: "Execute",
      message: { target: TARGET, value: 0n, data: "0x6d70f843", nonce: 7n, deadline: BigInt(sent.deadline!) },
      signature: sent.signature as Hex,
    });
    expect(signer).toBe(privateKeyToAccount(KEY).address);
  });

  it("refuses value transfers", async () => {
    const transport = sponsoredTransport({ rpc: "http://rpc", chainId: 314159, account: ACCOUNT, sessionKey: KEY })({ chain: filecoinCalibration });
    await expect(transport.request({ method: "eth_sendTransaction", params: [{ to: TARGET, value: "0x1" }] } as never)).rejects.toThrow(/value/);
  });

  it("retries only the provider's dataset-indexing lag", async () => {
    let calls = 0;
    const lagging = () => (++calls < 3 ? Promise.reject(new Error("Failed to delete piece. Data set not found")) : Promise.resolve("ok"));
    expect(await retryDatasetLag(lagging, { delayMs: 1 })).toBe("ok");
    expect(calls).toBe(3);
    await expect(retryDatasetLag(() => Promise.reject(new Error("boom")), { delayMs: 1 })).rejects.toThrow("boom");
  });

  it("removal adapters match piece ids by CID and submit through the provider", async () => {
    const deleted: bigint[] = [];
    const context = {
      async *getPieces() {
        yield { pieceId: 1n, pieceCid: { toString: () => "bafkA" } };
        yield { pieceId: 2n, pieceCid: { toString: () => "bafkB" } };
      },
      getScheduledRemovals: async () => [5n],
      deletePiece: async ({ piece }: { piece: bigint }) => {
        deleted.push(piece);
        return `0x${"cd".repeat(32)}` as Hex;
      },
    };
    const adapters = liveRemovalAdapters({ context: async () => context, client: {} as never, delayMs: 1 });
    expect(await adapters.listPieceIds("9", "bafkB")).toEqual(["2"]);
    expect([...(await adapters.scheduled("9"))]).toEqual(["5"]);
    expect((await adapters.submit("9", ["2"])).hash).toBe(`0x${"cd".repeat(32)}`);
    expect(deleted).toEqual([2n]);
  });
});
