/** Two storage copies, partial-failure checkpoints, and read-only recovery. */

export const DEFAULT_STORAGE_COPIES = 2;
export const CONFIRMATION_CHECK_LIMIT = 20;
export const CONFIRMATION_CHECK_INTERVAL_MS = 30_000;

export interface ProviderCandidate {
  providerId: string;
  serviceURL: string;
  endorsed?: boolean;
}

export interface CopyProvider {
  providerId: string;
  serviceURL: string;
  dataSetId?: string;
  transactionHash?: string;
  stored?: boolean;
  confirmed?: boolean;
  rejected?: boolean;
  pieceId?: string;
}

export interface UploadCheckpoint {
  phase: "waiting" | "uploading" | "confirming" | "pending" | "interrupted" | "failed" | "complete";
  expectedCopies: number;
  providers: CopyProvider[];
  error?: string;
  checks: number;
  nextCheckAt: number;
  pieceCid?: string;
}

export type PollResult = "confirmed" | "rejected" | "pending" | "timeout";

const checkpointKey = (scope: string) => `fifolders:replication:${scope}`;

export function loadCheckpoint(scope: string): UploadCheckpoint | null {
  try {
    const raw = localStorage.getItem(checkpointKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UploadCheckpoint;
    if (!parsed || !Array.isArray(parsed.providers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCheckpoint(scope: string, checkpoint: UploadCheckpoint | null): void {
  if (!checkpoint) {
    localStorage.removeItem(checkpointKey(scope));
    return;
  }
  localStorage.setItem(checkpointKey(scope), JSON.stringify(checkpoint));
}

/**
 * Pick distinct reachable providers. A brand-new primary must be endorsed when
 * any endorsed candidate exists. Fewer reachable providers than requested is
 * reduced redundancy, except zero providers for a new primary.
 */
export async function selectCopyProviders(
  candidates: readonly ProviderCandidate[],
  options: {
    copies?: number;
    existingProviderIds?: readonly string[];
    ping?: (serviceURL: string) => Promise<void>;
  } = {},
): Promise<{ providers: ProviderCandidate[]; reduced: boolean }> {
  const copies = options.copies ?? DEFAULT_STORAGE_COPIES;
  const ping = options.ping ?? (async () => undefined);
  const exclude = new Set(options.existingProviderIds ?? []);
  const selected: ProviderCandidate[] = [];
  const pool = candidates.filter((candidate) => candidate.providerId && !exclude.has(candidate.providerId));
  for (let slot = 0; slot < copies; slot += 1) {
    const endorsedOnly = slot === 0 && (options.existingProviderIds?.length ?? 0) === 0 && pool.some((candidate) => candidate.endorsed);
    let found = false;
    for (const candidate of pool) {
      if (exclude.has(candidate.providerId)) continue;
      if (endorsedOnly && !candidate.endorsed) continue;
      exclude.add(candidate.providerId);
      try {
        await ping(candidate.serviceURL);
        selected.push(candidate);
        found = true;
        break;
      } catch {
        // Unreachable providers are skipped. Try the next distinct provider.
      }
    }
    if (!found) {
      if (slot === 0 && (options.existingProviderIds?.length ?? 0) === 0) {
        throw new Error("No reachable storage providers available");
      }
      break;
    }
  }
  return { providers: selected, reduced: selected.length < copies };
}

/** Upload to each unfinished provider. A failed copy does not discard a confirmed one. */
export async function replicatePiece(
  pieceCid: string,
  providers: readonly ProviderCandidate[],
  put: (provider: ProviderCandidate) => Promise<{ transactionHash?: string; pieceId?: string } | void>,
  previous?: UploadCheckpoint,
): Promise<UploadCheckpoint> {
  const checkpoint: UploadCheckpoint = previous
    ? { ...previous, providers: previous.providers.map((provider) => ({ ...provider })), pieceCid }
    : {
        phase: "uploading",
        expectedCopies: providers.length,
        providers: providers.map((provider) => ({ providerId: provider.providerId, serviceURL: provider.serviceURL })),
        checks: 0,
        nextCheckAt: 0,
        pieceCid,
      };
  checkpoint.pieceCid = pieceCid;
  for (const provider of providers) {
    const row = checkpoint.providers.find((item) => item.providerId === provider.providerId) ?? {
      providerId: provider.providerId,
      serviceURL: provider.serviceURL,
    };
    if (!checkpoint.providers.includes(row)) checkpoint.providers.push(row);
    if (row.confirmed || row.rejected) continue;
    try {
      const result = await put(provider);
      row.stored = true;
      row.confirmed = true;
      row.transactionHash = result?.transactionHash ?? row.transactionHash;
      row.pieceId = result?.pieceId ?? row.pieceId;
    } catch (error) {
      row.rejected = true;
      console.error("FiFolders upload", error);
      checkpoint.error = error instanceof Error ? error.message : "Upload failed";
    }
  }
  return settle(checkpoint);
}

/**
 * Read existing submissions only. A timeout or a missing hash never resubmits.
 */
export async function recoverReplication(
  checkpoint: UploadCheckpoint,
  poll: (provider: CopyProvider) => Promise<PollResult>,
  now = Date.now(),
): Promise<UploadCheckpoint> {
  if (checkpoint.phase === "complete" || checkpoint.phase === "failed") return checkpoint;
  if (!checkpoint.pieceCid) {
    return {
      ...checkpoint,
      phase: "interrupted",
      error:
        checkpoint.phase === "waiting"
          ? "The page closed before this queued upload started. Select the original file to upload it."
          : "The page closed before receipt of the file was saved. Select the original file to try again.",
    };
  }
  if (checkpoint.checks >= CONFIRMATION_CHECK_LIMIT || checkpoint.nextCheckAt > now) return checkpoint;
  const providers = await Promise.all(
    checkpoint.providers.map(async (provider): Promise<CopyProvider> => {
      if (provider.confirmed || provider.rejected || !provider.transactionHash) return provider;
      const result = await poll(provider);
      if (result === "confirmed") return { ...provider, confirmed: true, stored: true };
      if (result === "rejected") return { ...provider, rejected: true };
      return provider;
    }),
  );
  const next = settle({
    ...checkpoint,
    providers,
    checks: checkpoint.checks + 1,
    nextCheckAt: now + CONFIRMATION_CHECK_INTERVAL_MS,
  });
  if (next.phase === "pending") {
    next.error = "Storage confirmation is taking longer than expected. This does not mean your upload failed.";
  }
  return next;
}

export interface StoredCopy {
  datasetId: string;
  providerId: string;
  serviceURL: string;
}

const catalogKey = (scope: string) => `fifolders:copies:${scope}`;

export function loadCopyCatalog(scope: string): Record<string, StoredCopy[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(catalogKey(scope)) || "{}") as Record<string, StoredCopy[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCopyCatalog(scope: string, catalog: Record<string, StoredCopy[]>): void {
  localStorage.setItem(catalogKey(scope), JSON.stringify(catalog));
}

export function defaultLocalCopies(): StoredCopy[] {
  return [
    { datasetId: "local-a", providerId: "provider-a", serviceURL: "https://a.example" },
    { datasetId: "local-b", providerId: "provider-b", serviceURL: "https://b.example" },
  ];
}

function settle(checkpoint: UploadCheckpoint): UploadCheckpoint {
  const providers = checkpoint.providers;
  const confirmed = providers.filter((provider) => provider.confirmed);
  const complete = providers.length > 0 && providers.every((provider) => provider.confirmed || provider.rejected);
  const failed = !confirmed.length && providers.length > 0 && providers.every((provider) => provider.rejected);
  const missingSubmission =
    providers.length === 0 || providers.some((provider) => !provider.confirmed && !provider.rejected && !provider.transactionHash);
  const pendingSubmission = providers.some((provider) => !provider.confirmed && !provider.rejected && provider.transactionHash);
  const interrupted = !complete && missingSubmission && !pendingSubmission;
  const phase = failed ? "failed" : complete ? "complete" : interrupted ? "interrupted" : "pending";
  return {
    ...checkpoint,
    phase,
    error: failed
      ? "Storage providers rejected this upload. Select the original file to retry."
      : phase === "complete"
        ? undefined
        : phase === "interrupted"
          ? "Not all storage submission receipts were saved. Background upload work has stopped. Check status can discover existing confirmations, but cannot resume unfinished upload steps."
          : checkpoint.error,
  };
}
