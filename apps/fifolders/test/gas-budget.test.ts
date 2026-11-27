import { describe, expect, it } from "vitest";
import {
  emptyGasState,
  lifetimeCapWei,
  limitsFromEnv,
  releaseGas,
  reserveGas,
  reservedCostWei,
  settleGas,
  GasBudgetError,
} from "../sponsor/gas-budget.js";

const limits = limitsFromEnv({
  SPONSOR_GAS_HOURLY_FIL: "0.01",
  SPONSOR_GAS_BURST_FIL: "0.02",
  SPONSOR_GAS_DAILY_FIL: "0.05",
  SPONSOR_GAS_LIFETIME_BASE_FIL: "0.01",
  SPONSOR_GAS_LIFETIME_PER_PURCHASE_FIL: "0.002",
  SPONSOR_GAS_TX_MAX_GAS: "1000000",
  SPONSOR_GAS_TX_MAX_FEE_FIL: "0.01",
  SPONSOR_GAS_SESSION_DAILY_FIL: "0.015",
  SPONSOR_GAS_IP_HOURLY_FIL: "0.02",
  SPONSOR_GAS_FIL_FLOOR_FIL: "0.05",
});
const fil = (n: string) => limitsFromEnv({ SPONSOR_GAS_HOURLY_FIL: n }).hourlyWei;
const now0 = 1_700_000_000_000;

describe("gas budget", () => {
  it("reserves estimate×1.3×maxFee and settles the actual, refunding unused tokens", () => {
    expect(reservedCostWei(1_000_000n, 10n ** 9n)).toBe(1_300_000n * 10n ** 9n);
    const state = emptyGasState();
    const cost = reservedCostWei(100_000n, 10n ** 9n); // 0.00013 FIL
    reserveGas(state, limits, {
      account: "0xabc",
      reservationId: "r1",
      costWei: cost,
      gas: 100_000n,
      maxFeePerGas: 10n ** 9n,
      lifetimeCapWei: lifetimeCapWei(0, limits),
      sponsorFilWei: fil("1"),
      now: now0,
    });
    expect(state.reservations.r1?.amount).toBe(cost.toString());
    settleGas(state, "r1", cost / 2n);
    expect(state.reservations.r1).toBeUndefined();
    expect(state.accounts["0xabc"]!.dayUsed).toBe((cost / 2n).toString());
  });

  it("trips hourly, daily, lifetime, tx, session, ip and fil-floor with Retry-After", () => {
    const tight = limitsFromEnv({
      SPONSOR_GAS_HOURLY_FIL: "0.001",
      SPONSOR_GAS_BURST_FIL: "0.001",
      SPONSOR_GAS_DAILY_FIL: "1",
      SPONSOR_GAS_LIFETIME_BASE_FIL: "1",
      SPONSOR_GAS_TX_MAX_GAS: "100",
      SPONSOR_GAS_TX_MAX_FEE_FIL: "0.0000000000001",
      SPONSOR_GAS_FIL_FLOOR_FIL: "0.5",
    });
    const state = emptyGasState();
    const base = {
      account: "0x1",
      reservationId: "a",
      costWei: 10n ** 15n,
      gas: 50n,
      maxFeePerGas: 1n,
      lifetimeCapWei: 10n ** 18n,
      sponsorFilWei: 10n ** 18n,
      now: now0,
    };
    try {
      reserveGas(state, tight, { ...base, gas: 200n });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GasBudgetError);
      expect((e as GasBudgetError).limit).toBe("tx-gas");
      expect((e as GasBudgetError).status).toBe(429);
    }
    try {
      reserveGas(state, tight, { ...base, costWei: 10n ** 16n, gas: 50n });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("tx-fee");
    }
    try {
      reserveGas(state, tight, { ...base, sponsorFilWei: 10n ** 17n }); // 0.1 < 0.5 floor
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("fil-floor");
      expect((e as GasBudgetError).retryAfter).toBeGreaterThan(0);
    }
    const hour = limitsFromEnv({
      SPONSOR_GAS_HOURLY_FIL: "0.001",
      SPONSOR_GAS_BURST_FIL: "0.001",
      SPONSOR_GAS_DAILY_FIL: "1",
      SPONSOR_GAS_LIFETIME_BASE_FIL: "1",
      SPONSOR_GAS_TX_MAX_FEE_FIL: "1",
      SPONSOR_GAS_FIL_FLOOR_FIL: "0",
    });
    const s2 = emptyGasState();
    reserveGas(s2, hour, { ...base, costWei: 10n ** 15n, reservationId: "h1" }); // 0.001 = burst
    try {
      reserveGas(s2, hour, { ...base, costWei: 1n, reservationId: "h2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("hourly");
      expect((e as GasBudgetError).retryAfter).toBeGreaterThan(0);
    }
    releaseGas(s2, "h1");

    const day = limitsFromEnv({
      SPONSOR_GAS_HOURLY_FIL: "10",
      SPONSOR_GAS_BURST_FIL: "10",
      SPONSOR_GAS_DAILY_FIL: "0.002",
      SPONSOR_GAS_LIFETIME_BASE_FIL: "1",
      SPONSOR_GAS_TX_MAX_FEE_FIL: "1",
      SPONSOR_GAS_FIL_FLOOR_FIL: "0",
    });
    const s3 = emptyGasState();
    reserveGas(s3, day, { ...base, costWei: 2n * 10n ** 15n, reservationId: "d1" });
    try {
      reserveGas(s3, day, { ...base, costWei: 1n, reservationId: "d2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("daily");
    }

    const life = limitsFromEnv({
      SPONSOR_GAS_HOURLY_FIL: "10",
      SPONSOR_GAS_BURST_FIL: "10",
      SPONSOR_GAS_DAILY_FIL: "10",
      SPONSOR_GAS_LIFETIME_BASE_FIL: "0.001",
      SPONSOR_GAS_LIFETIME_PER_PURCHASE_FIL: "0.002",
      SPONSOR_GAS_TX_MAX_FEE_FIL: "1",
      SPONSOR_GAS_FIL_FLOOR_FIL: "0",
    });
    expect(lifetimeCapWei(0, life)).toBe(10n ** 15n);
    expect(lifetimeCapWei(3, life)).toBe(7n * 10n ** 15n);
    const s4 = emptyGasState();
    reserveGas(s4, life, { ...base, costWei: 10n ** 15n, lifetimeCapWei: lifetimeCapWei(0, life), reservationId: "l1" });
    settleGas(s4, "l1", 10n ** 15n);
    try {
      reserveGas(s4, life, { ...base, costWei: 1n, lifetimeCapWei: lifetimeCapWei(0, life), reservationId: "l2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("lifetime");
    }

    const sess = limitsFromEnv({
      SPONSOR_GAS_HOURLY_FIL: "10",
      SPONSOR_GAS_BURST_FIL: "10",
      SPONSOR_GAS_DAILY_FIL: "10",
      SPONSOR_GAS_LIFETIME_BASE_FIL: "10",
      SPONSOR_GAS_SESSION_DAILY_FIL: "0.001",
      SPONSOR_GAS_TX_MAX_FEE_FIL: "1",
      SPONSOR_GAS_FIL_FLOOR_FIL: "0",
    });
    const s5 = emptyGasState();
    reserveGas(s5, sess, { ...base, costWei: 10n ** 15n, sessionKey: "0x55", reservationId: "s1" });
    try {
      reserveGas(s5, sess, { ...base, costWei: 1n, sessionKey: "0x55", reservationId: "s2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("session");
    }

    const ip = limitsFromEnv({
      SPONSOR_GAS_HOURLY_FIL: "10",
      SPONSOR_GAS_BURST_FIL: "10",
      SPONSOR_GAS_DAILY_FIL: "10",
      SPONSOR_GAS_LIFETIME_BASE_FIL: "10",
      SPONSOR_GAS_IP_HOURLY_FIL: "0.001",
      SPONSOR_GAS_TX_MAX_FEE_FIL: "1",
      SPONSOR_GAS_FIL_FLOOR_FIL: "0",
    });
    const s6 = emptyGasState();
    reserveGas(s6, ip, { ...base, costWei: 10n ** 15n, ip: "1.2.3.4", reservationId: "i1" });
    try {
      reserveGas(s6, ip, { ...base, costWei: 1n, ip: "1.2.3.4", reservationId: "i2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as GasBudgetError).limit).toBe("ip");
    }
  });
});
