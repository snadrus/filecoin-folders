import { describe, expect, it } from "vitest";
import { MemoryRegistry, MemoryStorage, buildFixtureCar, listDirectory, manifestBytes, openVolume, parseCar } from "../src/index.js";
import { parseManifest } from "../src/codec.js";
import { OWNER, decode, makeVolume, text } from "./helpers.js";

function drivePiece(storage: MemoryStorage) {
  const car = buildFixtureCar({ "hello.txt": text("hello from filecoin drive"), sub: { "a.md": text("# A") } });
  storage.pieces.set("bafkzcibdrivepiece", car);
  const parsed = parseCar(car);
  const list = listDirectory(parsed, parsed.roots[0]!);
  const hello = list.find((e) => e.name === "hello.txt")!;
  const a = list.find((e) => e.name === "sub")!.children!.find((e) => e.name === "a.md")!;
  return { car, root: parsed.roots[0]!, hello, a };
}

describe("adopt Filecoin Drive (UnixFS) pieces", () => {
  it("references pieces without re-upload and reads them back after reopen", async () => {
    const storage = new MemoryStorage();
    const registry = new MemoryRegistry(OWNER);
    const { volume } = await makeVolume({ storage, registry });
    const { root, hello, a } = drivePiece(storage);
    const before = storage.pieces.size;
    await volume.adopt([
      { path: "/fd/hello.txt", ref: { cid: hello.cid, piece: "bafkzcibdrivepiece", size: hello.size, ipfs: root, mime: "text/plain" } },
      { path: "/fd/sub/a.md", ref: { cid: a.cid, piece: "bafkzcibdrivepiece", size: a.size, ipfs: root } },
    ]);
    // One manifest piece added, no file bytes re-uploaded.
    expect(storage.pieces.size).toBe(before + 1);
    expect(decode(await volume.get("/fd/hello.txt"))).toBe("hello from filecoin drive");
    const fresh = await openVolume({ storage, registry, owner: OWNER, name: "demo" });
    expect(decode(await fresh.get("/fd/sub/a.md"))).toBe("# A");
    const stat = await fresh.stat("/fd/hello.txt");
    expect(stat).toMatchObject({ format: "unixfs", located: "bafkzcibdrivepiece", ipfs: root, size: hello.size });
    expect(await fresh.referencedPieces()).toContain("bafkzcibdrivepiece");
    await fresh.mv("/fd/hello.txt", "/hello.txt");
    expect(decode(await fresh.get("/hello.txt"))).toBe("hello from filecoin drive");
  });

  it("serves an imported CAR raw", async () => {
    const storage = new MemoryStorage();
    const { volume } = await makeVolume({ storage });
    const car = buildFixtureCar(text("x"));
    storage.pieces.set("bafkzcibcarpiece", car);
    await volume.adopt([{ path: "/backup.car", ref: { cid: parseCar(car).roots[0]!, piece: "bafkzcibcarpiece", size: car.length, importedCar: true } }]);
    expect(await volume.get("/backup.car")).toEqual(car);
  });

  it("adopted files stay plaintext in an encrypted volume", async () => {
    const storage = new MemoryStorage();
    const { volume } = await makeVolume({ storage, encryption: true });
    const { hello } = drivePiece(storage);
    await volume.adopt([{ path: "/hello.txt", ref: { cid: hello.cid, piece: "bafkzcibdrivepiece", size: hello.size } }]);
    expect(decode(await volume.get("/hello.txt"))).toBe("hello from filecoin drive");
    expect((await volume.stat("/hello.txt")).format).toBe("unixfs");
  });
});

describe("manifest format compatibility", () => {
  const golden =
    '{"entries":[{"located":"bafkzcibdrivepiece","format":"unixfs","ipfs":"bafyroot","mtime":5,"name":"a.txt","pieceCid":"bafkreifile","size":3,"type":"file"},{"mtime":5,"name":"old.txt","pieceCid":"mem:abc","size":1,"type":"file"}],"mtime":5,"v":1}';
  it("round-trips the additive unixfs fields byte-for-byte (canonical JSON)", () => {
    const parsed = parseManifest(text(golden));
    expect(parsed.entries[0]).toMatchObject({ format: "unixfs", located: "bafkzcibdrivepiece" });
    expect(parsed.entries[1]).toEqual({ name: "old.txt", type: "file", size: 1, mtime: 5, pieceCid: "mem:abc" });
    expect(decode(manifestBytes(parsed))).toBe(
      '{"entries":[{"format":"unixfs","ipfs":"bafyroot","located":"bafkzcibdrivepiece","mtime":5,"name":"a.txt","pieceCid":"bafkreifile","size":3,"type":"file"},{"mtime":5,"name":"old.txt","pieceCid":"mem:abc","size":1,"type":"file"}],"mtime":5,"v":1}',
    );
  });
  it("ignores unknown future formats instead of failing", () => {
    const parsed = parseManifest(text('{"entries":[{"format":"zzz","mtime":1,"name":"b","pieceCid":"p","size":0,"type":"file"}],"mtime":1,"v":1}'));
    expect(parsed.entries[0]!.format).toBeUndefined();
  });
});
