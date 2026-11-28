// Card payment → USDFC credit. All money values in US cents; USDFC at `usdfcPerUsd` (default 1 USDFC per $1).
//   net    = charge − Stripe fee (from the charge's balance transaction)
//   credit = net − reserve ($1.00) − creation fee (first purchase only, $1.50)
// Reserve and creation fee stay off-chain (never become user USDFC): they are owed to the sponsor, which paid for the
// account and dataset creation; /status reports the running total. A warm-pool account already holds
// `poolSeedUsdfc` (1 USDFC); only credit above that is deposited at handover.
//
// Minimum charge (Andy's rule): charge − Stripe fee ≥ minNet (= reserve + minimum credit: $1.00 + 1 USDFC = $2.00),
// plus the creation fee on a first purchase. Minimums are derived exactly from Stripe's standard card fee
// (2.9% + $0.30, rounded to the cent) with `minStepCents` 1¢: top-up $2.37, first purchase $3.91.
import { parseUnits } from "viem";

export interface Pricing {
  reserveCents: number;
  setupCents: number;
  /** Every paid purchase credits at least this (1 USDFC); a Stripe fee above the model comes out of the reserve. */
  minCreditCents: number;
  /** charge − Stripe fee must reach this (before the setup fee). */
  minNetCents: number;
  /** Stripe fee model used to derive minimums and to estimate when the real fee is unavailable. */
  stripeFeeBps: number;
  stripeFeeFixedCents: number;
  minStepCents: number;
  minTopUpCents: number;
  minFirstCents: number;
  maxCents: number;
  /** Recommended purchase shown by the app ($10). */
  suggestedCents: number;
  usdfcPerUsd: string;
}

/** Stripe's fee for a charge under the configured model (2.9% + 30¢ by default), rounded to the cent like Stripe. */
export function stripeFeeModelCents(cents: number, model: Pick<Pricing, "stripeFeeBps" | "stripeFeeFixedCents"> = { stripeFeeBps: 290, stripeFeeFixedCents: 30 }): number {
  return Math.round((cents * model.stripeFeeBps) / 10_000) + model.stripeFeeFixedCents;
}

/** Smallest charge (rounded up to `step`) whose net after the modelled Stripe fee is ≥ `netCents`. */
export function minChargeCents(netCents: number, model: Pick<Pricing, "stripeFeeBps" | "stripeFeeFixedCents">, step = 5): number {
  let c = Math.max(1, Math.ceil(((netCents + model.stripeFeeFixedCents) * 10_000) / (10_000 - model.stripeFeeBps)) - 2);
  while (c - stripeFeeModelCents(c, model) < netCents) c += 1;
  return Math.ceil(c / step) * step;
}

function derive(base: Omit<Pricing, "minTopUpCents" | "minFirstCents">, overrides: { minTopUpCents?: number; minFirstCents?: number } = {}): Pricing {
  const topUp = minChargeCents(base.minNetCents, base, base.minStepCents);
  const first = minChargeCents(base.minNetCents + base.setupCents, base, base.minStepCents);
  // Overrides can only raise a minimum: the net rule always holds.
  return { ...base, minTopUpCents: Math.max(topUp, overrides.minTopUpCents ?? 0), minFirstCents: Math.max(first, overrides.minFirstCents ?? 0) };
}

export const DEFAULT_PRICING: Pricing = derive({ reserveCents: 100, setupCents: 150, minCreditCents: 100, minNetCents: 200, stripeFeeBps: 290, stripeFeeFixedCents: 30, minStepCents: 1, maxCents: 20_000, suggestedCents: 1_000, usdfcPerUsd: "1" });

export function pricingFromEnv(env: Record<string, string | undefined>): Pricing {
  const set = (name: string) => env[name] !== undefined && env[name] !== "";
  const cents = (name: string, fallback: number) => (set(name) ? Math.round(Number(env[name]) * 100) : fallback);
  const reserveCents = cents("SPONSOR_RESERVE_USD", DEFAULT_PRICING.reserveCents);
  // Net floor = reserve + minimum user credit (1 USDFC at the default rate); SPONSOR_MIN_NET_USD can only raise it.
  const minCreditCents = cents("SPONSOR_MIN_CREDIT_USD", DEFAULT_PRICING.minCreditCents);
  const minNetCents = Math.max(reserveCents + minCreditCents, cents("SPONSOR_MIN_NET_USD", 0));
  return derive(
    {
      reserveCents,
      minCreditCents,
      setupCents: cents("SPONSOR_SETUP_FEE_USD", DEFAULT_PRICING.setupCents),
      minNetCents,
      stripeFeeBps: set("SPONSOR_STRIPE_FEE_PCT") ? Math.round(Number(env.SPONSOR_STRIPE_FEE_PCT) * 100) : DEFAULT_PRICING.stripeFeeBps,
      stripeFeeFixedCents: cents("SPONSOR_STRIPE_FEE_FIXED_USD", DEFAULT_PRICING.stripeFeeFixedCents),
      minStepCents: cents("SPONSOR_MIN_STEP_USD", DEFAULT_PRICING.minStepCents),
      maxCents: cents("SPONSOR_MAX_USD", DEFAULT_PRICING.maxCents),
      suggestedCents: cents("SPONSOR_SUGGESTED_USD", DEFAULT_PRICING.suggestedCents),
      usdfcPerUsd: env.SPONSOR_USDFC_PER_USD ?? DEFAULT_PRICING.usdfcPerUsd,
    },
    { minTopUpCents: set("SPONSOR_MIN_TOPUP_USD") ? cents("SPONSOR_MIN_TOPUP_USD", 0) : undefined, minFirstCents: set("SPONSOR_MIN_FIRST_USD") ? cents("SPONSOR_MIN_FIRST_USD", 0) : undefined },
  );
}

export function usdfcForCents(cents: number, usdfcPerUsd: string): bigint {
  return cents <= 0 ? 0n : (BigInt(cents) * parseUnits(usdfcPerUsd, 18)) / 100n;
}

export interface CreditQuote {
  chargeCents: number;
  feeCents: number;
  netCents: number;
  /** Kept off-chain and owed to the sponsor: the reserve actually retained (normally `pricing.reserveCents`). */
  reserveCents: number;
  /** Creation fee, kept off-chain and owed to the sponsor (first purchase only). */
  setupCents: number;
  /** What the user gets, in cents (at least `minCreditCents`). */
  creditCents: number;
  creditUsdfc: bigint;
}

export function creditFor(pricing: Pricing, input: { chargeCents: number; feeCents: number; first: boolean }): CreditQuote {
  const setupCents = input.first ? pricing.setupCents : 0;
  const netCents = input.chargeCents - input.feeCents;
  const creditCents = Math.max(pricing.minCreditCents, netCents - pricing.reserveCents - setupCents);
  const reserveCents = netCents - setupCents - creditCents; // < pricing.reserveCents only if Stripe's fee beat the model
  return { chargeCents: input.chargeCents, feeCents: input.feeCents, netCents, reserveCents, setupCents, creditCents, creditUsdfc: usdfcForCents(creditCents, pricing.usdfcPerUsd) };
}

/** Deposit at warm-pool handover: only the credit above what the pooled account already holds. */
export function poolTopUp(creditUsdfc: bigint, seedUsdfc: bigint): bigint {
  return creditUsdfc > seedUsdfc ? creditUsdfc - seedUsdfc : 0n;
}
