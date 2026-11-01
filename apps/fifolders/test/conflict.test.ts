import { MemoryRegistry, MemoryStorage, RegistryCasConflict, openVolume, type Registry } from "fil-folders";
import { describe, expect, it } from "vitest";
import { observeRegistry } from "../src/session.js";

const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("registry conflicts", () => {
  it("merges a non-overlapping write and records the conflict", async () => {
    const storage = new MemoryStorage();
    const raw = new MemoryRegistry(owner);
    const observed = observeRegistry(raw);
    let interleave: (() => Promise<void>) | null = null;
    const registry: Registry = {
      head: (o, ns, key) => raw.head(o, ns, key),
      commit: async (input) => {
        if (interleave) {
          const run = interleave;
          interleave = null;
          await run();
        }
        return observed.registry.commit(input);
      },
      setWriter: (ns, writer, allowed) => raw.setWriter(ns, writer, allowed),
      isWriter: (o, ns, writer) => raw.isWriter(o, ns, writer),
      committed: (query) => raw.committed(query),
    };
    const other = await openVolume({ storage, registry: raw, owner, name: "Vol" });
    const volume = await openVolume({ storage, registry, owner, name: "Vol" });
    interleave = async () => {
      await other.put("/from-a.txt", new TextEncoder().encode("a"), { mime: "text/plain" });
    };
    await volume.put("/from-b.txt", new TextEncoder().encode("b"), { mime: "text/plain" });
    expect(observed.cas.takeMerged()).toBe(true);
    const names = (await volume.ls("/")).map((entry) => entry.name).sort();
    expect(names).toEqual(["from-a.txt", "from-b.txt"]);
  });

  it("surfaces a real path conflict", async () => {
    const storage = new MemoryStorage();
    const raw = new MemoryRegistry(owner);
    let interleave: (() => Promise<void>) | null = null;
    let conflicts = 0;
    const registry: Registry = {
      head: (o, ns, key) => raw.head(o, ns, key),
      commit: async (input) => {
        if (interleave) {
          const run = interleave;
          interleave = null;
          await run();
        }
        try {
          return await raw.commit(input);
        } catch (error) {
          if (error instanceof RegistryCasConflict) conflicts += 1;
          throw error;
        }
      },
      setWriter: (ns, writer, allowed) => raw.setWriter(ns, writer, allowed),
      isWriter: (o, ns, writer) => raw.isWriter(o, ns, writer),
      committed: (query) => raw.committed(query),
    };
    const other = await openVolume({ storage, registry: raw, owner, name: "Vol" });
    const volume = await openVolume({ storage, registry, owner, name: "Vol" });
    interleave = async () => {
      await other.put("/same.txt", new TextEncoder().encode("theirs"));
    };
    await expect(volume.put("/same.txt", new TextEncoder().encode("ours"))).rejects.toThrow(/same\.txt/);
    expect(conflicts).toBeGreaterThan(0);
  });
});
