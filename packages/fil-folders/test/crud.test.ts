import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  IsADirectoryError,
  MemoryRegistry,
  MemoryStorage,
  NotFoundError,
  RegistryNotAuthorized,
  assertSupportedRuntime,
  bytesToPieceCid,
  decodeCar,
  isCar,
  namespaceId,
  openVolume,
  unpadPiece,
  volumeKey,
} from "../src/index.js";
import { OWNER, decode, makeVolume, text } from "./helpers.js";

describe("folder crud", () => {
  it("requires the Synapse runtime globals", () => {
    expect(assertSupportedRuntime()).toBeUndefined();
    expect(namespaceId()).toBe("0x0b4de049e17120d1420abedef8ed7acfb9c02910bf5b2f012661245a1ce86bbf");
    expect(volumeKey("demo")).toBe("0x3a784687a2b2ff9a2c72e22b001d33d9f2e2155a7858ff663b0990d35f14745d");
  });

  it("puts, reads, lists, and stats files and directories", async () => {
    const { volume, storage, registry } = await makeVolume();
    await volume.mkdir("/docs");
    await volume.mkdir("/docs");
    const stat = await volume.put("/docs/a.txt", text("hello"), { mime: "text/plain" });
    expect(stat).toMatchObject({ name: "a.txt", path: "/docs/a.txt", type: "file", size: 5, mime: "text/plain" });
    expect(decode(await volume.get("/docs/a.txt"))).toBe("hello");
    expect(await volume.ls("/docs")).toEqual([expect.objectContaining({ name: "a.txt", size: 5 })]);
    expect(await volume.ls("/")).toEqual([expect.objectContaining({ name: "docs", type: "dir", size: 5 })]);
    expect((await volume.stat("/")).name).toBe("demo");
    expect(registry.commits).toBe(2);

    const again = await openVolume({ storage, registry, owner: OWNER, name: "demo", now: () => 1_700_000_000_000 });
    expect(decode(await again.get("/docs/a.txt"))).toBe("hello");
    expect((await again.stat("/docs/a.txt")).mime).toBe("text/plain");
  });

  it("accepts a byte stream and sorts sibling names", async () => {
    const { volume } = await makeVolume();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text("hello "));
        controller.enqueue(text("stream"));
        controller.close();
      },
    });
    await volume.put("/b.txt", text("b"));
    await volume.put("/a.txt", stream);
    expect((await volume.ls("/")).map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
    expect(decode(await volume.get("/a.txt"))).toBe("hello stream");
  });

  it("commits a transaction once and rolls it back when the callback throws", async () => {
    const { volume, registry } = await makeVolume();
    await volume.tx(async (draft) => {
      await draft.mkdir("/docs");
      await draft.put("/docs/a.txt", text("a"));
      await draft.put("/docs/b.txt", text("b"));
      expect(decode(await draft.get("/docs/a.txt"))).toBe("a");
    });
    expect(registry.commits).toBe(1);
    expect((await volume.ls("/docs")).map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);

    await expect(
      volume.tx(async (draft) => {
        await draft.put("/docs/c.txt", text("c"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(registry.commits).toBe(1);
    await expect(volume.get("/docs/c.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("inlines small directories and spills them past the threshold", async () => {
    const inlined = await makeVolume();
    await inlined.volume.put("/docs/a.txt", text("hi"));
    expect(inlined.storage.pieces.size).toBe(1);
    const inlineHead = await inlined.registry.head(OWNER, namespaceId(), volumeKey("demo"));
    const inlineCar = unpadPiece(inlined.storage.pieces.get(bytesToPieceCid(inlineHead.pieceCid))!);
    expect(isCar(inlineCar)).toBe(true);
    const inlineManifest = decode(decodeCar(inlineCar).blocks.get(decodeCar(inlineCar).root)!);
    expect(inlineManifest).toContain("docs");
    expect(inlineManifest).toContain("a.txt");

    const spilled = await makeVolume({ dirThreshold: 0 });
    await spilled.volume.put("/docs/a.txt", text("hi"));
    expect(spilled.storage.pieces.size).toBe(1);
    const spillHead = await spilled.registry.head(OWNER, namespaceId(), volumeKey("demo"));
    const spillCar = decodeCar(unpadPiece(spilled.storage.pieces.get(bytesToPieceCid(spillHead.pieceCid))!));
    const spillJson = decode(spillCar.blocks.get(spillCar.root)!);
    expect(spillJson).toContain("docs");
    expect(spillJson).not.toContain("a.txt");
    const reopened = await openVolume({
      storage: spilled.storage,
      registry: spilled.registry,
      owner: OWNER,
      name: "demo",
      dirThreshold: 0,
      now: () => 1_700_000_000_000,
    });
    expect(decode(await reopened.get("/docs/a.txt"))).toBe("hi");
  });

  it("rejects bad paths and a signer who is not a writer", async () => {
    const { volume } = await makeVolume();
    await expect(volume.put("/../x", text("no"))).rejects.toThrow("..");
    await volume.mkdir("/docs");
    await expect(volume.put("/docs", text("no"))).rejects.toBeInstanceOf(IsADirectoryError);
    await expect(volume.get("/missing")).rejects.toBeInstanceOf(NotFoundError);

    const other = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
    const registry = new MemoryRegistry(other.address);
    const denied = await openVolume({
      storage: new MemoryStorage(),
      registry,
      owner: OWNER,
      name: "demo",
    });
    await expect(denied.put("/a.txt", text("a"))).rejects.toBeInstanceOf(RegistryNotAuthorized);
  });
});
