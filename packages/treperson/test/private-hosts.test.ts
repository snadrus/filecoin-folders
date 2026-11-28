import { describe, expect, it } from "vitest";
import { fetchPieceFromProviders, isPrivateHost } from "../src/view/resolve.js";

describe("provider piece fetch", () => {
  it("never asks private/loopback hosts (no Local Network Access prompt)", async () => {
    const asked: string[] = [];
    const f = (async (u: URL) => { asked.push(String(u)); return new Response(new Uint8Array([1])); }) as unknown as typeof fetch;
    await fetchPieceFromProviders("bafkzcibx", ["http://127.0.0.1:4720/", "http://localhost/", "http://192.168.0.2/", "https://ok.example/"], () => true, f);
    expect(asked).toEqual(["https://ok.example/piece/bafkzcibx"]);
    expect(isPrivateHost("http://116.182.28.4:12310/")).toBe(false);
  });
});
