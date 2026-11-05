import { describe, expect, it } from "vitest";
import { decodeCar, driveMetadata, fitBytes, openVolume, readDriveMetadata, versionsToPrune } from "../src/index.js";
import { OWNER, decode, makeVolume, text } from "./helpers.js";

describe("Filecoin Drive piece metadata", () => {
  it("names a single-file commit like Filecoin Drive does (label, path, ipfsRootCID) plus version", async () => {
    const { volume, storage } = await makeVolume();
    await volume.put("/FiPen/Notes.fipen", text("hello"));
    await volume.put("/FiPen/Notes.fipen", text("hello again"));
    const history = await volume.history();
    const meta = storage.metadata.get(history[1]!.pieceCid)!;
    expect(meta).toMatchObject({ label: "Notes.fipen", path: "FiPen", version: "2" });
    // What Drive does on download: read the CAR piece, export the ipfsRootCID block.
    const car = decodeCar(storage.pieces.get(history[1]!.pieceCid)!);
    expect(decode(car.blocks.get(meta.ipfsRootCID!)!)).toBe("hello again");
    expect(readDriveMetadata(meta)).toMatchObject({ fileName: "Notes.fipen", folderPath: "FiPen", version: 2n });
  });

  it("names multi-file and metadata-only commits as a system manifest under .fifolders", async () => {
    const { volume, storage } = await makeVolume();
    await volume.tx(async (v) => {
      await v.put("/a.txt", text("a"));
      await v.put("/b.txt", text("b"));
    });
    await volume.mv("/a.txt", "/c.txt");
    for (const entry of await volume.history()) {
      const meta = storage.metadata.get(entry.pieceCid)!;
      expect(meta.path).toBe(".fifolders");
      expect(meta.label).toBe("demo.manifest.json");
      expect(decodeCar(storage.pieces.get(entry.pieceCid)!).root).toBe(meta.ipfsRootCID);
    }
  });

  it("publishes only the version for encrypted volumes", async () => {
    const { volume, storage } = await makeVolume({ encryption: true });
    await volume.put("/secret/plan.txt", text("x"));
    const [entry] = await volume.history();
    expect(storage.metadata.get(entry!.pieceCid)).toEqual({ version: "1" });
  });

  it("respects Drive and Synapse limits", () => {
    const long = `${"é".repeat(80)}.figrid`;
    const fitted = fitBytes(long);
    expect(new TextEncoder().encode(fitted).byteLength).toBeLessThanOrEqual(96);
    expect(fitted.endsWith(".figrid")).toBe(true);
    const meta = driveMetadata({ name: "a.txt", folder: "x".repeat(200), ipfsRootCID: "bafk", version: 3n, extra: { one: "1", two: "2" } });
    expect(meta.path).toBe("");
    expect(Object.keys(meta).length).toBeLessThanOrEqual(5);
  });

  it("reads Drive-written metadata (label/name, path/carPath)", () => {
    expect(readDriveMetadata({ label: "photo.jpg", path: "/Trips//2026/", ipfsRootCID: "bafy" })).toEqual({
      fileName: "photo.jpg",
      folderPath: "Trips/2026",
      ipfsRootCID: "bafy",
      importedCar: false,
    });
    expect(readDriveMetadata({ name: "site.car", carPath: "" })?.importedCar).toBe(true);
    expect(readDriveMetadata({ source: "x" })).toBeNull();
  });
});

describe("version retention", () => {
  const day = 86_400;
  const now = 1_800_000_000_000;
  const h = (ages: number[]) => ages.map((age, i) => ({ pieceCid: `p${i}`, timestamp: now / 1000 - age * day }));

  it("keeps 30 days and the newest 100 versions, pruning only the oldest contiguous run", () => {
    const history = h([90, 80, 40, 10, 1]);
    expect(versionsToPrune(history, new Set(), { now, policy: { keepVersions: 2 } })).toEqual(["p0", "p1", "p2"]);
    expect(versionsToPrune(history, new Set(), { now })).toEqual([]);
    expect(versionsToPrune(history, new Set(["p1"]), { now, policy: { keepVersions: 2 } })).toEqual(["p0", "p2"]);
    expect(versionsToPrune(history, new Set(), { now, policy: { keepVersions: 2 }, pinned: new Set(["p1"]) })).toEqual(["p0"]);
  });

  it("history still opens after old versions are pruned, with stable version numbers", async () => {
    const { volume, storage, registry } = await makeVolume();
    for (const body of ["one", "two", "three", "four"]) await volume.put("/a.txt", text(body));
    const before = await volume.history();
    storage.pieces.delete(before[0]!.pieceCid);
    storage.pieces.delete(before[1]!.pieceCid);
    const fresh = await openVolume({ storage, registry, owner: OWNER, name: "demo" });
    const after = await fresh.history();
    expect(after.map((entry) => entry.version)).toEqual([3n, 4n]);
    expect(decode(await fresh.get("/a.txt"))).toBe("four");
  });
});
