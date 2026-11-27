// Receipt polling that survives Filecoin null rounds.
// viem's waitForTransactionReceipt walks blocks by number to detect replacements; on Filecoin an epoch can be a
// null round ("requested epoch was a null round"), which makes that walk throw even though the tx is fine.
//
// Glif's eth_getTransactionReceipt can lag a full epoch after a block is produced. We also poll new heads via
// eth_getBlockReceipts("latest") / eth_getBlockByNumber (and optional extra RPCs) so ready can track block time.
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

async function lookupOnRpc(url: string, hash: Hex, opts: ReceiptLookupOpts): Promise<{ receipt: TransactionReceipt; source: string } | undefined> {
  const direct = await jsonRpc<RpcReceipt | null>(url, "eth_getTransactionReceipt", [hash], opts).catch(() => null);
  if (hasBlock(direct)) return { receipt: receiptFromRpc(direct), source: `getTransactionReceipt:${url}` };
  const latest = await receiptFromBlockReceipts(url, hash, "latest", opts);
  if (latest) return latest;
  // If the tx is in the latest block but receipts for "latest" failed, fetch receipts by block number.
  const block = await jsonRpc<{ number?: string; transactions?: Array<string | { hash?: string }> } | null>(
    url,
    "eth_getBlockByNumber",
    ["latest", true],
    opts,
  ).catch(() => null);
  const want = hash.toLowerCase();
  const inBlock = (block?.transactions ?? []).some((tx) => (typeof tx === "string" ? tx : tx.hash ?? "").toLowerCase() === want);
  if (inBlock && block?.number) {
    const byNumber = await receiptFromBlockReceipts(url, hash, block.number, opts);
    if (byNumber) return { ...byNumber, source: `blockReceiptsByNumber:${url}` };
  }
  return undefined;
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
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt?.blockHash) return receipt;
    } catch (error) {
      last = error; // not mined yet, a null round, or a transient RPC error: keep polling
    }
    if (urls.length) {
      const found = await Promise.any(
        urls.map(async (url) => {
          const hit = await lookupOnRpc(url, hash, { timeoutMs: Math.min(poll + 1_000, 5_000), fetch: opts.fetch });
          if (!hit) throw new Error("not yet");
          return hit;
        }),
      ).catch(() => undefined);
      if (found) {
        console.log(`[receipt-timing] ${JSON.stringify({ hash, source: found.source.replace(/https?:\/\/[^/]+/, (m) => new URL(m).host), status: found.receipt.status, blockNumber: found.receipt.blockNumber.toString() })}`);
        return found.receipt;
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${hash}: ${last instanceof Error ? last.message.split("\n")[0] : String(last)}`);
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

/** Filecoin fallback when `finalized` / F3 is unavailable (~30s epochs). */
export const FINALITY_EPOCHS = 900;

export type ReceiptFate = "included" | "finalized" | "dropped";

export interface RecordedInclusion {
  hash: Hex;
  blockNumber: bigint | string | number;
  blockHash: Hex;
}

/**
 * Re-check a previously included receipt until F3/`finalized` or head is >= block+900.
 * A missing receipt or a different block hash at the recorded number means the tx was dropped or reorged out.
 * If the same hash was re-included in a new block, returns "included" (caller should update the recorded hash/number).
 */
export async function receiptFate(
  client: {
    getTransactionReceipt: (args: { hash: Hex }) => Promise<TransactionReceipt>;
    getBlockNumber?: () => Promise<bigint>;
    getBlock?: (args: never) => Promise<{ number?: bigint | null; hash?: Hex | null }>;
  },
  recorded: RecordedInclusion,
  opts: { finalityEpochs?: number } = {},
): Promise<{ fate: ReceiptFate; blockNumber?: bigint; blockHash?: Hex }> {
  const wantNumber = BigInt(recorded.blockNumber);
  const wantHash = recorded.blockHash.toLowerCase();
  let receipt: TransactionReceipt | undefined;
  try {
    receipt = await client.getTransactionReceipt({ hash: recorded.hash });
  } catch {
    receipt = undefined;
  }
  if (!receipt?.blockHash) return { fate: "dropped" };
  const blockNumber = BigInt(receipt.blockNumber);
  const blockHash = receipt.blockHash as Hex;
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
