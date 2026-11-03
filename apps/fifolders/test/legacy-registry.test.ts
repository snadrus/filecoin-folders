import { describe, expect, it } from "vitest";
import { isLegacyRegistry } from "../src/onboarding-logic.js";

describe("isLegacyRegistry (no surprise root-wallet prompts)", () => {
  it("current permission → not legacy", async () => {
    expect(await isLegacyRegistry(async () => "0xAB", "0xab")).toBe(false);
  });
  it("different permission → legacy", async () => {
    expect(await isLegacyRegistry(async () => "0x01", "0xab")).toBe(true);
  });
  it("RPC failures are retried and never fall back to the root wallet", async () => {
    let n = 0;
    expect(await isLegacyRegistry(async () => { n++; throw new Error("rpc down"); }, "0xab", 2)).toBe(false);
    expect(n).toBe(2);
  });
  it("a transient failure then success uses the real answer", async () => {
    let n = 0;
    expect(await isLegacyRegistry(async () => { if (n++ === 0) throw new Error("x"); return "0xab"; }, "0xab")).toBe(false);
  });
});
