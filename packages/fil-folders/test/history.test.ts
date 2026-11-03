import { describe, expect, it } from "vitest";
import { makeVolume, text } from "./helpers.js";

describe("history", () => {
  it("returns volume commits and path changes", async () => {
    const { volume } = await makeVolume();
    expect(await volume.history()).toEqual([]);

    await volume.put("/a.txt", text("one"));
    await volume.put("/b.txt", text("two"));
    await volume.put("/a.txt", text("three"));
    await volume.rm("/a.txt");

    const volumeLog = await volume.history();
    expect(volumeLog.map((entry) => entry.version)).toEqual([1n, 2n, 3n, 4n]);
    expect(volumeLog.every((entry) => entry.timestamp > 0)).toBe(true);
    expect(volumeLog[1]?.prevPieceCid).toBe(volumeLog[0]?.pieceCid);

    const fileLog = await volume.history("/a.txt");
    expect(fileLog.map((entry) => [entry.version, entry.change])).toEqual([
      [1n, "added"],
      [3n, "updated"],
      [4n, "removed"],
    ]);
    expect(await volume.history("/b.txt")).toEqual([expect.objectContaining({ version: 2n, change: "added", path: "/b.txt" })]);
  });
});

describe("getAt", () => {
  it("reads a file as it was at an older snapshot (Manage versions)", async () => {
    const { volume } = await makeVolume();
    await volume.put("/a.txt", text("one"));
    await volume.put("/a.txt", text("two"));
    const versions = await volume.history("/a.txt");
    expect(new TextDecoder().decode(await volume.getAt(versions[0]!.pieceCid, "/a.txt"))).toBe("one");
    expect(new TextDecoder().decode(await volume.getAt(versions[1]!.pieceCid, "/a.txt"))).toBe("two");
    await expect(volume.getAt(versions[0]!.pieceCid, "/missing.txt")).rejects.toThrow();
  });
});
