import { assertSupportedRuntime } from "../runtime.js";
import type { SynapseLike } from "../types.js";
import type { Storage } from "./types.js";

/**
 * Storage adapter for `@filoz/synapse-sdk` (`synapse.storage.upload` / `download`).
 * Install `@filoz/synapse-sdk` in the app. The SDK needs `Array.fromAsync` and
 * `Promise.withResolvers` (Node.js 22+ or a current browser).
 */
export interface SynapseStorageOptions {
  /**
   * Synapse dataset that receives new pieces. This is the volume's storage
   * backend: the registry head still names the manifest, and these piece CIDs
   * live in the dataset.
   */
  dataSetId?: bigint;
  /** Used when the dataset does not exist yet and the first upload should open one with this provider. */
  providerId?: bigint;
}

export function createSynapseStorage(synapse: SynapseLike, options: SynapseStorageOptions = {}): Storage {
  assertSupportedRuntime();
  const uploadOptions =
    options.dataSetId != null
      ? { dataSetIds: [options.dataSetId] }
      : options.providerId != null
        ? { providerIds: [options.providerId] }
        : undefined;
  return {
    async put(data) {
      const result = await synapse.storage.upload(data, uploadOptions);
      const pieceCid = pieceCidString(result.pieceCid);
      const size = asSize(result.size, data instanceof Uint8Array ? data.byteLength : Number.NaN);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("Synapse upload did not return a piece size");
      }
      return { pieceCid, size };
    },
    async get(pieceCid) {
      const bytes = await synapse.storage.download({ pieceCid });
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    },
  };
}

function pieceCidString(pieceCid: { toString(): string } | string): string {
  if (typeof pieceCid === "string" && pieceCid.length > 0) return pieceCid;
  if (pieceCid && typeof pieceCid === "object") {
    const text = pieceCid.toString();
    if (text.length > 0 && text !== "[object Object]") return text;
  }
  throw new Error("Synapse upload did not return a pieceCid");
}

function asSize(size: number | bigint | undefined, fallback: number): number {
  if (typeof size === "number" && Number.isFinite(size)) return size;
  if (typeof size === "bigint" && size <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(size);
  return fallback;
}
