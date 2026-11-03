import { afterEach, describe, expect, it, vi } from "vitest";
import { saveStaged, stagedKey } from "../src/staged";

describe("saveStaged quota", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns false (and keeps no partial backup) when localStorage is full, instead of throwing", () => {
    const store = new Map<string, string>([[stagedKey("0xA", "v"), "old"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
    });
    expect(saveStaged("0xA", "v", { ops: [{ op: "put", path: "/big", bytes: "x" }], origins: {}, stars: [] })).toBe(false);
    expect(store.has(stagedKey("0xA", "v"))).toBe(false);
  });
});
