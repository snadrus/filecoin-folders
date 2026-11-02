import { describe, expect, it } from "vitest";
import { MemoryStorage, decodeCar, isCar, openVolume, MIN_PIECE_BYTES, padPiece, unpadPiece } from "../src/index.js";
import { OWNER, decode, makeVolume, text } from "./helpers.js";

describe("piece padding", () => {
  it("frames a 77-byte payload up to the PDP minimum and restores it", () => {
    const original = new Uint8Array(77).map((_, i) => i + 1);
    const padded = padPiece(original);
    expect(padded.byteLength).toBeGreaterThanOrEqual(MIN_PIECE_BYTES);
    expect(padded.byteLength).toBe(127);
    expect(unpadPiece(padded)).toEqual(original);
  });

  it("leaves payloads that are already large enough unframed", () => {
    const original = new Uint8Array(200).fill(7);
    const padded = padPiece(original);
    expect(padded).toBe(original);
    expect(unpadPiece(original)).toEqual(original);
  });

  it("round-trips tiny files and registry manifests through a volume", async () => {
    const { volume, storage, registry } = await makeVolume();
    await volume.put("/note.txt", text("hi"));
    expect(decode(await volume.get("/note.txt"))).toBe("hi");
    expect((await volume.stat("/note.txt")).size).toBe(2);
    for (const piece of storage.pieces.values()) {
      expect(piece.byteLength).toBeGreaterThanOrEqual(MIN_PIECE_BYTES);
    }
    const restored = await openVolume({ storage, registry, owner: OWNER, name: "demo", now: () => 1_700_000_000_000 });
    expect(decode(await restored.get("/note.txt"))).toBe("hi");
  });

  it("pads a short stream and passes a long stream through", async () => {
    const storage = new MemoryStorage();
    const { volume } = await makeVolume({ storage });
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text("hello "));
        controller.enqueue(text("stream"));
        controller.close();
      },
    });
    await volume.put("/short.txt", short);
    expect(decode(await volume.get("/short.txt"))).toBe("hello stream");
    const big = new Uint8Array(180);
    big.set(text("big-stream-prefix"));
    await volume.put("/big.bin", big);
    const blocks = [...storage.pieces.values()].flatMap((piece) => {
      const raw = unpadPiece(piece);
      return isCar(raw) ? [...decodeCar(raw).blocks.values()] : [];
    });
    const stored = blocks.find((block) => block.byteLength === 180);
    expect(stored).toBeTruthy();
    expect(stored![0]).not.toBe(0xff);
  });
});
