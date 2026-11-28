import { describe, expect, it } from "vitest";
import {
  decideSpareCare,
  DEFAULT_POOL_CARE,
  effectiveRate,
  poolCareFromEnv,
  runwayDays,
  settledPayAccount,
  topUpToMonths,
  USDFC_MONTHLY_FLOOR,
  EPOCHS_PER_MONTH,
  ageDays,
} from "../sponsor/pool-care.js";

describe("pool spare runway", () => {
  const rate = USDFC_MONTHLY_FLOOR / EPOCHS_PER_MONTH;

  it("settles lockup from the last Pay epoch and reports available funds", () => {
    const { available, lockup } = settledPayAccount(10n ** 18n, 0n, rate, 1000n, 1000n + 2880n);
    expect(lockup).toBe(rate * 2880n);
    expect(available).toBe(10n ** 18n - rate * 2880n);
  });

  it("uses the 1 USDFC/month floor when lockup rate is 0", () => {
    expect(effectiveRate(0n)).toBe(rate);
    expect(runwayDays(10n ** 18n, 0n)).toBe(30);
  });

  it("tops up the shortfall to N months of runway", () => {
    const need = topUpToMonths(10n ** 18n, rate, 3);
    expect(need).toBe(rate * EPOCHS_PER_MONTH * 3n - 10n ** 18n);
    expect(need).toBeGreaterThan(19n * 10n ** 17n);
    expect(topUpToMonths(4n * 10n ** 18n, rate, 3)).toBe(0n);
  });

  it("retires spares at max age even if runway is short, otherwise tops up or leaves them", () => {
    const care = DEFAULT_POOL_CARE;
    expect(decideSpareCare({ ageDays: 91, runwayDays: 10, care })).toBe("retire");
    expect(decideSpareCare({ ageDays: 10, runwayDays: 30, care })).toBe("topup");
    expect(decideSpareCare({ ageDays: 10, runwayDays: 45, care })).toBe("ok");
    expect(decideSpareCare({ ageDays: 91, runwayDays: 10, care: { ...care, maxAgeDays: 0 } })).toBe("topup");
    expect(decideSpareCare({ ageDays: 10, runwayDays: 10, care: { ...care, minRunwayDays: 0, maxAgeDays: 0 } })).toBe("ok");
  });

  it("reads care config from env with defaults", () => {
    expect(poolCareFromEnv({})).toEqual(DEFAULT_POOL_CARE);
    expect(poolCareFromEnv({ SPONSOR_POOL_MIN_RUNWAY_DAYS: "60", SPONSOR_POOL_TOPUP_MONTHS: "2", SPONSOR_POOL_MAX_AGE_DAYS: "120" })).toEqual({
      minRunwayDays: 60,
      topUpMonths: 2,
      maxAgeDays: 120,
    });
    expect(ageDays(Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 2))).toBe(91);
  });
});
