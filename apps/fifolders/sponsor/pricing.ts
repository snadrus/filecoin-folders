// Card payment → USDFC credit. All money values in US cents; USDFC at `usdfcPerUsd` (default 1 USDFC per $1).
//   net    = charge − Stripe fee (from the charge's balance transaction)
//   credit = net − reserve ($0.20, stays with the company) − setup fee (first purchase only, default $1.50)
// A warm-pool account already holds `poolSeedUsdfc` (1 USDFC); only credit above that is deposited at handover.
import { parseUnits } from "viem";

export interface Pricing {
  reserveCents: number;
  setupCents: number;
  minTopUpCents: number;
  minFirstCents: number;
  maxCents: number;
  usdfcPerUsd: string;
}

export const DEFAULT_PRICING: Pricing = { reserveCents: 20, setupCents: 150, minTopUpCents: 155, minFirstCents: 305, maxCents: 20_000, usdfcPerUsd: "1" };

export function pricingFromEnv(env: NodeJS.ProcessEnv): Pricing {
  const cents = (name: string, fallback: number) => (env[name] !== undefined && env[name] !== "" ? Math.round(Number(env[name]) * 100) : fallback);
  return {
    reserveCents: cents("SPONSOR_RESERVE_USD", DEFAULT_PRICING.reserveCents),
    setupCents: cents("SPONSOR_SETUP_FEE_USD", DEFAULT_PRICING.setupCents),
    minTopUpCents: cents("SPONSOR_MIN_TOPUP_USD", DEFAULT_PRICING.minTopUpCents),
    minFirstCents: cents("SPONSOR_MIN_FIRST_USD", DEFAULT_PRICING.minFirstCents),
    maxCents: cents("SPONSOR_MAX_USD", DEFAULT_PRICING.maxCents),
    usdfcPerUsd: env.SPONSOR_USDFC_PER_USD ?? DEFAULT_PRICING.usdfcPerUsd,
  };
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
