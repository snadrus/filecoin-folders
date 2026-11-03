import { describe, expect, it } from "vitest";
import { IDENTITY_INTENTS, IdentityBlocked, assertStorageReady, buildIdentity, encodeIdentity, parseIdentity, resolveIdentity, saveIdentity, type PointerRegistry } from "../src/edit/index.js";

const A = "0x1111111111111111111111111111111111111111";

function memRegistry(): PointerRegistry & { heads: Map<string, { pieceCid: Uint8Array; version: bigint }> } {
  const heads = new Map<string, { pieceCid: Uint8Array; version: bigint }>();
  const id = (o: string, n: string, k: string) => `${o.toLowerCase()}|${n}|${k}`;
  return {
    heads,
    async head(o, n, k) {
      return heads.get(id(o, n, k)) ?? { pieceCid: new Uint8Array(), version: 0n };
    },
    async commit(input) {
      const cur = heads.get(id(input.owner, input.ns, input.key)) ?? { pieceCid: new Uint8Array(), version: 0n };
      if (new TextDecoder().decode(cur.pieceCid) !== new TextDecoder().decode(input.prevPieceCid)) throw new Error("cas");
      const next = { pieceCid: input.pieceCid, version: cur.version + 1n };
      heads.set(id(input.owner, input.ns, input.key), next);
      return next;
    },
  };
}

describe("edit", () => {
  it("encodes padded, saves piece + pointer with labeled intents, and view resolves it", async () => {
    const doc = buildIdentity(A, { displayName: "Andy" });
    expect(encodeIdentity(doc).byteLength).toBeGreaterThanOrEqual(127);
    const pieces = new Map<string, Uint8Array>();
    const registry = memRegistry();
    const intents: string[] = [];
    const storage = { put: async (b: Uint8Array) => (pieces.set("p" + pieces.size, b), { pieceCid: "p" + (pieces.size - 1) }) };
    const withIntent = async <T,>(i: { title: string }, fn: () => Promise<T>) => (intents.push(i.title), fn());
    expect(await saveIdentity(doc, { storage, registry, withIntent })).toMatchObject({ pieceCid: "p0", version: "1" });
    await saveIdentity(buildIdentity(A, { displayName: "Andy 2" }), { storage, registry, withIntent });
    expect(intents).toEqual([IDENTITY_INTENTS.upload.title, IDENTITY_INTENTS.pointer.title, IDENTITY_INTENTS.upload.title, IDENTITY_INTENTS.pointer.title]);
    const got = await resolveIdentity(A, { head: registry.head, fetchPiece: async (c) => pieces.get(c)!, cache: null });
    expect(got.displayName).toBe("Andy 2");
    expect(parseIdentity(pieces.get("p0")!, A)?.displayName).toBe("Andy");
  });
  it("storage gate never pays: blocks without payments or dataset", () => {
    expect(() => assertStorageReady({ funds: 0n, approved: true, datasetId: 1n })).toThrow(IdentityBlocked);
    expect(() => assertStorageReady({ funds: 1n, approved: true, datasetId: null })).toThrow(/dataset/);
    expect(() => assertStorageReady({ funds: 1n, approved: true, datasetId: 1n })).not.toThrow();
  });
});
