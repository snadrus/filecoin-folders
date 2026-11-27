/** Per-account sponsor gas budget, stored in the Durable Object. Amounts are wei (attoFIL). */
import { formatUnits, parseUnits } from "viem";

export type GasLimitName = "hourly" | "daily" | "lifetime" | "tx-gas" | "tx-fee" | "session" | "ip" | "fil-floor" | "blocked";

export class GasBudgetError extends Error {
  readonly status = 429;
  constructor(
    readonly limit: GasLimitName,
    readonly retryAfter: number,
    message?: string,
  ) {
    super(message ?? `gas budget exceeded: ${limit}`);
    this.name = "GasBudgetError";
  }
}

export interface GasBudgetLimits {
  hourlyWei: bigint;
  burstWei: bigint;
  dailyWei: bigint;
  lifetimeBaseWei: bigint;
  lifetimePerPurchaseWei: bigint;
  txMaxGas: bigint;
  txMaxFeeWei: bigint;
  sessionDailyWei: bigint;
  ipHourlyWei: bigint;
  filFloorWei: bigint;
}

export interface GasBucket {
  tokens: string;
  updated: number;
}

export interface GasAccount {
  hour: GasBucket;
  dayUsed: string;
  dayStart: number;
  reserved: string;
  sessions: Record<string, { dayUsed: string; dayStart: number }>;
}

export interface FailureRow {
  count: number;
  first: number;
  blockedUntil?: number;
  reason?: string;
}

export interface GasBudgetState {
  accounts: Record<string, GasAccount>;
  ips: Record<string, GasBucket>;
  reservations: Record<string, { account: string; amount: string; at: number }>;
  /** Relays that were mined but reverted (sponsor paid gas for nothing), per account and per target. */
  failures?: { accounts: Record<string, FailureRow>; targets: Record<string, FailureRow> };
}

/** Reverted relays tolerated per window before the account (or, across accounts, the target) is refused. */
export const FAILURE_RULES = {
  windowMs: 24 * 3_600_000,
  accountMax: 3,
  accountBlockMs: 24 * 3_600_000,
  targetMax: 5,
  targetBlockMs: 7 * 24 * 3_600_000,
} as const;

function failures(state: GasBudgetState): NonNullable<GasBudgetState["failures"]> {
  state.failures ??= { accounts: {}, targets: {} };
  return state.failures;
}

/** Throws GasBudgetError("blocked") if the account or target is refused right now. */
export function assertRelayAllowed(state: GasBudgetState, account: string, target: string, now = Date.now()): void {
  const f = failures(state);
  for (const [kind, row] of [["account", f.accounts[account.toLowerCase()]], ["target", f.targets[target.toLowerCase()]]] as const) {
    if (row?.blockedUntil && row.blockedUntil > now) {
      throw new GasBudgetError("blocked", Math.max(1, Math.ceil((row.blockedUntil - now) / 1000)), `${kind} blocked from sponsored relays: ${row.reason ?? "repeated reverted relays"}`);
    }
  }
}

function bump(row: FailureRow | undefined, now: number, max: number, blockMs: number, reason: string): FailureRow {
  const next: FailureRow = row && now - row.first < FAILURE_RULES.windowMs ? { ...row, count: row.count + 1 } : { count: 1, first: now };
  if (next.count >= max) Object.assign(next, { blockedUntil: now + blockMs, reason });
  return next;
}

/** A relay was mined and reverted: count it; block the account after 3/day and the target after 5/day (any accounts). */
export function recordRelayFailure(state: GasBudgetState, account: string, target: string, now = Date.now()): void {
  const f = failures(state);
  const a = account.toLowerCase();
  const t = target.toLowerCase();
  f.accounts[a] = bump(f.accounts[a], now, FAILURE_RULES.accountMax, FAILURE_RULES.accountBlockMs, "repeated reverted relays");
  f.targets[t] = bump(f.targets[t], now, FAILURE_RULES.targetMax, FAILURE_RULES.targetBlockMs, "target keeps reverting relays");
}

/** Refuse sponsored relays for an account (e.g. a disputed card payment). */
export function blockAccount(state: GasBudgetState, account: string, untilMs: number, reason: string): void {
  const f = failures(state);
  const a = account.toLowerCase();
  f.accounts[a] = { ...(f.accounts[a] ?? { count: 0, first: Date.now() }), blockedUntil: untilMs, reason };
}

export const DEFAULT_GAS_LIMITS = {
  hourlyFil: "0.01",
  burstFil: "0.03",
  dailyFil: "0.05",
  lifetimeBaseFil: "0.01",
  lifetimePerPurchaseFil: "0.002",
  // Filecoin EVM gas units are much larger than Ethereum; addSessionKey uses ~62M on Calibration and estimates can exceed 200M.
  txMaxGas: "500000000",
  txMaxFeeFil: "0.01",
  sessionDailyFil: "0.02",
  ipHourlyFil: "0.03",
  filFloorFil: "0.05",
} as const;

export function limitsFromEnv(env: Record<string, string | undefined> = {}): GasBudgetLimits {
  const fil = (name: string, fallback: string) => parseUnits(env[name] || fallback, 18);
  return {
    hourlyWei: fil("SPONSOR_GAS_HOURLY_FIL", DEFAULT_GAS_LIMITS.hourlyFil),
    burstWei: fil("SPONSOR_GAS_BURST_FIL", DEFAULT_GAS_LIMITS.burstFil),
    dailyWei: fil("SPONSOR_GAS_DAILY_FIL", DEFAULT_GAS_LIMITS.dailyFil),
    lifetimeBaseWei: fil("SPONSOR_GAS_LIFETIME_BASE_FIL", DEFAULT_GAS_LIMITS.lifetimeBaseFil),
    lifetimePerPurchaseWei: fil("SPONSOR_GAS_LIFETIME_PER_PURCHASE_FIL", DEFAULT_GAS_LIMITS.lifetimePerPurchaseFil),
    txMaxGas: BigInt(env.SPONSOR_GAS_TX_MAX_GAS || DEFAULT_GAS_LIMITS.txMaxGas),
    txMaxFeeWei: fil("SPONSOR_GAS_TX_MAX_FEE_FIL", DEFAULT_GAS_LIMITS.txMaxFeeFil),
    sessionDailyWei: fil("SPONSOR_GAS_SESSION_DAILY_FIL", DEFAULT_GAS_LIMITS.sessionDailyFil),
    ipHourlyWei: fil("SPONSOR_GAS_IP_HOURLY_FIL", DEFAULT_GAS_LIMITS.ipHourlyFil),
    filFloorWei: fil("SPONSOR_GAS_FIL_FLOOR_FIL", DEFAULT_GAS_LIMITS.filFloorFil),
  };
}

export function lifetimeCapWei(purchases: number, limits: GasBudgetLimits): bigint {
  const n = Number.isFinite(purchases) && purchases > 0 ? Math.floor(purchases) : 0;
  return limits.lifetimeBaseWei + limits.lifetimePerPurchaseWei * BigInt(n);
}

/** Sponsor-pays cost of a relay: estimate × 1.3 × maxFee. */
export function reservedCostWei(gas: bigint, maxFeePerGas: bigint): bigint {
  return (gas * 13n) / 10n * maxFeePerGas;
}

export function emptyGasState(): GasBudgetState {
  return { accounts: {}, ips: {}, reservations: {} };
}

function utcDay(now: number): number {
  return Math.floor(now / 86_400_000);
}

function refill(bucket: GasBucket, capacity: bigint, refillPerHour: bigint, now: number): bigint {
  const elapsed = Math.max(0, now - bucket.updated);
  const add = (refillPerHour * BigInt(elapsed)) / 3_600_000n;
  let tokens = BigInt(bucket.tokens || "0") + add;
  if (tokens > capacity) tokens = capacity;
  bucket.tokens = tokens.toString();
  bucket.updated = now;
  return tokens;
}

function accountOf(state: GasBudgetState, address: string, now: number, limits: GasBudgetLimits): GasAccount {
  const id = address.toLowerCase();
  let row = state.accounts[id];
  if (!row) {
    row = { hour: { tokens: limits.burstWei.toString(), updated: now }, dayUsed: "0", dayStart: utcDay(now), reserved: "0", sessions: {} };
    state.accounts[id] = row;
  }
  if (row.dayStart !== utcDay(now)) {
    row.dayUsed = "0";
    row.dayStart = utcDay(now);
  }
  return row;
}

/**
 * Atomically reserve `cost` against every applicable cap. Throws GasBudgetError (429 + Retry-After + which limit).
 * Caller must settle or release the reservation id after the receipt (or on send failure).
 */
export function reserveGas(
  state: GasBudgetState,
  limits: GasBudgetLimits,
  input: {
    account: string;
    reservationId: string;
    costWei: bigint;
    gas: bigint;
    maxFeePerGas: bigint;
    lifetimeCapWei: bigint;
    sponsorFilWei: bigint;
    sessionKey?: string | null;
    ip?: string | null;
    now?: number;
  },
): { reserved: bigint } {
  const now = input.now ?? Date.now();
  const available = input.sponsorFilWei;
  if (available < limits.filFloorWei || available - input.costWei < limits.filFloorWei) {
    throw new GasBudgetError("fil-floor", 300, "sponsor FIL is at or below the gas floor");
  }
  if (input.gas > limits.txMaxGas) throw new GasBudgetError("tx-gas", 0, `gas ${input.gas} exceeds per-transaction max ${limits.txMaxGas}`);
  if (input.costWei > limits.txMaxFeeWei) throw new GasBudgetError("tx-fee", 0, `fee ${input.costWei} exceeds per-transaction max ${limits.txMaxFeeWei}`);
  const row = accountOf(state, input.account, now, limits);
  const reserved = BigInt(row.reserved || "0");
  const hourTokens = refill(row.hour, limits.burstWei, limits.hourlyWei, now);
  if (hourTokens < input.costWei) {
    const missing = input.costWei - hourTokens;
    const retry = limits.hourlyWei === 0n ? 3600 : Number((missing * 3_600_000n + limits.hourlyWei - 1n) / limits.hourlyWei);
    throw new GasBudgetError("hourly", Math.min(3600, Math.max(1, retry)));
  }
  const dayUsed = BigInt(row.dayUsed || "0");
  if (dayUsed + reserved + input.costWei > limits.dailyWei) {
    const end = (row.dayStart + 1) * 86_400_000;
    throw new GasBudgetError("daily", Math.max(1, Math.ceil((end - now) / 1000)));
  }
  // lifetime: settled usage + outstanding reservations + this cost
  const settled = lifetimeUsed(row);
  if (settled + reserved + input.costWei > input.lifetimeCapWei) {
    throw new GasBudgetError("lifetime", 86_400, "lifetime gas cap reached; a purchase raises it");
  }
  if (input.sessionKey) {
    const sid = input.sessionKey.toLowerCase();
    let sess = row.sessions[sid];
    if (!sess || sess.dayStart !== utcDay(now)) sess = row.sessions[sid] = { dayUsed: "0", dayStart: utcDay(now) };
    if (BigInt(sess.dayUsed) + input.costWei > limits.sessionDailyWei) {
      const end = (sess.dayStart + 1) * 86_400_000;
      throw new GasBudgetError("session", Math.max(1, Math.ceil((end - now) / 1000)));
    }
  }
  if (input.ip) {
    const ip = input.ip.trim();
    let bucket = state.ips[ip];
    if (!bucket) bucket = state.ips[ip] = { tokens: limits.ipHourlyWei.toString(), updated: now };
    const ipTokens = refill(bucket, limits.ipHourlyWei, limits.ipHourlyWei, now);
    if (ipTokens < input.costWei) {
      const missing = input.costWei - ipTokens;
      const retry = limits.ipHourlyWei === 0n ? 3600 : Number((missing * 3_600_000n + limits.ipHourlyWei - 1n) / limits.ipHourlyWei);
      throw new GasBudgetError("ip", Math.min(3600, Math.max(1, retry)));
    }
  }
  row.hour.tokens = (hourTokens - input.costWei).toString();
  row.reserved = (reserved + input.costWei).toString();
  if (input.sessionKey) {
    const sess = row.sessions[input.sessionKey.toLowerCase()]!;
    sess.dayUsed = (BigInt(sess.dayUsed) + input.costWei).toString();
  }
  if (input.ip) {
    const bucket = state.ips[input.ip.trim()]!;
    bucket.tokens = (BigInt(bucket.tokens) - input.costWei).toString();
  }
  state.reservations[input.reservationId] = { account: input.account.toLowerCase(), amount: input.costWei.toString(), at: now };
  return { reserved: input.costWei };
}

function lifetimeUsed(row: GasAccount): bigint {
  // dayUsed is only today; lifetime is accumulated on settle into row as `life` via a field we add when settling
  return BigInt((row as GasAccount & { life?: string }).life || "0");
}

export function settleGas(state: GasBudgetState, reservationId: string, actualWei: bigint): void {
  const hold = state.reservations[reservationId];
  if (!hold) return;
  const row = state.accounts[hold.account];
  const reserved = BigInt(hold.amount);
  // Charge what the sponsor actually paid, even above the reservation (re-estimate drift, fee spikes).
  const actual = actualWei;
  if (row) {
    row.reserved = (BigInt(row.reserved || "0") - reserved).toString();
    if (BigInt(row.reserved) < 0n) row.reserved = "0";
    row.dayUsed = (BigInt(row.dayUsed || "0") + actual).toString();
    const lifeRow = row as GasAccount & { life?: string };
    lifeRow.life = (BigInt(lifeRow.life || "0") + actual).toString();
    // Return unused hourly/ip tokens so an overestimate does not drain the bucket.
    const refund = reserved - actual;
    if (refund > 0n) row.hour.tokens = (BigInt(row.hour.tokens || "0") + refund).toString();
  }
  delete state.reservations[reservationId];
}

export function releaseGas(state: GasBudgetState, reservationId: string): void {
  const hold = state.reservations[reservationId];
  if (!hold) return;
  const row = state.accounts[hold.account];
  const reserved = BigInt(hold.amount);
  if (row) {
    row.reserved = (BigInt(row.reserved || "0") - reserved).toString();
    if (BigInt(row.reserved) < 0n) row.reserved = "0";
    row.hour.tokens = (BigInt(row.hour.tokens || "0") + reserved).toString();
  }
  delete state.reservations[reservationId];
}

export function gasStatus(state: GasBudgetState, limits: GasBudgetLimits, sponsorFilWei: bigint | null): {
  floorWei: string;
  floorFil: string;
  killed: boolean;
  sponsorFil: string | null;
} {
  const fil = sponsorFilWei;
  return {
    floorWei: limits.filFloorWei.toString(),
    floorFil: formatUnits(limits.filFloorWei, 18),
    killed: fil !== null && fil < limits.filFloorWei,
    sponsorFil: fil === null ? null : formatUnits(fil, 18),
  };
}
