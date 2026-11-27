import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { DEFAULT_PRICING } from "../sponsor/pricing.js";
import {
  classifyBalances,
  composeAlertEmail,
  decideBalanceAlert,
  fmtToken,
  usdfcReserveNeed,
  type AlertThresholds,
} from "../sponsor/balance-alerts.js";
import { deliverAlertEmail } from "../sponsor/mailer.js";

const one = 10n ** 18n;
const thresholds = (over: Partial<AlertThresholds> = {}): AlertThresholds => ({
  enabled: true,
  filWarnWei: parseUnits("0.1", 18),
  filCriticalWei: parseUnits("0.06", 18),
  usdfcWarnWei: parseUnits("9", 18),
  usdfcCriticalWei: parseUnits("4", 18),
  minRunwayDays: 45,
  criticalRunwayDays: 7,
  reminderMs: 24 * 3_600_000,
  to: "snadrus@gmail.com",
  from: "sponsor@scionbase.ai",
  ...over,
});

describe("usdfcReserveNeed", () => {
  it("is 2 spares at 3-month runway plus 3 minimum first-purchase credits", () => {
    const need = usdfcReserveNeed({ poolSize: 2, seedUsdfc: "1", topUpMonths: 3, pricing: DEFAULT_PRICING });
    // min first $3.91 → 1 USDFC credit; 2 × 3 USDFC + 3 × 1 USDFC = 9
    expect(need.firstPurchaseWei).toBe(one);
    expect(need.spareWei).toBe(6n * one);
    expect(need.warnWei).toBe(9n * one);
    expect(need.criticalWei).toBe(4n * one);
  });
});

describe("classifyBalances", () => {
  it("warns on FIL below 0.1 and goes critical below 0.06", () => {
    const warn = classifyBalances({
      filWei: parseUnits("0.08", 18),
      usdfcWei: parseUnits("20", 18),
      owedUsdfcWei: 0n,
      spareRunways: [90, 90],
      thresholds: thresholds(),
    });
    expect(warn.level).toBe("warn");
    expect(warn.fil).toBe("warn");
    expect(warn.usdfc).toBe("ok");
    expect(warn.suggestedFilWei).toBe(one - parseUnits("0.08", 18));

    const crit = classifyBalances({
      filWei: parseUnits("0.05", 18),
      usdfcWei: parseUnits("20", 18),
      owedUsdfcWei: 0n,
      spareRunways: [90],
      thresholds: thresholds(),
    });
    expect(crit.level).toBe("critical");
    expect(crit.fil).toBe("critical");
  });

  it("uses USDFC after owed credits and flags short spare runway", () => {
    const snap = classifyBalances({
      filWei: one,
      usdfcWei: parseUnits("10", 18),
      owedUsdfcWei: parseUnits("3", 18),
      spareRunways: [15, 90],
      thresholds: thresholds(),
    });
    expect(snap.availableUsdfcWei).toBe(7n * one);
    expect(snap.usdfc).toBe("warn");
    expect(snap.runway).toBe("warn");
    expect(snap.level).toBe("warn");
    expect(snap.reasons.some((r) => r.startsWith("USDFC"))).toBe(true);
    expect(snap.reasons.some((r) => r.includes("runway 15d"))).toBe(true);
  });
});

describe("decideBalanceAlert", () => {
  const day = 24 * 3_600_000;
  it("sends once on going low, once on recovery, and a daily reminder while low", () => {
    expect(decideBalanceAlert({ level: "ok", now: 1_000, reminderMs: day })).toBe(null);
    expect(decideBalanceAlert({ level: "warn", now: 1_000, reminderMs: day })).toBe("low");
    expect(decideBalanceAlert({ prev: { level: "warn", lastSentAt: 1_000 }, level: "warn", now: 1_000 + 60_000, reminderMs: day })).toBe(null);
    expect(decideBalanceAlert({ prev: { level: "warn", lastSentAt: 1_000 }, level: "warn", now: 1_000 + day, reminderMs: day })).toBe("reminder");
    expect(decideBalanceAlert({ prev: { level: "warn", lastSentAt: 1_000 }, level: "ok", now: 2_000, reminderMs: day })).toBe("recovery");
    expect(decideBalanceAlert({ prev: { level: "ok", lastSentAt: 1_000 }, level: "ok", now: 2_000, reminderMs: day })).toBe(null);
  });

  it("sends again when warn escalates to critical, and retries if the last send never landed", () => {
    expect(decideBalanceAlert({ prev: { level: "warn", lastSentAt: 1_000 }, level: "critical", now: 2_000, reminderMs: day })).toBe("low");
    expect(decideBalanceAlert({ prev: { level: "warn" }, level: "warn", now: 2_000, reminderMs: day })).toBe("low");
  });
});

describe("composeAlertEmail", () => {
  it("includes network, address, balances, suggested top-up, and a how-to", () => {
    const snapshot = classifyBalances({
      filWei: parseUnits("0.08", 18),
      usdfcWei: parseUnits("20", 18),
      owedUsdfcWei: 0n,
      spareRunways: [90],
      thresholds: thresholds(),
    });
    const msg = composeAlertEmail({
      action: "low",
      snapshot,
      network: "calibration",
      sponsor: "0xEc476AB8366a22fCafa2B7559638FE10b44E0106",
      thresholds: thresholds(),
    });
    expect(msg.to).toBe("snadrus@gmail.com");
    expect(msg.subject).toMatch(/Calibration sponsor FIL low/i);
    expect(msg.text).toContain("0xEc476AB8366a22fCafa2B7559638FE10b44E0106");
    expect(msg.text).toContain("Network:  calibration");
    expect(msg.text).toContain("Suggested top-up");
    expect(msg.text).toContain("0.05 FIL");
    expect(msg.text).toContain("docs/usdfc-refill.md");
    expect(msg.text).toContain("calibration.filfox.info");
    expect(msg.text).toContain(fmtToken(snapshot.suggestedFilWei));
  });
});

describe("deliverAlertEmail", () => {
  it("prefers the Email Routing binding and falls back to Resend", async () => {
    const sent: unknown[] = [];
    const via = await deliverAlertEmail(
      { EMAIL: { async send(message) { sent.push(message); } } },
      { to: "snadrus@gmail.com", from: "sponsor@scionbase.ai", subject: "t", text: "b" },
    );
    expect(via.channel).toBe("email-routing");
    expect(sent).toHaveLength(1);

    let body = "";
    const resend = await deliverAlertEmail(
      {
        RESEND_API_KEY: "re_test",
        fetch: (async (_url, init) => {
          body = String(init?.body ?? "");
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      },
      { to: "snadrus@gmail.com", from: "sponsor@scionbase.ai", subject: "t", text: "b" },
    );
    expect(resend.channel).toBe("resend");
    expect(body).toContain("onboarding@resend.dev");
    expect(body).not.toContain("re_test");

    await expect(deliverAlertEmail({}, { to: "a@b.c", from: "a@b.c", subject: "t", text: "b" })).rejects.toThrow(/no mailer/);
  });
});
