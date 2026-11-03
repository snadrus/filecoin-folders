import { buildIdentity, guestName, writeIdentityCache } from "fiperson/edit";
import { MemoryRegistry, MemoryStorage, openVolume, type Registry } from "fil-folders";
import { AUTOSAVE_UPLOADS_KEY } from "../src/staged.js";
import { afterEach, describe, expect, it } from "vitest";
import { DriveApp } from "../src/drive-app.js";
import { observeRegistry, openMockSession } from "../src/session.js";

const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

async function mountMock() {
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
    felarumiUrl: "https://felarumi.example",
    felanumioUrl: "https://felanumio.example",
  });
  app.mount(root);
  await app.settled;
  return { app, root, session };
}

function entry(root: ParentNode, name: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>("[data-testid=entry]")].find((node) => node.textContent?.includes(name));
}

describe("DriveApp", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows the wallet identity in the account menu and links to /identity/", async () => {
    const { app, root } = await mountMock();
    root.querySelector<HTMLButtonElement>("[data-testid=account]")!.click();
    const summary = root.querySelector("[data-testid=identity-summary]")!;
    expect(summary).toBeTruthy();
    expect(root.querySelector("[data-testid=display-name]")).toBeNull();
    const link = root.querySelector<HTMLAnchorElement>("[data-testid=identity-edit]")!;
    expect(link.getAttribute("href")).toMatch(/^\.\/identity\/\?return=/);
    expect(link.textContent).toBe("Set up identity");
    expect(summary.textContent).toContain(guestName(app.owner));
    writeIdentityCache(app.owner, { identity: buildIdentity(app.owner, { displayName: "Andy J" }), pieceCid: "p" });
    root.querySelector<HTMLButtonElement>("[data-testid=account]")!.click();
    root.querySelector<HTMLButtonElement>("[data-testid=account]")!.click();
    expect(root.querySelector("[data-testid=identity-name]")!.textContent).toBe("Andy J");
    expect(root.querySelector("[data-testid=identity-edit]")!.textContent).toBe("Edit identity");
  });

  it("creates a folder, uploads two files in one commit, renames, trashes, and restores", async () => {
    const { app, root, session } = await mountMock();
    expect(root.querySelector("[data-testid=nav-drive]")).toBeTruthy();
    root.querySelector<HTMLButtonElement>("[data-testid=new-button]")!.click();
    root.querySelector<HTMLButtonElement>("[data-action=new-folder]")!.click();
    const input = root.querySelector<HTMLInputElement>("[data-testid=dialog-input]")!;
    input.value = "Photos";
    input.form?.requestSubmit();
    await app.settled;
    expect(entry(root, "Photos")).toBeTruthy();

    const before = session.registry.commits;
    await app.uploadFiles([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]);
    expect(session.registry.commits).toBe(before + 1);
    expect(entry(root, "one.txt")).toBeTruthy();
    expect(root.querySelector("[data-testid=upload-panel]")).toBeTruthy();

    entry(root, "one.txt")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 12 }));
    root.querySelector<HTMLButtonElement>("[data-action=rename]")!.click();
    await app.settled;
    const rename = root.querySelector<HTMLInputElement>("[data-testid=dialog-input]")!;
    rename.value = "renamed.txt";
    rename.form?.requestSubmit();
    await app.settled;
    expect(entry(root, "renamed.txt")).toBeTruthy();

    entry(root, "renamed.txt")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 12 }));
    root.querySelector<HTMLButtonElement>("[data-action=trash]")!.click();
    await app.settled;
    expect(entry(root, "renamed.txt")).toBeUndefined();
    root.querySelector<HTMLButtonElement>("[data-testid=nav-trash]")!.click();
    await app.settled;
    expect(entry(root, "renamed.txt")).toBeTruthy();
    entry(root, "renamed.txt")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 12 }));
    root.querySelector<HTMLButtonElement>("[data-action=restore]")!.click();
    await app.settled;
    root.querySelector<HTMLButtonElement>("[data-testid=nav-drive]")!.click();
    await app.settled;
    expect(entry(root, "renamed.txt")).toBeTruthy();
  });

  it("toggles grid and list, previews text, and marks fel files", async () => {
    const { app, root } = await mountMock();
    root.querySelector<HTMLButtonElement>("[data-testid=view-grid]")!.click();
    expect(root.querySelector("[data-testid=browser]")?.getAttribute("data-view")).toBe("grid");
    root.querySelector<HTMLButtonElement>("[data-testid=view-list]")!.click();
    expect(root.querySelector("[data-testid=browser]")?.getAttribute("data-view")).toBe("list");

    await app.uploadFiles([
      new File(["hello folder"], "hello.txt", { type: "text/plain" }),
      new File(["{}"], "card.felarumi", { type: "application/octet-stream" }),
    ]);
    const fel = entry(root, "card.felarumi");
    expect(fel?.dataset.kind).toBe("felarumi");
    expect(fel?.querySelector(".fel-icon")).toBeTruthy();

    entry(root, "hello.txt")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await app.settled;
    expect(root.querySelector("[data-testid=preview-text]")?.textContent).toContain("hello folder");
  });

  it("selects a shift range", async () => {
    const { app, root } = await mountMock();
    await app.uploadFiles([
      new File(["a"], "a.txt", { type: "text/plain" }),
      new File(["b"], "b.txt", { type: "text/plain" }),
      new File(["c"], "c.txt", { type: "text/plain" }),
    ]);
    const clickRow = (index: number, shift = false) => {
      const rows = [...root.querySelectorAll<HTMLElement>("[data-testid=entry]")];
      rows[index]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift }));
    };
    clickRow(0);
    clickRow(2, true);
    const selected = [...root.querySelectorAll<HTMLElement>("[data-selected=true]")];
    expect(selected).toHaveLength(3);
  });

  it("toasts a merged conflict and a real conflict", async () => {
    const storage = new MemoryStorage();
    const raw = new MemoryRegistry(owner);
    const observed = observeRegistry(raw);
    let interleave: (() => Promise<void>) | null = null;
    const registry: Registry = {
      head: (o, ns, key) => raw.head(o, ns, key),
      commit: async (input) => {
        if (interleave) {
          const run = interleave;
          interleave = null;
          await run();
        }
        return observed.registry.commit(input);
      },
      setWriter: (ns, writer, allowed) => raw.setWriter(ns, writer, allowed),
      isWriter: (o, ns, writer) => raw.isWriter(o, ns, writer),
      committed: (query) => raw.committed(query),
    };
    const other = await openVolume({ storage, registry: raw, owner, name: "Vol" });
    const volume = await openVolume({ storage, registry, owner, name: "Vol" });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume,
      owner,
      chain: "calibration",
      encrypted: false,
      volumeName: "Vol",
      cas: observed.cas,
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
    });
    app.mount(root);
    await app.settled;
    interleave = () => other.put("/from-a.txt", new TextEncoder().encode("a")).then(() => undefined);
    await app.uploadFiles([new File(["b"], "from-b.txt", { type: "text/plain" })]);
    expect(root.textContent).toContain("Changes merged");
    expect(entry(root, "from-a.txt")).toBeTruthy();
    expect(entry(root, "from-b.txt")).toBeTruthy();

    interleave = () => other.put("/same.txt", new TextEncoder().encode("theirs")).then(() => undefined);
    await app.uploadFiles([new File(["ours"], "same.txt", { type: "text/plain" })]);
    expect(root.textContent).toContain("Couldn't save");
    expect(root.textContent).toContain("/same.txt");
  });

  it("creates a blank FiPen document and FiGrid spreadsheet, then opens them", async () => {
    const opened: string[] = [];
    const previous = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    try {
      const { app, root, session } = await mountMock();
      root.querySelector<HTMLButtonElement>("[data-testid=new-button]")!.click();
      expect(root.querySelector("[data-action=new-felarumi]")?.textContent).toContain("FiPen document");
      expect(root.querySelector("[data-action=new-felanumio]")?.textContent).toContain("FiGrid spreadsheet");
      root.querySelector<HTMLButtonElement>("[data-action=new-felarumi]")!.click();
      expect(root.querySelector("[data-testid=dialog-input]")).toBeNull();
      await app.settled;
      const pending = entry(root, "Untitled document.fipen");
      expect(pending?.dataset.kind).toBe("felarumi");
      expect(pending?.textContent).toContain("Save pending");
      await expect(session.volume.stat("/FiPen/Untitled document.fipen")).rejects.toThrow();
      const docUrl = new URL(opened[0] ?? "");
      expect(docUrl.origin).toBe("https://felarumi.example");
      expect(docUrl.searchParams.get("fifolders")).toBe("1");
      expect(docUrl.searchParams.get("name")).toBe("Untitled document.fipen");
      expect(docUrl.searchParams.get("path")).toBe("/FiPen/Untitled document.fipen");
      expect(docUrl.searchParams.get("pieceCid")).toBeNull();

      root.querySelector<HTMLButtonElement>("[data-testid=new-button]")!.click();
      root.querySelector<HTMLButtonElement>("[data-action=new-felanumio]")!.click();
      await app.settled;
      expect(entry(root, "Untitled spreadsheet.figrid")?.textContent).toContain("Save pending");
      const sheetUrl = new URL(opened[1] ?? "");
      expect(sheetUrl.origin).toBe("https://felanumio.example");
      expect(sheetUrl.searchParams.get("path")).toBe("/FiGrid/Untitled spreadsheet.figrid");
    } finally {
      window.open = previous;
    }
  });

  it("still lists a legacy Felarumi folder and file", async () => {
    const session = await openMockSession();
    await session.volume.mkdir("/Felarumi");
    await session.volume.put("/Felarumi/Old.felarumi", new TextEncoder().encode("{}"), { mime: "application/json" });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume: session.volume,
      owner: session.owner,
      chain: "calibration",
      encrypted: false,
      volumeName: session.volumeName,
      cas: session.cas,
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
    });
    app.mount(root);
    await app.settled;
    const folder = entry(root, "Felarumi");
    expect(folder?.dataset.type).toBe("dir");
    folder!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await app.settled;
    const file = entry(root, "Old.felarumi");
    expect(file?.dataset.kind).toBe("felarumi");
    expect(file?.querySelector(".fel-icon")).toBeTruthy();
  });

  it("keeps a new folder staged across refresh and prompts before unload", async () => {
    const { app, root, session } = await mountMock();
    const before = session.registry.commits;
    root.querySelector<HTMLButtonElement>("[data-testid=new-button]")!.click();
    root.querySelector<HTMLButtonElement>("[data-action=new-folder]")!.click();
    const input = root.querySelector<HTMLInputElement>("[data-testid=dialog-input]")!;
    input.value = "Photos";
    input.form?.requestSubmit();
    await app.settled;
    expect(session.registry.commits).toBe(before);
    expect(root.querySelector("[data-testid=save-changes]")?.textContent).toBe("Save 1 change");
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    const root2 = document.createElement("div");
    document.body.appendChild(root2);
    const app2 = new DriveApp({
      volume: session.volume,
      owner: session.owner,
      chain: "calibration",
      encrypted: false,
      volumeName: session.volumeName,
      cas: session.cas,
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
    });
    app2.mount(root2);
    await app2.settled;
    expect(root2.querySelector("[data-testid=staged-restore]")?.textContent).toBe("Restored 1 unsaved change");
    expect(entry(root2, "Photos")).toBeTruthy();
    expect(session.registry.commits).toBe(before);
    expect(await session.volume.ls("/")).toEqual([]);

    root2.querySelector<HTMLButtonElement>("[data-testid=save-changes]")!.click();
    await app2.settled;
    expect(session.registry.commits).toBe(before + 1);
    expect(root2.querySelector("[data-testid=save-changes]")).toBeNull();
    root2.querySelector<HTMLButtonElement>("[data-testid=txlog-toggle]")!.click();
    expect(root2.querySelector("[data-testid=activity]")?.textContent).toContain("Save 1 change");
    expect((await session.volume.ls("/")).map((item) => item.name)).toContain("Photos");
    expect(localStorage.getItem(`fifolders:staged:${session.owner.toLowerCase()}:${session.volumeName}`)).toBeNull();
  });

  it("holds uploads until Save when auto-save is off, and bundles them when it is on", async () => {
    localStorage.setItem(AUTOSAVE_UPLOADS_KEY, "0");
    const { app, root, session } = await mountMock();
    const before = session.registry.commits;
    await app.uploadFiles([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]);
    expect(session.registry.commits).toBe(before);
    expect(entry(root, "one.txt")).toBeTruthy();
    expect(entry(root, "two.txt")).toBeTruthy();
    expect(root.querySelector("[data-testid=save-changes]")?.textContent).toBe("Save 2 changes");
    await expect(session.volume.stat("/one.txt")).rejects.toThrow();

    root.querySelector<HTMLButtonElement>("[data-testid=account]")!.click();
    const toggle = root.querySelector<HTMLInputElement>("[data-testid=autosave-uploads]")!;
    expect(toggle.checked).toBe(false);
    root.querySelector<HTMLButtonElement>("[data-testid=save-changes]")!.click();
    await app.settled;
    expect(session.registry.commits).toBe(before + 1);
    expect(new TextDecoder().decode(await session.volume.get("/one.txt"))).toBe("one");
    expect(new TextDecoder().decode(await session.volume.get("/two.txt"))).toBe("two");
    root.querySelector<HTMLButtonElement>("[data-testid=txlog-toggle]")!.click();
    expect([...root.querySelectorAll("[data-testid=activity-item]")].filter((node) => node.textContent?.includes("Save 2 changes"))).toHaveLength(1);
  });
});
