/** Filecoin storage quote and funding runway. Amounts are atto-USDFC (18 decimals). */

export const DOCS_COSTS_URL = "https://docs.filecoin.cloud/developer-guides/storage/storage-costs/";
export const EPOCH_SECONDS = 30;
export const EPOCHS_PER_DAY = 2880;
/** Epochs in a 30-day month: 2880 * 30. */
export const EPOCHS_PER_MONTH = 86400;

export const FALLBACK_PER_TIB_PER_MONTH = 2_500_000_000_000_000_000n;
export const FALLBACK_PROVING_PER_MONTH = 120_000_000_000_000_000n;
export const FALLBACK_RESERVE = 500_000_000_000_000_000n;
export const FALLBACK_CDN_RESERVE = 1_500_000_000_000_000_000n;
export const FALLBACK_CREATE_FEE = 25_000_000_000_000_000n;
export const FALLBACK_ADD_PIECES_BASE = 8_000_000_000_000_000n;
export const FALLBACK_ADD_PIECES_EACH = 3_000_000_000_000_000n;

export interface CostQuote {
  perTiBPerMonth: bigint;
  perTiBPerMonthCdn: bigint;
  provingPerMonth: bigint;
  reserve: bigint;
  cdnReserve: bigint;
  createFee: bigint;
  addPiecesBase: bigint;
  addPiecesEach: bigint;
  /** From getUploadCosts rate.perMonth, when the API returned one. */
  ratePerMonth?: bigint;
  source: "live" | "fallback";
}

export function fallbackQuote(): CostQuote {
  return {
    perTiBPerMonth: FALLBACK_PER_TIB_PER_MONTH,
    perTiBPerMonthCdn: FALLBACK_PER_TIB_PER_MONTH,
    provingPerMonth: FALLBACK_PROVING_PER_MONTH,
    reserve: FALLBACK_RESERVE,
    cdnReserve: FALLBACK_CDN_RESERVE,
    createFee: FALLBACK_CREATE_FEE,
    addPiecesBase: FALLBACK_ADD_PIECES_BASE,
    addPiecesEach: FALLBACK_ADD_PIECES_EACH,
    source: "fallback",
  };
}

export interface LivePricing {
  perTiBNoCdn?: bigint;
  perTiBWithCdn?: bigint;
  minimumPricePerMonth?: bigint;
  ratePerMonth?: bigint;
}

export function quoteFromLive(live: LivePricing): CostQuote {
  const base = fallbackQuote();
  return {
    ...base,
    perTiBPerMonth: live.perTiBNoCdn && live.perTiBNoCdn > 0n ? live.perTiBNoCdn : base.perTiBPerMonth,
    perTiBPerMonthCdn: live.perTiBWithCdn && live.perTiBWithCdn > 0n ? live.perTiBWithCdn : base.perTiBPerMonthCdn,
    provingPerMonth: live.minimumPricePerMonth && live.minimumPricePerMonth > 0n ? live.minimumPricePerMonth : base.provingPerMonth,
    ratePerMonth: live.ratePerMonth,
    source: "live",
  };
}

/** Monthly USDFC for `gb` GiB of one copy, plus proving once any data is stored. */
export function monthlyEstimate(quote: CostQuote, gb: number): bigint {
  if (!Number.isFinite(gb) || gb <= 0) return 0n;
  const milli = BigInt(Math.round(gb * 1000));
  const storage = (quote.perTiBPerMonth * milli) / 1024n / 1000n;
  return storage + quote.provingPerMonth;
}

export function fourGiBLine(quote: CostQuote): bigint {
  return (quote.perTiBPerMonth * 4n) / 1024n;
}

export function formatUsd(atto: bigint): string {
  if (atto <= 0n) return "$0.00";
  const cents = (atto * 100n + 500_000_000_000_000_000n / 2n) / 1_000_000_000_000_000_000n;
  if (cents <= 0n) return "< $0.01";
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `$${whole.toString()}.${frac}`;
}

export function datasetBlurb(quote: CostQuote): string {
  return `Creating a dataset locks about ${formatUsd(quote.reserve)} USDFC as a refundable reserve. A ${formatUsd(quote.createFee)} create fee is drawn from it. Storage is ${formatUsd(quote.perTiBPerMonth)} per TiB each month.`;
}

export function depositBlurb(quote: CostQuote, depositLabel: string): string {
  return `This deposits ${depositLabel} USDFC. Storage is ${formatUsd(quote.perTiBPerMonth)} per TiB each month, and 30 days of storage is prepaid. Current deposit ${depositLabel} USDFC.`;
}

export interface Runway {
  headline: string;
  detail: string;
  low: boolean;
  showAdd: boolean;
  datasetLabel: string;
}

export interface RunwayInput {
  availableFunds: bigint;
  lockupRatePerEpoch: bigint;
  datasetBytes: number;
  /** When false, the wallet is not connected and no pay account can be read. */
  known: boolean;
  nowMs?: number;
}

export function describeRunway(input: RunwayInput): Runway {
  const bytes = Number.isFinite(input.datasetBytes) && input.datasetBytes > 0 ? input.datasetBytes : 0;
  const datasetLabel = formatBytesLocal(bytes);
  const now = input.nowMs ?? Date.now();
  if (!input.known) {
    if (bytes === 0) {
      return { headline: "Nothing stored yet — no ongoing cost", detail: "", low: false, showAdd: false, datasetLabel };
    }
    return {
      headline: `Dataset total ${datasetLabel}`,
      detail: "Connect a wallet to see how long storage is paid up.",
      low: false,
      showAdd: false,
      datasetLabel,
    };
  }
  if (bytes === 0 && input.lockupRatePerEpoch <= 0n) {
    return { headline: "Nothing stored yet — no ongoing cost", detail: "", low: false, showAdd: false, datasetLabel };
  }
  if (input.lockupRatePerEpoch <= 0n) {
    return {
      headline: "Your files are paid up for 100+ years",
      detail: `at today's rate of $0.00/month · Dataset total ${datasetLabel}`,
      low: false,
      showAdd: false,
      datasetLabel,
    };
  }
  const epochs = input.availableFunds / input.lockupRatePerEpoch;
  const days = Number(epochs / BigInt(EPOCHS_PER_DAY));
  const money = formatUsd(input.lockupRatePerEpoch * BigInt(EPOCHS_PER_MONTH));
  const detail = `at today's rate of ${money}/month · Dataset total ${datasetLabel}`;
  if (epochs > BigInt(Number.MAX_SAFE_INTEGER) || days >= 100 * 365) {
    return { headline: "Your files are paid up for 100+ years", detail, low: false, showAdd: false, datasetLabel };
  }
  if (days < 60) {
    return {
      headline: `Add funds soon — ${spanLabel(days)}`,
      detail,
      low: true,
      showAdd: true,
      datasetLabel,
    };
  }
  const when = new Date(now + Number(epochs) * EPOCH_SECONDS * 1000);
  const month = when.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year = when.getUTCFullYear();
  return {
    headline: `Your files are paid up through about ${month} ${year}`,
    detail,
    low: false,
    showAdd: false,
    datasetLabel,
  };
}

function spanLabel(days: number): string {
  if (days < 1) return "about less than a day left";
  if (days < 14) return `about ${Math.max(1, Math.round(days))} days left`;
  const weeks = Math.max(1, Math.round(days / 7));
  return `about ${weeks} ${weeks === 1 ? "week" : "weeks"} left`;
}

function formatBytesLocal(size: number): string {
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 || Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function skipLivePricing(): boolean {
  const vitest = import.meta.env.VITEST === true || import.meta.env.VITEST === "true" || import.meta.env.MODE === "test";
  return import.meta.env.VITE_E2E === "1" || vitest || (typeof process !== "undefined" && process.env.VITEST === "true");
}
