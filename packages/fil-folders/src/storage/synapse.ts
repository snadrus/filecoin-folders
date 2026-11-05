import { formatUnits } from "viem";
import { assertSupportedRuntime } from "../runtime.js";
import type { SynapseLike } from "../types.js";
import type { Storage } from "./types.js";

/**
 * Storage adapter for `@filoz/synapse-sdk` (`synapse.storage.upload` / `download`).
 * Install `@filoz/synapse-sdk` in the app. The SDK needs `Array.fromAsync` and
 * `Promise.withResolvers` (Node.js 22+ or a current browser).
 *
 * Uploads ask for two copies on different providers. A partial success keeps the
 * confirmed copies and reports the rest through {@link SynapseStorageOptions.onReplication}.
 * `prepare` is read-only: a shortfall throws and does not deposit.
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
  /** Distinct provider copies. Defaults to 2 when the SDK can select providers. */
  copies?: number;
  /** JSON-only progress. File bytes are never included. */
  onReplication?: (notice: ReplicationNotice) => void;
  /**
   * Resolve `put` as soon as the primary provider has stored the piece and submitted the add-pieces
   * transaction, instead of waiting for on-chain confirmation (and secondary copies). Small records
   * (identity profiles) use this so the pointer commit is not stuck behind slow receipts or null rounds.
   */
  resolveOnAdded?: boolean;
  /**
   * Data-set `source` for data sets this adapter creates. Default "fifolders". Filecoin Drive lists
   * only data sets with source "filecoin-pin"; pass that (or a Drive `dataSetId`) to make files visible there.
   */
  dataSetSource?: string;
}

export interface ReplicationProvider {
  providerId: string;
  serviceURL: string;
  dataSetId?: string;
  pieceId?: string;
  transactionHash?: string;
  stored?: boolean;
  confirmed?: boolean;
  rejected?: boolean;
}

export interface ReplicationNotice {
  phase: "uploading" | "confirming" | "pending" | "failed" | "complete";
  expectedCopies: number;
  providers: ReplicationProvider[];
  error?: string;
}

interface ContextLike {
  provider?: { id?: bigint | number | string; pdp?: { serviceURL?: string } };
  providerId?: bigint | number | string;
  serviceURL?: string;
  dataSetId?: bigint | number | string;
}

interface UploadCopy {
  providerId?: bigint | number | string;
  dataSetId?: bigint | number | string;
  pieceId?: bigint | number | string;
  retrievalUrl?: string;
}

interface UploadReturn {
  pieceCid: { toString(): string } | string;
  size?: number | bigint;
  complete?: boolean;
  requestedCopies?: number;
  copies?: UploadCopy[];
  failedAttempts?: { providerId?: bigint | number | string; error?: string }[];
}

export function createSynapseStorage(synapse: SynapseLike, options: SynapseStorageOptions = {}): Storage {
  assertSupportedRuntime();
  const legacyOptions =
    options.dataSetId != null
      ? { dataSetIds: [options.dataSetId] }
      : options.providerId != null
        ? { providerIds: [options.providerId] }
        : undefined;
  return {
    async put(data, putOptions) {
      const pieceMetadata = putOptions?.metadata && Object.keys(putOptions.metadata).length ? { ...putOptions.metadata } : undefined;
      const bytes = data instanceof Uint8Array ? data : await readAll(data);
      const extended = synapse.storage as SynapseLike["storage"] & {
        prepare?: SynapseLike["storage"]["prepare"];
        createContext?: SynapseLike["storage"]["createContext"];
        createContexts?: SynapseLike["storage"]["createContexts"];
      };
      const contexts =
        typeof extended.createContexts === "function" || typeof extended.createContext === "function"
          ? await resolveContexts(extended, options)
          : [];
      if (contexts.length && typeof extended.prepare === "function") {
        // synapse-sdk 0.40 reads `dataSize`; 2.x reads `pieceSizes` (raw byte sizes) and throws without it.
        // Pass both so either SDK computes the lockup for this upload.
        const size = BigInt(bytes.byteLength);
        const prepared = await extended.prepare({ context: contexts, dataSize: size, pieceSizes: [size] } as Parameters<NonNullable<typeof extended.prepare>>[0]);
        if (prepared?.costs && prepared.costs.ready === false) {
          throw new Error(fundingShortfall(prepared.costs, contexts.length));
        }
      }
      let storedCid: string | undefined;
      let early: ((value: { pieceCid: string; size: number }) => void) | undefined;
      const earlyResult = new Promise<{ pieceCid: string; size: number }>((resolve) => (early = resolve));
      const notice = noticeFromContexts(contexts, options.copies ?? (contexts.length ? 2 : 1));
      options.onReplication?.(notice);
      const uploadOptions = contexts.length
        ? {
            contexts,
            ...(pieceMetadata ? { pieceMetadata } : {}),
            callbacks: {
              onStored: (_providerId: bigint | number | string, cid: unknown) => {
                if (cid != null) storedCid ??= pieceCidString(cid as never);
              },
              onPiecesAdded: (txHash: string, providerId: bigint | number | string) => {
                if (options.resolveOnAdded && storedCid) early?.({ pieceCid: storedCid, size: bytes.byteLength });
                const row = notice.providers.find((provider) => provider.providerId === String(providerId));
                if (row) {
                  row.transactionHash = txHash;
                  row.stored = true;
                }
                notice.phase = "confirming";
                options.onReplication?.(cloneNotice(notice));
              },
              onPiecesConfirmed: (
                dataSetId: bigint | number | string,
                providerId: bigint | number | string,
                pieces?: { pieceId?: bigint | number | string }[],
              ) => {
                const row = notice.providers.find((provider) => provider.providerId === String(providerId));
                if (row) {
                  row.confirmed = true;
                  row.stored = true;
                  row.dataSetId = String(dataSetId);
                  if (pieces?.[0]?.pieceId != null) row.pieceId = String(pieces[0].pieceId);
                }
                options.onReplication?.(cloneNotice(notice));
              },
              onCopyFailed: (providerId: bigint | number | string, _piece: unknown, error?: { message?: string }) => {
                const row = notice.providers.find((provider) => provider.providerId === String(providerId));
                if (row) {
                  row.rejected = true;
                  row.confirmed = false;
                }
                if (error?.message) notice.error = error.message;
                options.onReplication?.(cloneNotice(notice));
              },
            },
          }
        : legacyOptions || pieceMetadata
          ? { ...(legacyOptions ?? {}), ...(pieceMetadata ? { pieceMetadata } : {}) }
          : undefined;
      try {
        const uploading = synapse.storage.upload(contexts.length ? bytes : data, uploadOptions) as Promise<UploadReturn>;
        if (options.resolveOnAdded && contexts.length) {
          const first = await Promise.race([uploading.then((result) => ({ result })), earlyResult.then((done) => ({ done }))]);
          if ("done" in first) {
            uploading.then(
              (result) => {
                applyUploadResult(notice, result);
                options.onReplication?.(cloneNotice(notice));
              },
              (error: unknown) => {
                notice.error = error instanceof Error ? error.message : "Confirmation failed";
                options.onReplication?.(cloneNotice(notice));
              },
            );
            return first.done;
          }
        }
        const result = await uploading;
        const pieceCid = pieceCidString(result.pieceCid);
        const size = asSize(result.size, bytes.byteLength);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("Synapse upload did not return a piece size");
        applyUploadResult(notice, result);
        options.onReplication?.(cloneNotice(notice));
        return { pieceCid, size };
      } catch (error) {
        notice.phase = notice.providers.some((provider) => provider.confirmed || provider.transactionHash) ? "pending" : "failed";
        notice.error = error instanceof Error ? error.message : "Upload failed";
        options.onReplication?.(cloneNotice(notice));
        throw error;
      }
    },
    async list() {
      if (options.dataSetId == null) return [];
      const storage = synapse.storage as unknown as {
        createContext?: (options: unknown) => Promise<{ getPieces?: () => AsyncIterable<{ pieceCid: { toString(): string } | string }> }>;
      };
      if (!storage.createContext) return [];
      const context = await storage.createContext({ dataSetId: options.dataSetId, withCDN: false });
      if (!context.getPieces) return [];
      const cids: string[] = [];
      for await (const piece of context.getPieces()) cids.push(pieceCidString(piece.pieceCid));
      return cids;
    },
    async get(pieceCid) {
      const bytes = await synapse.storage.download({ pieceCid });
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    },
  };
}

export function fundingShortfall(
  costs: { depositNeeded?: bigint; needsFwssMaxApproval?: boolean },
  copies: number,
): string {
  const issues: string[] = [];
  if (costs.depositNeeded != null && costs.depositNeeded > 0n) {
    issues.push(
      `Deposit at least ${formatUnits(costs.depositNeeded, 18)} more USDFC for these ${copies} storage copies, including dataset fees and lockups.`,
    );
  }
  if (costs.needsFwssMaxApproval) issues.push("Approve storage payments.");
  return issues.join(" ") || "Storage funding is not ready.";
}

async function resolveContexts(
  storage: {
    createContext?: (options: unknown) => Promise<unknown>;
    createContexts?: (options: unknown) => Promise<unknown[]>;
  },
  options: SynapseStorageOptions,
): Promise<ContextLike[]> {
  const want = options.copies ?? 2;
  const selected: ContextLike[] = [];
  if (options.dataSetId != null && storage.createContext) {
    try {
      selected.push((await storage.createContext({ dataSetId: options.dataSetId, withCDN: false })) as ContextLike);
    } catch (error) {
      if (want <= 1) throw error;
    }
  } else if (options.providerId != null && storage.createContext) {
    selected.push((await storage.createContext({ providerId: options.providerId, withCDN: false })) as ContextLike);
  }
  if (selected.length >= want) return distinct(selected).slice(0, want);
  if (!storage.createContexts) {
    if (!selected.length) throw new Error("No reachable storage providers available");
    return distinct(selected);
  }
  try {
    const more = await storage.createContexts({
      withCDN: false,
      copies: Math.max(1, want - selected.length),
      excludeProviderIds: selected.map(providerIdOf).filter((id) => id !== ""),
      metadata: { source: options.dataSetSource ?? "fifolders" },
    });
    if (!more.length && !selected.length) throw new Error("No reachable storage providers available");
    for (const ctx of more) selected.push(ctx as ContextLike);
  } catch (error) {
    if (!selected.length) {
      const message = error instanceof Error ? error.message : "";
      if (/no reachable/i.test(message)) throw new Error("No reachable storage providers available");
      throw error;
    }
  }
  const providers = distinct(selected).slice(0, want);
  if (!providers.length) throw new Error("No reachable storage providers available");
  return providers;
}

function distinct(contexts: ContextLike[]): ContextLike[] {
  const seen = new Set<string>();
  const out: ContextLike[] = [];
  for (const ctx of contexts) {
    const id = providerIdOf(ctx);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(ctx);
  }
  return out;
}

function noticeFromContexts(contexts: ContextLike[], expected: number): ReplicationNotice {
  return {
    phase: "uploading",
    expectedCopies: Math.max(expected, contexts.length),
    providers: contexts.map((ctx) => ({
      providerId: providerIdOf(ctx),
      serviceURL: serviceUrlOf(ctx),
      ...(ctx.dataSetId != null ? { dataSetId: String(ctx.dataSetId) } : {}),
    })),
  };
}

function applyUploadResult(notice: ReplicationNotice, result: UploadReturn): void {
  for (const copy of result.copies ?? []) {
    const id = copy.providerId != null ? String(copy.providerId) : "";
    const row = notice.providers.find((provider) => provider.providerId === id) ?? {
      providerId: id,
      serviceURL: copy.retrievalUrl ? originOf(copy.retrievalUrl) : "",
    };
    if (!notice.providers.includes(row)) notice.providers.push(row);
    row.confirmed = true;
    row.stored = true;
    if (copy.dataSetId != null) row.dataSetId = String(copy.dataSetId);
    if (copy.pieceId != null) row.pieceId = String(copy.pieceId);
    if (copy.retrievalUrl) row.serviceURL = originOf(copy.retrievalUrl);
  }
  for (const failed of result.failedAttempts ?? []) {
    const id = failed.providerId != null ? String(failed.providerId) : "";
    const row = notice.providers.find((provider) => provider.providerId === id);
    if (!row || row.confirmed) continue;
    row.rejected = true;
  }
  const settled = notice.providers.length > 0 && notice.providers.every((provider) => provider.confirmed || provider.rejected);
  const confirmed = notice.providers.some((provider) => provider.confirmed);
  if (settled && confirmed) notice.phase = "complete";
  else if (settled && !confirmed) notice.phase = "failed";
  else if (confirmed) notice.phase = "pending";
  else notice.phase = "failed";
  if (typeof result.requestedCopies === "number") notice.expectedCopies = result.requestedCopies;
  if (notice.phase === "failed") notice.error = notice.error ?? "Storage providers rejected this upload.";
  if (notice.phase === "pending") {
    notice.error = "Storage confirmation is taking longer than expected. This does not mean your upload failed.";
  }
  if (notice.phase === "complete") notice.error = undefined;
}

function cloneNotice(notice: ReplicationNotice): ReplicationNotice {
  return {
    phase: notice.phase,
    expectedCopies: notice.expectedCopies,
    providers: notice.providers.map((provider) => ({ ...provider })),
    ...(notice.error ? { error: notice.error } : {}),
  };
}

function providerIdOf(ctx: ContextLike): string {
  const id = ctx.provider?.id ?? ctx.providerId;
  return id == null ? "" : String(id);
}

function serviceUrlOf(ctx: ContextLike): string {
  return ctx.provider?.pdp?.serviceURL || ctx.serviceURL || "";
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
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

async function readAll(data: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  const reader = data.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    total += next.value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
