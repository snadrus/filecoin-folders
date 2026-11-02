import { folderCommitPermission } from "fil-folders";
import { afterEach, describe, expect, it } from "vitest";
import { DriveApp } from "../src/drive-app.js";
import { createMockOnboarding } from "../src/mock-onboarding.js";
import { prepareOnboarding, resumeOnboarding } from "../src/onboarding-controller.js";
import {
  SIGNATURES,
  chooseDataset,
  fifoldersPermissions,
  paymentsReady,
  saveSession,
  sessionUsable,
} from "../src/onboarding-logic.js";

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

/** happy-dom delivers some clicks as microtasks, after `settled` was read. */
async function settle(app: DriveApp): Promise<void> {
  await Promise.resolve();
  await app.settled;
  await app.settled;
}

describe("onboarding choices", () => {
  it("selects the last-used dataset, otherwise the only one", () => {
    expect(chooseDataset([{ id: "a" }, { id: "b" }], "b")).toEqual({ selectedId: "b", auto: true });
    expect(chooseDataset([{ id: "a" }], null)).toEqual({ selectedId: "a", auto: true });
    expect(chooseDataset([{ id: "a" }, { id: "b" }], null)).toEqual({ selectedId: null, auto: false });
    expect(chooseDataset([], "a")).toEqual({ selectedId: null, auto: false });
  });

  it("treats payment as ready only with a deposit and operator approval", () => {
    expect(paymentsReady(0n, true)).toBe(false);
    expect(paymentsReady(1n, false)).toBe(false);
    expect(paymentsReady(1n, true)).toBe(true);
  });

  it("keeps a session key only while the stored expiry has slack", () => {
    const session = {
      v: 1 as const,
      chainId: 314159,
      root: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
      privateKey: "0x11" as const,
      sessionAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const,
      expiry: "1000",
    };
    expect(sessionUsable(session, 900n)).toBe(true);
    expect(sessionUsable(session, 950n)).toBe(false);
    expect(fifoldersPermissions()).toContain(folderCommitPermission());
    expect(SIGNATURES.firstTimePaymentsReady).toBe(1);
    expect(SIGNATURES.firstTimePaymentsMissing).toBe(3);
    expect(SIGNATURES.returning).toBe(0);
  });
});

describe("mocked wallet and SessionKeyRegistry", () => {
  it("authorizes once, fixes payment, creates a dataset, then resumes with no signature", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume: null,
      owner: "",
      chain: "calibration",
      encrypted: false,
      volumeName: "My Drive",
      cas: { takeMerged: () => false },
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
    });
    const io = createMockOnboarding(new URLSearchParams(""));
    await prepareOnboarding(app, io);
    app.mount(root);
    await app.settled;

    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(app);
    expect(root.querySelector("[data-testid=setup]")).toBeTruthy();
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toContain("Wallet signatures 1");
    expect(root.querySelector("[data-testid=session-status]")?.textContent).toContain("Session key ready");

    root.querySelector<HTMLButtonElement>("[data-testid=fix-payments]")?.click();
    await settle(app);
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toContain("Wallet signatures 3");

    root.querySelector<HTMLButtonElement>("[data-testid=create-dataset]")?.click();
    await settle(app);
    expect(root.querySelector("[data-testid=nav-drive]")).toBeTruthy();
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("3");

    const again = document.createElement("div");
    document.body.appendChild(again);
    const resumed = new DriveApp({
      volume: null,
      owner: "",
      chain: "calibration",
      encrypted: false,
      volumeName: "My Drive",
      cas: { takeMerged: () => false },
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
    });
    const next = createMockOnboarding(new URLSearchParams(""));
    await prepareOnboarding(resumed, next);
    expect(await resumeOnboarding(resumed, next)).toBe(true);
    resumed.mount(again);
    await resumed.settled;
    expect(again.querySelector("[data-testid=nav-drive]")).toBeTruthy();
    expect(again.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("0");
  });

  it("does not resume an expired session key", async () => {
    saveSession({
      v: 1,
      chainId: 314159,
      root: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      privateKey: "0x11",
      sessionAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      expiry: "1",
    });
    localStorage.setItem("fifolders:wallet-permitted", "1");
    localStorage.setItem("fifolders:mock-registry", JSON.stringify({}));
    const app = new DriveApp({
      volume: null,
      owner: "",
      chain: "calibration",
      encrypted: false,
      volumeName: "My Drive",
      cas: { takeMerged: () => false },
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
    });
    const io = createMockOnboarding(new URLSearchParams("pay=ready&datasets=1"));
    await prepareOnboarding(app, io);
    expect(await resumeOnboarding(app, io)).toBe(false);
    expect(app.volume).toBeNull();
  });
});
