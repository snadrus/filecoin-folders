import type { Address, Hex } from "viem";
import type { SponsorSigner } from "./auth.js";
import { readNetworkPreference, type ChainChoice, type SponsorPricing } from "./config.js";
import { sponsorCall } from "./http.js";

async function signed<T>(path: string, signer: SponsorSigner, chainId: number, body: Record<string, unknown>, chain?: ChainChoice): Promise<T> {
  return sponsorCall<T>(path, { ...body, auth: await signer.auth(chainId, path.slice(1), body) }, chain ?? readNetworkPreference());
}

export async function sponsorPricing(chain?: ChainChoice): Promise<SponsorPricing> {
  return sponsorCall("/pricing", undefined, chain ?? readNetworkPreference());
}

/**
 * Stripe Checkout for storage credits; returns the hosted payment page URL. The first purchase also creates the
 * storage account (one-time setup fee shown as its own line).
 */
export async function buySponsoredCredits(
  signer: SponsorSigner,
  chainId: number,
  input: { usd: number; successUrl: string; cancelUrl: string; sessionKey?: Address; sessionExpiry?: string },
  chain?: ChainChoice,
): Promise<{ id: string; url: string; first: boolean }> {
  return signed("/checkout", signer, chainId, input, chain);
}

export async function sponsoredCreditStatus(
  sessionId: string,
  chain?: ChainChoice,
): Promise<{ status: string; account?: Address; usdfc?: string; path?: string | null; hash?: Hex | null; hashes?: Hex[]; finality?: string | null }> {
  return sponsorCall(`/credits?session=${encodeURIComponent(sessionId)}`, undefined, chain ?? readNetworkPreference());
}

/** After Stripe redirects back: wait until the sponsor has applied the payment (pool handover is one tx). */
export async function waitForCredit(
  sessionId: string,
  opts: { timeoutMs?: number; intervalMs?: number; chain?: ChainChoice } = {},
): Promise<{ status: string; account?: Address }> {
  const end = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const status = await sponsoredCreditStatus(sessionId, opts.chain);
    // Ready on inclusion: the sponsor sets `account` as soon as assign is in a block (not F3 finality).
    if (status.account && (status.status === "done" || status.status === "included")) return status;
    if (status.status === "failed" || status.status === "unknown" || status.status === "refunded" || Date.now() > end) return status;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 4_000));
  }
}

/** One-time dataset creation by the sponsor (approved provider only). */
export async function createSponsoredDataset(
  signer: SponsorSigner,
  chainId: number,
  metadata: Record<string, string>,
  chain?: ChainChoice,
): Promise<{ dataSetId: string; providerId: string; hash: Hex }> {
  return signed("/dataset", signer, chainId, { metadata }, chain);
}

/** After Stripe redirects back (`?checkout=success&session_id=`), wait for the credit and clean the URL. */
export async function settleReturnedCheckout(opts: { chain?: ChainChoice; timeoutMs?: number } = {}): Promise<{ status: string; account?: Address } | null> {
  if (typeof window === "undefined" || !window.location?.search) return null;
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");
  if (params.get("checkout") !== "success" || !sessionId) return null;
  const status = await waitForCredit(sessionId, { timeoutMs: opts.timeoutMs, chain: opts.chain }).catch(() => null);
  params.delete("checkout");
  params.delete("session_id");
  const query = params.toString();
  window.history?.replaceState?.(null, "", `${window.location.pathname ?? "/"}${query ? `?${query}` : ""}${window.location.hash ?? ""}`);
  return status;
}
