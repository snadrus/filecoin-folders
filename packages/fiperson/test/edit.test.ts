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
  it("labels profile pieces with Filecoin Drive metadata (label, path, version)", async () => {
    const registry = memRegistry();
    const seen: (Record<string, string> | undefined)[] = [];
    const storage = { put: async (_b: Uint8Array, o?: { metadata?: Record<string, string> }) => (seen.push(o?.metadata), { pieceCid: "p" + seen.length }) };
    await saveIdentity(buildIdentity(A, { displayName: "A" }), { storage, registry });
    await saveIdentity(buildIdentity(A, { displayName: "B" }), { storage, registry });
    expect(seen).toEqual([
      { label: "profile.json", path: "FiPerson", version: "1" },
      { label: "profile.json", path: "FiPerson", version: "2" },
    ]);
  });
  it("storage gate never pays: blocks without payments or dataset", () => {
    expect(() => assertStorageReady({ funds: 0n, approved: true, datasetId: 1n })).toThrow(IdentityBlocked);
    expect(() => assertStorageReady({ funds: 1n, approved: true, datasetId: null })).toThrow(/dataset/);
    expect(() => assertStorageReady({ funds: 1n, approved: true, datasetId: 1n })).not.toThrow();
  });
});

describe("identity pointer commit: stale version", () => {
  it("re-reads the head and retries once on a CAS conflict", async () => {
    const registry = memRegistry();
    let stale = true;
    const realHead = registry.head.bind(registry);
    registry.head = async (o, n, k) => (stale ? { pieceCid: new Uint8Array(), version: 0n } : realHead(o, n, k));
    // The first head read is stale (lagging RPC) and an overlapping save lands first.
    const realCommit = registry.commit.bind(registry);
    let commits = 0;
    registry.commit = async (input) => {
      commits++;
      if (commits === 1) {
        stale = false;
        await realCommit({ ...input, pieceCid: new TextEncoder().encode("other") }); // overlapping save lands first
        throw Object.assign(new Error("registry compare-and-swap conflict at version 1"), { name: "RegistryCasConflict" });
      }
      return realCommit(input);
    };
    const storage = { put: async () => ({ pieceCid: "mine" }) };
    const steps: string[] = [];
    const saved = await saveIdentity(buildIdentity(A, { displayName: "Andy" }), { storage, registry, retryDelayMs: 0, onStep: (s) => steps.push(s) });
    expect(saved).toMatchObject({ pieceCid: "mine", version: "2" });
    expect(commits).toBe(2);
    expect(steps.some((s) => /latest version/.test(s))).toBe(true);
  });
  it("does not retry other errors, and retries only once", async () => {
    const registry = memRegistry();
    let n = 0;
    registry.commit = async () => {
      n++;
      throw new Error("CasConflict(0x, 3)");
    };
    await expect(saveIdentity(buildIdentity(A, { displayName: "A" }), { storage: { put: async () => ({ pieceCid: "p" }) }, registry, retryDelayMs: 0 })).rejects.toThrow(/CasConflict/);
    expect(n).toBe(2);
    registry.commit = async () => {
      n++;
      throw new Error("user rejected");
    };
    n = 0;
    await expect(saveIdentity(buildIdentity(A, { displayName: "A" }), { storage: { put: async () => ({ pieceCid: "p" }) }, registry, retryDelayMs: 0 })).rejects.toThrow(/rejected/);
    expect(n).toBe(1);
  });
});
