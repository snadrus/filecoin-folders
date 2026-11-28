import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { configFromEnv, createStripeUsdcPayout, planRefill, requiredSecrets, runRefill, MAINNET_SPONSOR } from "../sponsor/refill-usdfc.js";

describe("USDFC refill (GEL-4)", () => {
  it("plans a capped payout when the sponsor is below the threshold", () => {
    const plan = planRefill({
      sponsor: MAINNET_SPONSOR,
      sponsorUsdfc: parseUnits("5", 18),
      sourceUsdc: 0n,
      threshold: parseUnits("20", 18),
      target: parseUnits("50", 18),
      maxUsdc: parseUnits("25", 6),
      dryRun: true,
      missing: ["SQUID_INTEGRATOR_ID"],
    });
    expect(plan.action).toBe("refill");
    expect(plan.payoutUsdc).toBe("25");
    expect(plan.neededUsdfc).toBe("45");
    expect(plan.dryRun).toBe(true);
    expect(plan.missing).toContain("SQUID_INTEGRATOR_ID");
  });

  it("skips when the sponsor is at or above the threshold", () => {
    const plan = planRefill({
      sponsor: MAINNET_SPONSOR,
      sponsorUsdfc: parseUnits("20", 18),
      sourceUsdc: 0n,
      threshold: parseUnits("20", 18),
      target: parseUnits("50", 18),
      maxUsdc: parseUnits("25", 6),
      dryRun: true,
      missing: [],
    });
    expect(plan.action).toBe("skip");
    expect(plan.payoutUsdc).toBe("0");
  });

  it("defaults to dry-run and lists the secrets Andy must set to turn it on", () => {
    const cfg = configFromEnv({ REFILL_THRESHOLD_USDFC: "20" }, []);
    expect(cfg.dryRun).toBe(true);
    const missing = requiredSecrets(cfg);
    expect(missing.join(" ")).toMatch(/STRIPE_PAYOUT_KEY|STRIPE_LIVE_SECRET_KEY/);
    expect(missing.join(" ")).toMatch(/STRIPE_FINANCIAL_ACCOUNT/);
    expect(missing.join(" ")).toMatch(/STRIPE_CRYPTO_PAYOUT_METHOD/);
    expect(missing.join(" ")).toMatch(/SQUID_INTEGRATOR_ID/);
  });

  it("refuses a live Stripe payout while dry-run is set", async () => {
    const cfg = configFromEnv({
      STRIPE_LIVE_SECRET_KEY: "sk_live_dummy",
      STRIPE_FINANCIAL_ACCOUNT: "fa_123",
      STRIPE_CRYPTO_PAYOUT_METHOD: "cwa_123",
    }, []);
    expect(cfg.dryRun).toBe(true);
    await expect(createStripeUsdcPayout(cfg, 1_000_000n)).rejects.toThrow(/dry-run/);
  });

  it("runRefill in dry-run never calls Stripe or sends a swap", async () => {
    let stripeOrSend = 0;
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("money_management") || url.includes("api.stripe.com")) {
        stripeOrSend += 1;
        throw new Error("stripe should not be called in dry-run");
      }
      if (url.includes("json") || url.endsWith("/rpc/v1") || url.includes("base.org")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (5n * 10n ** 18n).toString(16) }), { headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    };
    const report = await runRefill({
      ...configFromEnv({}, []),
      fetch: fetchImpl,
      sendSourceTx: async () => {
        stripeOrSend += 1;
        throw new Error("send should not run in dry-run");
      },
    });
    expect(report.dryRun).toBe(true);
    expect(report.stripePayoutId).toBeUndefined();
    expect(report.squidTx).toBeUndefined();
    expect(stripeOrSend).toBe(0);
    expect(calls.some((c) => c.includes("stripe.com"))).toBe(false);
  });
});
