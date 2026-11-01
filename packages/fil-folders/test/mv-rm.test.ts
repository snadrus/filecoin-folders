import { describe, expect, it } from "vitest";
import { AlreadyExistsError, DirectoryNotEmptyError, NotFoundError } from "../src/index.js";
import { decode, makeVolume, text } from "./helpers.js";

describe("mv cp rm", () => {
  it("moves and copies files, and removes empty or recursive directories", async () => {
    const { volume } = await makeVolume();
    await volume.put("/a/b.txt", text("beta"));
    await expect(volume.mv("/a/b.txt", "/c/d.txt")).rejects.toBeInstanceOf(NotFoundError);
    await volume.mkdir("/c");
    await volume.mv("/a/b.txt", "/c/d.txt");
    expect(decode(await volume.get("/c/d.txt"))).toBe("beta");
    await expect(volume.get("/a/b.txt")).rejects.toBeInstanceOf(NotFoundError);

    await volume.cp("/c/d.txt", "/e.txt");
    expect(decode(await volume.get("/e.txt"))).toBe("beta");
    expect(decode(await volume.get("/c/d.txt"))).toBe("beta");
    await expect(volume.cp("/e.txt", "/e.txt")).rejects.toBeInstanceOf(AlreadyExistsError);

    await volume.rm("/e.txt");
    await expect(volume.get("/e.txt")).rejects.toBeInstanceOf(NotFoundError);
    await expect(volume.rm("/c")).rejects.toBeInstanceOf(DirectoryNotEmptyError);
    await volume.rm("/c", { recursive: true });
    await expect(volume.stat("/c")).rejects.toBeInstanceOf(NotFoundError);
    await volume.rm("/a");
  });

  it("copies and moves directories without rewriting file pieces", async () => {
    const { volume, storage } = await makeVolume();
    await volume.put("/a/b.txt", text("same"));
    const pieces = storage.pieces.size;
    await volume.cp("/a", "/d");
    await volume.mv("/d", "/e");
    expect(decode(await volume.get("/e/b.txt"))).toBe("same");
    expect(decode(await volume.get("/a/b.txt"))).toBe("same");
    expect(storage.pieces.size).toBeGreaterThanOrEqual(pieces);
    await expect(volume.mv("/a", "/a/nested")).rejects.toThrow("into itself");
  });
});
