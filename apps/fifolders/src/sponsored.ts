/**
 * Gasless mode (VITE_SPONSOR_URL). A sponsor backend ("money processor", apps/fifolders/sponsor) pays all gas; users buy
 * storage credits by card (Stripe Checkout) and the sponsor deposits the matching USDFC. The payer is a per-user
 * LockedSignerAccount; the connected wallet (or passkey) and the browser session key only sign. The account's fixed
 * on-chain policy blocks every USDFC exit except the sponsor's sweep back to its treasury.
 */
import { createPublicClient, custom, encodeFunctionData, getAddress, hashTypedData, http, keccak256, numberToHex, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXECUTE_TYPES, SPONSOR_REQUEST_TYPES, executeDomain, lockedAccountAbi, sponsorDomain, stableJson, type SponsorAuth } from "./sponsored-abi.js";
import type { RemovalAdapters } from "./removal.js";

export function sponsorUrl(): string {
  return String(import.meta.env?.VITE_SPONSOR_URL ?? "").replace(/\/+$/, "");
}

export function isSponsored(): boolean {
  return sponsorUrl() !== "";
}

export const SPONSORED_DEPOSIT_NOTE = "Pay by card. Credits are spent only on storage. No FIL or USDFC needed.";
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

export type SponsorTyped = { domain: ReturnType<typeof sponsorDomain>; types: typeof SPONSOR_REQUEST_TYPES; primaryType: "SponsorRequest"; message: { action: string; bodyHash: Hex; issuedAt: bigint } };

/** Signs sponsor requests as the account owner, a session key of the account, or a passkey. */
export interface SponsorSigner {
  auth(chainId: number, action: string, body: Record<string, unknown>): Promise<SponsorAuth>;
}

export function sponsorRequestTyped(chainId: number, action: string, body: Record<string, unknown>, issuedAt = BigInt(Math.floor(Date.now() / 1000))): SponsorTyped {
  return { domain: sponsorDomain(chainId), types: SPONSOR_REQUEST_TYPES, primaryType: "SponsorRequest", message: { action, bodyHash: keccak256(stringToHex(stableJson(body))), issuedAt } };
}

/** Owner wallet (EIP-712 prompt). */
export function walletSponsorSigner(address: Address, sign: (typed: SponsorTyped) => Promise<Hex>): SponsorSigner {
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "eoa", address, issuedAt: typed.message.issuedAt.toString(), signature: await sign(typed) };
    },
  };
}

/** Browser session key registered on the account (no prompt). */
export function sessionSponsorSigner(account: Address, sessionKey: Hex): SponsorSigner {
  const local = privateKeyToAccount(sessionKey);
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "session", account, key: local.address, issuedAt: typed.message.issuedAt.toString(), signature: await local.signTypedData(typed) };
    },
  };
}

/** Passkey owner: the WebAuthn challenge is the SponsorRequest digest. */
export function passkeySponsorSigner(key: { x: Hex; y: Hex }, assert: (challenge: Hex) => Promise<{ authenticatorData: Hex; clientDataJSON: string; signature: Hex }>): SponsorSigner {
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "passkey", x: key.x, y: key.y, issuedAt: typed.message.issuedAt.toString(), ...(await assert(hashTypedData(typed))) };
    },
  };
}

async function signed<T>(path: string, signer: SponsorSigner, chainId: number, body: Record<string, unknown>): Promise<T> {
  return call<T>(path, { ...body, auth: await signer.auth(chainId, path.slice(1), body) });
}

/** Create the caller's account (once). Sponsor pays gas; no credits until a card payment lands. */
export async function ensureSponsoredAccount(signer: SponsorSigner, chainId: number): Promise<{ account: Address; hash?: Hex }> {
  const out = await signed<{ account: Address; hash?: Hex }>("/account", signer, chainId, {});
  return { account: getAddress(out.account), hash: out.hash };
}

/** Stripe Checkout for storage credits; returns the hosted payment page URL. */
export async function buySponsoredCredits(signer: SponsorSigner, chainId: number, input: { usd: number; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
  return signed("/checkout", signer, chainId, input);
}

export async function sponsoredCreditStatus(sessionId: string): Promise<{ status: string; account?: Address; usdfc?: string; hash?: Hex | null }> {
  return call(`/credits?session=${encodeURIComponent(sessionId)}`);
}

/** One-time dataset creation by the sponsor (approved provider only). */
export async function createSponsoredDataset(signer: SponsorSigner, chainId: number, metadata: Record<string, string>): Promise<{ dataSetId: string; providerId: string; hash: Hex }> {
  return signed("/dataset", signer, chainId, { metadata });
}

/** Default card purchase (whole USD). */
export function sponsoredCreditUsd(): number {
  return Number(import.meta.env?.VITE_SPONSOR_CREDIT_USD ?? 5) || 5;
}

/** Calibration must use Stripe test mode (pk_test_); mainnet live mode. Empty is allowed (sponsor decides). */
export function stripeModeNote(chain: "calibration" | "mainnet"): string | null {
  const key = String(import.meta.env?.VITE_STRIPE_PUBLISHABLE_KEY ?? "");
  if (!key) return null;
  if (chain === "calibration" && !key.startsWith("pk_test_")) throw new Error("Calibration needs a Stripe test publishable key (pk_test_…).");
  if (chain === "mainnet" && !key.startsWith("pk_live_")) throw new Error("Mainnet needs a Stripe live publishable key (pk_live_…).");
  return chain === "calibration" ? "Test mode: pay with card 4242 4242 4242 4242, any future date, any CVC." : null;
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
