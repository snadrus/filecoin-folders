import { describe, expect, it, vi } from "vitest";
import { activeProviderUrls, apiList } from "../src/filecoin-api.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("api.filecoin.io reads", () => {
  it("lists active provider URLs from the API across pages without touching the chain", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("cursor=c2")
        ? ok({ data: [{ serviceUrl: "https://b", active: true, pdpProductActive: true }], nextCursor: null })
        : ok({ data: [{ serviceUrl: "https://a", active: true, pdpProductActive: true }, { serviceUrl: "https://x", active: true, pdpProductActive: false }, { serviceUrl: null }], nextCursor: "c2" }),
    ) as unknown as typeof fetch;
    const chainFallback = vi.fn(async () => ["https://chain"]);
    expect(await activeProviderUrls({ network: "calibration", fetchImpl, chainFallback })).toEqual(["https://a", "https://b"]);
    expect(chainFallback).not.toHaveBeenCalled();
    expect(String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toMatch(/^https:\/\/api\.filecoin\.io\/calibration\/providers\?.*active=true/);
  });

  it("falls back to the chain when the API errors, is empty, or the network is unknown", async () => {
    const chainFallback = vi.fn(async () => ["https://chain"]);
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const empty = (async () => ok({ data: [], nextCursor: null })) as unknown as typeof fetch;
    const never = vi.fn() as unknown as typeof fetch;
    expect(await activeProviderUrls({ network: "mainnet", fetchImpl: down, chainFallback })).toEqual(["https://chain"]);
    expect(await activeProviderUrls({ network: "mainnet", fetchImpl: empty, chainFallback })).toEqual(["https://chain"]);
    expect(await activeProviderUrls({ network: "devnet", fetchImpl: never, chainFallback })).toEqual(["https://chain"]);
    expect(never).not.toHaveBeenCalled();
  });

  it("rejects malformed pages", async () => {
    await expect(apiList("/calibration/providers", {}, (async () => ok({ nope: 1 })) as unknown as typeof fetch)).rejects.toThrow();
  });
});
