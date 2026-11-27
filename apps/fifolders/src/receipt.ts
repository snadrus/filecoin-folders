// Receipt polling that survives Filecoin null rounds.
// viem's waitForTransactionReceipt walks blocks by number to detect replacements; on Filecoin an epoch can be a
// null round ("requested epoch was a null round"), which makes that walk throw even though the tx is fine.
// Polling eth_getTransactionReceipt alone never touches block-by-number.
import type { Hex, PublicClient, TransactionReceipt } from "viem";

export async function waitForReceipt(
  client: Pick<PublicClient, "getTransactionReceipt">,
  hash: Hex,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TransactionReceipt> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const poll = opts.pollMs ?? 1_000;
  let last: unknown;
  for (;;) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      last = error; // not mined yet, a null round, or a transient RPC error: keep polling
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
