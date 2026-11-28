import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ipfsSha256, isPrivateHost, PieceUnavailableError, withPieceFallback } from "../src/piece-fallback.js";

const PIECE = "bafkzcibduufqo7cqgtfha3tvyiembv6d5heniakbozj67yq3j6ohfo225imepyy4";
const bytes = new TextEncoder().encode("hello folders");

function base32(b: Uint8Array): string {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, v = 0, out = "";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += A[(v << (5 - bits)) & 31];
  return out;
}
const rawCid = (data: Uint8Array) => "b" + base32(new Uint8Array([1, 0x55, 0x12, 0x20, ...createHash("sha256").update(data).digest()]));

type Route = (url: string) => Promise<Response> | Response;
function fakeFetch(route: Route) {
  const calls: string[] = [];
  const f = (async (input: string) => { calls.push(String(input)); return route(String(input)); }) as unknown as typeof fetch;
  return { f, calls };
}
const never = () => new Promise<Response>(() => {});
const sdkMiss = async () => { throw new Error("SDK: piece not found"); };

describe("piece fallback", () => {
  it("a provider 404 is a definite miss: the next provider answers at once and the 404 one is never asked again", async () => {
    const { f, calls } = fakeFetch((url) => (url.startsWith("https://miss.example") ? new Response("no", { status: 404 }) : new Response(bytes)));
    const fb = withPieceFallback(sdkMiss, { providerUrls: async () => ["https://miss.example/", "https://good.example/"], verify: () => true, fetch: f, timeoutMs: 60_000 });
    const t0 = Date.now();
    expect(await fb.get(PIECE)).toEqual(bytes);
    expect(Date.now() - t0).toBeLessThan(1000);
    await fb.get(PIECE);
    await fb.get(PIECE);
    expect(calls.filter((c) => c.startsWith("https://miss.example"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("https://good.example"))).toHaveLength(3);
  });

  it("skips private/unroutable hosts (no Local Network Access prompt) and marks 502/unreachable providers down", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.startsWith("https://bad502.example")) return new Response("bad gateway", { status: 502 });
      if (url.startsWith("https://unreach.example")) throw new TypeError("Failed to fetch");
      return new Response(bytes);
    });
    const urls = ["http://192.168.1.5:8443/", "http://localhost:3000/", "https://bad502.example:8443/", "https://unreach.example/", "https://good.example/"];
    const fb = withPieceFallback(sdkMiss, { providerUrls: async () => urls, verify: () => true, fetch: f });
    await fb.get(PIECE);
    await fb.get(PIECE.replace(/y4$/, "ya"));
    expect(calls.some((c) => c.includes("192.168") || c.includes("localhost"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("https://bad502.example"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("https://unreach.example"))).toHaveLength(1);
    expect(isPrivateHost("http://10.0.0.1/")).toBe(true);
    expect(isPrivateHost("https://pdp.660688.xyz:8443/")).toBe(false);
  });

  it("bafkrei CIDs fall back to IPFS gateways (sha-256 checked); nothing anywhere is 'unavailable', not an opaque error", async () => {
    const cid = rawCid(bytes);
    expect(ipfsSha256(cid)).not.toBeNull();
    const { f } = fakeFetch((url) => (url.startsWith("https://gw.example") ? new Response(bytes) : new Response("", { status: 404 })));
    const fb = withPieceFallback(sdkMiss, { providerUrls: async () => ["https://p.example/"], verify: () => false, fetch: f, gateways: ["https://gw.example"] });
    expect(await fb.get(cid)).toEqual(bytes);
    const liar = fakeFetch(() => new Response("tampered"));
    const fb2 = withPieceFallback(sdkMiss, { providerUrls: async () => [], verify: () => false, fetch: liar.f, gateways: ["https://gw.example"] });
    await expect(fb2.get(cid)).rejects.toBeInstanceOf(PieceUnavailableError);
    const none = withPieceFallback(sdkMiss, { providerUrls: async () => ["https://p.example/"], verify: () => true, fetch: fakeFetch(() => new Response("", { status: 404 })).f });
    await expect(none.get(PIECE)).rejects.toBeInstanceOf(PieceUnavailableError);
    void never;
  });
});
