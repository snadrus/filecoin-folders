/** Runway math for unassigned warm-pool accounts (dataset rail can drain a 1 USDFC seed). */

export const EPOCH_SECONDS = 30;
export const EPOCHS_PER_DAY = 2880;
/** 30-day month in Filecoin epochs: 2880 * 30. */
export const EPOCHS_PER_MONTH = 86_400n;
/** Empty-dataset rail floor: 1 USDFC per month. */
export const USDFC_MONTHLY_FLOOR = 10n ** 18n;

export interface PoolCareConfig {
  /** Top up when runway is shorter than this many days. 0 disables top-ups. Default 45. */
  minRunwayDays: number;
  /** Restore this many 30-day months of runway when topping up. Default 3. */
  topUpMonths: number;
  /** Retire (terminate + sweep) a spare older than this many days instead of topping up. 0 disables. Default 90. */
  maxAgeDays: number;
}

export const DEFAULT_POOL_CARE: PoolCareConfig = { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 };

export function poolCareFromEnv(env: Record<string, string | undefined>): PoolCareConfig {
  const num = (value: string | undefined, fallback: number) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    minRunwayDays: num(env.SPONSOR_POOL_MIN_RUNWAY_DAYS, DEFAULT_POOL_CARE.minRunwayDays),
    topUpMonths: Math.max(1, num(env.SPONSOR_POOL_TOPUP_MONTHS, DEFAULT_POOL_CARE.topUpMonths)),
    maxAgeDays: num(env.SPONSOR_POOL_MAX_AGE_DAYS, DEFAULT_POOL_CARE.maxAgeDays),
  };
}

export function settledPayAccount(
  funds: bigint,
  lockupCurrent: bigint,
  lockupRate: bigint,
  lockupLastSettledAt: bigint,
  epoch: bigint,
): { available: bigint; lockup: bigint } {
  const elapsed = epoch > lockupLastSettledAt ? epoch - lockupLastSettledAt : 0n;
  const lockup = lockupCurrent + lockupRate * elapsed;
  const available = funds > lockup ? funds - lockup : 0n;
  return { available, lockup };
}

/** Effective lockup rate, using the 1 USDFC/month floor when the chain reports 0. */
export function effectiveRate(lockupRatePerEpoch: bigint): bigint {
  return lockupRatePerEpoch > 0n ? lockupRatePerEpoch : USDFC_MONTHLY_FLOOR / EPOCHS_PER_MONTH;
}

export function runwayDays(available: bigint, lockupRatePerEpoch: bigint): number {
  const rate = effectiveRate(lockupRatePerEpoch);
  if (rate <= 0n) return available > 0n ? 10_000 : 0;
  return Number(available / rate / BigInt(EPOCHS_PER_DAY));
}

export function topUpToMonths(available: bigint, lockupRatePerEpoch: bigint, months: number): bigint {
  const rate = effectiveRate(lockupRatePerEpoch);
  const target = rate * EPOCHS_PER_MONTH * BigInt(Math.max(1, months));
  return target > available ? target - available : 0n;
}

export function ageDays(createdAtMs: number, nowMs: number): number {
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return 0;
  return Math.max(0, Math.floor((nowMs - createdAtMs) / 86_400_000));
}

/** Infer created-at from a pool sessionExpiry (set at build as now + 365 days). */
export function createdAtFromSessionExpiry(sessionExpirySec: string | number | undefined, ttlSec: bigint, nowMs: number): number {
  const expiry = Number(sessionExpirySec ?? 0);
  if (!Number.isFinite(expiry) || expiry <= 0) return nowMs;
  return (BigInt(Math.floor(expiry)) - ttlSec) * 1000n > 0n ? Number(BigInt(Math.floor(expiry)) - ttlSec) * 1000 : nowMs;
}

export type SpareAction = "ok" | "topup" | "retire" | "skip";

export function decideSpareCare(input: { ageDays: number; runwayDays: number; care: PoolCareConfig }): SpareAction {
  if (input.care.maxAgeDays > 0 && input.ageDays >= input.care.maxAgeDays) return "retire";
  if (input.care.minRunwayDays > 0 && input.runwayDays < input.care.minRunwayDays) return "topup";
  return "ok";
}
