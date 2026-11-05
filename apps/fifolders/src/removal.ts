import { versionsToPrune, type RetentionPolicy } from "fil-folders";
/** Schedule piece removals across copies. A live manifest reference blocks the piece. */

export const REMOVAL_BATCH = 35;

export class DeletionConfirmationPendingError extends Error {
  constructor() {
    super("Waiting for deletion confirmation.");
    this.name = "DeletionConfirmationPendingError";
  }
}

export interface RemovalCheckpoint {
  transactionHash?: string;
  messageCid?: string;
  confirmed?: boolean;
  remaining?: boolean;
}

export interface RemovalFile {
  pieceCid: string;
  datasetIds: string[];
  checkpoints: Record<string, RemovalCheckpoint>;
}

export function liveKeepsPiece(pieceCid: string, live: ReadonlySet<string>): boolean {
  return live.has(pieceCid);
}

export function piecesEligibleForRemoval(candidates: readonly string[], live: ReadonlySet<string>): string[] {
  return [...new Set(candidates)].filter((piece) => piece && !live.has(piece));
}

/**
 * Version retention (Google Drive style): every version from the last 30 days and the newest 100
 * versions stay browsable in Manage versions; only older ones that the live folder tree no longer
 * uses are removed, oldest first. `history` is oldest first.
 */
export function versionsEligibleForRemoval(
  history: readonly { pieceCid: string; timestamp: number }[],
  live: ReadonlySet<string>,
  opts: { now?: number; policy?: Partial<RetentionPolicy> } = {},
): string[] {
  return versionsToPrune(history, live, opts);
}

export interface RemovalAdapters {
  listPieceIds: (datasetId: string) => Promise<string[]>;
  scheduled: (datasetId: string) => Promise<Set<string>>;
  submit: (datasetId: string, pieceIds: string[]) => Promise<{ hash: string }>;
  resolve: (
    datasetId: string,
    checkpoint: RemovalCheckpoint,
  ) => Promise<{ status: "pending" | "success" | "reverted" | "replaced"; hash?: string; messageCid?: string }>;
}

/**
 * Schedule removals for one piece on every dataset copy.
 * The transaction hash is persisted before waiting. A timeout keeps that hash
 * and does not submit again. Replaced or reverted checkpoints are cleared.
 */
export async function schedulePieceRemovals(
  file: RemovalFile,
  persist: (datasetId: string, next?: RemovalCheckpoint) => Promise<void>,
  adapters: RemovalAdapters,
): Promise<void> {
  const deferred: string[] = [];
  const results = await Promise.allSettled(
    [...new Set(file.datasetIds)].map(async (datasetId) => {
      const previous = file.checkpoints[datasetId];
      if (previous?.confirmed && !previous.remaining) return;
      let hash = (previous?.confirmed ? undefined : previous?.transactionHash) as string | undefined;
      let remaining = previous?.remaining ?? false;
      let messageCid = previous?.messageCid;
      if (!hash) {
        const queued = await adapters.scheduled(datasetId);
        const ids = await adapters.listPieceIds(datasetId);
        const unscheduled = ids.filter((id) => !queued.has(id));
        if (!ids.length && !previous?.confirmed) {
          throw new Error(`Piece is no longer active in dataset ${datasetId}. Its removal status needs checking on the explorer.`);
        }
        if (!unscheduled.length) {
          if (previous?.confirmed) {
            await persist(datasetId, { ...previous, remaining: false });
            return;
          }
          throw new Error(`Removal is already queued for dataset ${datasetId}. Check its status on the explorer.`);
        }
        const capacity = Math.max(0, REMOVAL_BATCH - queued.size);
        if (!capacity) {
          deferred.push(datasetId);
          return;
        }
        const pieces = unscheduled.slice(0, capacity);
        remaining = pieces.length < unscheduled.length;
        const submitted = await adapters.submit(datasetId, pieces);
        hash = submitted.hash;
        const pending: RemovalCheckpoint = { transactionHash: hash, confirmed: false, ...(remaining ? { remaining } : {}) };
        file.checkpoints[datasetId] = pending;
        await persist(datasetId, pending);
      }
      let result = await adapters.resolve(datasetId, { transactionHash: hash, messageCid, confirmed: false, remaining });
      if (result.messageCid && result.messageCid !== messageCid) {
        messageCid = result.messageCid;
        const pending: RemovalCheckpoint = {
          transactionHash: hash,
          confirmed: false,
          ...(remaining ? { remaining } : {}),
          messageCid,
        };
        file.checkpoints[datasetId] = pending;
        await persist(datasetId, pending);
      }
      if (result.status === "pending") throw new DeletionConfirmationPendingError();
      if (result.status === "replaced" || result.status === "reverted") {
        delete file.checkpoints[datasetId];
        await persist(datasetId);
        throw new Error(
          result.status === "replaced"
            ? `Deletion transaction was replaced by a different operation for dataset ${datasetId}. Check its result before retrying.`
            : `Deletion transaction reverted for dataset ${datasetId}. Retry to submit again.`,
        );
      }
      const done: RemovalCheckpoint = {
        transactionHash: result.hash ?? hash,
        confirmed: true,
        ...(remaining ? { remaining } : {}),
        ...(messageCid ? { messageCid } : {}),
      };
      file.checkpoints[datasetId] = done;
      await persist(datasetId, done);
      if (remaining) deferred.push(datasetId);
    }),
  );
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  const failures = rejected.filter((cause) => !(cause instanceof DeletionConfirmationPendingError));
  if (deferred.length) {
    failures.push(
      new Error(
        `Deletion progress saved. Dataset(s) ${deferred.join(", ")} need another batch. Retry after the provider’s next proving period releases its removal queue.`,
      ),
    );
  }
  if (!failures.length && rejected.length) throw new DeletionConfirmationPendingError();
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new Error([...new Set(failures.map((cause) => (cause instanceof Error ? cause.message : "File deletion failed")))].join("\n"));
  }
}

const removalKey = (scope: string) => `fifolders:removals:${scope}`;

export function loadRemovals(scope: string): Record<string, Record<string, RemovalCheckpoint>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(removalKey(scope)) || "{}") as Record<string, Record<string, RemovalCheckpoint>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRemovals(scope: string, records: Record<string, Record<string, RemovalCheckpoint>>): void {
  localStorage.setItem(removalKey(scope), JSON.stringify(records));
}
