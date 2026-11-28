// Receipt polling that survives Filecoin null rounds.
// viem's waitForTransactionReceipt walks blocks by number to detect replacements; on Filecoin an epoch can be a
// null round ("requested epoch was a null round"), which makes that walk throw even though the tx is fine.
//
// Glif's eth_getTransactionReceipt can lag a full epoch after a block is produced. Ready is marked when our tx
// appears in a new head's transactions (eth_getBlockByNumber with txs), before an execution receipt is required.
// Receipt status is confirmed in the background; a revert, drop, or reorg unwinds the credit.
import type { Hex, Log, PublicClient, TransactionReceipt } from "viem";

export async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<T> {
  const fetchImpl = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "fifolders-sponsor/1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = (await response.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? method);
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Public Calibration RPCs raced for receipts (and raw-tx broadcast). Glif can lag one epoch on getTransactionReceipt. */
export const CALIBRATION_RECEIPT_RPCS = [
  "https://api.calibration.node.glif.io/rpc/v1",
  "https://rpc.ankr.com/filecoin_testnet",
  "https://filecoin-calibration.drpc.org",
] as const;

export function receiptRpcUrls(network: "calibration" | "mainnet" | string, primary?: string): string[] {
  const urls = [primary, ...(network === "mainnet" ? ["https://api.node.glif.io/rpc/v1"] : CALIBRATION_RECEIPT_RPCS)];
  return [...new Set(urls.filter((url): url is string => Boolean(url)))];
}

type RpcReceipt = Record<string, unknown>;

/** Normalize a JSON-RPC transaction receipt (eth_getTransactionReceipt / eth_getBlockReceipts). */
export function receiptFromRpc(raw: RpcReceipt): TransactionReceipt {
  const statusRaw = raw.status;
  const success = statusRaw === "0x1" || statusRaw === 1 || statusRaw === "success" || statusRaw === true;
  const indexRaw = raw.transactionIndex;
  const transactionIndex = typeof indexRaw === "number" ? indexRaw : Number.parseInt(String(indexRaw ?? "0"), 16) || 0;
  return {
    transactionHash: raw.transactionHash as Hex,
    blockHash: raw.blockHash as Hex,
    blockNumber: BigInt(raw.blockNumber as string | number),
    status: success ? "success" : "reverted",
    from: (raw.from as Hex) ?? ("0x0000000000000000000000000000000000000000" as Hex),
    to: (raw.to as Hex) ?? null,
    contractAddress: (raw.contractAddress as Hex) ?? null,
    cumulativeGasUsed: BigInt((raw.cumulativeGasUsed as string | number | undefined) ?? "0"),
    gasUsed: BigInt((raw.gasUsed as string | number | undefined) ?? "0"),
    effectiveGasPrice: BigInt((raw.effectiveGasPrice as string | number | undefined) ?? "0"),
    logs: (raw.logs as Log[]) ?? [],
    logsBloom: (raw.logsBloom as Hex) ?? "0x",
    type: raw.type === "0x2" || raw.type === 2 ? "eip1559" : "legacy",
    transactionIndex,
  } as TransactionReceipt;
}

export interface ReceiptLookupOpts {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function hasBlock(raw: RpcReceipt | null | undefined): raw is RpcReceipt {
  return Boolean(raw && raw.blockHash && raw.transactionHash && (raw.status != null || raw.logs));
}

async function receiptFromBlockReceipts(
  url: string,
  hash: Hex,
  tag: string,
  opts: ReceiptLookupOpts,
): Promise<{ receipt: TransactionReceipt; source: string } | undefined> {
  const recs = await jsonRpc<RpcReceipt[] | null>(url, "eth_getBlockReceipts", [tag], opts).catch(() => null);
  if (!Array.isArray(recs)) return undefined;
  const want = hash.toLowerCase();
  const hit = recs.find((row) => String(row.transactionHash ?? "").toLowerCase() === want);
  if (!hit || !hasBlock(hit)) return undefined;
  return { receipt: receiptFromRpc(hit), source: `blockReceipts:${url}` };
}

/** Resolve as soon as any job finds a block receipt; do not wait for slower RPCs. */
function firstReceipt(
  jobs: Promise<{ receipt: TransactionReceipt; source?: string } | undefined>[],
): Promise<{ receipt: TransactionReceipt; source?: string } | undefined> {
  return new Promise((resolve) => {
    let left = jobs.length;
    if (!left) { resolve(undefined); return; }
    for (const job of jobs) {
      void job.then((row) => {
        if (row?.receipt.blockHash) resolve(row);
      }, () => undefined).finally(() => {
        left -= 1;
        if (left === 0) resolve(undefined);
      });
    }
  });
}

async function lookupOnRpc(url: string, hash: Hex, opts: ReceiptLookupOpts): Promise<{ receipt: TransactionReceipt; source: string } | undefined> {
  const direct = jsonRpc<RpcReceipt | null>(url, "eth_getTransactionReceipt", [hash], opts)
    .then((raw) => (hasBlock(raw) ? { receipt: receiptFromRpc(raw), source: `getTransactionReceipt:${url}` } : undefined))
    .catch(() => undefined);
  const latest = receiptFromBlockReceipts(url, hash, "latest", opts);
  const prior = (async () => {
    // Glif can lag receipts until the next epoch, by which time "latest" has already moved on.
    // Check the last few heads by number so we do not miss the including block.
    const head = await jsonRpc<string>(url, "eth_blockNumber", [], opts).catch(() => undefined);
    if (!head) return undefined;
    const n = BigInt(head);
    const tags: string[] = [];
    for (let i = 0; i <= 2; i += 1) {
      if (n >= BigInt(i)) tags.push(`0x${(n - BigInt(i)).toString(16)}`);
    }
    return firstReceipt(tags.map((tag) => receiptFromBlockReceipts(url, hash, tag, opts)));
  })();
  return await firstReceipt([direct, latest, prior]) as { receipt: TransactionReceipt; source: string } | undefined;
}

export async function waitForReceipt(
  client: Pick<PublicClient, "getTransactionReceipt">,
  hash: Hex,
  opts: { timeoutMs?: number; pollMs?: number; rpcUrls?: string[]; fetch?: typeof fetch } = {},
): Promise<TransactionReceipt> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const poll = opts.pollMs ?? 1_000;
  const urls = [...new Set(opts.rpcUrls ?? [])];
  let last: unknown;
  for (;;) {
    const tick: Promise<{ receipt: TransactionReceipt; source?: string } | undefined>[] = [
      Promise.resolve()
        .then(async () => {
          const receipt = await Promise.race([
            client.getTransactionReceipt({ hash }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("receipt poll timeout")), Math.min(poll, 1_500))),
          ]);
          return receipt?.blockHash ? { receipt, source: "client.getTransactionReceipt" } : undefined;
        })
        .catch((error) => {
          last = error;
          return undefined;
        }),
      ...urls.map(async (url) => {
        const hit = await lookupOnRpc(url, hash, { timeoutMs: Math.min(poll + 1_000, 4_000), fetch: opts.fetch });
        return hit;
      }),
    ];
    const found = await firstReceipt(tick);
    if (found) {
      const host = (found.source ?? "").replace(/https?:\/\/[^/]+/, (m) => {
        try { return new URL(m).host; } catch { return m; }
      });
      if (host && host !== "client.getTransactionReceipt") {
        console.log(`[receipt-timing] ${JSON.stringify({ hash, source: host, status: found.receipt.status, blockNumber: found.receipt.blockNumber.toString() })}`);
      }
      return found.receipt;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${hash}: ${last instanceof Error ? last.message.split("\n")[0] : String(last)}`);
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

export function txHashesInBlock(transactions: unknown[] | undefined): string[] {
  if (!Array.isArray(transactions)) return [];
  return transactions
    .map((tx) => {
      if (typeof tx === "string") return tx.toLowerCase();
      if (tx && typeof tx === "object" && "hash" in (tx as { hash?: unknown })) return String((tx as { hash: string }).hash).toLowerCase();
      return "";
    })
    .filter(Boolean);
}

export interface HeadInclusion {
  hash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

async function lookupTxInHeadOnRpc(url: string, hash: Hex, opts: ReceiptLookupOpts): Promise<HeadInclusion | undefined> {
  const want = hash.toLowerCase();
  const head = await jsonRpc<string>(url, "eth_blockNumber", [], opts).catch(() => undefined);
  const tags = new Set<string>(["latest"]);
  if (head) {
    const n = BigInt(head);
    for (let i = 0; i <= 2; i += 1) {
      if (n >= BigInt(i)) tags.add(`0x${(n - BigInt(i)).toString(16)}`);
    }
  }
  const jobs = [...tags].map(async (tag) => {
    const block = await jsonRpc<{ hash?: string; number?: string; transactions?: unknown[] } | null>(
      url,
      "eth_getBlockByNumber",
      [tag, true],
      opts,
    ).catch(() => null);
    if (!block?.hash || block.number == null) return undefined;
    if (!txHashesInBlock(block.transactions).includes(want)) return undefined;
    return { hash, blockNumber: BigInt(block.number), blockHash: block.hash as Hex };
  });
  return await new Promise((resolve) => {
    let left = jobs.length;
    if (!left) { resolve(undefined); return; }
    for (const job of jobs) {
      void job.then((row) => { if (row) resolve(row); }, () => undefined).finally(() => {
        left -= 1;
        if (left === 0) resolve(undefined);
      });
    }
  });
}

/**
 * Resolve when `hash` appears in a new head's transaction list (no execution receipt required).
 * A successful receipt is also accepted, so callers can share this with the receipt fallback.
 * A reverted receipt is returned as inclusion plus `reverted: true` so the caller can refuse to mark ready.
 */
type HeadClient = {
  // viem PublicClient is not assignable to a narrow getBlock signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTransactionReceipt?: (args: { hash: Hex }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getBlock?: (...args: any[]) => Promise<any>;
  getBlockNumber?: () => Promise<bigint>;
};

export async function waitForTxInHead(
  client: HeadClient,
  hash: Hex,
  opts: { timeoutMs?: number; pollMs?: number; rpcUrls?: string[]; fetch?: typeof fetch } = {},
): Promise<HeadInclusion & { reverted?: boolean }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const poll = opts.pollMs ?? 1_000;
  const urls = [...new Set(opts.rpcUrls ?? [])];
  const want = hash.toLowerCase();
  let last: unknown;
  for (;;) {
    const jobs: Promise<(HeadInclusion & { reverted?: boolean }) | undefined>[] = [];
    if (client.getBlock) {
      jobs.push((async () => {
        const tags: Array<{ blockTag?: "latest"; blockNumber?: bigint }> = [{ blockTag: "latest" }];
        if (client.getBlockNumber) {
          try {
            const n = await client.getBlockNumber();
            for (let i = 0; i <= 2; i += 1) if (n >= BigInt(i)) tags.push({ blockNumber: n - BigInt(i) });
          } catch (error) {
            last = error;
          }
        }
        for (const tag of tags) {
          try {
            const block = await client.getBlock!({ ...tag, includeTransactions: true } as never);
            if (!block?.hash || block.number == null) continue;
            if (txHashesInBlock(block.transactions).includes(want)) {
              return { hash, blockNumber: BigInt(block.number), blockHash: block.hash as Hex };
            }
          } catch (error) {
            last = error;
          }
        }
        return undefined;
      })());
    }
    for (const url of urls) {
      jobs.push(lookupTxInHeadOnRpc(url, hash, { timeoutMs: Math.min(poll + 1_000, 4_000), fetch: opts.fetch }));
    }
    if (client.getTransactionReceipt) {
      jobs.push((async () => {
        try {
          const receipt = await Promise.race([
            client.getTransactionReceipt!({ hash }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("receipt poll timeout")), Math.min(poll, 1_500))),
          ]);
          if (!receipt?.blockHash) return undefined;
          return {
            hash,
            blockNumber: BigInt(receipt.blockNumber ?? 0),
            blockHash: receipt.blockHash as Hex,
            reverted: receipt.status === "reverted",
          };
        } catch (error) {
          last = error;
          return undefined;
        }
      })());
    }
    const found = await new Promise<(HeadInclusion & { reverted?: boolean }) | undefined>((resolve) => {
      let left = jobs.length;
      if (!left) { resolve(undefined); return; }
      for (const job of jobs) {
        void job.then((row) => { if (row) resolve(row); }, () => undefined).finally(() => {
          left -= 1;
          if (left === 0) resolve(undefined);
        });
      }
    });
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${hash} in a new head: ${last instanceof Error ? last.message.split("\n")[0] : String(last)}`);
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

/** Filecoin fallback when `finalized` / F3 is unavailable (~30s epochs). */
export const FINALITY_EPOCHS = 900;

export type ReceiptFate = "included" | "finalized" | "dropped" | "reverted";

export interface RecordedInclusion {
  hash: Hex;
  blockNumber: bigint | string | number;
  blockHash: Hex;
}

/**
 * Re-check a previously included tx until F3/`finalized` or head is >= block+900.
 * A reverted execution receipt is "reverted". A missing receipt is not a drop if the tx is still in the
 * recorded head (RPC receipt lag). A missing receipt plus a changed block hash or a block that no longer
 * lists the tx is "dropped". If the same hash was re-included in a new block, returns "included".
 */
export async function receiptFate(
  client: HeadClient & { getTransactionReceipt: NonNullable<HeadClient["getTransactionReceipt"]> },
  recorded: RecordedInclusion,
  opts: { finalityEpochs?: number } = {},
): Promise<{ fate: ReceiptFate; blockNumber?: bigint; blockHash?: Hex }> {
  const wantNumber = BigInt(recorded.blockNumber);
  const wantHash = recorded.blockHash.toLowerCase();
  let receipt: Awaited<ReturnType<NonNullable<HeadClient["getTransactionReceipt"]>>> | undefined;
  try {
    receipt = await client.getTransactionReceipt({ hash: recorded.hash });
  } catch {
    receipt = undefined;
  }

  const stillInRecordedBlock = async (): Promise<"present" | "absent" | "unknown"> => {
    if (!client.getBlock) return "unknown";
    try {
      let at: { number?: bigint | null; hash?: Hex | null; transactions?: unknown[] } | undefined;
      try {
        at = await client.getBlock({ blockHash: recorded.blockHash, includeTransactions: true } as never);
      } catch {
        at = await client.getBlock({ blockNumber: wantNumber, includeTransactions: true } as never);
      }
      if (!at?.hash) return "unknown";
      if (at.hash.toLowerCase() !== wantHash) return "absent";
      if (at.transactions == null) return "unknown";
      return txHashesInBlock(at.transactions).includes(recorded.hash.toLowerCase()) ? "present" : "absent";
    } catch {
      return "unknown";
    }
  };

  if (!receipt?.blockHash) {
    const inBlock = await stillInRecordedBlock();
    if (inBlock === "absent") return { fate: "dropped" };
    return { fate: "included", blockNumber: wantNumber, blockHash: recorded.blockHash };
  }

  const blockNumber = BigInt(receipt.blockNumber);
  const blockHash = receipt.blockHash as Hex;
  if (receipt.status === "reverted") return { fate: "reverted", blockNumber, blockHash };
  if (blockNumber === wantNumber && blockHash.toLowerCase() !== wantHash) return { fate: "dropped" };
  if (client.getBlock) {
    try {
      const at = await client.getBlock({ blockNumber: wantNumber } as never);
      if (at?.hash && at.hash.toLowerCase() !== wantHash && blockNumber === wantNumber) return { fate: "dropped" };
    } catch {
      /* historical block read can fail on a null round */
    }
    try {
      const finalized = await client.getBlock({ blockTag: "finalized" } as never);
      if (finalized?.number != null && BigInt(finalized.number) >= wantNumber) {
        if (blockHash.toLowerCase() === wantHash || blockNumber !== wantNumber) return { fate: "finalized", blockNumber, blockHash };
      }
    } catch {
      /* no F3 / finalized tag on this RPC */
    }
  }
  if (client.getBlockNumber) {
    try {
      const head = await client.getBlockNumber();
      if (head >= wantNumber + BigInt(opts.finalityEpochs ?? FINALITY_EPOCHS)) return { fate: "finalized", blockNumber, blockHash };
    } catch {
      /* */
    }
  }
  return { fate: "included", blockNumber, blockHash };
}
