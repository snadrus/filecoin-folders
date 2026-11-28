import { describe, expect, it } from "vitest";
import { MemoryRegistry, NotFoundError } from "../src/index.js";
import { OWNER, makeVolume, text } from "./helpers.js";

/** A registry whose head() lags one commit behind, like a public RPC node right after our own commit. */
class LaggingRegistry extends MemoryRegistry {
  lag = false;
  #previous: Awaited<ReturnType<MemoryRegistry["head"]>> | null = null;
  override async head(...args: Parameters<MemoryRegistry["head"]>) {
    const now = await super.head(...args);
    if (this.lag && this.#previous && this.#previous.version < now.version) return this.#previous;
    return now;
  }
  override async commit(...args: Parameters<MemoryRegistry["commit"]>) {
    this.#previous = await super.head(args[0].owner, args[0].ns, args[0].key);
    const record = await super.commit(...args);
    // Like the viem registry without a decodable event: the version comes from a (lagging) head read.
    return this.lag ? { ...record, version: this.#previous.version } : record;
  }
}

describe("stale registry head after our own commit", () => {
  it("does not step back: the deleted file stays deleted and its piece is released", async () => {
    const registry = new LaggingRegistry(OWNER);
    const { volume } = await makeVolume({ registry });
    await volume.put("/a.txt", text("delete me"));
    const before = new Set(await volume.referencedPieces());
    registry.lag = true;
    await volume.rm("/a.txt");
    const live = new Set(await volume.referencedPieces());
    const released = [...before].filter((piece) => !live.has(piece));
    expect(released.length).toBeGreaterThan(0);
    await expect(volume.stat("/a.txt")).rejects.toBeInstanceOf(NotFoundError);
    // The copy catalog keys on the head: it must be the new root, not the lagging one.
    expect(live.has(await volume.headPiece())).toBe(true);
    expect(before.has(await volume.headPiece())).toBe(false);
  });
});
