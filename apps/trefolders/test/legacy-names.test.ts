import { describe, expect, it } from "vitest";
import { felKindOfPath } from "../src/fel-names";
import { felKind } from "../src/model";

describe("pre-rename file names", () => {
  it("opens .fipen and .figrid files from before the rename, and the new .trepen and .tregrid", () => {
    expect(felKind("Notes.fipen")).toBe("felarumi");
    expect(felKind("Budget.figrid")).toBe("felanumio");
    expect(felKind("Notes.trepen")).toBe("felarumi");
    expect(felKind("Budget.tregrid")).toBe("felanumio");
    expect(felKind("OLD.FIPEN")).toBe("felarumi");
    expect(felKind("older.felarumi")).toBe("felarumi");
    expect(felKind("older.felanumio")).toBe("felanumio");
    expect(felKind("readme.txt")).toBeNull();
  });

  it("keeps routing a .figrid path to the spreadsheet editor", () => {
    expect(felKindOfPath("/Budget.figrid")).toBe("felanumio");
    expect(felKindOfPath("/Budget.tregrid")).toBe("felanumio");
    expect(felKindOfPath("/Notes.fipen")).toBe("felarumi");
  });
});
