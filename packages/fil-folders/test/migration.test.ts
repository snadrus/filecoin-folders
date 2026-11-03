import { describe, expect, it } from "vitest";
import { MemoryRegistry, MemoryStorage, createMigratingRegistry, openVolume, namespaceId, volumeKey } from "../src/index.js";
import { manifestBytes } from "../src/codec.js";
import { pieceCidToBytes } from "../src/bytes.js";
import { OWNER, text, decode } from "./helpers.js";

async function legacyHistory(storage: MemoryStorage, legacy: MemoryRegistry) {
  const ns = namespaceId("fil-folders");
  const key = volumeKey("demo");
  let prev: Uint8Array = new Uint8Array();
  const pieces: string[] = [];
  for (const mtime of [1, 2]) {
    // Pre-v2 manifests: raw JSON, no `prev`.
    const { pieceCid } = await storage.put(manifestBytes({ v: 1, mtime, entries: [] }));
    await legacy.commit({ owner: OWNER, ns, key, pieceCid: pieceCidToBytes(pieceCid), prevPieceCid: prev });
    prev = pieceCidToBytes(pieceCid);
    pieces.push(pieceCid);
  }
  return { ns, key, pieces };
}

describe("registry v1 → v2 migration", () => {
  it("reads the v1 head, moves it on the next commit once, and history stays linked", async () => {
    const storage = new MemoryStorage();
    const legacy = new MemoryRegistry(OWNER);
    const current = new MemoryRegistry(OWNER);
    const { ns, key, pieces } = await legacyHistory(storage, legacy);
    const moves: string[] = [];
    const registry = createMigratingRegistry({ current, legacy, wrapMigration: async (info, fn) => (moves.push(info.key), fn()) });
    expect(await registry.needsMigration(OWNER, ns, key)).toBe(true);
    expect(decode((await registry.head(OWNER, ns, key)).pieceCid)).toBe(pieces[1]);

    const volume = await openVolume({ storage, registry, owner: OWNER, name: "demo" });
    await volume.put("/a.txt", text("one"));
    expect(moves).toEqual([key]);
    expect(await registry.needsMigration(OWNER, ns, key)).toBe(false);
    expect((await current.head(OWNER, ns, key)).version).toBe(1n);
    expect((await legacy.head(OWNER, ns, key)).version).toBe(2n); // v1 untouched
    await volume.put("/b.txt", text("two"));
    expect(moves.length).toBe(1);

    const log = await volume.history();
    expect(log.map((e) => e.version)).toEqual([1n, 2n, 3n, 4n]);
    expect(log[0]!.pieceCid).toBe(pieces[0]);
    expect(log[1]!.pieceCid).toBe(pieces[1]);
    expect(log[2]!.prevPieceCid).toBe(pieces[1]);
    expect(log[3]!.prevPieceCid).toBe(log[2]!.pieceCid);
    expect(log.every((e) => e.timestamp > 0)).toBe(true);
    expect((await volume.history("/a.txt")).map((e) => e.change)).toEqual(["added"]);
  });

  it("v2-only volumes walk prev links without a log scan", async () => {
    const storage = new MemoryStorage();
    const current = new MemoryRegistry(OWNER);
    let scans = 0;
    const legacy = new MemoryRegistry(OWNER);
    const spy = Object.assign(Object.create(legacy), { committed: async () => (scans++, []), head: legacy.head.bind(legacy) });
    const registry = createMigratingRegistry({ current, legacy: spy });
    const volume = await openVolume({ storage, registry, owner: OWNER, name: "fresh" });
    await volume.put("/x", text("1"));
    await volume.put("/x", text("2"));
    const log = await volume.history();
    expect(log.map((e) => e.version)).toEqual([1n, 2n]);
    expect(log[0]!.prevPieceCid).toBe("");
    expect(scans).toBe(0);
  });

  it("refuses a fresh v2 commit that would hide an unseen v1 head", async () => {
    const storage = new MemoryStorage();
    const legacy = new MemoryRegistry(OWNER);
    const { ns, key } = await legacyHistory(storage, legacy);
    const registry = createMigratingRegistry({ current: new MemoryRegistry(OWNER), legacy });
    await expect(registry.commit({ owner: OWNER, ns, key, pieceCid: text("x"), prevPieceCid: new Uint8Array() })).rejects.toThrow();
  });
});
