import { describe, expect, it } from "vitest";
import { CALIBRATION_REGISTRY, CALIBRATION_REGISTRY_V2, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID, registryHeadReader } from "../src/view/index.js";
import { saveIdentity } from "../src/edit/index.js";

const OWNER = "0x2222222222222222222222222222222222222222" as const;
function encodeHead(piece: string, version: number): string {
  const hex = Buffer.from(piece).toString("hex");
  const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
  return "0x" + w(64) + w(version) + w(piece.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
}
function fakeFetch(heads: Record<string, string>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const to = JSON.parse(init.body).params[0].to.toLowerCase();
    return { json: async () => ({ result: heads[to] }) };
  }) as never;
}

describe("registry v2 head reader", () => {
  it("falls back to v1 while v2 is empty, then prefers v2", async () => {
    const v1 = { [CALIBRATION_REGISTRY.toLowerCase()]: encodeHead("v1piece", 3) };
    const empty = { ...v1, [CALIBRATION_REGISTRY_V2.toLowerCase()]: encodeHead("", 0) };
    let head = await registryHeadReader("http://rpc", CALIBRATION_REGISTRY, fakeFetch(empty))(OWNER, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID);
    expect(new TextDecoder().decode(head.pieceCid)).toBe("v1piece");
    const moved = { ...v1, [CALIBRATION_REGISTRY_V2.toLowerCase()]: encodeHead("v2piece", 1) };
    head = await registryHeadReader("http://rpc", CALIBRATION_REGISTRY, fakeFetch(moved))(OWNER, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID);
    expect(new TextDecoder().decode(head.pieceCid)).toBe("v2piece");
  });

  it("saveIdentity links the new profile to the previous piece", async () => {
    let stored = "";
    await saveIdentity(
      { v: 1, schema: "fil-identity/profile", address: OWNER, displayName: "A", updatedAt: new Date(0).toISOString() },
      {
        storage: { put: async (b) => ((stored = new TextDecoder().decode(b)), { pieceCid: "new" }) },
        registry: {
          head: async () => ({ pieceCid: new TextEncoder().encode("old"), version: 1n }),
          commit: async (i) => ({ pieceCid: i.pieceCid, version: 2n }),
        },
      },
    );
    expect(JSON.parse(stored).prev).toBe("old");
  });
});
