import { describe, expect, it, vi } from "vitest";
import { assertDriveMetadata, DRIVE_METADATA_KEYS, guardSponsoredSynapse, guardStorage, SponsoredGuardError } from "../src/guards.js";
import type { Storage } from "fil-folders";

describe("assertDriveMetadata", () => {
  it("allows Drive's three keys", () => {
    expect(() => assertDriveMetadata({ label: "profile.json", path: "FiPerson", ipfsRootCID: "bafkreiabc" })).not.toThrow();
  });

  it("allows a subset of the three keys", () => {
    expect(() => assertDriveMetadata({ label: "a", path: "" })).not.toThrow();
  });

  it("rejects version (registry holds version)", () => {
    expect(() => assertDriveMetadata({ label: "a", path: "b", version: "1" })).toThrow(SponsoredGuardError);
    expect(() => assertDriveMetadata({ label: "a", path: "b", version: "1" })).toThrow(/version/);
  });

  it("rejects a fourth key", () => {
    expect(() => assertDriveMetadata({ label: "a", path: "b", ipfsRootCID: "c", extra: "d" })).toThrow(/at most 3 keys/);
  });

  it("rejects unknown keys", () => {
    expect(() => assertDriveMetadata({ name: "file" })).toThrow(/not allowed/);
  });

  it("rejects values over 96 bytes", () => {
    expect(() => assertDriveMetadata({ label: "x".repeat(97) })).toThrow(/96 bytes/);
  });

  it("DRIVE_METADATA_KEYS is exactly the Drive set", () => {
    expect([...DRIVE_METADATA_KEYS].sort()).toEqual(["ipfsRootCID", "label", "path"]);
  });
});

describe("guardStorage", () => {
  it("forwards puts with Drive metadata and blocks version", async () => {
    const puts: unknown[] = [];
    const inner = {
      async put(data: Uint8Array, options?: { metadata?: Record<string, string> }) {
        puts.push(options?.metadata);
        return { pieceCid: "bafk", size: data.byteLength };
      },
      async get() {
        return new Uint8Array();
      },
    } as unknown as Storage;
    const storage = guardStorage(inner);
    await storage.put(new Uint8Array(8), { metadata: { label: "a", path: "b" } });
    expect(puts).toEqual([{ label: "a", path: "b" }]);
    await expect(storage.put(new Uint8Array(8), { metadata: { label: "a", version: "2" } })).rejects.toThrow(SponsoredGuardError);
  });
});

describe("guardSponsoredSynapse", () => {
  function fakeSynapse() {
    const created: unknown[] = [];
    const synapse = {
      payments: {
        deposit: async () => "0xdeposit",
        approveService: async () => "0xapprove",
        depositWithPermitAndApproveOperator: async () => "0xcombo",
        accountInfo: async () => ({ funds: 1n }),
      },
      storage: {
        createContext: async (options?: { dataSetId?: bigint }) => {
          created.push(options);
          return { dataSetId: options?.dataSetId ?? 99n };
        },
        createContexts: async (options?: { dataSetIds?: bigint[] }) => {
          created.push(options);
          return [];
        },
      },
    };
    guardSponsoredSynapse(synapse);
    return { synapse, created };
  }

  it("blocks payment deposits and approvals", async () => {
    const { synapse } = fakeSynapse();
    await expect(synapse.payments.deposit()).rejects.toThrow(/must not call payments.deposit/);
    await expect(synapse.payments.approveService()).rejects.toThrow(/approveService/);
    await expect(synapse.payments.depositWithPermitAndApproveOperator()).rejects.toThrow(/depositWithPermitAndApproveOperator/);
    await expect(synapse.payments.accountInfo()).resolves.toEqual({ funds: 1n });
  });

  it("blocks dataset creation but allows createContext with a dataSetId", async () => {
    const { synapse, created } = fakeSynapse();
    await expect(synapse.storage.createContext()).rejects.toThrow(/must not create datasets/);
    await expect(synapse.storage.createContexts()).rejects.toThrow(/must not create datasets/);
    await expect(synapse.storage.createContext({ dataSetId: 7n })).resolves.toEqual({ dataSetId: 7n });
    expect(created).toEqual([{ dataSetId: 7n }]);
  });
});
