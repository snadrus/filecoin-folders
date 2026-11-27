// Pins the purchase waterfall documented in sponsor/README.md ("Purchase waterfall").
import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, creditFor, poolTopUp, stripeFeeModelCents } from "../sponsor/pricing.js";

const SEED = 10n ** 18n; // 1 USDFC pre-funded in every warm-pool spare
const usdfc = (wei: bigint) => Number(wei) / 1e18;

function waterfall(chargeCents: number, first: boolean) {
  const fee = stripeFeeModelCents(chargeCents);
  const q = creditFor(DEFAULT_PRICING, { chargeCents, feeCents: fee, first });
  return { fee, setup: q.setupCents, txFee: q.reserveCents, credit: q.creditCents, deposit: usdfc(first ? poolTopUp(q.creditUsdfc, SEED) : q.creditUsdfc) };
}

describe("purchase waterfall", () => {
  it("first purchase: Stripe fee, $1.50 creation, $1 tx fee, $1 pre-funded seed, rest topped up", () => {
    expect(waterfall(500, true)).toEqual({ fee: 45, setup: 150, txFee: 100, credit: 205, deposit: 1.05 });
    expect(waterfall(1000, true)).toEqual({ fee: 59, setup: 150, txFee: 100, credit: 691, deposit: 5.91 });
  });
  it("minimum first purchase $3.91 leaves exactly the pre-funded 1 USDFC (top-up 0)", () => {
    expect(DEFAULT_PRICING.minFirstCents).toBe(391);
    expect(waterfall(391, true)).toEqual({ fee: 41, setup: 150, txFee: 100, credit: 100, deposit: 0 });
  });
  it("top-ups: Stripe fee, $1 tx fee, rest deposited; minimum $2.37 deposits 1 USDFC", () => {
    expect(DEFAULT_PRICING.minTopUpCents).toBe(237);
    expect(waterfall(237, false)).toEqual({ fee: 37, setup: 0, txFee: 100, credit: 100, deposit: 1 });
    expect(waterfall(1000, false)).toEqual({ fee: 59, setup: 0, txFee: 100, credit: 841, deposit: 8.41 });
  });
});
