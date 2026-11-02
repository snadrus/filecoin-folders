/** Bounded IPFS indexing checks. A miss consumes one attempt and does not fail the upload. */

export const IPFS_CHECK_LIMIT = 5;
export const IPFS_CHECK_INTERVAL_MS = 120_000;

export interface IndexRecord {
  attempts: number;
  nextAt: number;
  indexed?: boolean;
}

export interface IndexStore {
  read(): Record<string, IndexRecord>;
  write(records: Record<string, IndexRecord>): void;
}

const keyFor = (scope: string) => `fifolders:ipfs-checks:${scope}`;

export function localIndexStore(scope: string): IndexStore {
  return {
    read() {
      try {
        return JSON.parse(localStorage.getItem(keyFor(scope)) || "{}") as Record<string, IndexRecord>;
      } catch {
        return {};
      }
    },
    write(records) {
      localStorage.setItem(keyFor(scope), JSON.stringify(records));
    },
  };
}

/** Reserve the attempt before the request so a reload cannot reset the budget. */
export function reserveIndexingCheck(store: IndexStore, cid: string, now: number): IndexRecord | null {
  const records = store.read();
  const previous = records[cid] ?? { attempts: 0, nextAt: 0 };
  if (previous.indexed || previous.attempts >= IPFS_CHECK_LIMIT || previous.nextAt > now) return null;
  const record: IndexRecord = { attempts: previous.attempts + 1, nextAt: now + IPFS_CHECK_INTERVAL_MS };
  store.write({ ...records, [cid]: record });
  return record;
}

export function markIndexed(store: IndexStore, cid: string): void {
  const records = store.read();
  const previous = records[cid] ?? { attempts: IPFS_CHECK_LIMIT, nextAt: 0 };
  store.write({ ...records, [cid]: { ...previous, indexed: true } });
}

export function indexingLabel(record: IndexRecord | undefined): string {
  if (!record) return "Not checked";
  if (record.indexed) return "Indexed";
  if (record.attempts >= IPFS_CHECK_LIMIT) return "Not indexed";
  return `Checking ${record.attempts}/${IPFS_CHECK_LIMIT}`;
}

export async function runIndexingCheck(
  store: IndexStore,
  cid: string,
  probe: (cid: string) => Promise<boolean>,
  now = Date.now(),
): Promise<IndexRecord | null> {
  const reserved = reserveIndexingCheck(store, cid, now);
  if (!reserved) return store.read()[cid] ?? null;
  let indexed = false;
  try {
    indexed = await probe(cid);
  } catch {
    indexed = false;
  }
  if (indexed) markIndexed(store, cid);
  return store.read()[cid] ?? reserved;
}
