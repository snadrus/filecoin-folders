import { describe, expect, it } from "vitest";
import {
  MemoryRegistry,
  MemoryStorage,
  bytesToPieceCid,
  contentCid,
  decodeCar,
  encodeCar,
  isCar,
  manifestBytes,
  namespaceId,
  openVolume,
  padPiece,
  pieceCidToBytes,
  unpadPiece,
  volumeKey,
} from "../src/index.js";
import { OWNER, decode, makeVolume, text } from "./helpers.js";

describe("CARv1 bundle", () => {
  it("round-trips a manifest root and file blocks, including byte ranges", async () => {
    const file = text("hello bundle");
    const manifest = text('{"v":1,"entries":[]}');
    const fileCid = await contentCid(file);
    const root = await contentCid(manifest);
    const car = encodeCar(root, new Map([[root, manifest], [fileCid, file]]));
    expect(isCar(car)).toBe(true);
    expect(isCar(manifest)).toBe(false);
    const decoded = decodeCar(car);
    expect(decoded.root).toBe(root);
    expect(decoded.blocks.get(root)).toEqual(manifest);
    expect(decoded.blocks.get(fileCid)).toEqual(file);
    const range = decoded.ranges.get(fileCid);
    expect(range).toBeTruthy();
    expect(car.subarray(range!.offset, range!.offset + range!.length)).toEqual(file);

    const storage = new MemoryStorage();
    const stored = await storage.put(car);
    const slice = await storage.getRange(stored.pieceCid, range!.offset, range!.length);
    expect(slice).toEqual(file);
    expect(decodeCar(await storage.get(stored.pieceCid)).root).toBe(root);
  });

  it("keeps a legacy per-file piece readable beside a new one-piece commit", async () => {
    const storage = new MemoryStorage();
    const registry = new MemoryRegistry(OWNER);
    const legacy = await storage.put(padPiece(text("legacy")));
    const manifest = manifestBytes({
      v: 1,
      mtime: 0,
      entries: [{ name: "old.txt", type: "file", size: 6, mtime: 0, pieceCid: legacy.pieceCid }],
    });
    const head = await storage.put(padPiece(manifest));
    await registry.commit({
      owner: OWNER,
      ns: namespaceId(),
      key: volumeKey("demo"),
      pieceCid: pieceCidToBytes(head.pieceCid),
      prevPieceCid: new Uint8Array(),
    });
    const volume = await openVolume({ storage, registry, owner: OWNER, name: "demo", now: () => 1_700_000_000_000 });
    expect(decode(await volume.get("/old.txt"))).toBe("legacy");

    const before = storage.pieces.size;
    await volume.tx(async (draft) => {
      await draft.put("/new.txt", text("new"));
      await draft.put("/docs/b.txt", text("bee"));
    });
    expect(storage.pieces.size).toBe(before + 1);
    expect(decode(await volume.get("/old.txt"))).toBe("legacy");
    expect(decode(await volume.get("/new.txt"))).toBe("new");
    expect(decode(await volume.get("/docs/b.txt"))).toBe("bee");

    const again = await openVolume({ storage, registry, owner: OWNER, name: "demo", now: () => 1_700_000_000_000 });
    expect(decode(await again.get("/old.txt"))).toBe("legacy");
    expect(decode(await again.get("/docs/b.txt"))).toBe("bee");
  });

  it("stores a new nested file and its manifest entry in one CAR", async () => {
    const { volume, storage, registry } = await makeVolume();
    const body = text('{"v":1,"type":"doc","content":[{"text":"hello"}]}');
    await volume.tx(async (draft) => {
      await draft.mkdir("/FiPen");
      await draft.put("/FiPen/Notes.fipen", body, { mime: "application/json" });
    });
    expect(registry.commits).toBe(1);
    expect(storage.pieces.size).toBe(1);
    const head = await registry.head(OWNER, namespaceId(), volumeKey("demo"));
    const car = decodeCar(unpadPiece(storage.pieces.get(bytesToPieceCid(head.pieceCid))!));
    const manifest = decode(car.blocks.get(car.root)!);
    expect(manifest).toContain("Notes.fipen");
    expect([...car.blocks.values()].some((block) => decode(block).includes("hello"))).toBe(true);
    expect(car.blocks.size).toBeGreaterThan(1);

    await volume.mkdir("/FiPen/empty");
    expect(storage.pieces.size).toBe(2);
    const metaHead = await registry.head(OWNER, namespaceId(), volumeKey("demo"));
    const meta = decodeCar(unpadPiece(storage.pieces.get(bytesToPieceCid(metaHead.pieceCid))!));
    expect(meta.blocks.size).toBe(1);
    expect([...meta.blocks.values()].some((block) => decode(block).includes("hello"))).toBe(false);
  });

  it("writes a metadata-only CAR and does not copy unchanged file bytes", async () => {
    const { volume, storage, registry } = await makeVolume();
    await volume.put("/notes/a.txt", text("same-bytes"));
    const fileCid = (await volume.stat("/notes/a.txt")).pieceCid;
    const afterPut = storage.pieces.size;
    const head = await registry.head(OWNER, namespaceId(), volumeKey("demo"));
    const first = decodeCar(unpadPiece(storage.pieces.get(bytesToPieceCid(head.pieceCid))!));
    expect(first.blocks.size).toBeGreaterThan(1);

    await volume.mkdir("/notes/empty");
    await volume.mv("/notes/a.txt", "/notes/b.txt");
    expect(storage.pieces.size).toBe(afterPut + 2);
    expect((await volume.stat("/notes/b.txt")).pieceCid).toBe(fileCid);
    expect(decode(await volume.get("/notes/b.txt"))).toBe("same-bytes");

    const moved = await registry.head(OWNER, namespaceId(), volumeKey("demo"));
    const car = decodeCar(unpadPiece(storage.pieces.get(bytesToPieceCid(moved.pieceCid))!));
    expect(car.blocks.size).toBe(1);
    expect(car.blocks.has(fileCid!)).toBe(false);
    for (const piece of storage.pieces.values()) expect(piece.byteLength).toBeGreaterThanOrEqual(127);
  });
});
