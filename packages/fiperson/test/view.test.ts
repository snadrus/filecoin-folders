import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, stringToBytes, toHex } from "viem";
import {
  ADJECTIVES,
  ANIMALS,
  HEAD_SELECTOR,
  IDENTITY_CONTACTS_KEY_ID,
  IDENTITY_NS,
  IDENTITY_PROFILE_KEY_ID,
  avatarColors,
  avatarGlyph,
  cachedIdentity,
  decodeHead,
  guestName,
  identityCacheKey,
  identityUrl,
  initials,
  normalizeIdentity,
  parseIdentity,
  pickDisplayName,
  resolveDisplayName,
  resolveIdentity,
  writeIdentityCache,
} from "../src/view/index.js";

const A = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
function kv() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("guest names (golden: identical to the pre-FiPerson FiPen/FiFolders outputs)", () => {
  it.each([
    ["0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331", "Upbeat Peacock"],
    ["0x0000000000000000000000000000000000000000", "Humble Puffin"],
    ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "Sparkly Raccoon"],
    ["0x2d633437f7E2138B400AF6882bee2d79C81CF401", "Genuine Cricket"],
    ["a1b2c3d4e5f6a1b2c3d4e5f6", "Genuine Frog"],
    ["", "Diligent Puffin"],
  ])("%s -> %s", (seed, name) => expect(guestName(seed)).toBe(name));
  it("word lists are unchanged", () => {
    expect([ADJECTIVES.length, ANIMALS.length, ADJECTIVES[0], ANIMALS.at(-1)]).toEqual([110, 110, "Able", "Zebra"]);
    expect(guestName(A)).toBe(guestName(A.toLowerCase()));
  });
});

describe("constants match keccak", () => {
  it("ns/key ids and head selector", () => {
    expect(IDENTITY_NS).toBe(keccak256(stringToBytes("fil-identity")));
    expect(IDENTITY_PROFILE_KEY_ID).toBe(keccak256(stringToBytes("profile")));
    expect(IDENTITY_CONTACTS_KEY_ID).toBe(keccak256(stringToBytes("contacts")));
    expect(HEAD_SELECTOR).toBe(keccak256(stringToBytes("head(address,bytes32,bytes32)")).slice(2, 10));
  });
  it("decodes head(bytes,uint64) return data", () => {
    const data = encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }], [toHex(stringToBytes("bafkzcib-x")), 7n]);
    const out = decodeHead(data);
    expect(new TextDecoder().decode(out.pieceCid)).toBe("bafkzcib-x");
    expect(out.version).toBe(7n);
    expect(decodeHead(encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }], ["0x", 0n])).pieceCid.length).toBe(0);
  });
});

describe("schema", () => {
  it("normalizes, rejects other owners, keeps unknown fields", () => {
    const doc = normalizeIdentity(A, { displayName: "  Andy \n J ", avatar: { emoji: "🦊🐻", color: "#AABBCC" }, bio: " hi " }, new Date(0));
    expect(doc).toEqual({ v: 1, schema: "fil-identity/profile", address: A.toLowerCase(), displayName: "Andy J", avatar: { emoji: "🦊", color: "#aabbcc" }, bio: "hi", updatedAt: "1970-01-01T00:00:00.000Z" });
    expect(() => normalizeIdentity(A, { displayName: " " })).toThrow(/required/);
    expect(parseIdentity(JSON.stringify(doc), "0x" + "1".repeat(40))).toBeNull();
    expect(parseIdentity({ ...doc, future: 1 })?.future).toBe(1);
    expect(parseIdentity("{bad")).toBeNull();
  });
});

describe("resolve + cache", () => {
  it("chain -> piece, then cache; refetch only on pointer change; guest/cached fallbacks", async () => {
    const doc = normalizeIdentity(A, { displayName: "Andy" });
    let fetches = 0;
    const cache = kv();
    const opts = { head: async () => ({ pieceCid: stringToBytes("p1"), version: 1n }), fetchPiece: async () => (fetches++, stringToBytes(JSON.stringify(doc))), cache };
    expect(await resolveIdentity(A, opts)).toMatchObject({ displayName: "Andy", source: "chain", pieceCid: "p1" });
    expect((await resolveIdentity(A, opts)).source).toBe("cache");
    await resolveIdentity(A, { ...opts, force: true });
    expect(fetches).toBe(1);
    expect(cachedIdentity(A, cache).displayName).toBe("Andy");
    expect(cache.getItem(identityCacheKey(A))).toContain('"pieceCid":"p1"');
    expect(identityCacheKey(A)).toBe("fil-identity:v1:" + A.toLowerCase());
    const none = await resolveIdentity(A, { head: async () => ({ pieceCid: new Uint8Array(), version: 0n }), fetchPiece: async () => new Uint8Array(), cache: kv() });
    expect(none).toMatchObject({ source: "guest", displayName: guestName(A) });
    const old = kv();
    writeIdentityCache(A, { identity: normalizeIdentity(A, { displayName: "Old" }), pieceCid: "p" }, old, 0);
    expect(await resolveIdentity(A, { head: async () => { throw new Error("down"); }, fetchPiece: async () => new Uint8Array(), cache: old })).toMatchObject({ source: "cache", displayName: "Old" });
  });
});

describe("display", () => {
  it("name precedence", () => {
    const wallet = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331";
    expect(pickDisplayName({ identityName: "Id", sessionName: "S", legacyName: "L", wallet })).toBe("Id");
    expect(pickDisplayName({ sessionName: "S", legacyName: "L", wallet })).toBe("S");
    expect(pickDisplayName({ legacyName: "L", wallet })).toBe("L");
    expect(pickDisplayName({ wallet })).toBe("Upbeat Peacock");
    expect(pickDisplayName({ browserId: "a1b2c3d4e5f6a1b2c3d4e5f6" })).toBe("Genuine Frog");
    const local = kv();
    local.setItem("fipen:wallet", wallet.toLowerCase());
    expect(resolveDisplayName(local, kv())).toBe("Upbeat Peacock");
    writeIdentityCache(wallet, { identity: normalizeIdentity(wallet, { displayName: "Andy" }), pieceCid: "p" }, local);
    expect(resolveDisplayName(local, kv())).toBe("Andy");
  });
  it("avatar helpers and identity URL", () => {
    expect(initials(" andy")).toBe("A");
    expect(avatarGlyph({ displayName: "x", avatar: { emoji: "🦊" } })).toBe("🦊");
    expect(avatarColors({})).toEqual({ background: "#e8eaed", color: "#202124" });
    const url = new URL(identityUrl("https://fifolders.scionbase.ai/fipen/?x=1#d"));
    expect([url.pathname, url.searchParams.get("return")]).toEqual(["/identity/", "https://fifolders.scionbase.ai/fipen/?x=1#d"]);
  });
});

import { contrastRatio, pixelAvatar, pixelAvatarSvg, avatarHtml } from "../src/view/index.js";
describe("pixel avatar", () => {
  const seeds = ["0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331", "0x0000000000000000000000000000000000000000", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"];
  it("is mirrored, readable, deterministic, and leaves names unchanged", () => {
    for (const s of seeds) {
      const a = pixelAvatar(s);
      expect(a.pixels).toHaveLength(8);
      for (const row of a.pixels) expect(row).toEqual([...row].reverse());
      expect(contrastRatio(a.fg, a.bg)).toBeGreaterThanOrEqual(4.5);
      expect(pixelAvatar(s.toUpperCase().replace("0X", "0x"))).toEqual(a);
    }
    expect(guestName(seeds[0]!)).toBe("Upbeat Peacock");
  });
  it("golden", () => {
    expect(seeds.map((s) => { const a = pixelAvatar(s); return [a.fg, a.bg, a.pixels.map((r) => r.slice(0, 3).map(Number).join("")).join("/")]; })).toMatchSnapshot();
    expect(pixelAvatarSvg(seeds[0]!, 32)).toContain('shape-rendering="crispEdges"');
    expect(avatarHtml({ address: seeds[0], displayName: "x" })).toContain('data-kind="pixel"');
    expect(avatarHtml({ address: seeds[0], displayName: "x", avatar: { emoji: "🦊" } })).toContain('data-kind="emoji"');
  });
});
