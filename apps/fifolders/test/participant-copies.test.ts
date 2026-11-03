import { describe, expect, it } from "vitest";
import { copyTarget, type ParticipantCopy } from "../src/participant-copies";

const base: ParticipantCopy = { id: "x", kind: "doc", title: "Plan", from: "Ada", content: "{}", origin: { doc: "doc:a", owner: "", baseRev: 2, by: "Ada", at: 1 }, fit: "version", path: "/Work/Plan.fipen", received: 1 };

describe("copyTarget", () => {
  it("a copy that still fits becomes the next version of the original", () => {
    expect(copyTarget(base)).toEqual({ path: "/Work/Plan.fipen", mode: "version" });
  });
  it("a diverged copy goes beside the original and says whose it is", () => {
    expect(copyTarget({ ...base, fit: "diverged" })).toEqual({ path: "/Work/Plan (copy from Ada).fipen", mode: "side" });
  });
  it("without a known original path it lands in FiPen / FiGrid", () => {
    expect(copyTarget({ ...base, path: "" }).path).toBe("/FiPen/Plan (copy from Ada).fipen");
    expect(copyTarget({ ...base, kind: "book", path: "", from: "a/b" }).path).toBe("/FiGrid/Plan (copy from a b).figrid");
  });
});
