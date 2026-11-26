// Card payment → USDFC credit. All money values in US cents; USDFC at `usdfcPerUsd` (default 1 USDFC per $1).
//   net    = charge − Stripe fee (from the charge's balance transaction)
//   credit = net − reserve ($0.20, stays with the company) − setup fee (first purchase only, default $1.50)
// A warm-pool account already holds `poolSeedUsdfc` (1 USDFC); only credit above that is deposited at handover.
//
// Minimum charge (Andy's rule): charge − Stripe fee ≥ minNet ($1.20 = $0.20 reserve + $1.00 credit), plus the setup
// fee on a first purchase. Minimums are derived from Stripe's standard card fee (2.9% + $0.30, rounded to the cent)
// and rounded up to `minStepCents` (5¢): top-up $1.55, first purchase $3.10.
import { parseUnits } from "viem";

export interface Pricing {
  reserveCents: number;
  setupCents: number;
  /** charge − Stripe fee must reach this (before the setup fee). */
  minNetCents: number;
  /** Stripe fee model used to derive minimums and to estimate when the real fee is unavailable. */
  stripeFeeBps: number;
  stripeFeeFixedCents: number;
  minStepCents: number;
  minTopUpCents: number;
  minFirstCents: number;
  maxCents: number;
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

export const DEFAULT_PRICING: Pricing = derive({ reserveCents: 20, setupCents: 150, minNetCents: 120, stripeFeeBps: 290, stripeFeeFixedCents: 30, minStepCents: 5, maxCents: 20_000, usdfcPerUsd: "1" });

export function pricingFromEnv(env: Record<string, string | undefined>): Pricing {
  const set = (name: string) => env[name] !== undefined && env[name] !== "";
  const cents = (name: string, fallback: number) => (set(name) ? Math.round(Number(env[name]) * 100) : fallback);
  return derive(
    {
      reserveCents: cents("SPONSOR_RESERVE_USD", DEFAULT_PRICING.reserveCents),
      setupCents: cents("SPONSOR_SETUP_FEE_USD", DEFAULT_PRICING.setupCents),
      minNetCents: cents("SPONSOR_MIN_NET_USD", DEFAULT_PRICING.minNetCents),
      stripeFeeBps: set("SPONSOR_STRIPE_FEE_PCT") ? Math.round(Number(env.SPONSOR_STRIPE_FEE_PCT) * 100) : DEFAULT_PRICING.stripeFeeBps,
      stripeFeeFixedCents: cents("SPONSOR_STRIPE_FEE_FIXED_USD", DEFAULT_PRICING.stripeFeeFixedCents),
      minStepCents: cents("SPONSOR_MIN_STEP_USD", DEFAULT_PRICING.minStepCents),
      maxCents: cents("SPONSOR_MAX_USD", DEFAULT_PRICING.maxCents),
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
  reserveCents: number;
  setupCents: number;
  /** What the user gets, in cents (never negative). */
  creditCents: number;
  creditUsdfc: bigint;
}

export function creditFor(pricing: Pricing, input: { chargeCents: number; feeCents: number; first: boolean }): CreditQuote {
  const setupCents = input.first ? pricing.setupCents : 0;
  const netCents = input.chargeCents - input.feeCents;
  const creditCents = Math.max(0, netCents - pricing.reserveCents - setupCents);
  return { chargeCents: input.chargeCents, feeCents: input.feeCents, netCents, reserveCents: pricing.reserveCents, setupCents, creditCents, creditUsdfc: usdfcForCents(creditCents, pricing.usdfcPerUsd) };
}

/** Deposit at warm-pool handover: only the credit above what the pooled account already holds. */
export function poolTopUp(creditUsdfc: bigint, seedUsdfc: bigint): bigint {
  return creditUsdfc > seedUsdfc ? creditUsdfc - seedUsdfc : 0n;
}
