import { describe, expect, it } from "vitest";
import { MemoryRegistry, MemoryStorage, createSynapseStorage, decodeCar, encodeCar, openVolume, readCarRoots } from "../src/index.js";
import { text } from "./helpers.js";

const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

describe("recorded IPFS roots and live piece references", () => {
  it("stores an imported CAR's root without rewriting the file bytes", async () => {
    const payload = text("archive-bytes");
    const root = await (await import("../src/car.js")).contentCid(payload);
    const archive = encodeCar(root, new Map([[root, payload]]));
    const before = archive.slice();
    expect(readCarRoots(archive)).toEqual([root]);
    expect(archive).toEqual(before);
    expect(decodeCar(archive).root).toBe(root);

    const volume = await openVolume({
      storage: new MemoryStorage(),
      registry: new MemoryRegistry(owner),
      owner,
      name: "notes",
    });
    await volume.put("/drop.car", archive, { mime: "application/vnd.ipld.car", ipfs: root, importedCar: true });
    const stat = await volume.stat("/drop.car");
    expect(stat.ipfs).toBe(root);
    expect(stat.importedCar).toBe(true);
    expect(await volume.get("/drop.car")).toEqual(archive);
  });

  it("drops a storage piece from the live set only after nothing references it", async () => {
    const volume = await openVolume({
      storage: new MemoryStorage(),
      registry: new MemoryRegistry(owner),
      owner,
      name: "notes",
    });
    await volume.put("/a.txt", text("a"));
    const first = (await volume.history()).at(-1)?.pieceCid ?? "";
    await volume.put("/b.txt", text("b"));
    const second = (await volume.history()).at(-1)?.pieceCid ?? "";
    expect(await volume.referencedPieces()).toEqual(expect.arrayContaining([first, second]));
    await volume.rm("/a.txt");
    const live = await volume.referencedPieces();
    expect(live).not.toContain(first);
    expect(live).toContain(second);
    const head = (await volume.history()).at(-1)?.pieceCid ?? "";
    expect(live).toContain(head);
  });
});

describe("synapse copies and funding quote", () => {
  it("quotes the real piece and keeps a confirmed copy when the other provider fails", async () => {
    const notices: unknown[] = [];
    let prepared: bigint[] = [];
    let uploadedWith: unknown;
    const synapse = {
      storage: {
        async createContext() {
          return { provider: { id: 1n, pdp: { serviceURL: "https://a.example" } }, dataSetId: 9n };
        },
        async createContexts() {
          return [{ provider: { id: 2n, pdp: { serviceURL: "https://b.example" } }, dataSetId: 10n }];
        },
        async prepare(options: { pieceSizes: bigint[] }) {
          prepared = options.pieceSizes;
          return { costs: { ready: true, depositNeeded: 0n } };
        },
        async upload(_data: Uint8Array, options: { callbacks?: { onPiecesAdded?: (hash: string, id: bigint) => void } }) {
          uploadedWith = options;
          options.callbacks?.onPiecesAdded?.("0xabc", 1n);
          return {
            pieceCid: "bafybei",
            size: 4,
            requestedCopies: 2,
            complete: false,
            copies: [{ providerId: 1n, dataSetId: 9n, pieceId: 3n, retrievalUrl: "https://a.example/piece/x" }],
            failedAttempts: [{ providerId: 2n, error: "unreachable" }],
          };
        },
        async download() {
          return new Uint8Array();
        },
      },
    };
    const storage = createSynapseStorage(synapse, { dataSetId: 9n, onReplication: (notice) => notices.push(JSON.parse(JSON.stringify(notice))) });
    const stored = await storage.put(new Uint8Array([1, 2, 3, 4]));
    expect(prepared).toEqual([4n]);
    expect(stored.pieceCid).toBe("bafybei");
    const last = notices.at(-1) as { phase: string; providers: { providerId: string; confirmed?: boolean; rejected?: boolean; transactionHash?: string }[] };
    expect(last.phase).toBe("complete");
    expect(last.providers.find((provider) => provider.providerId === "1")?.confirmed).toBe(true);
    expect(last.providers.find((provider) => provider.providerId === "1")?.transactionHash).toBe("0xabc");
    expect(last.providers.find((provider) => provider.providerId === "2")?.rejected).toBe(true);
    expect(JSON.stringify(last)).not.toContain("bytes");
    expect(uploadedWith).toBeTruthy();
  });

  it("refuses the upload when the quote is not ready", async () => {
    let uploads = 0;
    const synapse = {
      storage: {
        async createContexts() {
          return [
            { provider: { id: 1n, pdp: { serviceURL: "https://a.example" } } },
            { provider: { id: 2n, pdp: { serviceURL: "https://b.example" } } },
          ];
        },
        async prepare() {
          return { costs: { ready: false, depositNeeded: 2n * 10n ** 18n, needsFwssMaxApproval: true } };
        },
        async upload() {
          uploads += 1;
          return { pieceCid: "nope", size: 1 };
        },
        async download() {
          return new Uint8Array();
        },
      },
    };
    const storage = createSynapseStorage(synapse);
    await expect(storage.put(new Uint8Array([1]))).rejects.toThrow(/Deposit at least 2 more USDFC for these 2 storage copies/);
    await expect(storage.put(new Uint8Array([1]))).rejects.toThrow(/Approve storage payments/);
    expect(uploads).toBe(0);
  });

  it("throws when no provider can be selected", async () => {
    const synapse = {
      storage: {
        async createContexts() {
          return [];
        },
        async upload() {
          return { pieceCid: "nope", size: 1 };
        },
        async download() {
          return new Uint8Array();
        },
      },
    };
    const storage = createSynapseStorage(synapse);
    await expect(storage.put(new Uint8Array([1]))).rejects.toThrow("No reachable storage providers available");
  });
});
