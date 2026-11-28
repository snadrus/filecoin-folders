/** Edge-triggered low-balance emails for the sponsor cron (FIL, USDFC, spare runway). */

import { formatUnits, parseUnits } from "viem";
import { creditFor, stripeFeeModelCents, type Pricing } from "./pricing.js";
import { USDFC_MONTHLY_FLOOR, type PoolCareConfig } from "./pool-care.js";

export type AlertLevel = "ok" | "warn" | "critical";
export type AlertAction = "low" | "recovery" | "reminder";

export interface AlertThresholds {
  /** Master switch. Production default is on. */
  enabled: boolean;
  filWarnWei: bigint;
  filCriticalWei: bigint;
  /** If set, overrides the computed USDFC warn (2 spares + 3 first purchases). */
  usdfcWarnWei?: bigint;
  usdfcCriticalWei?: bigint;
  minRunwayDays: number;
  criticalRunwayDays: number;
  reminderMs: number;
  to: string;
  from: string;
}

export const DEFAULT_ALERT_TO = "snadrus@gmail.com";
export const DEFAULT_ALERT_FROM = "sponsor@scionbase.ai";
export const DEFAULT_FIL_WARN = "0.1";
export const DEFAULT_FIL_CRITICAL = "0.06";
export const DEFAULT_REMINDER_HOURS = 24;
export const FIRST_PURCHASES_RESERVE = 3;

export interface UsdfcReserveNeed {
  warnWei: bigint;
  criticalWei: bigint;
  spareWei: bigint;
  firstPurchaseWei: bigint;
  firstPurchases: number;
  spares: number;
}

export function usdfcReserveNeed(input: {
  poolSize: number;
  seedUsdfc: string;
  topUpMonths: number;
  pricing: Pricing;
  firstPurchases?: number;
}): UsdfcReserveNeed {
  const firstPurchases = input.firstPurchases ?? FIRST_PURCHASES_RESERVE;
  const seed = parseUnits(input.seedUsdfc || "1", 18);
  const months = BigInt(Math.max(1, input.topUpMonths));
  const perSpare = seed > USDFC_MONTHLY_FLOOR * months ? seed : USDFC_MONTHLY_FLOOR * months;
  const spares = Math.max(0, input.poolSize);
  const spareWei = perSpare * BigInt(spares);
  const feeCents = stripeFeeModelCents(input.pricing.minFirstCents, input.pricing);
  const firstPurchaseWei = creditFor(input.pricing, { chargeCents: input.pricing.minFirstCents, feeCents, first: true }).creditUsdfc;
  const warnWei = spareWei + firstPurchaseWei * BigInt(firstPurchases);
  const criticalWei = perSpare + firstPurchaseWei; // one spare + one first purchase
  return { warnWei, criticalWei, spareWei, firstPurchaseWei, firstPurchases, spares };
}

export function alertThresholdsFromEnv(
  env: Record<string, string | undefined>,
  opts: { poolSize: number; seedUsdfc: string; care: PoolCareConfig; pricing: Pricing },
): AlertThresholds {
  const num = (value: string | undefined, fallback: number) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const wei = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return parseUnits(value, 18);
    } catch {
      return undefined;
    }
  };
  const computed = usdfcReserveNeed({
    poolSize: opts.poolSize,
    seedUsdfc: opts.seedUsdfc,
    topUpMonths: opts.care.topUpMonths,
    pricing: opts.pricing,
  });
  let filWarnWei = wei(env.SPONSOR_ALERT_FIL_WARN_FIL) ?? parseUnits(DEFAULT_FIL_WARN, 18);
  let filCriticalWei = wei(env.SPONSOR_ALERT_FIL_CRITICAL_FIL) ?? parseUnits(DEFAULT_FIL_CRITICAL, 18);
  if (filCriticalWei > filWarnWei) filCriticalWei = filWarnWei;
  const usdfcWarnWei = wei(env.SPONSOR_ALERT_USDFC_WARN) ?? computed.warnWei;
  let usdfcCriticalWei = wei(env.SPONSOR_ALERT_USDFC_CRITICAL) ?? computed.criticalWei;
  if (usdfcCriticalWei > usdfcWarnWei) usdfcCriticalWei = usdfcWarnWei;
  const minRunwayDays = num(env.SPONSOR_ALERT_MIN_RUNWAY_DAYS, opts.care.minRunwayDays || 45);
  let criticalRunwayDays = num(env.SPONSOR_ALERT_CRITICAL_RUNWAY_DAYS, Math.min(7, minRunwayDays));
  if (criticalRunwayDays > minRunwayDays) criticalRunwayDays = minRunwayDays;
  return {
    enabled: env.SPONSOR_ALERT_DISABLED !== "1" && Boolean((env.SPONSOR_ALERT_TO ?? DEFAULT_ALERT_TO).trim()),
    filWarnWei,
    filCriticalWei,
    usdfcWarnWei,
    usdfcCriticalWei,
    minRunwayDays,
    criticalRunwayDays,
    reminderMs: Math.max(1, num(env.SPONSOR_ALERT_REMINDER_HOURS, DEFAULT_REMINDER_HOURS)) * 3_600_000,
    to: (env.SPONSOR_ALERT_TO ?? DEFAULT_ALERT_TO).trim(),
    from: (env.SPONSOR_ALERT_FROM ?? DEFAULT_ALERT_FROM).trim(),
  };
}

export function tokenLevel(value: bigint, warn: bigint, critical: bigint): AlertLevel {
  if (value < critical) return "critical";
  if (value < warn) return "warn";
  return "ok";
}

export function runwayLevel(runways: number[], minDays: number, criticalDays: number): AlertLevel {
  if (!runways.length || minDays <= 0) return "ok";
  const worst = Math.min(...runways);
  if (worst < criticalDays) return "critical";
  if (worst < minDays) return "warn";
  return "ok";
}

export function worstLevel(...levels: AlertLevel[]): AlertLevel {
  if (levels.includes("critical")) return "critical";
  if (levels.includes("warn")) return "warn";
  return "ok";
}

export function fmtToken(wei: bigint, digits = 4): string {
  const raw = formatUnits(wei, 18);
  const [whole, frac = ""] = raw.split(".");
  const trimmed = frac.replace(/0+$/, "").slice(0, digits);
  return trimmed ? `${whole}.${trimmed}` : whole ?? "0";
}

export interface BalanceSnapshot {
  level: AlertLevel;
  fil: AlertLevel;
  usdfc: AlertLevel;
  runway: AlertLevel;
  reasons: string[];
  filWei: bigint;
  usdfcWei: bigint;
  owedUsdfcWei: bigint;
  availableUsdfcWei: bigint;
  warnUsdfcWei: bigint;
  criticalUsdfcWei: bigint;
  suggestedFilWei: bigint;
  suggestedUsdfcWei: bigint;
  spareRunways: number[];
}

const ONE_FIL = 10n ** 18n;

export function classifyBalances(input: {
  filWei: bigint;
  usdfcWei: bigint;
  owedUsdfcWei: bigint;
  spareRunways: number[];
  thresholds: AlertThresholds;
}): BalanceSnapshot {
  const t = input.thresholds;
  const availableUsdfcWei = input.usdfcWei > input.owedUsdfcWei ? input.usdfcWei - input.owedUsdfcWei : 0n;
  const warnUsdfcWei = t.usdfcWarnWei ?? 0n;
  const criticalUsdfcWei = t.usdfcCriticalWei ?? 0n;
  const fil = tokenLevel(input.filWei, t.filWarnWei, t.filCriticalWei);
  const usdfc = warnUsdfcWei > 0n ? tokenLevel(availableUsdfcWei, warnUsdfcWei, criticalUsdfcWei || warnUsdfcWei) : "ok";
  const runway = runwayLevel(input.spareRunways, t.minRunwayDays, t.criticalRunwayDays);
  const reasons: string[] = [];
  if (fil !== "ok") reasons.push(`FIL ${fmtToken(input.filWei)} (${fil}; warn ${fmtToken(t.filWarnWei)} / critical ${fmtToken(t.filCriticalWei)})`);
  if (usdfc !== "ok") reasons.push(`USDFC ${fmtToken(availableUsdfcWei)} available (${usdfc}; warn ${fmtToken(warnUsdfcWei)} / critical ${fmtToken(criticalUsdfcWei)})`);
  if (runway !== "ok") {
    const worst = input.spareRunways.length ? Math.min(...input.spareRunways) : 0;
    reasons.push(`spare runway ${worst}d (${runway}; warn < ${t.minRunwayDays}d / critical < ${t.criticalRunwayDays}d)`);
  }
  const filTarget = input.filWei < ONE_FIL ? ONE_FIL : t.filWarnWei;
  const suggestedFilWei = input.filWei < filTarget ? filTarget - input.filWei : 0n;
  const usdfcTarget = warnUsdfcWei;
  const suggestedUsdfcWei = availableUsdfcWei < usdfcTarget ? usdfcTarget - availableUsdfcWei : 0n;
  return {
    level: worstLevel(fil, usdfc, runway),
    fil,
    usdfc,
    runway,
    reasons,
    filWei: input.filWei,
    usdfcWei: input.usdfcWei,
    owedUsdfcWei: input.owedUsdfcWei,
    availableUsdfcWei,
    warnUsdfcWei,
    criticalUsdfcWei,
    suggestedFilWei,
    suggestedUsdfcWei,
    spareRunways: input.spareRunways,
  };
}

export function decideBalanceAlert(input: {
  prev?: { level: AlertLevel; lastSentAt?: number };
  level: AlertLevel;
  now: number;
  reminderMs: number;
}): AlertAction | null {
  const wasLow = input.prev?.level === "warn" || input.prev?.level === "critical";
  const isLow = input.level === "warn" || input.level === "critical";
  if (!wasLow && isLow) return "low";
  if (wasLow && !isLow) return "recovery";
  if (isLow && input.prev?.level !== "critical" && input.level === "critical") return "low";
  if (isLow && input.prev?.lastSentAt == null) return "low";
  if (isLow && input.prev?.lastSentAt != null && input.now - input.prev.lastSentAt >= input.reminderMs) return "reminder";
  return null;
}

export interface AlertEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export function composeAlertEmail(input: {
  action: AlertAction;
  snapshot: BalanceSnapshot;
  network: string;
  sponsor: string;
  thresholds: AlertThresholds;
  need?: UsdfcReserveNeed;
}): AlertEmail {
  const net = input.network === "mainnet" ? "mainnet" : "calibration";
  const s = input.snapshot;
  const label = s.reasons.length ? s.reasons.map((r) => r.split(" ")[0]).join(" and ") : "funds";
  let subject: string;
  if (input.action === "recovery") subject = `[TreFolders] ${net} sponsor funds recovered`;
  else if (input.action === "reminder") subject = `[TreFolders] ${net} sponsor ${label} still ${s.level}`;
  else subject = s.level === "critical"
    ? `[TreFolders] ${net} sponsor ${label} CRITICAL`
    : `[TreFolders] ${net} sponsor ${label} low`;

  const explorer = net === "mainnet"
    ? `https://filfox.info/en/address/${input.sponsor}`
    : `https://calibration.filfox.info/en/address/${input.sponsor}`;
  const runways = s.spareRunways.length ? s.spareRunways.map((d) => `${d}d`).join(", ") : "no ready spares";
  const need = input.need;
  const needLine = need
    ? `USDFC reserve target is ${fmtToken(need.warnWei)} (${need.spares} spares × ${fmtToken(need.spareWei && need.spares ? need.spareWei / BigInt(need.spares) : 0n)} + ${need.firstPurchases} first purchases × ${fmtToken(need.firstPurchaseWei)} at the minimum first charge).`
    : "";
  const suggested = [
    s.suggestedFilWei > 0n ? `${fmtToken(s.suggestedFilWei)} FIL (top up to 1 FIL)` : null,
    s.suggestedUsdfcWei > 0n ? `${fmtToken(s.suggestedUsdfcWei)} USDFC (to the reserve target)` : null,
  ].filter(Boolean).join(" and ") || "none (balances are at or above the targets)";

  const text = [
    input.action === "recovery"
      ? `The ${net} TreFolders sponsor wallet is back above its alert thresholds.`
      : input.action === "reminder"
        ? `Reminder: the ${net} TreFolders sponsor wallet is still ${s.level}.`
        : `The ${net} TreFolders sponsor wallet is ${s.level}.`,
    "",
    `Network:  ${net}`,
    `Address:  ${input.sponsor}`,
    `FIL:      ${fmtToken(s.filWei)}  (${s.fil}; warn ${fmtToken(input.thresholds.filWarnWei)} / critical ${fmtToken(input.thresholds.filCriticalWei)})`,
    `USDFC:    ${fmtToken(s.usdfcWei)} total, ${fmtToken(s.availableUsdfcWei)} available after ${fmtToken(s.owedUsdfcWei)} owed  (${s.usdfc}; warn ${fmtToken(s.warnUsdfcWei)} / critical ${fmtToken(s.criticalUsdfcWei)})`,
    `Runway:   ${runways}  (${s.runway}; warn < ${input.thresholds.minRunwayDays}d / critical < ${input.thresholds.criticalRunwayDays}d)`,
    s.reasons.length ? `Reasons:  ${s.reasons.join("; ")}` : "",
    needLine,
    `Suggested top-up: ${suggested}`,
    "",
    "How to top up",
    "--------------",
    `1. Send FIL to the sponsor address on Filecoin ${net}:`,
    `   ${input.sponsor}`,
    "2. Send USDFC (the Filecoin ERC-20) to the same address.",
    "3. Keep at least 0.05 FIL in the wallet for gas. The sponsor will not spend below that floor.",
    "4. Mainnet automatic USDFC refill (Stripe USDC payout → Squid swap → sponsor) is documented in docs/usdfc-refill.md; it stays dry-run until you enable it.",
    `Explorer: ${explorer}`,
  ].filter((line) => line !== "").join("\n");

  return { to: input.thresholds.to, from: input.thresholds.from, subject, text };
}

export interface BalanceAlertRecord {
  level: AlertLevel;
  lastSentAt?: string;
  lastAction?: AlertAction;
  lastError?: string;
  lastAttemptAt?: string;
  lastChannel?: "email-routing" | "resend";
  reasons?: string[];
  fil?: string;
  usdfc?: string;
}

export function alertStatusView(record: BalanceAlertRecord | undefined, snapshot: BalanceSnapshot, thresholds: AlertThresholds, need: UsdfcReserveNeed): Record<string, unknown> {
  return {
    enabled: thresholds.enabled,
    level: snapshot.level,
    fil: snapshot.fil,
    usdfc: snapshot.usdfc,
    runway: snapshot.runway,
    reasons: snapshot.reasons,
    to: thresholds.to,
    thresholds: {
      filWarn: fmtToken(thresholds.filWarnWei),
      filCritical: fmtToken(thresholds.filCriticalWei),
      usdfcWarn: fmtToken(snapshot.warnUsdfcWei),
      usdfcCritical: fmtToken(snapshot.criticalUsdfcWei),
      minRunwayDays: thresholds.minRunwayDays,
      criticalRunwayDays: thresholds.criticalRunwayDays,
      reminderHours: thresholds.reminderMs / 3_600_000,
    },
    reserve: {
      usdfcWarn: fmtToken(need.warnWei),
      usdfcCritical: fmtToken(need.criticalWei),
      spares: need.spares,
      firstPurchases: need.firstPurchases,
      perSpare: fmtToken(need.spares ? need.spareWei / BigInt(need.spares) : 0n),
      perFirstPurchase: fmtToken(need.firstPurchaseWei),
    },
    suggestedTopUp: {
      fil: fmtToken(snapshot.suggestedFilWei),
      usdfc: fmtToken(snapshot.suggestedUsdfcWei),
    },
    lastAction: record?.lastAction ?? null,
    lastSentAt: record?.lastSentAt ?? null,
    lastChannel: record?.lastChannel ?? null,
    lastError: record?.lastError ?? null,
  };
}
