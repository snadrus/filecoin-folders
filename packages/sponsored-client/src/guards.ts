import {
  MAX_PIECE_KEY_BYTES,
  MAX_PIECE_KEYS,
  MAX_PIECE_VALUE_BYTES,
  VERSION_KEY,
  type Storage,
} from "fil-folders";

export const DRIVE_METADATA_KEYS = new Set(["label", "path", "ipfsRootCID"]);

export const PAYMENTS_BLOCKED = [
  "deposit",
  "approve",
  "approveService",
  "depositWithPermit",
  "depositWithPermitAndApproveOperator",
] as const;

export class SponsoredGuardError extends Error {
  override name = "SponsoredGuardError";
}

function utf8Len(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Reject piece metadata that is not Filecoin Drive's 3 keys (label, path, ipfsRootCID). */
export function assertDriveMetadata(metadata: Record<string, string>): void {
  const keys = Object.keys(metadata);
  if (keys.length > MAX_PIECE_KEYS) {
    throw new SponsoredGuardError(`Piece metadata may have at most ${MAX_PIECE_KEYS} keys (got ${keys.length}).`);
  }
  for (const key of keys) {
    if (key === VERSION_KEY || !DRIVE_METADATA_KEYS.has(key)) {
      throw new SponsoredGuardError(`Piece metadata key "${key}" is not allowed. Use only label, path, and ipfsRootCID (version lives on the registry).`);
    }
    if (utf8Len(key) > MAX_PIECE_KEY_BYTES) {
      throw new SponsoredGuardError(`Piece metadata key "${key}" exceeds ${MAX_PIECE_KEY_BYTES} bytes.`);
    }
    const value = metadata[key] ?? "";
    if (utf8Len(value) > MAX_PIECE_VALUE_BYTES) {
      throw new SponsoredGuardError(`Piece metadata "${key}" exceeds ${MAX_PIECE_VALUE_BYTES} bytes.`);
    }
  }
}

export function guardStorage(storage: Storage): Storage {
  return {
    ...storage,
    async put(data, options) {
      if (options?.metadata) assertDriveMetadata(options.metadata);
      return storage.put(data, options);
    },
  };
}

export function guardSponsoredSynapse(synapse: { payments: Record<string, unknown>; storage: { createContext: Function; createContexts?: Function } }): void {
  for (const name of PAYMENTS_BLOCKED) {
    const method = synapse.payments[name];
    if (typeof method !== "function") continue;
    synapse.payments[name] = async () => {
      throw new SponsoredGuardError(`Sponsored accounts must not call payments.${name}. Buy credits with buySponsoredCredits.`);
    };
  }
  const storage = synapse.storage;
  const originalCreateContext = storage.createContext.bind(storage);
  storage.createContext = async (options?: { dataSetId?: bigint | number | string }) => {
    if (options?.dataSetId == null) {
      throw new SponsoredGuardError("Sponsored accounts must not create datasets. Call createSponsoredDataset.");
    }
    return originalCreateContext(options);
  };
  if (typeof storage.createContexts === "function") {
    const originalCreateContexts = storage.createContexts.bind(storage);
    storage.createContexts = async (options?: { dataSetId?: bigint | number | string; dataSetIds?: unknown[] }) => {
      const hasId = options?.dataSetId != null || (Array.isArray(options?.dataSetIds) && options.dataSetIds.length > 0);
      if (!hasId) {
        throw new SponsoredGuardError("Sponsored accounts must not create datasets. Call createSponsoredDataset.");
      }
      return originalCreateContexts(options);
    };
  }
}
