import { describe, expect, it } from "vitest";
import {
  applySelection,
  appLink,
  breadcrumbs,
  copyName,
  felKind,
  formatBytes,
  isTrashPath,
  meterPercent,
  sortStats,
  uniqueName,
} from "../src/model.js";
import type { Stat } from "fil-folders";

function stat(name: string, type: "file" | "dir", extra: Partial<Stat> = {}): Stat {
  return { name, path: `/${name}`, type, size: type === "dir" ? 0 : 10, mtime: 1, ...extra };
}

describe("model", () => {
  it("formats sizes and the storage meter", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(1)).toBeGreaterThan(0);
  });

  it("recognizes fel files and builds app links", () => {
    expect(felKind("Notes.Felarumi")).toBe("felarumi");
    expect(felKind("scene.felanumio")).toBe("felanumio");
    expect(felKind("notes.txt")).toBeNull();
    const link = appLink("felarumi", "bafy", "a.felarumi", {
      felarumi: "https://felarumi.example/",
      felanumio: "https://felanumio.example",
    });
    expect(link).toContain("pieceCid=bafy");
    expect(link).toContain("name=a.felarumi");
  });

  it("builds breadcrumbs and trash paths", () => {
    expect(breadcrumbs("drive", "/docs/img").map((crumb) => crumb.label)).toEqual(["My Drive", "docs", "img"]);
    expect(breadcrumbs("trash", "/.trash")).toEqual([{ label: "Trash", path: "/.trash" }]);
    expect(isTrashPath("/.trash/a.txt")).toBe(true);
    expect(isTrashPath("/trash")).toBe(false);
  });

  it("selects with shift ranges and ctrl toggles", () => {
    const ordered = ["/a", "/b", "/c"];
    const ranged = applySelection({ ordered, selected: ["/a"], anchor: "/a", path: "/c", shift: true, toggle: false });
    expect(ranged.selected).toEqual(["/a", "/b", "/c"]);
    const toggled = applySelection({ ordered, selected: ranged.selected, anchor: "/c", path: "/b", shift: false, toggle: true });
    expect(toggled.selected).toEqual(["/a", "/c"]);
  });

  it("sorts folders first and names copies", () => {
    const sorted = sortStats([stat("b.txt", "file"), stat("A", "dir"), stat("a.txt", "file", { size: 3 })], "name", 1, true);
    expect(sorted.map((entry) => entry.name)).toEqual(["A", "a.txt", "b.txt"]);
    expect(copyName("notes.txt")).toBe("notes (copy).txt");
    const taken = new Set(["notes (copy).txt"]);
    expect(uniqueName("notes (copy).txt", taken)).toBe("notes (copy) (1).txt");
  });
});
