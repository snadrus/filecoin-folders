/**
 * Gasless mode (VITE_SPONSOR_URL). A sponsor backend ("money processor", apps/fifolders/sponsor) pays all gas; users buy
 * storage credits by card (Stripe Checkout) and the sponsor deposits the matching USDFC. The payer is a per-user
 * LockedSignerAccount; the connected wallet (or passkey) and the browser session key only sign. The account's fixed
 * on-chain policy blocks every USDFC exit except the sponsor's sweep back to its treasury.
 */
import { readNetworkPreference } from "./network.js";
import { createPublicClient, custom, encodeFunctionData, getAddress, hashTypedData, http, keccak256, numberToHex, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXECUTE_TYPES, SPONSOR_REQUEST_TYPES, executeDomain, lockedAccountAbi, sponsorDomain, stableJson, type SponsorAuth } from "./sponsored-abi.js";
import type { RemovalAdapters } from "./removal.js";
import { waitForReceipt } from "./receipt.js";

/**
 * Networks with a sponsor (VITE_SPONSOR_NETWORKS, comma-separated; default "calibration"). Other networks use plain
 * wallets. One sponsor origin serves both: Calibration at the root, mainnet under /mainnet.
 */
export function sponsorNetworks(): ("calibration" | "mainnet")[] {
  const raw = String(import.meta.env?.VITE_SPONSOR_NETWORKS ?? "calibration");
  return raw.split(",").map((value) => value.trim()).filter((value): value is "calibration" | "mainnet" => value === "calibration" || value === "mainnet");
}

export function sponsorUrl(): string {
  const base = String(import.meta.env?.VITE_SPONSOR_URL ?? "").replace(/\/+$/, "");
  const network = readNetworkPreference();
  if (!base || !sponsorNetworks().includes(network)) return "";
  return network === "mainnet" ? `${base}/mainnet` : base;
}

/** Stripe publishable key for a network: test (pk_test_) on Calibration, live (pk_live_) on mainnet. */
export function stripePublishableKey(chain: "calibration" | "mainnet"): string {
  return String((chain === "mainnet" ? import.meta.env?.VITE_STRIPE_PUBLISHABLE_KEY_MAINNET : import.meta.env?.VITE_STRIPE_PUBLISHABLE_KEY) ?? "");
}

export function isSponsored(): boolean {
  return sponsorUrl() !== "";
}

export const SPONSORED_DEPOSIT_NOTE = "Pay by card. Credits pay only for storage; no FIL or USDFC needed. First purchase includes a one-time $1.50 account setup (minimum $3.91; top-ups from $2.37).";
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
export function passkeySponsorSigner(key: { x: Hex; y: Hex; credentialId?: string }, assert: (challenge: Hex) => Promise<{ authenticatorData: Hex; clientDataJSON: string; signature: Hex }>): SponsorSigner {
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "passkey", x: key.x, y: key.y, ...(key.credentialId ? { credentialId: key.credentialId } : {}), issuedAt: typed.message.issuedAt.toString(), ...(await assert(hashTypedData(typed))) };
    },
  };
}

/** Passkey owner's account, or null before the first purchase. */
export async function findPasskeyAccount(key: { x: Hex; y: Hex }): Promise<Address | null> {
  const out = await call<{ account: Address | null }>(`/account?x=${key.x}&y=${key.y}`);
  return out.account ? getAddress(out.account) : null;
}

/** Public key of a passkey the sponsor has seen (recorded at its first purchase), by WebAuthn credential id. */
export async function findPasskeyByCredential(credentialId: string): Promise<{ x: Hex; y: Hex } | null> {
  const out = await call<{ account: Address | null; x?: Hex; y?: Hex }>(`/account?credential=${encodeURIComponent(credentialId)}`);
  return out.account && out.x && out.y ? { x: out.x, y: out.y } : null;
}

export interface SponsorPricing {
  minFirstUsd: number;
  minTopUpUsd: number;
  maxUsd: number;
  suggestedUsd?: number;
  minCreditUsd?: number;
  minNetUsd?: number;
  setupFeeUsd: number;
  reserveUsd: number;
  testMode: boolean;
}

export async function sponsorPricing(): Promise<SponsorPricing> {
  return call("/pricing");
}

/** After Stripe redirects back: wait until the sponsor has applied the payment (pool handover is one tx). */
export async function waitForCredit(sessionId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<{ status: string; account?: Address }> {
  const end = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const status = await sponsoredCreditStatus(sessionId);
    if (status.status === "done" || status.status === "failed" || status.status === "unknown" || Date.now() > end) return status;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 4_000));
  }
}

async function signed<T>(path: string, signer: SponsorSigner, chainId: number, body: Record<string, unknown>): Promise<T> {
  return call<T>(path, { ...body, auth: await signer.auth(chainId, path.slice(1), body) });
}

/**
 * Stripe Checkout for storage credits; returns the hosted payment page URL. The first purchase also creates the
 * storage account (one-time setup fee shown as its own line).
 */
export async function buySponsoredCredits(signer: SponsorSigner, chainId: number, input: { usd: number; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string; first: boolean }> {
  return signed("/checkout", signer, chainId, input);
}

export async function sponsoredCreditStatus(sessionId: string): Promise<{ status: string; account?: Address; usdfc?: string; path?: string | null; hash?: Hex | null; hashes?: Hex[] }> {
  return call(`/credits?session=${encodeURIComponent(sessionId)}`);
}

/** One-time dataset creation by the sponsor (approved provider only). */
export async function createSponsoredDataset(signer: SponsorSigner, chainId: number, metadata: Record<string, string>): Promise<{ dataSetId: string; providerId: string; hash: Hex }> {
  return signed("/dataset", signer, chainId, { metadata });
}

/**
 * Fallback limits, mirroring the sponsor's defaults (sponsor/pricing.ts): charge − Stripe fee (2.9% + 30¢) must
 * reach $2.00 ($1.00 reserve + at least 1 USDFC credit), plus the $1.50 creation fee on a first purchase.
 * The sponsor's /pricing wins when reachable.
 */
export const DEFAULT_SPONSOR_LIMITS = { minFirstUsd: 3.91, minTopUpUsd: 2.37, maxUsd: 200, suggestedUsd: 10 } as const;

/** Card amount to charge: the suggestion, raised to the minimum for this purchase and capped at the maximum. */
export function sponsoredPurchaseUsd(limits: Pick<SponsorPricing, "minFirstUsd" | "minTopUpUsd" | "maxUsd" | "suggestedUsd">, first: boolean, requested = sponsoredCreditUsd(limits.suggestedUsd)): number {
  const min = first ? limits.minFirstUsd : limits.minTopUpUsd;
  const usd = Number.isFinite(requested) ? Math.round(requested * 100) / 100 : min;
  return Math.min(limits.maxUsd, Math.max(min, usd));
}

/** Suggested card purchase in USD: VITE_SPONSOR_CREDIT_USD, else the sponsor's suggestion, else $10. */
export function sponsoredCreditUsd(fromSponsor?: number): number {
  return Number(import.meta.env?.VITE_SPONSOR_CREDIT_USD ?? fromSponsor ?? 10) || 10;
}

/** Calibration must use Stripe test mode (pk_test_); mainnet live mode. Empty is allowed (sponsor decides). */
export function stripeModeNote(chain: "calibration" | "mainnet"): string | null {
  const key = stripePublishableKey(chain);
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
        const receipt = await waitForReceipt(input.client, hash);
        return { status: receipt.status === "success" ? "success" : "reverted", hash };
      } catch {
        return { status: "pending", hash };
      }
    },
  };
}
