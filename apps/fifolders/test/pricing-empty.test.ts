import { describe, expect, it } from "vitest";
import { describeRunway } from "../src/pricing.js";

const now = Date.UTC(2026, 0, 1);
describe("empty dataset still costs the dataset fee", () => {
  it("never says no ongoing cost when a dataset exists", () => {
    const r = describeRunway({ availableFunds: 0n, lockupRatePerEpoch: 0n, datasetBytes: 0, known: true, hasDataset: true, nowMs: now });
    expect(r.headline).toBe("Empty dataset — $0.12/month dataset fee");
    expect(r.headline).not.toContain("no ongoing cost");
    expect(r.showAdd).toBe(true);
  });
  it("shows runway from funds at the dataset fee", () => {
    const r = describeRunway({ availableFunds: 5n * 10n ** 18n, lockupRatePerEpoch: 0n, datasetBytes: 0, known: true, hasDataset: true, nowMs: now });
    expect(r.headline).toBe("Empty dataset — $0.12/month dataset fee");
    expect(r.detail).toMatch(/^Paid up through about \w+ 20\d\d$/);
  });
  it("uses the on-chain rate when present", () => {
    const r = describeRunway({ availableFunds: 10n * 2880n, lockupRatePerEpoch: 1n, datasetBytes: 0, known: true, hasDataset: true, nowMs: now });
    expect(r.detail).toBe("Add funds soon — about 10 days left");
  });
  it("before connect, an empty dataset still names the fee", () => {
    const r = describeRunway({ availableFunds: 0n, lockupRatePerEpoch: 0n, datasetBytes: 0, known: false, hasDataset: true });
    expect(r.headline).toBe("Empty dataset — $0.12/month dataset fee");
  });
  it("no dataset at all is the only no-cost case", () => {
    expect(describeRunway({ availableFunds: 0n, lockupRatePerEpoch: 0n, datasetBytes: 0, known: true, hasDataset: false }).headline).toBe("Nothing stored yet — no ongoing cost");
  });
  it("a dataset with files and no rate read yet is not billed at $0.00", () => {
    const r = describeRunway({ availableFunds: 10n ** 18n, lockupRatePerEpoch: 0n, datasetBytes: 100, known: true, hasDataset: true, nowMs: now });
    expect(r.detail).toContain("$0.12/month");
  });
});
