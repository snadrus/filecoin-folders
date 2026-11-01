import { describe, expect, it } from "vitest";
import { CasConflictError, NotFoundError } from "../src/index.js";
import { decode, makeVolume, text } from "./helpers.js";

describe("compare-and-swap merge", () => {
  it("merges non-overlapping paths and surfaces a true conflict", async () => {
    const { volume: left, storage, registry } = await makeVolume();
    const right = (await makeVolume({ storage, registry })).volume;

    await right.tx(async (draft) => {
      await left.put("/a.txt", text("A"));
      await draft.put("/b.txt", text("B"));
    });
    expect(decode(await right.get("/a.txt"))).toBe("A");
    expect(decode(await right.get("/b.txt"))).toBe("B");
    expect(decode(await left.get("/b.txt"))).toBe("B");

    const third = (await makeVolume({ storage, registry })).volume;
    const fourth = (await makeVolume({ storage, registry })).volume;
    await expect(
      fourth.tx(async (draft) => {
        await third.put("/a.txt", text("from-third"));
        await draft.put("/a.txt", text("from-fourth"));
      }),
    ).rejects.toBeInstanceOf(CasConflictError);
    expect(decode(await third.get("/a.txt"))).toBe("from-third");
    expect(decode(await left.get("/b.txt"))).toBe("B");
  });

  it("merges a delete with a disjoint add and conflicts when the same file is edited", async () => {
    const { volume: left, storage, registry } = await makeVolume();
    await left.put("/a.txt", text("1"));
    await left.put("/b.txt", text("2"));
    const right = (await makeVolume({ storage, registry })).volume;

    await right.tx(async (draft) => {
      await left.rm("/a.txt");
      await draft.put("/c.txt", text("3"));
    });
    await expect(right.get("/a.txt")).rejects.toBeInstanceOf(NotFoundError);
    expect(decode(await right.get("/b.txt"))).toBe("2");
    expect(decode(await right.get("/c.txt"))).toBe("3");

    await left.put("/b.txt", text("left"));
    const editor = (await makeVolume({ storage, registry })).volume;
    await expect(
      editor.tx(async (draft) => {
        await left.put("/b.txt", text("raced"));
        await draft.put("/b.txt", text("draft"));
      }),
    ).rejects.toMatchObject({ name: "CasConflictError", paths: ["/b.txt"] });
    expect(decode(await left.get("/b.txt"))).toBe("raced");
  });

  it("merges encrypted volumes when the paths do not overlap", async () => {
    const { volume: left, storage, registry } = await makeVolume({ encryption: true });
    const right = (await makeVolume({ storage, registry, encryption: true })).volume;
    await right.tx(async (draft) => {
      await left.put("/left.txt", text("L"));
      await draft.put("/right.txt", text("R"));
    });
    expect(decode(await right.get("/left.txt"))).toBe("L");
    expect(decode(await left.get("/right.txt"))).toBe("R");
  });
});
