/** Recover a wallet transaction that confirmed slowly or was gas-repriced. */

const MESSAGE_LOOKBACK_EPOCHS = 120;

export interface WalletTransactionResult {
  status: "pending" | "success" | "reverted" | "replaced";
  hash?: string;
  messageCid?: string;
}

export interface ReceiptClient {
  getTransactionReceipt(args: { hash: string }): Promise<{ status: "success" | "reverted"; transactionHash?: string } | null>;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export async function resolveTransactionReceipt(
  client: ReceiptClient,
  transaction: { hash: string; messageCid?: string },
): Promise<WalletTransactionResult> {
  const receipt = await client.getTransactionReceipt({ hash: transaction.hash }).catch(() => null);
  if (receipt) return { status: receipt.status, hash: receipt.transactionHash ?? transaction.hash };
  const messageCid = transaction.messageCid ?? (await messageCidFor(client, transaction.hash));
  const pending: WalletTransactionResult = { status: "pending", ...(messageCid ? { messageCid } : {}) };
  if (!messageCid) return pending;
  let lookup: { Message?: { "/"?: string }; Receipt?: { ExitCode?: number } } | null;
  try {
    lookup = (await client.request({
      method: "Filecoin.StateSearchMsg",
      params: [[], { "/": messageCid }, MESSAGE_LOOKBACK_EPOCHS, true],
    })) as typeof lookup;
  } catch (cause) {
    const details = rpcDetails(cause);
    if (details.includes("message was replaced:") && details.includes("NOT a valid replacement message")) {
      return { status: "replaced", messageCid };
    }
    return pending;
  }
  if (!lookup || !Number.isSafeInteger(lookup.Receipt?.ExitCode) || (lookup.Receipt?.ExitCode ?? -1) < 0) return pending;
  const executed = lookup.Message?.["/"];
  if (!executed) return pending;
  const hash =
    executed === messageCid
      ? transaction.hash
      : await client
          .request({ method: "Filecoin.EthGetTransactionHashByCid", params: [{ "/": executed }] })
          .then((value) => (typeof value === "string" ? value : undefined))
          .catch(() => undefined);
  return {
    status: lookup.Receipt?.ExitCode === 0 ? "success" : "reverted",
    ...(hash ? { hash } : {}),
    messageCid,
  };
}

async function messageCidFor(client: ReceiptClient, hash: string): Promise<string | undefined> {
  try {
    const result = (await client.request({
      method: "Filecoin.EthGetMessageCidByTransactionHash",
      params: [hash],
    })) as { "/"?: string } | null;
    return result?.["/"] || undefined;
  } catch {
    return undefined;
  }
}

function rpcDetails(cause: unknown): string {
  if (!cause || typeof cause !== "object") return "";
  const details = (cause as { details?: unknown }).details;
  if (typeof details === "string") return details;
  const message = cause instanceof Error ? cause.message : "";
  return message;
}

export interface PendingWalletTx {
  hash: string;
  messageCid?: string;
  confirmed: boolean;
}

/**
 * Persist the hash before waiting. A timeout leaves the checkpoint in place
 * so the next attempt checks the receipt instead of submitting again.
 */
export async function confirmWalletTransaction(input: {
  hash: string;
  messageCid?: string;
  persist: (pending: PendingWalletTx) => Promise<void>;
  resolve: (pending: { hash: string; messageCid?: string }) => Promise<WalletTransactionResult>;
  wait?: (hash: string) => Promise<{ status: "success" | "reverted" } | "timeout">;
}): Promise<WalletTransactionResult> {
  await input.persist({ hash: input.hash, ...(input.messageCid ? { messageCid: input.messageCid } : {}), confirmed: false });
  let result = await input.resolve({ hash: input.hash, messageCid: input.messageCid });
  if (result.messageCid && result.messageCid !== input.messageCid) {
    await input.persist({ hash: input.hash, messageCid: result.messageCid, confirmed: false });
  }
  if (result.status === "pending" && input.wait) {
    const waited = await input.wait(input.hash);
    if (waited === "timeout") {
      result = await input.resolve({ hash: input.hash, messageCid: result.messageCid });
      if (result.status === "pending") return result;
    } else {
      result = { status: waited.status, hash: input.hash, ...(result.messageCid ? { messageCid: result.messageCid } : {}) };
    }
  }
  if (result.status === "success") {
    await input.persist({ hash: result.hash ?? input.hash, ...(result.messageCid ? { messageCid: result.messageCid } : {}), confirmed: true });
  }
  return result;
}
