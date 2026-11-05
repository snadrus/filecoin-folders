import { contentCid, encodeCar } from "fil-folders";
import { describe, expect, it } from "vitest";
import { driveInfo, isDriveSource, type PieceDetail } from "../src/drive-pieces.js";
import { loosePieces } from "../src/loose.js";
import { versionsEligibleForRemoval } from "../src/removal.js";

describe("Filecoin Drive compatibility", () => {
  it("recognises Filecoin Drive data sets by filecoin-pin's source (and the old label)", () => {
    expect(isDriveSource("filecoin-pin")).toBe(true);
    expect(isDriveSource("filecoin-drive")).toBe(true);
    expect(isDriveSource("fifolders")).toBe(false);
  });

  it("reads version metadata written by FiFolders, FiPen and FiGrid", () => {
    expect(driveInfo({ label: "Plan.figrid", path: "FiGrid", ipfsRootCID: "bafkrei", version: "7" })).toMatchObject({
      fileName: "Plan.figrid",
      folderPath: "FiGrid",
      version: 7n,
    });
  });

  it("lists Drive uploads as loose files but not older FiFolders versions", async () => {
    const bytes = new TextEncoder().encode("hello drive");
    const cid = await contentCid(bytes);
    const car = encodeCar(cid, new Map([[cid, bytes]]));
    const details = new Map<string, PieceDetail>([
      ["drive", { pieceCid: "drive", pieceId: "1", metadata: { label: "hello.txt", path: "Docs", ipfsRootCID: cid } }],
      ["old", { pieceCid: "old", pieceId: "2", metadata: { label: "hello.txt", path: "Docs", ipfsRootCID: cid, version: "3" } }],
    ]);
    const rows = loosePieces(
      [
        { pieceCid: "drive", bytes: car },
        { pieceCid: "old", bytes: car },
      ],
      new Set(),
      details,
    );
    expect(rows.map((row) => [row.pieceCid, row.name, row.folder])).toEqual([["drive", "hello.txt", "Docs"]]);
  });

  it("keeps recent versions when cleaning up after Delete forever", () => {
    const now = Date.now();
    const history = [
      { pieceCid: "v1", timestamp: Math.floor(now / 1000) - 5 * 86_400 },
      { pieceCid: "v2", timestamp: Math.floor(now / 1000) },
    ];
    expect(versionsEligibleForRemoval(history, new Set(["v2"]), { now })).toEqual([]);
    expect(versionsEligibleForRemoval(history, new Set(["v2"]), { now, policy: { keepDays: 1, keepVersions: 1 } })).toEqual(["v1"]);
  });
});
