import { describe, expect, it } from "vitest";
import { chooseDataset, latestDatasetId, markDrives, wasAutoPicked } from "../src/onboarding-logic.js";

describe("dataset picker logic", () => {
  it("marks the highest numeric id as latest", () => {
    expect(latestDatasetId([{ id: "3" }, { id: "12" }, { id: "provider:1" }, { id: "9" }])).toBe("12");
    expect(latestDatasetId([{ id: "provider:1" }])).toBe("");
  });
  it("counts as auto-picked only when no saved preference matched", () => {
    const list = [{ id: "1" }, { id: "2" }];
    expect(wasAutoPicked(list, null, "2")).toBe(true);
    expect(wasAutoPicked(list, "7", "2")).toBe(true);
    expect(wasAutoPicked(list, "1", "1")).toBe(false);
    expect(wasAutoPicked([], null, null)).toBe(false);
  });
  it("auto-picks the newest dataset holding a manifest, else newest overall", () => {
    expect(chooseDataset([{ id: "1" }, { id: "2", drive: true }, { id: "3" }], null).selectedId).toBe("2");
    expect(chooseDataset([{ id: "1" }, { id: "3" }], null).selectedId).toBe("3");
    expect(chooseDataset([{ id: "1" }, { id: "2", drive: true }], "1").selectedId).toBe("1");
  });
  it("marks datasets containing a manifest piece", () => {
    const marked = markDrives([{ id: "1" }, { id: "2" }], new Map([["1", ["a"]], ["2", ["m"]]]), new Map([["m", "default"]]));
    expect(marked.map((d) => [d.drive, d.driveName])).toEqual([[false, undefined], [true, "default"]]);
  });
});
