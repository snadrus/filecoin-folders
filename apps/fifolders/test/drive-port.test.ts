import { encodeCar, contentCid } from "fil-folders";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIRMATION_CHECK_LIMIT,
  recoverReplication,
  replicatePiece,
  selectCopyProviders,
  type UploadCheckpoint,
} from "../src/copies.js";
import { DownloadQueue } from "../src/downloads.js";
import { DriveApp } from "../src/drive-app.js";
import { IPFS_CHECK_LIMIT, reserveIndexingCheck, runIndexingCheck } from "../src/indexing.js";
import { canPreviewName, fileShareLink } from "../src/links.js";
import { matchesQuery } from "../src/model.js";
import { readNetworkPreference, REGISTRY_NOT_DEPLOYED, registryReady, saveNetworkPreference } from "../src/network.js";
import { qrSvg } from "../src/qr.js";
import { confirmWalletTransaction, resolveTransactionReceipt } from "../src/receipts.js";
import { DeletionConfirmationPendingError, piecesEligibleForRemoval, schedulePieceRemovals } from "../src/removal.js";
import { applyTheme } from "../src/theme.js";
import { connectWalletConnect, walletChoices, walletConnectConfig } from "../src/wallets.js";
import { openMockSession } from "../src/session.js";

describe("two copies, recovery, and checkpoints", () => {
  it("selects two different providers and keeps a confirmed copy when the other fails", async () => {
    const picked = await selectCopyProviders(
      [
        { providerId: "1", serviceURL: "https://down.example", endorsed: true },
        { providerId: "2", serviceURL: "https://a.example", endorsed: true },
        { providerId: "2", serviceURL: "https://dup.example", endorsed: true },
        { providerId: "3", serviceURL: "https://b.example", endorsed: false },
      ],
      {
        ping: async (url) => {
          if (url.includes("down")) throw new Error("unreachable");
        },
      },
    );
    expect(picked.providers.map((provider) => provider.providerId)).toEqual(["2", "3"]);
    expect(picked.reduced).toBe(false);

    const calls: string[] = [];
    const checkpoint = await replicatePiece("piece", picked.providers, async (provider) => {
      calls.push(provider.providerId);
      if (provider.providerId === "3") throw new Error("rejected");
      return { transactionHash: "0x1", pieceId: "9" };
    });
    expect(calls).toEqual(["2", "3"]);
    expect(checkpoint.phase).toBe("complete");
    expect(checkpoint.providers.find((provider) => provider.providerId === "2")?.confirmed).toBe(true);
    expect(checkpoint.providers.find((provider) => provider.providerId === "3")?.rejected).toBe(true);
    expect(JSON.stringify(checkpoint)).not.toMatch(/Uint8Array|file bytes/);

    const retry = await replicatePiece("piece", picked.providers, async () => ({ transactionHash: "0x2" }), checkpoint);
    expect(retry.providers.find((provider) => provider.providerId === "2")?.transactionHash).toBe("0x1");
    expect(calls).toEqual(["2", "3"]);
  });

  it("proceeds with fewer providers and throws when none are reachable", async () => {
    const reduced = await selectCopyProviders([{ providerId: "9", serviceURL: "https://only.example" }], {
      existingProviderIds: ["1"],
      copies: 2,
    });
    expect(reduced.providers).toHaveLength(1);
    expect(reduced.reduced).toBe(true);
    await expect(selectCopyProviders([{ providerId: "1", serviceURL: "https://down.example", endorsed: true }], {
      ping: async () => {
        throw new Error("down");
      },
    })).rejects.toThrow("No reachable storage providers available");
  });

  it("does not resubmit a slow confirmation and stops at the check limit", async () => {
    const pending: UploadCheckpoint = {
      phase: "confirming",
      expectedCopies: 2,
      pieceCid: "piece",
      checks: 0,
      nextCheckAt: 0,
      providers: [
        { providerId: "1", serviceURL: "https://a.example", transactionHash: "0x1" },
        { providerId: "2", serviceURL: "https://b.example", confirmed: true, transactionHash: "0x2" },
      ],
    };
    let polls = 0;
    const next = await recoverReplication(pending, async () => {
      polls += 1;
      return "timeout";
    });
    expect(polls).toBe(1);
    expect(next.phase).toBe("pending");
    expect(next.error).toMatch(/does not mean your upload failed/);
    expect(next.providers[0]?.transactionHash).toBe("0x1");
    expect(next.providers[0]?.rejected).toBeUndefined();

    const capped = await recoverReplication({ ...next, checks: CONFIRMATION_CHECK_LIMIT }, async () => {
      polls += 1;
      return "rejected";
    });
    expect(polls).toBe(1);
    expect(capped.checks).toBe(CONFIRMATION_CHECK_LIMIT);

    const rejected = await recoverReplication(
      {
        ...pending,
        providers: pending.providers.map((provider) => ({ ...provider, confirmed: false, transactionHash: provider.transactionHash })),
      },
      async () => "rejected",
    );
    expect(rejected.phase).toBe("failed");

    const closed = await recoverReplication({ ...pending, pieceCid: undefined, phase: "uploading" }, async () => "pending");
    expect(closed.phase).toBe("interrupted");
  });
});

describe("share links, CAR import, and search", () => {
  it("shares a gateway URL for a normal file and a piece URL for an unchanged CAR", async () => {
    const cid = "bafyfile";
    expect(canPreviewName("photo.png", cid)).toBe(true);
    expect(canPreviewName("photo.bin", cid)).toBe(false);
    const share = fileShareLink({ name: "photo.png", cid, uploadComplete: true });
    expect(share).toBe("https://ipfs.io/ipfs/bafyfile?filename=photo.png");
    expect(fileShareLink({ name: "photo.png", cid, removalScheduled: true })).toBeUndefined();
    expect(fileShareLink({ name: "photo.png", cid, uploadComplete: false })).toBeUndefined();
    const piece = fileShareLink({
      name: "drop.car",
      cid: "bafyroot",
      pieceCid: "bagapiece",
      importedCar: true,
      serviceURLs: ["javascript:alert(1)", "https://sp.example/pdp"],
    });
    expect(piece).toBe("https://sp.example/piece/bagapiece");
    expect(qrSvg(share!)).toContain("<svg");
    expect(qrSvg(share!)).toContain("currentColor");

    const payload = new TextEncoder().encode("same-bytes");
    const root = await contentCid(payload);
    const archive = encodeCar(root, new Map([[root, payload]]));
    const copy = archive.slice();
    const { app, root: view } = await mount();
    const fileBytes = new Uint8Array(archive.byteLength);
    fileBytes.set(archive);
    await app.uploadFiles([new File([fileBytes], "drop.car", { type: "application/vnd.ipld.car" })]);
    const stat = await app.volume!.stat("/drop.car");
    expect(stat.importedCar).toBe(true);
    expect(stat.ipfs).toBe(root);
    expect(await app.volume!.get("/drop.car")).toEqual(copy);
    view.querySelector<HTMLElement>("[data-testid=entry]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }));
    view.querySelector<HTMLButtonElement>("[data-action=details]")!.click();
    await app.settled;
    expect(view.querySelector("[data-testid=imported-car]")?.textContent).toMatch(/stored unchanged/);
    expect(view.querySelector("[data-testid=ipfs-cid]")?.textContent).toBe(root);
    expect(view.querySelector("[data-testid=share-qr] svg")).toBeTruthy();
  });

  it("matches names and paths", () => {
    expect(matchesQuery({ name: "cat.txt", path: "/Photos/cat.txt" }, "photos")).toBe(true);
    expect(matchesQuery({ name: "cat.txt", path: "/Photos/cat.txt" }, "dog")).toBe(false);
  });
});

describe("real delete checkpoints", () => {
  it("schedules every copy only when the live manifest no longer references the piece", async () => {
    expect(piecesEligibleForRemoval(["a", "b", "a"], new Set(["b"]))).toEqual(["a"]);
    const persisted: string[] = [];
    let submits = 0;
    const file = { pieceCid: "piece", datasetIds: ["10", "11"], checkpoints: {} as Record<string, { transactionHash?: string; confirmed?: boolean }> };
    await schedulePieceRemovals(
      file,
      async (datasetId, next) => {
        persisted.push(`${datasetId}:${next?.transactionHash ?? ""}:${next?.confirmed}`);
        if (next) file.checkpoints[datasetId] = next;
      },
      {
        async listPieceIds() {
          return ["4", "5"];
        },
        async scheduled() {
          return new Set(["4"]);
        },
        async submit(_datasetId, ids) {
          submits += 1;
          expect(ids).toEqual(["5"]);
          return { hash: "0xdel" };
        },
        async resolve() {
          return { status: "success", hash: "0xdel" };
        },
      },
    );
    expect(submits).toBe(2);
    expect(persisted[0]).toBe("10:0xdel:false");
    expect(file.checkpoints["10"]?.confirmed).toBe(true);
    expect(file.checkpoints["11"]?.confirmed).toBe(true);

    let second = 0;
    file.datasetIds = ["10"];
    file.checkpoints = { "10": { transactionHash: "0xdel", confirmed: false } };
    await expect(
      schedulePieceRemovals(
        file,
        async () => undefined,
        {
          async listPieceIds() {
            return ["5"];
          },
          async scheduled() {
            return new Set();
          },
          async submit() {
            second += 1;
            return { hash: "0xagain" };
          },
          async resolve() {
            return { status: "pending" };
          },
        },
      ),
    ).rejects.toBeInstanceOf(DeletionConfirmationPendingError);
    expect(second).toBe(0);
    expect(file.checkpoints["10"]?.transactionHash).toBe("0xdel");
  });
});

describe("wallet transactions, indexing, downloads, theme, network, wallets", () => {
  it("recovers a slow or replaced transaction without resubmitting", async () => {
    const calls: string[] = [];
    const client = {
      async getTransactionReceipt() {
        return null;
      },
      async request(args: { method: string }) {
        calls.push(args.method);
        if (args.method === "Filecoin.EthGetMessageCidByTransactionHash") return { "/": "bafymsg" };
        if (args.method === "Filecoin.StateSearchMsg") return { Message: { "/": "bafymsg" }, Receipt: { ExitCode: 0 } };
        return null;
      },
    };
    const found = await resolveTransactionReceipt(client, { hash: "0x1" });
    expect(found.status).toBe("success");
    expect(found.messageCid).toBe("bafymsg");

    const replaced = await resolveTransactionReceipt(
      {
        async getTransactionReceipt() {
          return null;
        },
        async request(args: { method: string }) {
          if (args.method === "Filecoin.EthGetMessageCidByTransactionHash") return { "/": "bafymsg" };
          throw { details: "message was replaced: abc NOT a valid replacement message" };
        },
      },
      { hash: "0x1" },
    );
    expect(replaced.status).toBe("replaced");

    let submits = 0;
    const hashes: string[] = [];
    const pending = await confirmWalletTransaction({
      hash: "0xslow",
      persist: async (row) => {
        hashes.push(row.hash);
      },
      resolve: async () => ({ status: "pending", messageCid: "bafymsg" }),
      wait: async () => "timeout",
    });
    expect(pending.status).toBe("pending");
    expect(hashes[0]).toBe("0xslow");
    expect(submits).toBe(0);
  });

  it("bounds indexing checks and does not treat a miss as failure", async () => {
    const store = {
      records: {} as Record<string, { attempts: number; nextAt: number; indexed?: boolean }>,
      read() {
        return this.records;
      },
      write(records: typeof this.records) {
        this.records = records;
      },
    };
    let now = 1_000;
    for (let i = 0; i < IPFS_CHECK_LIMIT; i += 1) {
      const reserved = reserveIndexingCheck(store, "cid", now);
      expect(reserved?.attempts).toBe(i + 1);
      now = reserved!.nextAt;
    }
    expect(reserveIndexingCheck(store, "cid", now)).toBeNull();
    store.records = {};
    const missed = await runIndexingCheck(store, "cid", async () => {
      throw new Error("timeout");
    });
    expect(missed?.indexed).toBeUndefined();
    expect(missed?.attempts).toBe(1);
    const indexed = await runIndexingCheck(store, "other", async () => true, missed!.nextAt);
    expect(indexed?.indexed).toBe(true);
  });

  it("runs one download at a time and cancels only queued jobs", async () => {
    const queue = new DownloadQueue();
    queue.scope = "scope";
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.enqueue({
      id: "a",
      name: "a",
      cid: "cid-a",
      run: async () => {
        order.push("a");
        await gate;
      },
    });
    queue.enqueue({
      id: "a",
      name: "a",
      cid: "cid-a",
      run: async () => {
        order.push("dup");
      },
    });
    queue.enqueue({
      id: "gone",
      name: "gone",
      deletionScheduled: true,
      cid: "x",
      run: async () => {
        order.push("gone");
      },
    });
    queue.enqueue({
      id: "b",
      name: "b",
      cid: "cid-b",
      run: async () => {
        order.push("b");
      },
    });
    queue.cancel("b");
    queue.cancel("a");
    release();
    await queue.idle;
    expect(order).toEqual(["a"]);
    expect(queue.pending).toHaveLength(0);
  });

  it("always uses the light palette", () => {
    const root = document.createElement("html");
    applyTheme(root);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("remembers the network and treats an unset mainnet registry as not deployed", () => {
    expect(readNetworkPreference()).toBe("calibration");
    saveNetworkPreference("mainnet");
    expect(readNetworkPreference()).toBe("mainnet");
    expect(registryReady("calibration")).toBe(true);
    expect(registryReady("mainnet", {})).toBe(false);
    expect(registryReady("mainnet", { VITE_FOLDER_REGISTRY_MAINNET: "0xabc" })).toBe(true);
    expect(REGISTRY_NOT_DEPLOYED).toBe("Registry not deployed");
  });

  it("lists WalletConnect beside named wallets and restores a session without pairing", async () => {
    expect(walletChoices([{ rdns: "io.metamask", name: "MetaMask" }]).map((wallet) => wallet.name)).toEqual([
      "MetaMask",
      "WalletConnect",
    ]);
    expect(walletChoices([{ rdns: "window.ethereum", name: "Browser wallet" }]).map((wallet) => wallet.rdns)).toEqual([
      "window.ethereum",
      "walletconnect",
    ]);
    const config = walletConnectConfig("https://fidrive.example", "calibration", "project");
    expect(config.metadata.name).toBe("FiFolders");
    expect(config.metadata.icons.join(" ")).not.toMatch(/filecoin-mark/);
    expect(config.showQrModal).toBe(true);
    expect(config.optionalChains).toEqual([314, 314159]);
    let paired = 0;
    const restored = await connectWalletConnect({
      network: "calibration",
      origin: "https://fidrive.example",
      init: async (options) => {
        expect(options.metadata.name).toBe("FiFolders");
        return {
          session: { expiry: Date.now() / 1000 + 60 },
          accounts: ["0xabc"],
          connect: async () => {
            paired += 1;
          },
        };
      },
    });
    expect(paired).toBe(0);
    expect(restored.address).toBe("0xabc");
  });
});

describe("DriveApp polish", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    document.documentElement.dataset.theme = "";
  });

  it("searches paths, quotes before upload, queues downloads, and shows registry not deployed", async () => {
    const session = await openMockSession();
    const root = document.createElement("div");
    document.body.appendChild(root);
    let connects = 0;
    const app = new DriveApp({
      volume: session.volume,
      owner: session.owner,
      chain: "calibration",
      encrypted: false,
      volumeName: session.volumeName,
      cas: session.cas,
      felarumiUrl: "https://felarumi.example",
      felanumioUrl: "https://felanumio.example",
      onConnect: async () => {
        connects += 1;
      },
      quoteUpload: async () => ({ ready: true }),
    });
    app.mount(root);
    await app.settled;
    root.querySelector<HTMLButtonElement>("[data-testid=new-button]")!.click();
    root.querySelector<HTMLButtonElement>("[data-action=new-folder]")!.click();
    const input = root.querySelector<HTMLInputElement>("[data-testid=dialog-input]")!;
    input.value = "Photos";
    input.form?.requestSubmit();
    await app.settled;
    const folder = [...root.querySelectorAll<HTMLElement>("[data-testid=entry]")].find((node) => node.textContent?.includes("Photos"));
    folder!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await app.settled;
    await app.uploadFiles([new File(["cat"], "cat.txt", { type: "text/plain" })]);
    const search = root.querySelector<HTMLInputElement>("[data-testid=search]")!;
    search.value = "photos";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await app.settled;
    expect(root.textContent).toContain("cat.txt");

    const before = session.registry.commits;
    app.quoteUpload = async () => ({ ready: false, depositNeeded: 10n ** 18n, needsApproval: true });
    await app.uploadFiles([new File(["nope"], "nope.txt", { type: "text/plain" })]);
    expect(session.registry.commits).toBe(before);
    expect(root.textContent).toMatch(/Deposit at least 1 more USDFC/);

    root.querySelector<HTMLButtonElement>("[data-testid=account]")!.click();
    root.querySelector<HTMLButtonElement>("[data-testid=chain-mainnet]")!.click();
    expect(root.querySelector("[data-testid=mainnet-banner]")?.textContent).toBe("Registry not deployed");
    expect(connects).toBe(0);
    expect(readNetworkPreference()).toBe("mainnet");
  });

  it("queues a download and checks indexing without failing the file", async () => {
    const { app, root } = await mount();
    await app.uploadFiles([new File(["hello"], "note.txt", { type: "text/plain" })]);
    const entry = root.querySelector<HTMLElement>("[data-testid=entry]")!;
    entry.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }));
    root.querySelector<HTMLButtonElement>("[data-action=download]")!.click();
    await app.settled;
    expect(root.querySelector("[data-testid=download-finished]")?.textContent).toContain("note.txt");

    root.querySelector<HTMLElement>("[data-testid=entry]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }));
    root.querySelector<HTMLButtonElement>("[data-action=details]")!.click();
    await app.settled;
    expect(root.querySelector("[data-testid=indexing-status]")?.textContent).toBe("Not checked");
    expect(root.querySelector("[data-testid=share-link]")?.getAttribute("href")).toMatch(/^https:\/\/ipfs\.io\/ipfs\//);
    root.querySelector<HTMLButtonElement>("[data-testid=check-indexing]")!.click();
    await app.settled;
    expect(root.querySelector("[data-testid=indexing-status]")?.textContent).toBe("Checking 1/5");
    expect(root.querySelector("[data-testid=entry]")?.textContent).toContain("note.txt");
  });

  it("schedules removals for an unreferenced piece across both local copies", async () => {
    const { app, root } = await mount();
    await app.uploadFiles([new File(["a"], "a.txt", { type: "text/plain" })]);
    const entry = root.querySelector<HTMLElement>("[data-testid=entry]")!;
    entry.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }));
    root.querySelector<HTMLButtonElement>("[data-action=trash]")!.click();
    await app.settled;
    root.querySelector<HTMLButtonElement>("[data-testid=nav-trash]")!.click();
    await app.settled;
    root.querySelector<HTMLElement>("[data-testid=entry]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }));
    root.querySelector<HTMLButtonElement>("[data-action=delete-forever]")!.click();
    await app.settled;
    root.querySelector<HTMLButtonElement>("[data-testid=save-changes]")!.click();
    await app.settled;
    const raw = localStorage.getItem(`fifolders:removals:${app.owner.toLowerCase()}:My Drive`);
    expect(raw).toBeTruthy();
    expect(raw).toContain("local-a");
    expect(raw).toContain("local-b");
    expect(raw).toContain("0xlocal");
  });
});

async function mount() {
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
