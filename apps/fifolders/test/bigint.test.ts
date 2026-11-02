import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stat } from "fil-folders";
import { formatBytes, formatWhen, sortStats, sumSizes, toBigInt, toNumber } from "../src/model.js";
import { describeRunway, formatUsd } from "../src/pricing.js";
import { DriveApp } from "../src/drive-app.js";
import { newOp, upsertOp } from "../src/ops.js";
import { openMockSession } from "../src/session.js";

const stat = (name: string, size: unknown, mtime: unknown): Stat => ({ name, path: `/${name}`, type: "file", size, mtime } as unknown as Stat);

describe("bigint chain values never mix with numbers", () => {
  it("normalizes sizes, times, funds, and rates from live code paths", () => {
    expect(toNumber(5n)).toBe(5);
    expect(toNumber("12")).toBe(12);
    expect(toBigInt(7)).toBe(7n);
    expect(toBigInt("9")).toBe(9n);
    const entries = [stat("a", 10n, 1_700_000_000_000n), stat("b", 5, 1_700_000_000_001), { ...stat("dir", 0, Date.now()), type: "dir" } as Stat];
    expect(sumSizes(entries)).toBe(15);
    expect(sortStats(entries, "size", 1, false).map((e) => e.name)).toEqual(["dir", "b", "a"]);
    expect(() => sortStats(entries, "mtime", -1, true)).not.toThrow();
    expect(formatBytes(2048n as unknown as number)).toBe("2 KB");
    expect(formatWhen(1_700_000_000_000n as unknown as number)).not.toBe("—");
    expect(formatUsd(10n ** 18n)).toBe("$1.00");
    expect(formatUsd(1e18 as unknown as bigint)).toBe("$1.00");
    const runway = describeRunway({
      availableFunds: 5n * 10n ** 18n,
      lockupRatePerEpoch: 1000 as unknown as bigint,
      datasetBytes: 4096n as unknown as number,
      known: true,
    });
    expect(runway.headline).toBeTruthy();
  });
});

describe("activity rows auto-dismiss", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows a progress bar on a finished row, removes it after 10 s, keeps and dismisses failures", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const session = await openMockSession();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume: session.volume,
      owner: session.owner,
      chain: "calibration",
      encrypted: false,
      volumeName: session.volumeName,
      cas: session.cas,
      felarumiUrl: "./felarumi/",
      felanumioUrl: "./felanumio/",
    });
    app.mount(root);
    upsertOp(newOp({ id: "bad", kind: "upload", label: "broken.bin", path: "/broken.bin", name: "broken.bin", stage: "pending", status: "error", error: "boom" } as never));
    const op = app.beginOp({ kind: "dataset", label: "Create dataset", stage: "pending" });
    app.finishOp(op);
    (app as unknown as { render: () => void }).render();
    expect(root.querySelector("[data-testid=activity-progress]")).toBeTruthy();
    expect(root.textContent).toContain("Create dataset");
    vi.advanceTimersByTime(10_001);
    expect(root.textContent).not.toContain("Create dataset");
    expect(root.querySelector("[data-testid=activity-progress]")).toBeNull();
    expect(root.textContent).toContain("broken.bin");
    root.querySelector<HTMLButtonElement>("[data-testid=dismiss-activity]")!.click();
    expect(root.textContent).not.toContain("broken.bin");
  });
});
