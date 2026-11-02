import { decodeCar, MemoryStorage, openVolume, unpadPiece } from "fil-folders";
import { afterEach, describe, expect, it } from "vitest";
import { DriveApp } from "../src/drive-app.js";
import { sniffMime } from "../src/loose.js";
import { appLink } from "../src/model.js";
import { createMockOnboarding } from "../src/mock-onboarding.js";
import { prepareOnboarding } from "../src/onboarding-controller.js";
import { dropOp, isBlankFelContent, loadOps, newOp, OPS_KEY, upsertOp } from "../src/ops.js";
import { describeRunway, formatUsd, quoteFromLive, fallbackQuote } from "../src/pricing.js";
import { observeRegistry, openMockSession } from "../src/session.js";
import { loadSavedView } from "../src/volume-persist.js";

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

function memoryPieces(volume: { storage: unknown }): Map<string, Uint8Array> {
  const pieces = (volume.storage as { inner?: { pieces?: Map<string, Uint8Array> } }).inner?.pieces;
  if (!pieces) throw new Error("memory pieces missing");
  return pieces;
}

async function headCar(volume: { storage: unknown; history: () => Promise<{ pieceCid: string }[]> }) {
  const history = await volume.history();
  const piece = memoryPieces(volume).get(history.at(-1)?.pieceCid ?? "");
  if (!piece) throw new Error("head piece missing");
  return decodeCar(unpadPiece(piece));
}

async function settle(app: DriveApp): Promise<void> {
  await Promise.resolve();
  await app.settled;
  await app.settled;
}

describe("pricing and runway", () => {
  it("turns live storage fields into a quote", () => {
    const quote = quoteFromLive({ perTiBNoCdn: 2n * 10n ** 18n, perTiBWithCdn: 3n * 10n ** 18n, minimumPricePerMonth: 10n ** 17n, ratePerMonth: 10n ** 16n });
    expect(quote.source).toBe("live");
    expect(quote.perTiBPerMonth).toBe(2n * 10n ** 18n);
    expect(formatUsd(0n)).toBe("$0.00");
    expect(formatUsd(1n)).toBe("< $0.01");
  });

  it("describes empty, low, dated, and huge runways", () => {
    expect(describeRunway({ availableFunds: 0n, lockupRatePerEpoch: 0n, datasetBytes: 0, known: true }).headline).toBe("Nothing stored yet — no ongoing cost");
    const low = describeRunway({ availableFunds: 21n * 2880n, lockupRatePerEpoch: 1n, datasetBytes: 100, known: true, nowMs: Date.UTC(2026, 0, 1) });
    expect(low.headline).toBe("Add funds soon — about 3 weeks left");
    expect(low.low).toBe(true);
    expect(low.showAdd).toBe(true);
    const now = Date.UTC(2026, 0, 15);
    const target = Date.UTC(2030, 6, 15);
    const epochs = BigInt(Math.round((target - now) / 1000 / 30));
    const dated = describeRunway({ availableFunds: epochs, lockupRatePerEpoch: 1n, datasetBytes: 1200, known: true, nowMs: now });
    expect(dated.headline).toBe("Your files are paid up through about July 2030");
    expect(dated.detail).toContain("Dataset total");
    const huge = describeRunway({ availableFunds: 10n ** 30n, lockupRatePerEpoch: 1n, datasetBytes: 10, known: true });
    expect(huge.headline).toBe("Your files are paid up for 100+ years");
    const flat = describeRunway({ availableFunds: 10n, lockupRatePerEpoch: 0n, datasetBytes: 10, known: true });
    expect(flat.headline).toBe("Your files are paid up for 100+ years");
    const offline = describeRunway({ availableFunds: 0n, lockupRatePerEpoch: 0n, datasetBytes: 15, known: false });
    expect(offline.headline).toBe("Dataset total 15 B");
    expect(offline.detail).toContain("Connect a wallet");
  });
});

describe("editor links and save records", () => {
  it("keeps piece cid and name and resolves a relative editor on this origin", () => {
    const link = appLink("felarumi", "bafy", "a.felarumi", { felarumi: "./fipen/", felanumio: "./figrid/" }, {
      href: "https://fifolder.scionbase.ai/",
      path: "/Felarumi/a.felarumi",
      volume: "My Drive",
      owner: "0xabc",
    });
    const url = new URL(link);
    expect(url.origin).toBe("https://fifolder.scionbase.ai");
    expect(url.pathname).toBe("/fipen/");
    expect(url.searchParams.get("fifolders")).toBe("1");
    expect(url.searchParams.get("pieceCid")).toBe("bafy");
    expect(url.searchParams.get("name")).toBe("a.felarumi");
    expect(url.searchParams.get("path")).toBe("/Felarumi/a.felarumi");
  });

  it("drops aged and finished ops and ignores a blank template", () => {
    expect(isBlankFelContent(JSON.stringify({ v: 1, type: "doc", content: [{ type: "paragraph", text: "" }] }))).toBe(true);
    expect(isBlankFelContent(JSON.stringify({ v: 1, type: "doc", content: [{ type: "paragraph", text: "hi" }] }))).toBe(false);
    const stale = newOp({ id: "old", kind: "upload", label: "old", stage: "uploading" });
    stale.updated = Date.now() - 31 * 24 * 60 * 60 * 1000;
    upsertOp(stale);
    upsertOp(newOp({ id: "done", kind: "upload", label: "done", status: "done", stage: "uploaded" }));
    upsertOp(newOp({ id: "keep", kind: "fel-save", label: "Notes", path: "/Felarumi/Notes.felarumi", name: "Notes.felarumi", stage: "pending" }));
    const ids = loadOps().map((op) => op.id);
    expect(ids).toContain("keep");
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("done");
    expect(localStorage.getItem(OPS_KEY)).toContain("keep");
    dropOp("keep");
    expect(loadOps()).toEqual([]);
  });
});

describe("drive feedback", () => {
  it("shows chain steps, then the drive, and restores the last folder", async () => {
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
    const io = createMockOnboarding(new URLSearchParams("pay=ready&datasets=1&ens=andy.eth"));
    await prepareOnboarding(app, io);
    app.mount(root);
    await settle(app);
    expect(root.querySelector("[data-testid=costs]")).toBeNull();
    expect(root.querySelector("[data-testid=connect-wallet]")).toBeTruthy();
    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(app);
    expect(root.querySelector("[data-testid=chain-steps]")).toBeNull();
    root.querySelector<HTMLButtonElement>("[data-testid=txlog-toggle]")!.click();
    expect(root.querySelector("[data-testid=txlog] [data-testid=chain-steps]")).toBeTruthy();
    const steps = [...root.querySelectorAll("[data-testid=chain-step]")].map((node) => node.textContent ?? "");
    expect(steps.join(" ")).toContain("Waiting for wallet signature");
    expect(steps.join(" ")).toContain("Transaction submitted");
    expect(steps.join(" ")).toContain("Confirming");
    expect(steps.join(" ")).toContain("Authorized");
    expect(root.querySelector("[data-testid=tx-link]")?.getAttribute("href")).toContain("calibration.filfox.info");
    root.querySelector<HTMLButtonElement>("[data-testid=txlog-toggle]")!.click();
    expect(root.querySelector("[data-testid=txlog]")).toBeNull();
    expect(root.querySelector("[data-testid=account-label]")?.textContent).toBe("andy.eth");
    expect(root.querySelector("[data-testid=account-identicon]")).toBeTruthy();
    root.querySelector<HTMLButtonElement>("[data-testid=account]")!.click();
    expect(root.querySelector("[data-testid=chain-calibration]")).toBeTruthy();
    expect(root.querySelector("[data-testid=advanced-editors]")?.hasAttribute("open")).toBe(false);
    expect(root.querySelector("[data-testid=storage-meter]")).toBeNull();
    expect(root.querySelector("[data-testid=storage-runway]")).toBeTruthy();

    const saved = loadSavedView(app.owner, app.volumeName);
    expect(saved?.nav).toBe("drive");
  });

  it("rehydrates a pending save and uploads it once the editor writes content", async () => {
    upsertOp(
      newOp({
        id: "save-1",
        kind: "fel-save",
        label: "Notes.felarumi",
        path: "/Felarumi/Notes.felarumi",
        name: "Notes.felarumi",
        volume: "My Drive",
        stage: "saving",
        content: JSON.stringify({ v: 1, type: "doc", content: [{ type: "paragraph", text: "hello" }] }),
      }),
    );
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
    await settle(app);
    expect(new TextDecoder().decode(await session.volume.get("/Felarumi/Notes.felarumi"))).toContain("hello");
    expect(session.registry.commits).toBe(1);
    const first = await headCar(session.volume);
    expect(memoryPieces(session.volume).size).toBe(1);
    expect(new TextDecoder().decode(first.blocks.get(first.root)!)).toContain("Notes.felarumi");
    expect([...first.blocks.values()].some((block) => new TextDecoder().decode(block).includes("hello"))).toBe(true);
    expect(first.blocks.size).toBeGreaterThan(1);
    expect(loadOps().some((op) => op.id === "save-1")).toBe(false);
    expect(root.textContent).toContain("saved");

    upsertOp(
      newOp({
        id: "save-2",
        kind: "fel-save",
        label: "Notes.felarumi",
        path: "/Felarumi/Notes.felarumi",
        name: "Notes.felarumi",
        volume: session.volumeName,
        stage: "saving",
        content: JSON.stringify({ v: 1, type: "doc", content: [{ type: "paragraph", text: "edited" }] }),
      }),
    );
    const root2 = document.createElement("div");
    document.body.appendChild(root2);
    const app2 = new DriveApp({
      volume: session.volume,
      owner: session.owner,
      chain: "calibration",
      encrypted: false,
      volumeName: session.volumeName,
      cas: session.cas,
      felarumiUrl: "./felarumi/",
      felanumioUrl: "./felanumio/",
    });
    app2.mount(root2);
    await settle(app2);
    expect(new TextDecoder().decode(await session.volume.get("/Felarumi/Notes.felarumi"))).toContain("edited");
    expect(session.registry.commits).toBe(2);
    expect(memoryPieces(session.volume).size).toBe(2);
    const second = await headCar(session.volume);
    expect(new TextDecoder().decode(second.blocks.get(second.root)!)).toContain("Notes.felarumi");
    expect([...second.blocks.values()].some((block) => new TextDecoder().decode(block).includes("edited"))).toBe(true);
    expect(second.blocks.size).toBeGreaterThan(1);
  });

  it("lists a loose piece and warns before unload while an upload is pending", async () => {
    const storage = new MemoryStorage();
    const observed = observeRegistry(new (await import("fil-folders")).MemoryRegistry("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
    const volume = await openVolume({ storage, registry: observed.registry, owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", name: "Loose" });
    await volume.put("/kept.txt", new TextEncoder().encode("kept"));
    const extra = new Uint8Array(200);
    extra.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await storage.put(extra);
    expect(sniffMime("pic.bin", extra)).toBe("image/png");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume,
      owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      chain: "calibration",
      encrypted: false,
      volumeName: "Loose",
      cas: observed.cas,
      felarumiUrl: "./felarumi/",
      felanumioUrl: "./felanumio/",
    });
    app.mount(root);
    await settle(app);
    root.querySelector<HTMLButtonElement>("[data-testid=nav-loose]")!.click();
    await settle(app);
    expect(root.querySelector("[data-testid=loose-row]")).toBeTruthy();
    expect(root.querySelector("[data-testid=loose-download]")).toBeTruthy();
    upsertOp(newOp({ id: "up", kind: "upload", label: "big.bin", path: "/big.bin", name: "big.bin", stage: "uploading" }));
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("reported bugs", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  function setupApp(): { app: DriveApp; root: HTMLElement } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume: null,
      owner: "",
      chain: "calibration",
      encrypted: false,
      volumeName: "My Drive",
      cas: { takeMerged: () => false },
      felarumiUrl: "./felarumi/",
      felanumioUrl: "./felanumio/",
    });
    return { app, root };
  }

  const panel = (selected: string) => ({
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    fil: "1",
    usdfc: "5",
    deposit: "5",
    availableFunds: "",
    lockupRate: "",
    paymentsReady: true,
    sessionReady: false,
    sessionExpiry: "",
    datasets: [
      { id: "1", label: "One", pieceCount: "0", created: "", size: "0", providerId: "1" },
      { id: "2", label: "Two", pieceCount: "0", created: "", size: "0", providerId: "1" },
    ] as never,
    selectedDatasetId: selected,
    createPrimary: false,
    legacyRegistry: false,
    signatures: 0,
    connectPrompts: 0,
  });

  it("keeps a clicked dataset when a stale snapshot re-renders the session pop-up (bug 1)", async () => {
    const { app, root } = setupApp();
    const saved: string[] = [];
    app.onPickDataset = (id) => saved.push(id);
    app.mount(root);
    app.showPanel(panel("1"));
    expect(root.querySelector("[data-testid=setup]")).toBeTruthy();
    expect(root.querySelector("[data-testid=drive-pending]")).toBeTruthy();
    const two = [...root.querySelectorAll<HTMLInputElement>("[data-testid=dataset-choice]")].find((input) => input.value === "2")!;
    two.checked = true;
    two.dispatchEvent(new Event("change", { bubbles: true }));
    app.showPanel(panel("1"));
    const checked = root.querySelector<HTMLInputElement>("[data-testid=dataset-choice]:checked");
    expect(checked?.value).toBe("2");
    expect(saved).toEqual(["2"]);
  });

  it("goes straight into the newest dataset's drive with no setup page when payment and dataset exist (bugs 2, 4)", async () => {
    const { app, root } = setupApp();
    const io = createMockOnboarding(new URLSearchParams("pay=ready&datasets=2"));
    await prepareOnboarding(app, io);
    app.mount(root);
    await settle(app);
    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(app);
    await settle(app);
    expect(app.volume).toBeTruthy();
    expect(root.querySelector("[data-testid=setup]")).toBeNull();
    expect(root.querySelector("[data-testid=nav-drive]")).toBeTruthy();
  });

  it("shows a boot error instead of a blank page (bug 5)", () => {
    const { app, root } = setupApp();
    app.mount(root);
    app.showBootError("RPC exploded");
    expect(root.querySelector("[data-testid=connect-error]")?.textContent).toContain("RPC exploded");
  });

  it("lists loose pieces from a dataset that only exposes list(), like Synapse (bug 7)", async () => {
    const memory = new MemoryStorage();
    const listOnly = {
      put: (data: Uint8Array) => memory.put(data),
      get: (cid: string) => memory.get(cid),
      list: () => memory.list(),
    };
    const observed = observeRegistry(new (await import("fil-folders")).MemoryRegistry("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
    const { withPiecePadding } = await import("fil-folders");
    const volume = await openVolume({ storage: withPiecePadding(listOnly as never), registry: observed.registry, owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", name: "Live" });
    await volume.put("/kept.txt", new TextEncoder().encode("kept"));
    await listOnly.put(new TextEncoder().encode("orphan bytes"));
    const { app, root } = setupApp();
    app.attach({
      volume,
      owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      chain: "calibration",
      encrypted: false,
      volumeName: "Live",
      cas: observed.cas,
      felarumiUrl: "./felarumi/",
      felanumioUrl: "./felanumio/",
      encryptPref: false,
    });
    app.mount(root);
    await settle(app);
    root.querySelector<HTMLButtonElement>("[data-testid=nav-loose]")!.click();
    await settle(app);
    expect(root.querySelectorAll("[data-testid=loose-row]").length).toBe(1);
    expect(root.querySelector("[data-testid=loose-summary]")?.textContent).toMatch(/pieces: \d+ in folders, \d+ manifests, 1 loose/);
  });
});

describe("editor title names the file (item 8)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("renames an untitled document to the editor title, and keeps a FiFolders rename", async () => {
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
    const doc = (text: string) => JSON.stringify({ v: 1, type: "doc", content: [{ type: "paragraph", text }] });
    const origin = "/FiPen/Untitled document.fipen";
    upsertOp(newOp({ id: "fel:" + origin, kind: "fel-save", label: "x", path: origin, name: "Untitled document.fipen", volume: session.volumeName, stage: "saving", content: doc("one") }));
    app.mount(root);
    await settle(app);
    expect(new TextDecoder().decode(await session.volume.get(origin))).toContain("one");
    upsertOp(newOp({ id: "fel:" + origin, kind: "fel-save", label: "x", path: origin, name: "Untitled document.fipen", title: "Trip plan", volume: session.volumeName, stage: "saving", content: doc("two") }));
    await (app as unknown as { refresh: () => Promise<void> }).refresh();
    await settle(app);
    expect(new TextDecoder().decode(await session.volume.get("/FiPen/Trip plan.fipen"))).toContain("two");
    await expect(session.volume.stat(origin)).rejects.toThrow();
    upsertOp(newOp({ id: "fel:" + origin, kind: "fel-save", label: "x", path: origin, name: "Untitled document.fipen", title: "Trip plan", volume: session.volumeName, stage: "saving", content: doc("three") }));
    await (app as unknown as { refresh: () => Promise<void> }).refresh();
    expect(new TextDecoder().decode(await session.volume.get("/FiPen/Trip plan.fipen"))).toContain("three");
  });
});
