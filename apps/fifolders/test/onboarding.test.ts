import { folderCommitPermission } from "fil-folders";
import { afterEach, describe, expect, it } from "vitest";
import { DriveApp } from "../src/drive-app.js";
import { createMockOnboarding } from "../src/mock-onboarding.js";
import { prepareOnboarding, resumeOnboarding } from "../src/onboarding-controller.js";
import { OPS_KEY } from "../src/ops.js";
import {
  SESSION_PERMISSION_ERROR,
  SESSION_RENEW_MARGIN_SEC,
  SESSION_WARN_SEC,
  SIGNATURES,
  chooseDataset,
  fifoldersPermissions,
  isSessionPermissionError,
  paymentsReady,
  saveSession,
  sessionGateFromExpiries,
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
    expect(chooseDataset([{ id: "a" }, { id: "b" }], null)).toEqual({ selectedId: "b", auto: true });
    expect(chooseDataset([{ id: "12" }, { id: "9" }, { id: "provider:3" }], null)).toEqual({ selectedId: "12", auto: true });
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
    expect(fifoldersPermissions()).toHaveLength(5);
    expect(fifoldersPermissions()).toContain(folderCommitPermission());
    expect(SIGNATURES.firstTimePaymentsReady).toBe(1);
    expect(SIGNATURES.firstTimePaymentsMissing).toBe(3);
    expect(SIGNATURES.returning).toBe(0);
  });

  it("requires every permission to clear the margin, and warns inside a day", () => {
    const now = 1_000_000n;
    const ok = now + BigInt(SESSION_WARN_SEC) + 10n;
    const soon = now + 12n * 60n * 60n;
    const margin = now + BigInt(SESSION_RENEW_MARGIN_SEC);
    expect(sessionGateFromExpiries([ok, ok, ok, ok, ok], now)).toBe("ok");
    expect(sessionGateFromExpiries([ok, soon, ok, ok, ok], now)).toBe("soon");
    expect(sessionGateFromExpiries([ok, ok, ok, margin, ok], now)).toBe("expired");
    expect(sessionGateFromExpiries([ok, 0n, ok, ok, ok], now)).toBe("expired");
    expect(sessionGateFromExpiries([], now)).toBe("expired");
    expect(isSessionPermissionError(new Error(SESSION_PERMISSION_ERROR))).toBe(true);
    expect(isSessionPermissionError(`wrapped: ${SESSION_PERMISSION_ERROR}`)).toBe(true);
    expect(isSessionPermissionError(new Error("dataset was not created"))).toBe(false);
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
    // Storage payment is asked for up front, before the session key.
    expect(root.querySelector("[data-testid=fix-payments]")).toBeTruthy();
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toContain("Wallet signatures 0");

    root.querySelector<HTMLButtonElement>("[data-testid=fix-payments]")?.click();
    await settle(app);
    // Lazy session key: payment takes 2 signatures; creating the dataset (the first write) authorizes the key.
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toContain("Wallet signatures 2");

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

describe("lazy session key (Andy decision 1-3)", () => {
  it("Connect asks for no session key; the first upload authorizes it, shows progress, then saves", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume: null, owner: "", chain: "calibration", encrypted: false, volumeName: "My Drive",
      cas: { takeMerged: () => false }, felarumiUrl: "https://felarumi.example", felanumioUrl: "https://felanumio.example",
    });
    const io = createMockOnboarding(new URLSearchParams("pay=ready&datasets=1&authdelay=150"));
    await prepareOnboarding(app, io);
    app.mount(root);
    await app.settled;
    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(app);
    expect(root.querySelector("[data-testid=nav-drive]")).toBeTruthy();
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("0");
    const pending = app.uploadFiles([new File(["hi"], "lazy.txt", { type: "text/plain" })]);
    await until(() => root.querySelector("[data-testid=setup-note]")?.textContent?.includes("Setting up your wallet session") === true);
    await until(() => root.querySelector("[data-testid=upload-title]")?.textContent?.includes("waiting for wallet setup") === true);
    await pending;
    await until(() => root.querySelector("[data-testid=wallet-signatures]")?.textContent === "1");
    await settle(app);
    expect((await app.volume!.ls("/")).some((e) => e.name === "lazy.txt")).toBe(true);
    expect(root.querySelector("[data-testid=upload-title]")?.textContent).toContain("complete");
  });

  it("Disconnect session and refund forgets the key; the next save authorizes again", async () => {
    const { app, root } = await openMockDrive();
    if (!root.querySelector("[data-testid=refund-session]")) root.querySelector<HTMLElement>("[data-action=account]")?.click();
    expect(root.querySelector("[data-testid=refund-session]")).toBeTruthy();
    root.querySelector<HTMLElement>("[data-testid=refund-session]")?.click();
    await settle(app);
    expect(root.textContent).toContain("refunded to your wallet");
    if (!root.querySelector("[data-testid=account-menu]")) root.querySelector<HTMLElement>("[data-action=account]")?.click();
    expect(root.querySelector("[data-testid=session-status]")?.textContent).toContain("Session key missing");
    await app.uploadFiles([new File(["x"], "after.txt", { type: "text/plain" })]);
    await until(() => root.querySelector("[data-testid=wallet-signatures]")?.textContent === "2");
    await settle(app);
    expect((await app.volume!.ls("/")).some((e) => e.name === "after.txt")).toBe(true);
  });
});

describe("expired session key renews and retries", () => {
  it("keeps the upload queued, renews the same key with one signature, then stores the file", async () => {
    const { app, root } = await openMockDrive();
    const before = readStoredSession();
    setMockExpiry(-60);
    const pending = app.uploadFiles([new File(["hello"], "note.txt", { type: "text/plain" })]);
    await until(() => root.querySelector("[data-testid=session-renew]")?.textContent?.includes("Reconnect wallet session") === true);
    expect(root.querySelector("[data-testid=txlog-toggle] [data-testid=txlog-spinner]")).toBeTruthy();
    expect(root.querySelector(".setup-backdrop")).toBeNull();
    const queued = loadOpsFile();
    expect(queued.some((op) => op.kind === "commit" && op.status === "pending")).toBe(true);
    expect(queued.some((op) => op.status === "error")).toBe(false);
    expect(root.textContent).not.toContain("does not have the required permissions");

    root.querySelector<HTMLButtonElement>("[data-testid=session-renew-button]")?.click();
    await pending;
    await settle(app);

    const names = (await app.volume!.ls("/")).map((entry) => entry.name);
    expect(names).toContain("note.txt");
    expect(root.querySelector("[data-testid=session-renew]")).toBeNull();
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("2");
    expect(root.textContent).not.toContain("does not have the required permissions");
    const after = readStoredSession();
    expect(after.sessionAddress).toBe(before.sessionAddress);
    expect(BigInt(after.expiry)).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)) + 6n * 24n * 60n * 60n);
    expect(loadOpsFile().some((op) => op.name === "note.txt" && op.status === "error")).toBe(false);
  });

  it("routes the Synapse permission error into the same renew-and-retry path", async () => {
    const { app, root } = await openMockDrive();
    const volume = app.volume!;
    const original = volume.tx.bind(volume);
    let calls = 0;
    let depth = 0;
    volume.tx = async (fn) => {
      // Staged saves replay into the draft with nested tx calls; count top-level saves only.
      if (depth === 0) calls += 1;
      if (calls === 1 && depth === 0) throw new Error(SESSION_PERMISSION_ERROR);
      depth += 1;
      try {
        return await original(fn);
      } finally {
        depth -= 1;
      }
    };
    const pending = app.uploadFiles([new File(["again"], "retry.txt", { type: "text/plain" })]);
    await until(() => root.querySelector("[data-testid=session-renew]")?.getAttribute("data-prompt") === "expired");
    expect(loadOpsFile().some((op) => op.kind === "commit" && op.status === "pending")).toBe(true);
    expect(root.textContent).not.toContain("does not have the required permissions");
    root.querySelector<HTMLButtonElement>("[data-testid=session-renew-button]")?.click();
    await pending;
    await settle(app);
    expect(calls).toBe(2);
    expect((await app.volume!.ls("/")).map((entry) => entry.name)).toContain("retry.txt");
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("2");
    expect(root.textContent).not.toContain("does not have the required permissions");
  });

  it("prompts when the key expires within a day and still completes the upload", async () => {
    const { app, root } = await openMockDrive();
    setMockExpiry(12 * 60 * 60);
    const pending = app.uploadFiles([new File(["soon"], "soon.txt", { type: "text/plain" })]);
    await pending;
    await settle(app);
    expect(root.querySelector("[data-testid=txlog-spinner]")).toBeTruthy();
    root.querySelector<HTMLButtonElement>("[data-testid=txlog-toggle]")!.click();
    const banner = root.querySelector("[data-testid=session-renew]");
    expect(banner?.getAttribute("data-prompt")).toBe("soon");
    expect(banner?.textContent).toContain("Reconnect wallet session");
    expect(banner?.textContent).toContain("ends soon");
    expect((await app.volume!.ls("/")).map((entry) => entry.name)).toContain("soon.txt");
    expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("1");
  });
});

async function openMockDrive(): Promise<{ app: DriveApp; root: HTMLElement }> {
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
  const io = createMockOnboarding(new URLSearchParams("pay=ready&datasets=1"));
  await prepareOnboarding(app, io);
  app.mount(root);
  await app.settled;
  root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle(app);
  expect(root.querySelector("[data-testid=nav-drive]")).toBeTruthy();
  // Lazy session key: Connect asks for nothing; the key is authorized at the first save (or here, by hand).
  expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("0");
  root.querySelector<HTMLElement>("[data-action=account]")?.click();
  root.querySelector<HTMLElement>("[data-testid=authorize-session]")?.click();
  await settle(app);
  expect(root.querySelector("[data-testid=wallet-signatures]")?.textContent).toBe("1");
  return { app, root };
}

function readStoredSession(): { sessionAddress: string; expiry: string; privateKey: string } {
  const key = Object.keys(localStorage).find((item) => item.startsWith("fifolders:session:"));
  if (!key) throw new Error("missing session");
  return JSON.parse(localStorage.getItem(key) ?? "{}") as { sessionAddress: string; expiry: string; privateKey: string };
}

function setMockExpiry(secondsFromNow: number): void {
  const session = readStoredSession();
  const expiry = (Math.floor(Date.now() / 1000) + secondsFromNow).toString();
  const key = Object.keys(localStorage).find((item) => item.startsWith("fifolders:session:"));
  if (!key) throw new Error("missing session");
  localStorage.setItem(key, JSON.stringify({ ...session, expiry }));
  const book = JSON.parse(localStorage.getItem("fifolders:mock-registry") || "{}") as Record<string, string>;
  book[`0x70997970c51812dc3a010c7d01b50e0d17dc79c8:${session.sessionAddress.toLowerCase()}`] = expiry;
  localStorage.setItem("fifolders:mock-registry", JSON.stringify(book));
}

function loadOpsFile(): { kind: string; status: string; name?: string }[] {
  const parsed = JSON.parse(localStorage.getItem(OPS_KEY) || "{\"ops\":[]}") as { ops?: { kind: string; status: string; name?: string }[] };
  return parsed.ops ?? [];
}

async function until(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 2000) throw new Error("timed out waiting for the session banner");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("storage-payment approval check (matches synapse-core isFwssMaxApproved)", () => {
  it("treats a plain approval as missing and a max approval as ready", async () => {
    const { isMaxApproved } = await import("../src/live-onboarding.js");
    const max = 2n ** 256n - 1n;
    expect(isMaxApproved({ isApproved: true, rateAllowance: 10n, lockupAllowance: 10n, maxLockupPeriod: 86400n })).toBe(false);
    expect(isMaxApproved({ isApproved: true, rateAllowance: max, lockupAllowance: max, maxLockupPeriod: 86400n })).toBe(true);
    expect(isMaxApproved({ isApproved: true, rateAllowance: max, lockupAllowance: max, maxLockupPeriod: 100n })).toBe(false);
    expect(isMaxApproved([true, max, max, 0n, 0n, 86400n])).toBe(true);
    expect(isMaxApproved(null)).toBe(false);
  });
});
