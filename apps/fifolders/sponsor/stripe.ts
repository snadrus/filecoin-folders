// Stripe without the SDK: Checkout Session creation over REST and webhook signature checks
// (https://docs.stripe.com/webhooks#verify-manually: HMAC-SHA256 of `${t}.${payload}`, header `t=…,v1=…`).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stripeFeeModelCents } from "./pricing.js";

export type Network = "calibration" | "mainnet";

/** Calibration takes test keys only; mainnet takes live keys only. */
export function assertStripeMode(secretKey: string, network: Network): void {
  const live = secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_");
  const test = secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_");
  if (network === "calibration" && !test) throw new Error("Calibration needs a Stripe test key (sk_test_…)");
  if (network === "mainnet" && !live) throw new Error("Mainnet needs a Stripe live key (sk_live_…)");
}

export function stripeSignatureHeader(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Throws unless `header` carries a v1 signature of `payload` under `secret` within `toleranceSec`. */
export function verifyStripeSignature(payload: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): void {
  if (!header) throw new Error("missing Stripe-Signature");
  const parts = header.split(",").map((part) => part.trim().split("=") as [string, string]);
  const t = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isFinite(t) || !signatures.length) throw new Error("malformed Stripe-Signature");
  if (Math.abs(nowSec - t) > toleranceSec) throw new Error("Stripe-Signature timestamp outside tolerance");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"));
  const ok = signatures.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new Error("Stripe signature mismatch");
}

export interface CheckoutInput {
  /** Shown as separate lines on the Stripe page (e.g. credits + one-time account setup). */
  lineItems: { name: string; cents: number }[];
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  clientReferenceId: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

function form(input: Record<string, string | number>): string {
  return Object.entries(input)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/** POST /v1/checkout/sessions (one-time card payment for storage credits). */
export async function createCheckoutSession(secretKey: string, input: CheckoutInput, fetchImpl: typeof fetch = fetch): Promise<CheckoutSession> {
  const body: Record<string, string | number> = {
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.clientReferenceId,
    // Cards only: credits are deposited at checkout.session.completed (no delayed-settlement methods).
    "allowed_payment_method_types[0]": "card",
  };
  input.lineItems.forEach((item, i) => {
    body[`line_items[${i}][quantity]`] = 1;
    body[`line_items[${i}][price_data][currency]`] = "usd";
    body[`line_items[${i}][price_data][unit_amount]`] = item.cents;
    body[`line_items[${i}][price_data][product_data][name]`] = item.name;
  });
  for (const [key, value] of Object.entries(input.metadata)) {
    body[`metadata[${key}]`] = value;
    body[`payment_intent_data[metadata][${key}]`] = value;
  }
  const response = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: form(body),
  });
  const json = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !json.id || !json.url) throw new Error(`Stripe: ${json.error?.message ?? response.status}`);
  return { id: json.id, url: json.url };
}

/** Local stand-in when no Stripe key is configured (Calibration only): no card page, the webhook is simulated. */
export function fakeCheckoutSession(input: CheckoutInput): CheckoutSession {
  const id = `cs_test_local_${randomBytes(12).toString("hex")}`;
  const url = new URL(input.successUrl);
  url.searchParams.set("session_id", id);
  return { id, url: url.toString() };
}

/** Stripe's standard US card pricing (2.9% + 30¢); only for the local fake, where there is no balance transaction. */
export function estimateStripeFeeCents(cents: number, model?: { stripeFeeBps: number; stripeFeeFixedCents: number }): number {
  return stripeFeeModelCents(cents, model);
}

/**
 * Stripe's actual fee for a paid Checkout Session, from its charge's balance transaction (in cents, USD balance).
 * The balance transaction can lag the webhook slightly, so retry a few times.
 */
export async function stripeFeeCents(secretKey: string, sessionId: string, fetchImpl: typeof fetch = fetch, opts: { attempts?: number; delayMs?: number } = {}): Promise<number> {
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge.balance_transaction`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${secretKey}` } });
    const json = (await response.json()) as { payment_intent?: { latest_charge?: { balance_transaction?: { fee?: number; currency?: string } | string | null } }; error?: { message?: string } };
    if (!response.ok) throw new Error(`Stripe: ${json.error?.message ?? response.status}`);
    const bt = json.payment_intent?.latest_charge?.balance_transaction;
    if (bt && typeof bt === "object" && typeof bt.fee === "number") {
      if (bt.currency && bt.currency !== "usd") throw new Error(`Stripe balance currency ${bt.currency} (expected usd)`);
      return bt.fee;
    }
    if (attempt >= (opts.attempts ?? 6)) throw new Error("Stripe balance transaction not available yet");
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 5_000));
  }
}

/** Full refund of a Checkout payment (idempotent per session via Idempotency-Key). */
export async function refundPayment(secretKey: string, paymentIntent: string, meta: { session: string; reason: string }, fetchImpl: typeof fetch = fetch): Promise<{ id: string; status: string }> {
  const body = new URLSearchParams({ payment_intent: paymentIntent, reason: "requested_by_customer", "metadata[session]": meta.session, "metadata[note]": meta.reason.slice(0, 450) });
  const response = await fetchImpl("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `refund-${meta.session}` },
    body,
  });
  const json = (await response.json()) as { id?: string; status?: string; error?: { message?: string; code?: string } };
  if (!response.ok || !json.id) throw new Error(`Stripe refund: ${json.error?.message ?? response.status}`);
  return { id: json.id, status: json.status ?? "unknown" };
}
