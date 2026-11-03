import { describe, expect, it } from "vitest";
import {
  MemoryRegistry,
  buildIdentity,
  cachedIdentity,
  encodeIdentity,
  guestName,
  identityNamespace,
  identityPointerBytes,
  identityProfileKey,
  parseIdentity,
  resolveIdentity,
  writeIdentityCache,
} from "../src/index.js";

const A = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

function kv() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("identity schema", () => {
  it("builds a normalized v1 doc", () => {
    const doc = buildIdentity(A, { displayName: "  Andy \n J ", avatar: { emoji: "🦊🐻", color: "#AABBCC" }, bio: " hi " }, new Date(0));
    expect(doc).toEqual({ v: 1, schema: "fil-identity/profile", address: A.toLowerCase(), displayName: "Andy J", avatar: { emoji: "🦊", color: "#aabbcc" }, bio: "hi", updatedAt: "1970-01-01T00:00:00.000Z" });
  });
  it("requires a display name and address", () => {
    expect(() => buildIdentity(A, { displayName: " " })).toThrow(/required/);
    expect(() => buildIdentity("nope", { displayName: "x" })).toThrow(/wallet/);
  });
  it("round-trips through padded piece bytes and rejects other owners", () => {
    const doc = buildIdentity(A, { displayName: "A" });
    const bytes = encodeIdentity(doc);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(127);
    expect(parseIdentity(bytes, A)).toEqual(doc);
    expect(parseIdentity(bytes, "0x" + "1".repeat(40))).toBeNull();
    expect(parseIdentity("{bad")).toBeNull();
  });
  it("keeps unknown future fields", () => {
    const doc = { ...buildIdentity(A, { displayName: "A" }), contactsRef: "x" };
    expect(parseIdentity(JSON.stringify(doc))?.contactsRef).toBe("x");
  });
});

describe("guestName", () => {
  it("is deterministic and case-insensitive", () => {
    expect(guestName(A)).toBe(guestName(A.toLowerCase()));
    expect(guestName(A)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});

describe("resolveIdentity", () => {
  it("reads chain pointer then piece, caches, and only refetches on pointer change", async () => {
    const registry = new MemoryRegistry(A.toLowerCase() as never);
    const doc = buildIdentity(A, { displayName: "Andy" });
    const pieces = new Map([["bafkzcibpiece1", encodeIdentity(doc)]]);
    await registry.commit({ owner: A.toLowerCase() as never, ns: identityNamespace(), key: identityProfileKey(), pieceCid: identityPointerBytes("bafkzcibpiece1"), prevPieceCid: new Uint8Array() });
    let fetches = 0;
    const cache = kv();
    const opts = { head: registry.head.bind(registry), fetchPiece: async (cid: string) => (fetches++, pieces.get(cid)!), cache };
    const first = await resolveIdentity(A, opts);
    expect(first).toMatchObject({ displayName: "Andy", source: "chain", pieceCid: "bafkzcibpiece1" });
    expect((await resolveIdentity(A, opts)).source).toBe("cache");
    await resolveIdentity(A, { ...opts, force: true });
    expect(fetches).toBe(1);
    expect(cachedIdentity(A, cache).displayName).toBe("Andy");
  });
  it("falls back to guest name with no pointer or on errors", async () => {
    const registry = new MemoryRegistry(A.toLowerCase() as never);
    const none = await resolveIdentity(A, { head: registry.head.bind(registry), fetchPiece: async () => new Uint8Array(), cache: kv() });
    expect(none).toMatchObject({ source: "guest", displayName: guestName(A) });
    const cache = kv();
    writeIdentityCache(A, { identity: buildIdentity(A, { displayName: "Old" }), pieceCid: "p" }, cache, 0);
    const failed = await resolveIdentity(A, { head: async () => { throw new Error("rpc down"); }, fetchPiece: async () => new Uint8Array(), cache });
    expect(failed).toMatchObject({ source: "cache", displayName: "Old" });
  });
});
