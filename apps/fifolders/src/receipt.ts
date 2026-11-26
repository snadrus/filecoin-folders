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
  const poll = opts.pollMs ?? 5_000;
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
