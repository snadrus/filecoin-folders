import { describe, expect, it } from "vitest";
import { driveInfo, groupByFolder, loadPieceDetails } from "../src/drive-pieces.js";
import { directoryFile, loosePieces } from "../src/loose.js";
import { filecoinDriveFixture } from "../src/mock-onboarding.js";
import { buildFixtureCar, listDirectory, parseCar, readFile } from "../src/unixfs.js";

const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("UnixFS CAR reader", () => {
  it("reads a single wrapped file and lists nested directories", () => {
    const file = parseCar(buildFixtureCar(text("abc")));
    expect(decode(readFile(file, file.roots[0]!))).toBe("abc");
    const dir = parseCar(buildFixtureCar({ a: text("1"), sub: { b: text("22") } }));
    const list = listDirectory(dir, dir.roots[0]!);
    expect(list.map((e) => [e.name, e.kind])).toEqual([["a", "file"], ["sub", "directory"]]);
    expect(list[1]!.children?.[0]).toMatchObject({ name: "b", size: 2 });
  });
});

describe("Filecoin Drive metadata (filecoin-pin-website PR #250 shape)", () => {
  it("parses label/path/carPath/ipfsRootCID", () => {
    expect(driveInfo({ label: "a.txt", path: "/docs//x/" })).toEqual({ fileName: "a.txt", folderPath: "docs/x", ipfsRootCid: "", importedCar: false });
    expect(driveInfo({ label: "b.car", carPath: "arch", ipfsRootCID: "bafyroot" })).toMatchObject({ importedCar: true, folderPath: "arch", ipfsRootCid: "bafyroot" });
    expect(driveInfo({ created: "x" })).toBeNull();
  });

  it("turns drive pieces into loose rows: unwrapped files, directories, folders, dates", () => {
    const fixture = filecoinDriveFixture();
    const rows = loosePieces(fixture.map((p) => ({ pieceCid: p.pieceCid, bytes: p.bytes })), new Set(), new Map(fixture.map((p) => [p.pieceCid, p.detail])));
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get("hello.txt")).toMatchObject({ origin: "drive", unixfs: "file", folder: "", mime: "text/plain" });
    expect(decode(byName.get("hello.txt")!.bytes)).toBe("Hello from Filecoin Drive\n");
    expect(byName.get("report.txt")).toMatchObject({ folder: "docs/reports", unixfs: "file" });
    const site = byName.get("site")!;
    expect(site.unixfs).toBe("directory");
    expect(site.children?.map((c) => c.name)).toEqual(["index.html", "css"]);
    expect(decode(directoryFile(site, "css/main.css"))).toBe("h1{color:blue}");
    expect(site.uploaded).toBeGreaterThan(0);
    expect(groupByFolder(rows).map((g) => g.folder)).toEqual(["", "docs/reports", "projects"]);
  });

  it("keeps imported CARs raw", () => {
    const car = buildFixtureCar(text("x"));
    const [row] = loosePieces([{ pieceCid: "p", bytes: car }], new Set(), new Map([["p", { pieceCid: "p", pieceId: "1", metadata: { label: "b.car", carPath: "" } }]]));
    expect(row).toMatchObject({ unixfs: "car", mime: "application/vnd.ipld.car", bytes: car });
  });

  it("reads per-piece metadata from the Filecoin index, paginated, skipping removed pieces", async () => {
    const pages = [
      { data: [{ cid: "c1", pieceId: "1", removed: false, metadata: { label: "a", path: "" }, addedAtBlock: "10" }], nextCursor: "n" },
      { data: [{ cid: "c2", pieceId: "2", removed: true, metadata: {} }], nextCursor: null },
    ];
    let i = 0;
    const fetchImpl = (async () => new Response(JSON.stringify(pages[i++]))) as unknown as typeof fetch;
    const out = await loadPieceDetails({ network: "calibration", dataSetId: "5", genesisTimestamp: 1000, fetchImpl });
    expect(out).toEqual([{ pieceCid: "c1", pieceId: "1", metadata: { label: "a", path: "" }, addedAt: (1000 + 300) * 1000 }]);
  });

  it("falls back to chain metadata when the index is down", async () => {
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const out = await loadPieceDetails({ network: "calibration", dataSetId: "5", genesisTimestamp: 0, fetchImpl, chainFallback: async () => [{ pieceCid: "z", pieceId: "0", metadata: {} }] });
    expect(out[0]!.pieceCid).toBe("z");
  });
});
