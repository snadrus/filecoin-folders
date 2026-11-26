/**
 * Gasless mode (VITE_SPONSOR_URL). A sponsor backend ("money processor", apps/fifolders/sponsor) pays all gas and the
 * USDFC storage deposit. The payer is a per-user LockedSignerAccount; the connected wallet and the browser session key
 * only sign. The account's on-chain policy blocks every USDFC exit except the sponsor's sweep back to its treasury.
 */
import { createPublicClient, custom, encodeFunctionData, getAddress, http, numberToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXECUTE_TYPES, executeDomain, lockedAccountAbi } from "./sponsored-abi.js";
import type { RemovalAdapters } from "./removal.js";

export function sponsorUrl(): string {
  return String(import.meta.env?.VITE_SPONSOR_URL ?? "").replace(/\/+$/, "");
}

export function isSponsored(): boolean {
  return sponsorUrl() !== "";
}

export const SPONSORED_DEPOSIT_NOTE = "Paid from your FiFolders credits. No FIL or USDFC needed.";
export const SPONSORED_DATASET_NOTE = "Created once for you and paid from your FiFolders credits.";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${sponsorUrl()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body, (_, value) => (typeof value === "bigint" ? value.toString() : value)) }),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(json.error || `Sponsor ${path} failed (${response.status})`);
  return json;
}

/** The user's sponsored payer account, or null before the sponsor created it. */
export async function findSponsoredAccount(user: Address): Promise<Address | null> {
  const out = await call<{ account: Address | null }>(`/account?user=${user}`);
  return out.account ? getAddress(out.account) : null;
}

/** Create the account (if needed) and top up its storage credits. Sponsor pays gas and USDFC. */
export async function fundSponsoredAccount(user: Address): Promise<{ account: Address; hashes: Hex[] }> {
  const out = await call<{ account: Address; hashes: Hex[] }>("/account", { user });
  return { account: getAddress(out.account), hashes: out.hashes };
}

/** One-time dataset creation by the sponsor (approved provider only). */
export async function createSponsoredDataset(user: Address, metadata: Record<string, string>): Promise<{ dataSetId: string; providerId: string; hash: Hex }> {
  return call("/dataset", { user, metadata });
}

type TypedSigner = (typed: { domain: ReturnType<typeof executeDomain>; types: typeof EXECUTE_TYPES; primaryType: "Execute"; message: { target: Address; value: bigint; data: Hex; nonce: bigint; deadline: bigint } }) => Promise<Hex>;

/** Sign `Execute(target, data)` for the account and hand it to the sponsor. Returns the relay transaction hash. */
export async function relayExecute(input: { client: PublicClient; chainId: number; account: Address; target: Address; data: Hex; sign: TypedSigner }): Promise<Hex> {
  const nonce = (await input.client.readContract({ address: input.account, abi: lockedAccountAbi, functionName: "nonce" })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = { target: getAddress(input.target), value: 0n, data: input.data, nonce, deadline };
  const signature = await input.sign({ domain: executeDomain(input.chainId, input.account), types: EXECUTE_TYPES, primaryType: "Execute", message });
  const out = await call<{ hash: Hex }>("/execute", { account: input.account, ...message, signature });
  return out.hash;
}

export function addSessionKeyData(key: Address, expiry: bigint): Hex {
  return encodeFunctionData({ abi: lockedAccountAbi, functionName: "addSessionKey", args: [key, expiry] });
}

/**
 * EIP-1193 transport for a wallet client whose account is the LockedSignerAccount: `eth_sendTransaction`
 * (registry commits) becomes an Execute signed locally by the session key and relayed; everything else reads `rpc`.
 */
export function sponsoredTransport(input: { rpc: string; chainId: number; account: Address; sessionKey: Hex }) {
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
  const attempts = opts.attempts ?? 20;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const text = `${error instanceof Error ? error.message : String(error)} ${(error as { details?: string })?.details ?? ""}`;
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
        const receipt = await input.client.waitForTransactionReceipt({ hash, timeout: 10 * 60_000, pollingInterval: 5_000 });
        return { status: receipt.status === "success" ? "success" : "reverted", hash };
      } catch {
        return { status: "pending", hash };
      }
    },
  };
}
