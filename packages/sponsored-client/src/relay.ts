import { createPublicClient, custom, encodeFunctionData, getAddress, http, numberToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXECUTE_TYPES, executeDomain, lockedAccountAbi } from "./abi.js";
import { sponsorCallRetry } from "./http.js";
import { readNetworkPreference, type ChainChoice } from "./config.js";

export type TypedSigner = (typed: {
  domain: ReturnType<typeof executeDomain>;
  types: typeof EXECUTE_TYPES;
  primaryType: "Execute";
  message: { target: Address; value: bigint; data: Hex; nonce: bigint; deadline: bigint };
}) => Promise<Hex>;

export interface RemovalAdapters {
  listPieceIds: (datasetId: string, pieceCid?: string) => Promise<string[]>;
  scheduled: (datasetId: string) => Promise<Set<string>>;
  submit: (datasetId: string, pieceIds: string[]) => Promise<{ hash: string }>;
  resolve: (
    datasetId: string,
    checkpoint: { transactionHash?: string },
  ) => Promise<{ status: "pending" | "success" | "reverted" | "replaced"; hash?: string; messageCid?: string }>;
}

/** Sign `Execute(target, data)` for the account and hand it to the sponsor. Returns the relay transaction hash. */
export async function relayExecute(input: {
  client: PublicClient;
  chainId: number;
  account: Address;
  target: Address;
  data: Hex;
  sign: TypedSigner;
  chain?: ChainChoice;
}): Promise<Hex> {
  const nonce = (await input.client.readContract({ address: input.account, abi: lockedAccountAbi, functionName: "nonce" })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = { target: getAddress(input.target), value: 0n, data: input.data, nonce, deadline };
  const signature = await input.sign({ domain: executeDomain(input.chainId, input.account), types: EXECUTE_TYPES, primaryType: "Execute", message });
  const out = await sponsorCallRetry<{ hash: Hex }>("/execute", { account: input.account, ...message, signature }, input.chain ?? readNetworkPreference());
  return out.hash;
}

export function addSessionKeyData(key: Address, expiry: bigint): Hex {
  return encodeFunctionData({ abi: lockedAccountAbi, functionName: "addSessionKey", args: [key, expiry] });
}

/**
 * EIP-1193 transport for a wallet client whose account is the LockedSignerAccount: `eth_sendTransaction`
 * (registry commits) becomes an Execute signed locally by the session key and relayed; everything else reads `rpc`.
 */
export function sponsoredTransport(input: { rpc: string; chainId: number; account: Address; sessionKey: Hex; chain?: ChainChoice }) {
  const local = privateKeyToAccount(input.sessionKey);
  const reads = createPublicClient({ transport: http(input.rpc) });
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_sendTransaction") {
        const [tx] = params as [{ to?: Address; data?: Hex; input?: Hex; value?: Hex }];
        if (!tx.to) throw new Error("Sponsored accounts cannot deploy contracts.");
        if (tx.value && BigInt(tx.value) !== 0n) throw new Error("Sponsored accounts cannot send value.");
        return relayExecute({
          client: reads as PublicClient,
          chainId: input.chainId,
          account: input.account,
          target: tx.to,
          data: tx.data ?? tx.input ?? "0x",
          sign: (typed) => local.signTypedData(typed),
          chain: input.chain,
        });
      }
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [input.account];
      if (method === "eth_chainId") return numberToHex(input.chainId);
      return reads.request({ method, params } as never);
    },
  });
}

/** Providers can 404 a dataset for a few minutes after creation ("Data set not found"); retry those. */
export async function retryDatasetLag<T>(fn: () => Promise<T>, opts: { attempts?: number; delayMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const text = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !/data ?set not found/i.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 30_000));
    }
  }
}

interface RemovalContext {
  getPieces(): AsyncIterable<{ pieceId: bigint; pieceCid: { toString(): string } }>;
  getScheduledRemovals(): Promise<readonly bigint[]>;
  deletePiece(options: { piece: bigint }): Promise<Hex>;
}

async function waitForReceipt(client: PublicClient, hash: Hex) {
  return client.waitForTransactionReceipt({ hash });
}

/** Live removal adapters: the session key signs SchedulePieceRemovals and the provider submits it (no user gas). */
export function liveRemovalAdapters(input: { context: (datasetId: string) => Promise<RemovalContext>; client: PublicClient; delayMs?: number }): RemovalAdapters {
  return {
    async listPieceIds(datasetId, pieceCid) {
      const context = await input.context(datasetId);
      const ids: string[] = [];
      for await (const piece of context.getPieces()) if (!pieceCid || piece.pieceCid.toString() === pieceCid) ids.push(piece.pieceId.toString());
      return ids;
    },
    async scheduled(datasetId) {
      const context = await input.context(datasetId);
      return new Set((await context.getScheduledRemovals()).map((id) => id.toString()));
    },
    async submit(datasetId, pieceIds) {
      const context = await input.context(datasetId);
      let hash: Hex = "0x";
      for (const id of pieceIds) hash = await retryDatasetLag(() => context.deletePiece({ piece: BigInt(id) }), { delayMs: input.delayMs ?? 30_000 });
      return { hash };
    },
    async resolve(_datasetId, checkpoint) {
      const hash = checkpoint.transactionHash as Hex | undefined;
      if (!hash) return { status: "pending" };
      try {
        const receipt = await waitForReceipt(input.client, hash);
        return { status: receipt.status === "success" ? "success" : "reverted", hash };
      } catch {
        return { status: "pending", hash };
      }
    },
  };
}
