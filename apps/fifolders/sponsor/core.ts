// Sponsor backend ("money processor") for gasless FiFolders. Holds the gas wallet, which is also the factory admin and
// treasury. Users never hold FIL or USDFC: they pay by card (Stripe) and the sponsor deposits USDFC into their
// LockedSignerAccount, where the fixed call policy only lets it pay FWSS storage.
//
//   GET  /pricing                             → minimums, setup fee, reserve, default purchase
//   GET  /account?user=0x… | ?x=0x…&y=0x… | ?credential=… → { account, x?, y? } (null before the first purchase)
//   POST /checkout  {auth, usd, successUrl, cancelUrl} → Stripe Checkout Session → { id, url, first }
//   POST /stripe/webhook                      → Stripe-signed checkout.session.completed / payment_intent.succeeded → credit (once per session)
//   GET  /credits?session=cs_…                → { status, account, usdfc, path, hashes }
//   POST /dataset   {auth, metadata}          → dataset for an account that has none (normally pre-made)
//   POST /execute   {account, target, value, data, nonce, deadline, signature} → relay an owner/session-signed Execute
//
// First purchase (no account yet): a warm-pool account (pre-deployed, 1 USDFC deposited, dataset open, ownerless) is
// handed to the buyer in ONE transaction (factory.assign: one-shot owner + top-up of credit above 1 USDFC). Empty
// pool: create account, deposit, open dataset (slow path). The pool refills in the background.
//
// `auth` is an EIP-712 SponsorRequest signed by the owner wallet, a live session key of the account, or the owner's
// passkey (see auth.ts). /execute needs no extra auth: the account checks the Execute signature itself (simulated
// here first), the account must be one this factory deployed, and calls are rate limited per account.
//
//   GET  /health                              → liveness + sponsor address, factory, Stripe/pool status
//   GET  /pool                                → warm-pool entries (status, account, dataset)
//
// Runtime-neutral core: `handle()` takes a plain request and returns a plain response. server.ts wraps it in node:http
// with a JSON state file; worker.ts runs it inside a Durable Object (Cloudflare) with DO storage.
import { encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, formatUnits, getAddress, isAddress, isHex, parseAbi, parseUnits, recoverAddress, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { createDataSetApiRequest } from "@filoz/synapse-core/sp";
import { getPDPProvider } from "@filoz/synapse-core/sp-registry";
import { lockedAccountAbi, lockedFactoryAbi, type SponsorOwner } from "../src/sponsored-abi.js";
import { AuthError, parseIdentityId, passkeyId, verifyAuth, type Identity } from "./auth.js";
import { DEFAULT_PRICING, creditFor, poolTopUp, pricingFromEnv, type Pricing } from "./pricing.js";
import { RateLimiter } from "./ratelimit.js";
import { SponsorWalletRelayer, chainFor, publicClient, type Relayer } from "./relayer.js";
import { sweepAccount, type SweepResult } from "./sweeplib.js";
import { assertStripeMode, checkoutSessionIdForPaymentIntent, createCheckoutSession, estimateStripeFeeCents, fakeCheckoutSession, refundPayment, retrieveCheckoutSession, stripeFeeCents, verifyStripeSignature, type CheckoutSession, type Network } from "./stripe.js";
import { FINALITY_EPOCHS, receiptFate, receiptRpcUrls, waitForReceipt, waitForTxInHead, type RecordedInclusion } from "../src/receipt.js";
import { assertRelayAllowed, blockAccount, emptyGasState, gasStatus, lifetimeCapWei, limitsFromEnv, recordRelayFailure, releaseGas, reserveGas, reservedCostWei, settleGas, GasBudgetError, type GasBudgetLimits, type GasBudgetState } from "./gas-budget.js";
import { EXECUTE_TYPES, executeDomain } from "../src/sponsored-abi.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_POOL_CARE,
  ageDays,
  createdAtFromSessionExpiry,
  decideSpareCare,
  effectiveRate,
  poolCareFromEnv,
  runwayDays,
  settledPayAccount,
  topUpToMonths,
  type PoolCareConfig,
} from "./pool-care.js";
import {
  alertStatusView,
  alertThresholdsFromEnv,
  classifyBalances,
  composeAlertEmail,
  decideBalanceAlert,
  fmtToken,
  usdfcReserveNeed,
  type AlertAction,
  type AlertLevel,
  type AlertThresholds,
  type BalanceAlertRecord,
} from "./balance-alerts.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ZERO_ADDRESS = getAddress(`0x${"0".repeat(40)}`);
const ACCOUNT_TTL_SEC = 365n * 86400n;
// Padded FEVM gas for the warm-path handover (Calibration assign used ~53M; skip slow eth_estimateGas).
const PREPARE_SESSION_GAS = 40_000_000n;
const ASSIGN_GAS = 120_000_000n;

function markTiming(credit: CreditRecord, stage: string, extra: Record<string, string | number | undefined> = {}): void {
  const at = new Date().toISOString();
  const session = extra.session;
  const rest = { ...extra };
  delete rest.session;
  credit.timing = { ...(credit.timing ?? {}), [`${stage}At`]: at, ...rest };
  console.log(`[handover-timing] ${JSON.stringify({ stage, at, ...rest, session: typeof session === "string" ? `…${session.slice(-8)}` : undefined })}`);
}
const poolAccountAbi = parseAbi(["function unassigned() view returns (bool)"]);
const payAbi = parseAbi([
  "function deposit(address token, address to, uint256 amount) payable",
  "function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)",
]);

export interface SponsorConfig {
  network: Network;
  chainId: number;
  factory: Address;
  /** Previous (v1 clone) factory; /execute still accepts those accounts. */
  legacyFactory?: Address;
  beacon?: Address;
  registry?: Address;
  providerId: bigint;
  statePath?: string;
  contracts: { pay: Address; usdfc: Address; fwss: Address; pdp: Address; skr?: Address };
  pricing?: Pricing;
  /** Warm pool: ready accounts to keep (0 disables) and the USDFC each holds. */
  pool?: { size: number; seedUsdfc: string };
  /** Top up or retire stale unassigned spares (cron, both networks). */
  poolCare?: PoolCareConfig;
  /** Low-balance emails from the cron (both networks). Absent or enabled=false disables sending. */
  alerts?: AlertThresholds;
  /** Checkout is refused (503) unless the sponsor holds at least this much FIL, plus USDFC for the charge. */
  minSponsorFil?: string;
  /** /status and /health report "low" below these (warn before checkout pauses). */
  lowFil?: string;
  lowUsdfc?: string;
  /** Paid credits that wait this long for sponsor funds are refunded through Stripe. */
  refundAfterHours?: number;
  stripe: {
    secretKey?: string;
    webhookSecret?: string;
    /** Calibration only, and only without a secret key: checkout returns a local session and the webhook is simulated. */
    fake?: boolean;
    /** success/cancel URLs must start with one of these (empty = any, Calibration only). */
    allowedOrigins: string[];
  };
  limits?: { executePerMinute?: number; executeIpPerMinute?: number; setupPerHour?: number; checkoutPerHour?: number; checkoutIpPerHour?: number };
  /** Accounts to retry `sweep` on (cron), until something is swept. */
  sweepAccounts?: Address[];
  gasLimits?: GasBudgetLimits;
}

export interface UserRecord {
  owner: SponsorOwner;
  account: Address;
  sessionExpiry: string;
  credentialId?: string;
  dataSetId?: string;
  providerId?: string;
  dataSetTx?: Hex;
  /** "pool" (warm handover) or "create" (slow path). */
  via?: "pool" | "create";
}

export interface PoolEntry {
  account: Address;
  salt: string;
  sessionExpiry: string;
  /** "retired": swept back (failed build, or trimmed above the pool target). "trimming": sweep in flight. */
  status: "seeding" | "ready" | "assigning" | "assigned" | "failed" | "retired" | "trimming";
  dataSetId?: string;
  dataSetTx?: Hex;
  providerId?: string;
  hashes: Hex[];
  assignedTo?: string;
  /** Factory that deployed this account (tagged on new builds; inferred from the chain when missing). */
  factory?: Address;
  /** ISO time the account entered the pool (build). Used for max-age retirement. */
  createdAt?: string;
  /** Last Filecoin Pay snapshot from cron or /status. */
  pay?: { available: string; lockup: string; ratePerMonth: string; runwayDays: number; checkedAt: string };
  /** Last care action (top-up, retire, skip). */
  care?: { at: string; action: string; amount?: string; hash?: Hex; error?: string };
  error?: string;
}

export interface CreditRecord {
  identity: string;
  account?: Address;
  chargeCents: number;
  feeCents: number;
  netCents: number;
  reserveCents: number;
  setupCents: number;
  creditCents: number;
  /** USDFC the user ends up with from this purchase (incl. a pooled account's seed). */
  usdfc: string;
  /** USDFC actually sent by the sponsor in this step (top-up above the pool seed, or the full credit). */
  depositUsdfc: string;
  path?: "pool" | "create" | "topup";
  /** awaiting-funds: paid, nothing sent yet, sponsor short of USDFC/FIL; retried by cron, refunded after refundAfterHours. */
  status: "pending" | "done" | "failed" | "awaiting-funds" | "refunded";
  hashes: Hex[];
  paidAt?: string;
  paymentIntent?: string;
  credential?: string;
  refundId?: string;
  hash?: Hex;
  error?: string;
  sessionKey?: Address;
  sessionExpiry?: string;
  /** Included handover txs, recorded at inclusion (not finality). */
  inclusion?: { kind: string; hash: Hex; blockNumber: string; blockHash: Hex }[];
  finality?: "sent" | "included" | "finalized" | "dropped";
  /** Head block when the current handover tx was broadcast or last rebroadcast. */
  sentAtBlock?: string;
  rebroadcasts?: number;
  /** Signed fields (incl. nonce) of every tx sent for this credit, keyed by lower-case hash: resends reuse the nonce. */
  sentTxs?: Record<string, StoredTx>;
  /** End-to-end handover timestamps (ISO) and durations (ms) for latency traces. */
  timing?: Record<string, string | number | undefined>;
}

/** A broadcast tx, JSON-safe (bigints as decimal strings). */
export interface StoredTx {
  label: string;
  hash: Hex;
  nonce: number;
  gas: string;
  to?: Address;
  data: Hex;
  value: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface SponsorState {
  users: Record<string, UserRecord>;
  checkouts: Record<string, { identity: string; cents: number; first: boolean }>;
  credits: Record<string, CreditRecord>;
  pool: Record<string, PoolEntry>;
  /** Deferred sweeps: last attempt per account. */
  sweeps: Record<string, SweepResult & { at: string }>;
  /** Per-account sponsor gas budget (Durable Object). */
  gas?: { budget: GasBudgetState };
  /** Singleton alert records (key "balance"). */
  alerts?: Record<string, BalanceAlertRecord>;
}

export interface SponsorRequest {
  method: string;
  /** Path and query, e.g. "/credits?session=cs_…". */
  url: string;
  header(name: string): string | undefined;
  body: string;
}

export interface SponsorResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const CORS_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } as const;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function configFromEnv(env: Record<string, string | undefined>, opts: { statePath?: string } = {}): SponsorConfig {
  const factory = env.SPONSOR_FACTORY;
  if (!factory) throw new Error("Set SPONSOR_FACTORY");
  const network: Network = env.SPONSOR_NETWORK === "mainnet" ? "mainnet" : "calibration";
  const chain = chainFor(network);
  const contracts = chain.contracts as unknown as Record<string, { address: Address }>;
  const config: SponsorConfig = {
    network,
    chainId: chain.id,
    factory: getAddress(factory),
    legacyFactory: env.SPONSOR_FACTORY_LEGACY && isAddress(env.SPONSOR_FACTORY_LEGACY) ? getAddress(env.SPONSOR_FACTORY_LEGACY) : undefined,
    beacon: env.SPONSOR_BEACON && isAddress(env.SPONSOR_BEACON) ? getAddress(env.SPONSOR_BEACON) : undefined,
    registry: env.SPONSOR_REGISTRY && isAddress(env.SPONSOR_REGISTRY) ? getAddress(env.SPONSOR_REGISTRY) : undefined,
    providerId: BigInt(env.SPONSOR_PROVIDER_ID ?? "2"),
    statePath: env.SPONSOR_STATE ?? opts.statePath,
    contracts: {
      pay: getAddress(contracts.filecoinPay!.address),
      usdfc: getAddress(contracts.usdfc!.address),
      fwss: getAddress(contracts.fwss!.address),
      pdp: getAddress(contracts.pdp!.address),
      ...(contracts.sessionKeyRegistry?.address ? { skr: getAddress(contracts.sessionKeyRegistry.address) } : {}),
    },
    pricing: pricingFromEnv(env),
    pool: { size: Number(env.SPONSOR_POOL_SIZE ?? 2), seedUsdfc: env.SPONSOR_POOL_SEED_USDFC ?? "1" },
    poolCare: poolCareFromEnv(env),
    minSponsorFil: env.SPONSOR_MIN_FIL ?? "0.005",
    lowFil: env.SPONSOR_LOW_FIL ?? "0.05",
    lowUsdfc: env.SPONSOR_LOW_USDFC ?? "20",
    refundAfterHours: Number(env.SPONSOR_REFUND_AFTER_HOURS ?? 24),
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || undefined,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
      fake: env.SPONSOR_STRIPE_FAKE === "1",
      allowedOrigins: (env.SPONSOR_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    },
    sweepAccounts: (env.SPONSOR_SWEEP_ACCOUNTS ?? "").split(",").map((value) => value.trim()).filter((value) => isAddress(value)).map((value) => getAddress(value)),
    gasLimits: limitsFromEnv(env),
  };
  config.alerts = alertThresholdsFromEnv(env, {
    poolSize: config.pool?.size ?? 0,
    seedUsdfc: config.pool?.seedUsdfc ?? "1",
    care: config.poolCare ?? { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 },
    pricing: config.pricing!,
  });
  validateConfig(config);
  return config;
}

export function validateConfig(config: SponsorConfig): void {
  const { stripe, network } = config;
  if (stripe.secretKey) assertStripeMode(stripe.secretKey, network);
  if (stripe.fake && (network !== "calibration" || stripe.secretKey)) throw new Error("SPONSOR_STRIPE_FAKE is for Calibration without a Stripe key");
  if (network === "mainnet") {
    if (!stripe.secretKey || !stripe.webhookSecret) throw new Error("Mainnet needs STRIPE_SECRET_KEY (live) and STRIPE_WEBHOOK_SECRET");
    if (!stripe.allowedOrigins.length) throw new Error("Mainnet needs SPONSOR_ALLOWED_ORIGINS for Checkout redirects");
  }
  const pricing = config.pricing ?? DEFAULT_PRICING;
  if (pricing.minFirstCents < pricing.setupCents || pricing.maxCents < pricing.minFirstCents) throw new Error("bad pricing bounds");
}

function asAddress(value: unknown, name: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(400, `${name} must be an address`);
  return getAddress(value);
}

function asBytes32(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new HttpError(400, `${name} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function ownerArgs(identity: Identity): readonly [Address, Hex, Hex] {
  if (identity.kind === "eoa") return [identity.address, ZERO32, ZERO32];
  if (identity.kind === "passkey") return [ZERO_ADDRESS, identity.x, identity.y];
  throw new HttpError(403, "session keys cannot own accounts");
}

function ownerOf(identity: Identity): SponsorOwner {
  if (identity.kind === "eoa") return { kind: "eoa", address: identity.address };
  if (identity.kind === "passkey") return { kind: "passkey", x: identity.x, y: identity.y };
  throw new HttpError(403, "session keys cannot own accounts");
}

export interface SponsorDeps {
  pub?: PublicClient;
  relayer?: Relayer & { sent?: { label: string; hash: Hex }[] };
  /** Sponsor hot-wallet key, when no `relayer` is given. */
  sponsorKey?: Hex;
  rpc?: string;
  fetch?: typeof fetch;
  openDataset?: (account: Address, metadata: Record<string, string>) => Promise<{ dataSetId: string; txHash: Hex }>;
  /** Persisted state to resume from, and where to write it after every change. */
  state?: Partial<SponsorState>;
  persist?: (state: SponsorState) => void;
  /** Clock (tests). */
  now?: () => number;
  /** Rebroadcast a still-pending handover tx if it is not in a head within this many epochs. Default 2. */
  includeWithinEpochs?: number;
  /** Tests: terminate a retiring spare without an owner signature. */
  terminatePoolDataset?: (account: Address, dataSetId: string) => Promise<{ hash?: Hex }>;
  /** Deliver a low-balance / recovery / reminder email. Absent = record the skip on /status. */
  sendEmail?: (msg: { to: string; from: string; subject: string; text: string }) => Promise<{ channel: "email-routing" | "resend" } | void>;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createSponsorCore(config: SponsorConfig, deps: SponsorDeps = {}) {
  validateConfig(config);
  const pricing = config.pricing ?? DEFAULT_PRICING;
  const poolSize = config.pool?.size ?? 0;
  const seed = parseUnits(config.pool?.seedUsdfc ?? "1", 18);
  const now = deps.now ?? (() => Date.now());
  const pub = deps.pub ?? publicClient({ network: config.network, rpc: deps.rpc });
  if (!deps.relayer && !deps.sponsorKey) throw new Error("Set SPONSOR_KEY");
  const relayer = deps.relayer ?? new SponsorWalletRelayer(deps.sponsorKey!, { network: config.network, rpc: deps.rpc });
  const includeWithinEpochs = deps.includeWithinEpochs ?? 2;
  const maxRebroadcasts = 8;
  const receiptWait = (hash: Hex) => waitForReceipt(pub, hash, { rpcUrls: deps.pub ? undefined : receiptRpcUrls(config.network, deps.rpc) });
  const { pay: PAY, usdfc: USDFC, fwss: FWSS, pdp: PDP } = config.contracts;
  const loaded = deps.state ?? {};
  const state: SponsorState = {
    users: loaded.users ?? {},
    checkouts: loaded.checkouts ?? {},
    credits: loaded.credits ?? {},
    pool: loaded.pool ?? {},
    sweeps: loaded.sweeps ?? {},
    gas: { budget: loaded.gas?.budget ?? emptyGasState() },
    alerts: loaded.alerts ?? {},
  };
  const gasLimits = config.gasLimits ?? limitsFromEnv();
  // A pool build interrupted by a restart (or an evicted Durable Object) is not resumable: park it for a sweep.
  for (const entry of Object.values(state.pool)) {
    if (entry.status === "seeding") Object.assign(entry, { status: "failed", error: "interrupted while seeding" });
  }
  const save = () => deps.persist?.(state);
  const seen = new Map<string, number>();
  const limits = {
    execute: new RateLimiter(config.limits?.executePerMinute ?? 30, 60_000, now),
    executeIp: new RateLimiter(config.limits?.executeIpPerMinute ?? 120, 60_000, now),
    checkoutIp: new RateLimiter(config.limits?.checkoutIpPerHour ?? 30, 3_600_000, now),
    setup: new RateLimiter(config.limits?.setupPerHour ?? 20, 3_600_000, now),
    checkout: new RateLimiter(config.limits?.checkoutPerHour ?? 10, 3_600_000, now),
  };

  const recordFor = (identity: Identity): UserRecord | undefined =>
    identity.kind === "session" ? Object.values(state.users).find((record) => record.account === identity.account) : state.users[identity.id];
  const identityOfAccount = (account: Address) => Object.entries(state.users).find(([, record]) => record.account === account)?.[0];

  async function authenticate(action: string, body: Record<string, unknown>, limiter: RateLimiter): Promise<Identity> {
    let identity: Identity;
    try {
      identity = await verifyAuth({
        chainId: config.chainId,
        action,
        body,
        seen,
        sessionExpiry: async (account, key) => {
          if (!identityOfAccount(account)) return 0n;
          return (await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "sessionSigners", args: [key] })) as bigint;
        },
      });
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(401, error.message);
      throw error;
    }
    if (!limiter.take(`${action}:${identity.id}`)) throw new HttpError(429, "rate limited");
    return identity;
  }

  // ---------------------------------------------------------------- chain helpers (all sends go through `relayer`)

  async function ensureAllowance(spender: Address, amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const allowance = await pub.readContract({ address: USDFC, abi: erc20Abi, functionName: "allowance", args: [relayer.address, spender] });
    if (allowance < amount) await relayer.relay({ to: USDFC, label: `USDFC approve ${spender}`, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, parseUnits("1000000", 18)] }) });
  }

  async function deposit(account: Address, amount: bigint, label: string, onSent?: (hash: Hex) => void): Promise<Hex> {
    await ensureAllowance(PAY, amount);
    const hash = await relayer.send({ to: PAY, label, data: encodeFunctionData({ abi: payAbi, functionName: "deposit", args: [USDFC, account, amount] }) });
    onSent?.(hash);
    const receipt = await receiptWait(hash);
    if (receipt.status !== "success") throw new Error(`deposit reverted: ${hash}`);
    return hash;
  }

  /** admin allowDataSet + provider createDataSet with the keyless signature (r = s = 1, v = 27). */
  async function openDataset(account: Address, metadata: Record<string, string>): Promise<{ dataSetId: string; txHash: Hex }> {
    if (deps.openDataset) return deps.openDataset(account, metadata);
    const keys = Object.keys(metadata).sort();
    const values = keys.map((key) => String(metadata[key]));
    const clientDataSetId = BigInt(Date.now());
    await relayer.relay({ to: account, label: `allowDataSet ${account}`, data: encodeFunctionData({ abi: lockedAccountAbi, functionName: "allowDataSet", args: [config.providerId, clientDataSetId, keys, values] }) });
    const provider = (await getPDPProvider(pub as never, { providerId: config.providerId } as never)) as { pdp?: { serviceURL?: string }; products?: { PDP?: { data?: { serviceURL?: string } } } };
    const serviceURL = provider.pdp?.serviceURL ?? provider.products?.PDP?.data?.serviceURL;
    if (!serviceURL) throw new HttpError(502, `provider ${config.providerId} has no PDP service URL`);
    const one = `0x${"0".repeat(63)}1` as Hex;
    const signature = encodePacked(["bytes32", "bytes32", "uint8"], [one, one, 27]);
    const extraData = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "string[]" }, { type: "string[]" }, { type: "bytes" }],
      [account, clientDataSetId, keys, values, signature],
    );
    const created = await createDataSetApiRequest({ serviceURL, recordKeeper: FWSS, extraData });
    const receipt = await receiptWait(created.txHash);
    if (receipt.status !== "success") throw new HttpError(502, `createDataSet reverted: ${created.txHash}`);
    const log = receipt.logs.find((entry) => getAddress(entry.address) === PDP && entry.topics[1]);
    if (!log?.topics[1]) throw new HttpError(502, "createDataSet receipt has no DataSetCreated log");
    return { dataSetId: BigInt(log.topics[1]).toString(), txHash: created.txHash };
  }

  const datasetMetadata = () => ({ app: "fifolders", volume: "FiFolders", created: new Date().toISOString() });

  // ---------------------------------------------------------------- warm pool

  let refilling: Promise<void> | null = null;
  const poolCount = (...statuses: PoolEntry["status"][]) => Object.values(state.pool).filter((entry) => statuses.includes(entry.status)).length;

  async function isFactoryAccount(factory: Address, account: Address): Promise<boolean> {
    return Boolean(await pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: "isAccount", args: [account] }).catch(() => false));
  }

  /** Ready/seeding accounts of the current factory. Untagged entries are current unless they only exist on the legacy factory. */
  async function poolOnCurrentFactory(...statuses: PoolEntry["status"][]): Promise<PoolEntry[]> {
    const out: PoolEntry[] = [];
    for (const entry of Object.values(state.pool)) {
      if (!statuses.includes(entry.status)) continue;
      if (entry.factory) {
        if (getAddress(entry.factory) === getAddress(config.factory)) out.push(entry);
        continue;
      }
      if (config.legacyFactory && (await isFactoryAccount(config.legacyFactory, entry.account)) && !(await isFactoryAccount(config.factory, entry.account))) {
        entry.factory = config.legacyFactory;
        continue;
      }
      if (await isFactoryAccount(config.factory, entry.account)) entry.factory = config.factory;
      out.push(entry);
    }
    return out;
  }

  async function buildPooled(): Promise<void> {
    const salt = BigInt(`0x${randomHex(8)}`);
    const sessionExpiry = BigInt(Math.floor(Date.now() / 1000)) + ACCOUNT_TTL_SEC;
    const account = getAddress((await pub.readContract({ address: config.factory, abi: lockedFactoryAbi, functionName: "predict", args: [ZERO_ADDRESS, ZERO32, ZERO32, salt, sessionExpiry] })) as Address);
    const entry: PoolEntry = { account, salt: salt.toString(), sessionExpiry: sessionExpiry.toString(), status: "seeding", hashes: [], factory: config.factory, createdAt: new Date(now()).toISOString() };
    state.pool[account] = entry;
    save();
    try {
      entry.hashes.push((await relayer.relay({ to: config.factory, label: `pool create ${account}`, data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "createPooled", args: [salt, sessionExpiry] }) })).transactionHash);
      entry.hashes.push(await deposit(account, seed, `pool seed ${account}`));
      const opened = await openDataset(account, datasetMetadata());
      Object.assign(entry, { dataSetId: opened.dataSetId, dataSetTx: opened.txHash, providerId: config.providerId.toString(), status: "ready" });
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      save();
    }
  }

  /**
   * Top the pool up to `size` ready accounts (background; one at a time; stops on the first failure).
   * `max` caps builds per call (the Worker's alarm stays well inside its wall-time limit and re-arms).
   */
  function refillPool(opts: { max?: number } = {}): Promise<void> {
    if (!poolSize) return Promise.resolve();
    // Clear the latch in `.finally` (async) so a no-op run cannot leave it set.
    refilling ??= (async () => {
      try {
        let built = 0;
        while ((await poolOnCurrentFactory("ready", "seeding")).length < poolSize && built < (opts.max ?? Infinity)) {
          // Keep owed credits whole: build only with USDFC to spare for the seed, and FIL above the gas reserve.
          const funds = await sponsorFunds();
          if (funds.usdfc < pendingUsdfc() + seed || funds.fil < minFil() * 2n) {
            console.warn("[sponsor] pool refill paused: sponsor wallet low");
            break;
          }
          await buildPooled();
          built += 1;
        }
      } catch (error) {
        console.error("[sponsor] pool refill stopped:", error instanceof Error ? error.message : error);
      }
    })().finally(() => {
      refilling = null;
    });
    return refilling;
  }

  // ---------------------------------------------------------------- checkout + credits

  function checkRedirect(url: unknown, name: string): string {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new HttpError(400, `${name} must be an http(s) URL`);
    const origins = config.stripe.allowedOrigins;
    if (origins.length && !origins.some((origin) => url.startsWith(origin))) throw new HttpError(400, `${name} origin not allowed`);
    return url;
  }

  async function checkout(identity: Identity, body: Record<string, unknown>): Promise<CheckoutSession & { first: boolean }> {
    const record = recordFor(identity);
    if (!record) ownerArgs(identity); // session keys only top up existing accounts
    const first = !record?.dataSetId;
    const cents = Math.round(Number(body.usd) * 100);
    const min = first ? pricing.minFirstCents : pricing.minTopUpCents;
    if (!Number.isFinite(cents) || cents < min || cents > pricing.maxCents) throw new HttpError(400, `amount must be from $${(min / 100).toFixed(2)} to $${(pricing.maxCents / 100).toFixed(2)}`);
    const id = record ? (identityOfAccount(record.account) ?? identity.id) : identity.id;
    const lineItems = first
      ? [{ name: "FiFolders storage credits", cents: cents - pricing.setupCents }, { name: "Storage account setup (one-time)", cents: pricing.setupCents }]
      : [{ name: "FiFolders storage credits", cents }];
    const input = {
      lineItems,
      successUrl: checkRedirect(body.successUrl, "successUrl"),
      cancelUrl: checkRedirect(body.cancelUrl, "cancelUrl"),
      clientReferenceId: record?.account ?? id.slice(0, 200),
      metadata: {
        identity: id,
        first: first ? "1" : "0",
        network: config.network,
        factory: config.factory,
        ...(identity.kind === "passkey" && identity.credentialId ? { credential: identity.credentialId } : {}),
        ...(typeof body.sessionKey === "string" && isAddress(body.sessionKey)
          ? { sessionKey: getAddress(body.sessionKey), ...(body.sessionExpiry != null && /^\d+$/.test(String(body.sessionExpiry)) ? { sessionExpiry: String(body.sessionExpiry) } : {}) }
          : {}),
      },
    };
    await assertFunded(cents, first);
    let session: CheckoutSession;
    if (config.stripe.secretKey) session = await createCheckoutSession(config.stripe.secretKey, input, deps.fetch);
    else if (config.stripe.fake) session = fakeCheckoutSession(input);
    else throw new HttpError(503, "Stripe not configured: card payments need STRIPE_SECRET_KEY on the sponsor");
    state.checkouts[session.id] = { identity: id, cents, first };
    save();
    return { ...session, first };
  }

  const minFil = () => parseUnits(config.minSponsorFil ?? "0.005", 18);
  const pendingUsdfc = () => Object.values(state.credits).filter((c) => c.status === "pending" || c.status === "awaiting-funds").reduce((sum, c) => sum + BigInt(c.usdfc), 0n);

  async function sponsorFunds(): Promise<{ fil: bigint; usdfc: bigint }> {
    const [usdfc, fil] = await Promise.all([
      pub.readContract({ address: config.contracts.usdfc, abi: erc20Abi, functionName: "balanceOf", args: [relayer.address] }) as Promise<bigint>,
      pub.getBalance({ address: relayer.address }),
    ]);
    return { fil, usdfc };
  }

  /**
   * Never take a card payment the sponsor cannot honor: it must hold USDFC for this charge (an upper bound on the
   * credit) plus every credit still owed, and FIL for gas. Fails closed if the RPC fails.
   */
  async function assertFunded(cents: number, first: boolean): Promise<void> {
    // Upper bound on what this purchase can cost the sponsor in USDFC: the charge (less the setup fee on a first
    // purchase) at the credit rate; a first purchase served from a ready pool account only needs what exceeds its seed.
    const ceilingCents = Math.max(pricing.minCreditCents, cents - (first ? pricing.setupCents : 0) - pricing.reserveCents);
    const creditCeiling = (parseUnits((ceilingCents / 100).toFixed(2), 18) * parseUnits(pricing.usdfcPerUsd, 18)) / 10n ** 18n;
    const fromPool = first && Object.values(state.pool).some((entry) => entry.status === "ready");
    const need = (fromPool ? poolTopUp(creditCeiling, seed) : creditCeiling) + pendingUsdfc();
    let funds: { fil: bigint; usdfc: bigint };
    try {
      funds = await sponsorFunds();
    } catch {
      throw new HttpError(503, "Card payments are temporarily unavailable. Please try again later.");
    }
    if (funds.usdfc < need || funds.fil < minFil()) {
      console.warn(`[sponsor] checkout paused: sponsor holds ${funds.usdfc} USDFC / ${funds.fil} FIL, needs ${need} / ${minFil()}`);
      throw new HttpError(503, "Card payments are temporarily unavailable (the service wallet is being refilled). Please try again later; you have not been charged.");
    }
  }

  let creditQueue: Promise<unknown> = Promise.resolve();
  /** Pool accounts with an assign tx in flight in this process (never trimmed or reconciled). */
  const assigningNow = new Set<string>();

  function recordInclusion(credit: CreditRecord, kind: string, receipt: { transactionHash: Hex; blockNumber?: bigint | number; blockHash?: Hex }): void {
    if (receipt.blockHash == null || receipt.blockNumber == null) return;
    const row = { kind, hash: receipt.transactionHash, blockNumber: BigInt(receipt.blockNumber).toString(), blockHash: receipt.blockHash as Hex };
    credit.inclusion = [...(credit.inclusion ?? []).filter((item) => item.hash !== row.hash), row];
    if (kind === "assign" || kind === "create" || kind === "deposit") {
      credit.hash = receipt.transactionHash;
      credit.finality = credit.finality === "finalized" ? "finalized" : "included";
    }
  }

  async function headNumber(): Promise<bigint> {
    try {
      return await pub.getBlockNumber();
    } catch {
      return 0n;
    }
  }

  async function peekHandoverInclusion(hash: Hex): Promise<{ blockNumber: bigint; blockHash: Hex; reverted?: boolean } | undefined> {
    const want = hash.toLowerCase();
    try {
      const receipt = await pub.getTransactionReceipt({ hash });
      if (receipt?.blockHash) {
        return { blockNumber: BigInt(receipt.blockNumber), blockHash: receipt.blockHash as Hex, reverted: receipt.status === "reverted" };
      }
    } catch { /* not mined yet */ }
    try {
      const block = await pub.getBlock({ blockTag: "latest", includeTransactions: true } as never);
      const txs = ((block as { transactions?: unknown[] }).transactions ?? []).map((item) => {
        if (typeof item === "string") return item.toLowerCase();
        if (item && typeof item === "object" && "hash" in item && typeof (item as { hash: unknown }).hash === "string") return ((item as { hash: string }).hash).toLowerCase();
        return "";
      });
      if (txs.includes(want) && block?.hash && block.number != null) {
        return { blockNumber: BigInt(block.number), blockHash: block.hash as Hex };
      }
    } catch { /* head not available */ }
    return undefined;
  }

  function latestHandoverHash(credit: CreditRecord): Hex | undefined {
    const included = (credit.inclusion ?? []).filter((row) => row.kind === "assign" || row.kind === "create");
    if (credit.hash && (credit.finality === "sent" || !included.length)) return credit.hash;
    return included.at(-1)?.hash ?? credit.hash ?? credit.hashes.at(-1);
  }

  async function markUsableAtSend(credit: CreditRecord, account: Address, path: "pool" | "create" | "topup", sessionId: string): Promise<void> {
    credit.account = account;
    credit.status = "done";
    credit.path = path;
    credit.finality = credit.finality === "finalized" || credit.finality === "included" ? credit.finality : "sent";
    credit.sentAtBlock = (await headNumber()).toString();
    delete credit.error;
    markTiming(credit, "ready", { session: sessionId, path });
    save();
  }

  function rememberTx(credit: CreditRecord, hash: Hex): void {
    const tx = relayer.sentTx?.(hash);
    if (!tx) return;
    credit.sentTxs = {
      ...(credit.sentTxs ?? {}),
      [hash.toLowerCase()]: { label: tx.label, hash: tx.hash, nonce: tx.nonce, gas: tx.gas.toString(), to: tx.to, data: tx.data, value: tx.value.toString(), maxFeePerGas: tx.maxFeePerGas.toString(), maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString() },
    };
  }

  const pendingOf = (tx: StoredTx) => ({ ...tx, gas: BigInt(tx.gas), value: BigInt(tx.value), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });

  /** Same-nonce fee bump: from the relayer's memory, or from the credit's persisted record after a restart. */
  async function replaceSameNonce(credit: CreditRecord, hash: Hex): Promise<Hex> {
    const stored = credit.sentTxs?.[hash.toLowerCase()];
    let next: Hex;
    if (relayer.sentTx?.(hash) || !stored || !relayer.resend) next = await relayer.replace!(hash);
    else next = await relayer.resend(pendingOf(stored));
    rememberTx(credit, next);
    if (!credit.sentTxs?.[next.toLowerCase()] && stored) credit.sentTxs = { ...credit.sentTxs, [next.toLowerCase()]: { ...stored, hash: next } };
    return next;
  }

  /**
   * M1: before sending a credit again with FRESH nonces, prove none of its earlier txs can still land. Any earlier nonce
   * not yet consumed on chain → bump that same nonce instead ("rebroadcast"). All consumed and one of them succeeded →
   * it landed ("landed"). All consumed, none succeeded → they can never land, a resubmit is safe ("resubmit").
   * Relayers without nonce records (tests) → "resubmit" (previous behavior).
   */
  async function resubmitGate(credit: CreditRecord): Promise<"resubmit" | "rebroadcast" | "landed"> {
    const txs = Object.values(credit.sentTxs ?? {});
    if (!txs.length || !relayer.resend) return "resubmit";
    const latest = Number(await pub.getTransactionCount({ address: relayer.address, blockTag: "latest" }));
    const open = txs.filter((tx) => tx.nonce >= latest);
    if (open.length) {
      // Bump only the newest record per open nonce.
      const byNonce = new Map<number, StoredTx>();
      for (const tx of open) byNonce.set(tx.nonce, tx);
      for (const tx of byNonce.values()) {
        try {
          const next = await relayer.resend(pendingOf(tx));
          credit.sentTxs = { ...credit.sentTxs, [next.toLowerCase()]: { ...tx, hash: next } };
          if (credit.hash?.toLowerCase() === tx.hash.toLowerCase()) credit.hash = next;
          credit.hashes = [...credit.hashes, next];
        } catch (error) {
          console.warn("[sponsor] same-nonce resend", tx.hash, error);
        }
      }
      save();
      return "rebroadcast";
    }
    for (const tx of txs) {
      if (!/^(assign|create|credit) /.test(tx.label)) continue;
      const receipt = await pub.getTransactionReceipt({ hash: tx.hash }).catch(() => undefined);
      if (receipt?.status === "success") return "landed";
    }
    return "resubmit";
  }

  async function rebroadcastHandover(credit: CreditRecord, hash: Hex): Promise<Hex | undefined> {
    if (!relayer.replace) return undefined;
    if ((credit.rebroadcasts ?? 0) >= maxRebroadcasts) return undefined;
    const next = await replaceSameNonce(credit, hash);
    credit.hashes = [...(credit.hashes ?? []).filter((h) => h.toLowerCase() !== hash.toLowerCase()), next];
    credit.hash = next;
    credit.rebroadcasts = (credit.rebroadcasts ?? 0) + 1;
    credit.sentAtBlock = (await headNumber()).toString();
    credit.finality = "sent";
    markTiming(credit, "rebroadcast", { from: hash, to: next, n: credit.rebroadcasts });
    save();
    console.warn("[sponsor] rebroadcast handover", hash, "->", next);
    return next;
  }

  async function waitAndRecord(credit: CreditRecord, kind: string, hash: Hex): Promise<{ transactionHash: Hex; status: string; blockNumber?: bigint; blockHash?: Hex }> {
    const included = await waitForTxInHead(pub, hash, { rpcUrls: deps.pub ? undefined : receiptRpcUrls(config.network, deps.rpc) });
    if (included.reverted) throw new Error(`${kind} reverted: ${hash}`);
    recordInclusion(credit, kind, { transactionHash: hash, blockNumber: included.blockNumber, blockHash: included.blockHash });
    void confirmOptimisticReceipt(credit, kind, hash);
    return { transactionHash: hash, status: "success", blockNumber: included.blockNumber, blockHash: included.blockHash };
  }

  /** Watch tipsets after a broadcast-as-usable handover; bump fees / resubmit rather than waiting on cron. */
  async function ensureHandoverLanding(credit: CreditRecord): Promise<void> {
    const deadline = Date.now() + 20 * 60_000;
    const landed = () => credit.finality === "included" || credit.finality === "finalized";
    while (Date.now() < deadline) {
      if (landed()) return;
      if (credit.status === "failed" || credit.status === "pending") return;
      try {
        await checkHandoverFinality();
      } catch (error) {
        console.warn("[sponsor] landing watch", error);
      }
      if (landed()) return;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    if (!landed()) {
      credit.error = "handover not yet included; still retrying";
      save();
      console.warn("[sponsor] handover stuck", credit.hash, "rebroadcasts", credit.rebroadcasts ?? 0);
    }
  }

  async function confirmOptimisticReceipt(credit: CreditRecord, kind: string, hash: Hex): Promise<void> {
    try {
      const receipt = await receiptWait(hash);
      if (receipt.status !== "success") {
        await checkHandoverFinality();
        return;
      }
      recordInclusion(credit, kind, receipt);
      save();
    } catch (error) {
      console.warn("[sponsor] optimistic receipt confirm", kind, error);
      try { await checkHandoverFinality(); } catch { /* cron will retry */ }
    }
  }

  async function maybeInstallSession(credit: CreditRecord, account: Address): Promise<void> {
    const key = credit.sessionKey;
    if (!key) return;
    const expiry = BigInt(credit.sessionExpiry ?? String(Math.floor(Date.now() / 1000) + Number(ACCOUNT_TTL_SEC)));
    try {
      const already = (await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "sessionSigners", args: [key] })) as bigint;
      if (already && already > 0n) return;
      const hash = await relayer.send({
        to: account,
        label: `adminAddSessionKey ${account}`,
        data: encodeFunctionData({ abi: lockedAccountAbi, functionName: "adminAddSessionKey", args: [key, expiry] }),
      });
      credit.hashes.push(hash);
      save();
      void waitAndRecord(credit, "session", hash).then(() => save()).catch((error) => console.warn("[sponsor] adminAddSessionKey", error));
    } catch (error) {
      console.warn("[sponsor] adminAddSessionKey", error);
    }
  }

  /** Apply one paid session, at most once. Handover txs are sent back-to-back (nonce-ordered) and marked ready as soon as prepareSession + factory.assign are broadcast. Inclusion is watched in the background with fee bumps and resubmits. */
  function queueCredit(sessionId: string, credentialArg?: string): Promise<unknown> {
    creditQueue = creditQueue.then(async () => {
      const credit = state.credits[sessionId];
      if (!credit || credit.status !== "pending") return;
      const credential = credentialArg ?? credit.credential;
      let inFlight: string | undefined;
      const identity = parseIdentityId(credit.identity);
      try {
        markTiming(credit, "queueStart", { session: sessionId });
        save();
        // Pre-flight: if the sponsor is short, park the credit before sending anything (so a retry is always safe).
        const amount0 = BigInt(credit.usdfc);
        const viaPool = !state.users[credit.identity] && (await poolOnCurrentFactory("ready")).length > 0;
        const needUsdfc = viaPool ? poolTopUp(amount0, seed) : amount0;
        const funds = await sponsorFunds();
        markTiming(credit, "fundsChecked", { session: sessionId, viaPool: viaPool ? 1 : 0 });
        if (funds.usdfc < needUsdfc || funds.fil < minFil()) {
          credit.status = "awaiting-funds";
          credit.error = "sponsor wallet short of funds; will retry";
          save();
          return;
        }
        let record = state.users[credit.identity];
        const amount = BigInt(credit.usdfc);
        if (record) {
          credit.path = "topup";
          credit.account = record.account;
          if (amount > 0n) {
            credit.hashes.push((credit.hash = await deposit(record.account, amount, `credit ${record.account} (${sessionId})`, (h) => rememberTx(credit, h))));
            const receipt = await pub.getTransactionReceipt({ hash: credit.hash }).catch(() => undefined);
            if (receipt) recordInclusion(credit, "deposit", receipt);
          }
          credit.depositUsdfc = amount.toString();
          if (!record.dataSetId) await attachDataset(record);
        } else {
          if (!identity) throw new Error(`bad identity ${credit.identity}`);
          const pooled = (await poolOnCurrentFactory("ready"))[0];
          if (pooled) {
            // Warm path: one tx hands the account over and deposits the credit above its seed.
            credit.path = "pool";
            pooled.status = "assigning";
            pooled.assignedTo = credit.identity;
            assigningNow.add((inFlight = pooled.account));
            save();
            const topUp = poolTopUp(amount, seed);
            await ensureAllowance(config.factory, topUp);
            markTiming(credit, "allowance", { session: sessionId });
            const sessionExpiry = BigInt(credit.sessionExpiry ?? pooled.sessionExpiry);
            // Same sponsor-nonce batch: prepareSession then factory.assign (owner + top-up). Ready when assign is included.
            if (credit.sessionKey) {
              const prep = await relayer.send({
                to: pooled.account,
                label: `prepareSession ${pooled.account} (${sessionId})`,
                data: encodeFunctionData({ abi: lockedAccountAbi, functionName: "prepareSession", args: [credit.sessionKey, sessionExpiry] }),
                gas: PREPARE_SESSION_GAS,
              });
              credit.hashes.push(prep);
              rememberTx(credit, prep);
              markTiming(credit, "prepareSent", { session: sessionId, prepareHash: prep });
              save();
            }
            const assignHash = await relayer.send({
              to: config.factory,
              label: `assign ${pooled.account} (${sessionId})`,
              data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "assign", args: [pooled.account, ...ownerArgs(identity), topUp] }),
              gas: ASSIGN_GAS,
            });
            credit.hashes.push((credit.hash = assignHash));
            rememberTx(credit, assignHash);
            markTiming(credit, "assignSent", { session: sessionId, assignHash });
            pooled.status = "assigned";
            record = state.users[credit.identity] = { owner: ownerOf(identity), account: pooled.account, sessionExpiry: pooled.sessionExpiry, dataSetId: pooled.dataSetId, providerId: pooled.providerId, dataSetTx: pooled.dataSetTx, via: "pool", ...(credential ? { credentialId: credential } : {}) };
            credit.depositUsdfc = topUp.toString();
            credit.usdfc = (amount > seed ? amount : seed).toString();
            // Usable as soon as prepareSession + factory.assign are broadcast; landing is watched in the background.
            await markUsableAtSend(credit, pooled.account, "pool", sessionId);
            void ensureHandoverLanding(credit).then(() => {
              if (credit.account) void maybeInstallSession(credit, credit.account);
            });
            void refillPool();
          } else {
            // Slow path: create, fund, open the dataset.
            credit.path = "create";
            const sessionExpiry = BigInt(Math.floor(Date.now() / 1000)) + ACCOUNT_TTL_SEC;
            const args = ownerArgs(identity);
            const account = getAddress((await pub.readContract({ address: config.factory, abi: lockedFactoryAbi, functionName: "predict", args: [...args, 0n, sessionExpiry] })) as Address);
            const createHash = await relayer.send({ to: config.factory, label: `create account for ${credit.identity}`, data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "create", args: [...args, 0n, sessionExpiry] }) });
            credit.hashes.push((credit.hash = createHash));
            rememberTx(credit, createHash);
            record = state.users[credit.identity] = { owner: ownerOf(identity), account, sessionExpiry: sessionExpiry.toString(), via: "create", ...(credential ? { credentialId: credential } : {}) };
            await markUsableAtSend(credit, account, "create", sessionId);
            void ensureHandoverLanding(credit).then(async () => {
              if (credit.sessionKey && credit.account) void maybeInstallSession(credit, credit.account);
            });
            try {
              await waitAndRecord(credit, "create", createHash);
            } catch (error) {
              console.warn("[sponsor] create landing", error);
            }
            if (amount > 0n) {
              credit.hashes.push((credit.hash = await deposit(account, amount, `credit ${account} (${sessionId})`, (h) => rememberTx(credit, h))));
              const receipt = await pub.getTransactionReceipt({ hash: credit.hash }).catch(() => undefined);
              if (receipt) recordInclusion(credit, "deposit", receipt);
            }
            credit.depositUsdfc = amount.toString();
            await attachDataset(record);
            void refillPool();
          }
        }
        credit.status = "done";
        delete credit.error;
      } catch (error) {
        credit.status = "failed";
        credit.error = error instanceof Error ? error.message : String(error);
      }
      if (inFlight) assigningNow.delete(inFlight);
      save();
    });
    return creditQueue;
  }

  async function attachDataset(record: UserRecord): Promise<void> {
    if (record.dataSetId) return;
    const opened = await openDataset(record.account, datasetMetadata());
    record.dataSetId = opened.dataSetId;
    record.dataSetTx = opened.txHash;
    record.providerId = config.providerId.toString();
    save();
  }

  function sessionKeyFromMetadata(metadata: Record<string, string>): { sessionKey?: Address; sessionExpiry?: string } {
    const raw = metadata.sessionKey ?? metadata.session_key ?? "";
    if (!raw || !isAddress(raw)) return {};
    const sessionKey = getAddress(raw);
    const expiry = metadata.sessionExpiry ?? metadata.session_expiry ?? "";
    return { sessionKey, ...( /^\d+$/.test(expiry) ? { sessionExpiry: expiry } : {}) };
  }

  async function applyPaidCheckout(session: Record<string, unknown>, livemode: boolean, meta: { webhookAt?: string; eventType?: string } = {}): Promise<{ received: true; credited?: string; duplicate?: boolean; ignored?: string }> {
    const id = String(session.id ?? "");
    if (!id) throw new HttpError(400, "event without session id");
    const paid = session.payment_status === "paid" || session.status === "succeeded" || session.status === "complete";
    if (!paid && session.payment_status) return { received: true, ignored: `payment_status ${String(session.payment_status)}` };
    if (!paid) return { received: true, ignored: "not paid" };
    if (Boolean(livemode) !== (config.network === "mainnet")) throw new HttpError(400, `livemode ${livemode} on ${config.network}`);
    if (String(session.currency).toLowerCase() !== "usd") throw new HttpError(400, "currency must be usd");
    if (state.credits[id]) return { received: true, duplicate: true, credited: state.credits[id]!.usdfc };
    const metadata = (session.metadata ?? {}) as Record<string, string>;
    if (metadata.factory && getAddress(metadata.factory) !== config.factory) return { received: true, ignored: "other factory" };
    const identityId = String(metadata.identity ?? "");
    if (!parseIdentityId(identityId)) throw new HttpError(400, "metadata.identity missing");
    const chargeCents = Number(session.amount_total ?? session.amount);
    if (!Number.isInteger(chargeCents) || chargeCents <= 0) throw new HttpError(400, "bad amount_total");
    const feeStarted = Date.now();
    let feeCents = estimateStripeFeeCents(chargeCents, pricing);
    let feeSource = "estimate";
    if (config.stripe.secretKey) {
      // Do not retry/wait on the balance-transaction lag: handover starts immediately on an estimate.
      try {
        feeCents = await stripeFeeCents(config.stripe.secretKey, id, deps.fetch, { attempts: 1, delayMs: 0 });
        feeSource = "stripe";
      } catch {
        feeSource = "estimate-fallback";
      }
    }
    const feeMs = Date.now() - feeStarted;
    const raced = state.credits[id] as CreditRecord | undefined;
    if (raced) return { received: true, duplicate: true, credited: raced.usdfc };
    const first = !state.users[identityId]?.dataSetId;
    const { creditUsdfc, ...quote } = creditFor(pricing, { chargeCents, feeCents, first });
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : undefined;
    const sessionKey = sessionKeyFromMetadata(metadata);
    state.credits[id] = { identity: identityId, ...quote, usdfc: creditUsdfc.toString(), depositUsdfc: "0", status: "pending", hashes: [], paidAt: new Date(now()).toISOString(), ...(paymentIntent ? { paymentIntent } : {}), ...(metadata.credential ? { credential: metadata.credential } : {}), ...sessionKey, timing: { ...(meta.webhookAt ? { webhookAt: meta.webhookAt } : {}), ...(meta.eventType ? { eventType: meta.eventType } : {}), feeMs, feeSource } };
    markTiming(state.credits[id]!, "queued", { session: id, feeMs, feeSource, eventType: meta.eventType, webhookAt: meta.webhookAt });
    save();
    void queueCredit(id, metadata.credential);
    return { received: true, credited: creditUsdfc.toString() };
  }

  async function checkoutIdFromPaymentIntent(pi: Record<string, unknown>): Promise<string | undefined> {
    const meta = (pi.metadata ?? {}) as Record<string, string>;
    const direct = pi.checkout_session ?? meta.session ?? meta.checkout ?? meta.checkout_session;
    if (typeof direct === "string" && direct.startsWith("cs_")) return direct;
    if (config.stripe.secretKey && typeof pi.id === "string") {
      return checkoutSessionIdForPaymentIntent(config.stripe.secretKey, pi.id, deps.fetch ?? fetch);
    }
    return undefined;
  }

  /** Verified Stripe event → credit record (idempotent by session id). Starts handover on checkout completion or payment_intent.succeeded. */
  async function onStripeEvent(raw: string, signature: string | undefined): Promise<{ received: true; credited?: string; duplicate?: boolean; ignored?: string }> {
    const secret = config.stripe.webhookSecret;
    if (!secret) throw new HttpError(503, "Stripe not configured: STRIPE_WEBHOOK_SECRET not set");
    try {
      verifyStripeSignature(raw, signature, secret);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const event = JSON.parse(raw) as { type?: string; livemode?: boolean; data?: { object?: Record<string, unknown> } };
    const webhookAt = new Date().toISOString();
    console.log(`[handover-timing] ${JSON.stringify({ stage: "webhook", at: webhookAt, type: event.type })}`);
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data?.object ?? {};
      const sessionId = await checkoutIdFromPaymentIntent(pi);
      if (!sessionId) return { received: true, ignored: "payment_intent without checkout session" };
      if (state.credits[sessionId]) return { received: true, duplicate: true, credited: state.credits[sessionId]!.usdfc };
      let session: Record<string, unknown> = { id: sessionId, payment_status: "paid", currency: pi.currency, amount_total: pi.amount, payment_intent: pi.id, metadata: pi.metadata ?? {} };
      if (config.stripe.secretKey) {
        try {
          session = { ...(await retrieveCheckoutSession(config.stripe.secretKey, sessionId, deps.fetch ?? fetch)), payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : pi.id };
        } catch {
          /* metadata on the PaymentIntent is enough to start the handover */
        }
      }
      if (!session.id) session.id = sessionId;
      if (session.payment_status !== "paid") session.payment_status = "paid";
      return applyPaidCheckout(session, Boolean(event.livemode), { webhookAt, eventType: event.type });
    }
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return { received: true, ignored: event.type };
    return applyPaidCheckout(event.data?.object ?? {}, Boolean(event.livemode), { webhookAt, eventType: event.type });
  }

  /** Dataset for an account that has none (normally made by the pool or the slow path). */
  async function ensureDataset(identity: Identity): Promise<{ dataSetId: string; providerId: string; hash?: Hex }> {
    const record = recordFor(identity);
    if (!record) throw new HttpError(402, "buy storage credits first");
    if (!record.dataSetId) {
      const [funds] = (await pub.readContract({ address: PAY, abi: payAbi, functionName: "accounts", args: [USDFC, record.account] })) as readonly bigint[];
      if (!funds) throw new HttpError(402, "buy storage credits first");
      await attachDataset(record);
    }
    return { dataSetId: record.dataSetId!, providerId: record.providerId ?? "", hash: record.dataSetTx };
  }

  async function isSponsoredAccount(account: Address): Promise<boolean> {
    const check = async (factory: Address) =>
      pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: "isAccount", args: [account] }) as Promise<boolean>;
    if (await check(config.factory).catch(() => false)) return true;
    if (config.legacyFactory && (await check(config.legacyFactory).catch(() => false))) return true;
    return false;
  }

  function purchasesFor(account: Address): number {
    const id = account.toLowerCase();
    return Object.values(state.credits).filter((credit) => credit.status === "done" && credit.account?.toLowerCase() === id).length;
  }

  // Defense in depth only (the account contract enforces policy): ERC-20, permit and every Filecoin Pay fund selector.
  const FUND_SELECTORS = new Set(
    [
      "transfer(address,uint256)",
      "transferFrom(address,address,uint256)",
      "approve(address,uint256)",
      "increaseAllowance(address,uint256)",
      "decreaseAllowance(address,uint256)",
      "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
      "deposit(address,address,uint256)",
      "depositWithPermit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
      "depositWithPermitAndApproveOperator(address,address,uint256,uint256,uint8,bytes32,bytes32,address,bool,uint256,uint256,uint256)",
      "withdraw(address,uint256)",
      "withdrawTo(address,address,uint256)",
      "setOperatorApproval(address,address,bool,uint256,uint256,uint256)",
      "increaseOperatorApproval(address,address,uint256,uint256)",
    ].map((sig) => toFunctionSelector(`function ${sig}`).toLowerCase()),
  );

  /** Sponsored gas is only for accounts handed to a paying customer (C2): never for self-created factory accounts. */
  function isPaidAccount(account: Address): boolean {
    return Boolean(identityOfAccount(account)) || purchasesFor(account) > 0;
  }

  async function ownerSignedExecute(account: Address, target: Address, value: bigint, data: Hex, nonce: bigint, deadline: bigint, signature: Hex): Promise<{ asOwner: boolean; signer?: Address }> {
    if (signature.length !== 132) {
      // A passkey assertion can only be the owner, and only on an account that has a passkey.
      const qx = (await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "passkeyX" }).catch(() => ZERO32)) as Hex;
      if (!qx || BigInt(qx) === 0n) throw new HttpError(400, "account has no passkey owner");
      return { asOwner: true };
    }
    try {
      const digest = (await pub.readContract({
        address: account,
        abi: lockedAccountAbi,
        functionName: "executeDigest" as never,
        args: [target, value, data, nonce, deadline] as never,
      })) as Hex;
      const signer = getAddress(await recoverAddress({ hash: digest, signature }));
      const owner = (await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "owner" })) as Address;
      const asOwner = Boolean(owner) && owner !== "0x0000000000000000000000000000000000000000" && signer === getAddress(owner);
      return { asOwner, signer };
    } catch {
      return { asOwner: false };
    }
  }

  /** Refuse a session-key relay if a debug trace shows any native/token balance change. Nodes without tracers skip this. */
  async function traceShowsBalanceChange(from: Address, to: Address, data: Hex): Promise<boolean> {
    try {
      const trace = (await (pub.request as (args: { method: string; params: unknown }) => Promise<unknown>)({
        method: "debug_traceCall",
        params: [{ from, to, data }, "latest", { tracer: "prestateTracer", tracerConfig: { diffMode: true } }],
      })) as { post?: Record<string, { balance?: string }>; pre?: Record<string, { balance?: string }> };
      const post = trace?.post ?? {};
      const pre = trace?.pre ?? {};
      for (const [addr, next] of Object.entries(post)) {
        const before = pre[addr]?.balance;
        if (next?.balance !== undefined && before !== undefined && next.balance !== before) return true;
        if (next?.balance !== undefined && before === undefined && next.balance !== "0x0" && next.balance !== "0x") return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Relay a signed Execute to a v1 or v2 factory account. Session-key calls that would move funds are refused. */
  async function relayExecute(body: Record<string, unknown>, ip?: string): Promise<{ hash: Hex }> {
    const account = asAddress(body.account, "account");
    if (ip && !limits.executeIp.take(`execute-ip:${ip}`)) throw new HttpError(429, "rate limited");
    if (!(await isSponsoredAccount(account))) throw new HttpError(404, "not a sponsored account");
    if (!isPaidAccount(account)) throw new HttpError(403, "gas is sponsored only for accounts with a storage purchase");
    const target = asAddress(body.target, "target");
    const data = String(body.data) as Hex;
    if (!isHex(data) || data.length < 10) throw new HttpError(400, "data must be calldata");
    const value = BigInt(String(body.value ?? 0));
    const nonce = BigInt(String(body.nonce));
    const deadline = BigInt(String(body.deadline));
    const signature = String(body.signature) as Hex;
    if (!state.gas) state.gas = { budget: emptyGasState() };
    assertRelayAllowed(state.gas.budget, account, target, now());
    const signed = await ownerSignedExecute(account, target, value, data, nonce, deadline, signature);
    const asOwner = signed.asOwner;
    // Rate limit per (account, signer) so garbage requests for someone else's account cannot lock its owner out.
    if (!limits.execute.take(`execute:${account}:${asOwner ? "owner" : (signed.signer ?? "?")}`)) throw new HttpError(429, "rate limited");
    // Nobody (owner or session key) may log third-party keys into the SessionKeyRegistry through the sponsor (C1).
    if (config.contracts.skr && target.toLowerCase() === config.contracts.skr.toLowerCase()) throw new HttpError(403, `call not allowed: ${target}`);
    if (!asOwner) {
      if (value !== 0n) throw new HttpError(400, "value must be 0");
      const selector = data.slice(0, 10).toLowerCase();
      const tokenOrPay = [config.contracts.usdfc, config.contracts.pay].map((a) => a.toLowerCase());
      if (tokenOrPay.includes(target.toLowerCase()) || FUND_SELECTORS.has(selector)) {
        throw new HttpError(403, `call not allowed: ${target} ${selector}`);
      }
    }
    const call = encodeFunctionData({
      abi: lockedAccountAbi,
      functionName: "execute",
      args: [target, value, data, nonce, deadline, signature],
    });
    try {
      await pub.call({ account: relayer.address, to: account, data: call });
    } catch (error) {
      throw new HttpError(422, `execute would revert: ${(error as { shortMessage?: string }).shortMessage ?? String(error)}`);
    }
    if (!asOwner && (await traceShowsBalanceChange(relayer.address, account, call))) {
      throw new HttpError(403, "execute would change a balance");
    }
    const gas = await pub.estimateGas({ account: relayer.address, to: account, data: call, value: 0n } as never);
    // H2: the relayer signs exactly this limit (estimate × 1.3), never a second, uncapped estimate.
    const gasLimit = (gas * 13n) / 10n;
    const fees = await pub.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const cost = reservedCostWei(gas, maxFee);
    const funds = await sponsorFunds();
    const reservationId = `${account}:${nonce}:${now()}`;
    const purchases = purchasesFor(account);
    reserveGas(state.gas.budget, gasLimits, {
      account,
      reservationId,
      costWei: cost,
      gas: gasLimit,
      maxFeePerGas: maxFee,
      lifetimeCapWei: purchases > 0 || identityOfAccount(account) ? lifetimeCapWei(Math.max(1, purchases), gasLimits) : 0n,
      sponsorFilWei: funds.fil,
      sessionKey: asOwner ? null : signed.signer ?? null,
      ip: ip ?? null,
      now: now(),
    });
    save();
    let hash: Hex;
    try {
      hash = await relayer.send({ to: account, data: call, gas: gasLimit, label: `execute ${target} ${data.slice(0, 10)}` });
    } catch (error) {
      // Nothing was broadcast: give the reservation back.
      releaseGas(state.gas.budget, reservationId);
      save();
      throw error;
    }
    let receipt: { status?: string; gasUsed?: bigint | number; effectiveGasPrice?: bigint | number; gasPrice?: bigint | number } | undefined;
    try {
      receipt = (await receiptWait(hash)) as typeof receipt;
    } catch {
      // Broadcast but not confirmed in time: keep the full reservation charged (the sponsor may still pay it).
      settleGas(state.gas.budget, reservationId, cost);
      save();
      throw new HttpError(504, `execute sent but not confirmed yet: ${hash}`);
    }
    const actual = receipt?.gasUsed && (receipt.effectiveGasPrice || receipt.gasPrice)
      ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? receipt.gasPrice ?? maxFee)
      : cost;
    // H1: a mined revert still cost the sponsor gas, so it is charged like a success and counted toward a block.
    settleGas(state.gas.budget, reservationId, actual);
    if (receipt?.status !== "success") {
      recordRelayFailure(state.gas.budget, account, target, now());
      save();
      throw new HttpError(422, `execute reverted on chain: ${hash}`);
    }
    save();
    return { hash };
  }

  // ---------------------------------------------------------------- deferred sweeps

  /** Retry `sweep` on configured accounts until something is swept (cron). */
  async function sweepDeferred(): Promise<(SweepResult & { at: string })[]> {
    const results: (SweepResult & { at: string })[] = [];
    // Failed (or interrupted) pool builds are sponsor-owned and unassigned: return their deposit too.
    const failedPool = Object.values(state.pool).filter((entry) => entry.status === "failed").map((entry) => entry.account);
    for (const account of [...(config.sweepAccounts ?? []), ...failedPool]) {
      if (state.sweeps[account]?.outcome === "swept") continue;
      try {
        state.sweeps[account] = { ...(await sweepAccount(pub, relayer, account, config.network)), at: new Date().toISOString() };
      } catch (error) {
        state.sweeps[account] = { account, funds: "?", lockup: "?", outcome: `error: ${error instanceof Error ? error.message : String(error)}`, at: new Date().toISOString() };
      }
      results.push(state.sweeps[account]!);
      const entry = state.pool[account];
      const result = state.sweeps[account]!;
      if (entry?.status === "failed" && (result.outcome === "swept" || result.funds === "0")) entry.status = "retired";
      save();
    }
    return results;
  }

  // ---------------------------------------------------------------- HTTP (runtime-neutral)

  function parseJson(raw: string): Record<string, unknown> {
    if (raw.length > 256 * 1024) throw new HttpError(413, "body too large");
    try {
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  function lookup(url: URL): { account: Address | null; x?: Hex; y?: Hex } {
    const credential = url.searchParams.get("credential");
    if (credential) {
      const found = Object.values(state.users).find((record) => record.credentialId === credential && record.owner.kind === "passkey");
      return found && found.owner.kind === "passkey" ? { account: found.account, x: found.owner.x, y: found.owner.y } : { account: null };
    }
    const user = url.searchParams.get("user");
    const id = user ? `eoa:${asAddress(user, "user").toLowerCase()}` : passkeyId(asBytes32(url.searchParams.get("x"), "x"), asBytes32(url.searchParams.get("y"), "y"));
    return { account: state.users[id]?.account ?? null };
  }

  /**
   * Cron: retry credits parked for funds (nothing was sent for them, so a retry is safe); refund through Stripe once
   * one has waited refundAfterHours. Without a Stripe key (local fake) they just keep waiting.
   */
  async function retryAwaiting(): Promise<{ retried: string[]; refunded: string[]; errors: string[] }> {
    const out = { retried: [] as string[], refunded: [] as string[], errors: [] as string[] };
    const maxAgeMs = (config.refundAfterHours ?? 24) * 3600_000;
    let funds: { fil: bigint; usdfc: bigint } | undefined;
    let reserved = 0n;
    for (const [id, credit] of Object.entries(state.credits)) {
      if (credit.status !== "awaiting-funds") continue;
      const age = now() - Date.parse(credit.paidAt ?? new Date(now()).toISOString());
      if (age >= maxAgeMs && config.stripe.secretKey && credit.paymentIntent) {
        try {
          const refund = await refundPayment(config.stripe.secretKey, credit.paymentIntent, { session: id, reason: "sponsor could not deliver storage credits in time" }, deps.fetch);
          credit.status = "refunded";
          credit.refundId = refund.id;
          credit.error = `refunded after ${config.refundAfterHours ?? 24}h without sponsor funds`;
          out.refunded.push(id);
        } catch (error) {
          out.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        save();
        continue;
      }
      if (!funds) {
        try {
          funds = await sponsorFunds();
        } catch {
          continue;
        }
      }
      const need = BigInt(credit.usdfc);
      if (funds.usdfc < reserved + need || funds.fil < minFil()) continue; // still short: stay parked
      reserved += need;
      credit.status = "pending";
      delete credit.error;
      out.retried.push(id);
      void queueCredit(id);
    }
    save();
    await creditQueue;
    return out;
  }

  /**
   * Pool above target (e.g. SPONSOR_POOL_SIZE lowered): admin-sweep the excess ready accounts back to the treasury
   * (the sponsor on Calibration, so the USDFC is reused) and retire them. An entry leaves "ready" synchronously
   * before any await, so a concurrent purchase (which only takes "ready" entries) can never pick it.
   */
  async function trimPool(): Promise<{ account: Address; outcome: string; swept?: string }[]> {
    const out: { account: Address; outcome: string; swept?: string }[] = [];
    const current = await poolOnCurrentFactory("ready");
    const currentSet = new Set(current.map((entry) => entry.account));
    const stale = Object.values(state.pool).filter((entry) => entry.status === "ready" && !currentSet.has(entry.account));
    const excess = current.slice(Math.max(0, poolSize));
    const victims = [...stale, ...excess].filter((entry) => entry.status === "ready" && !assigningNow.has(entry.account));
    for (const entry of victims) {
      entry.status = "trimming";
    }
    if (victims.length) save();
    for (const entry of victims) {
      const reason = currentSet.has(entry.account) ? "trimmed: pool above target" : "trimmed: not on current factory";
      let result: SweepResult;
      try {
        result = await sweepAccount(pub, relayer, entry.account, config.network);
      } catch (error) {
        result = { account: entry.account, funds: "?", lockup: "?", outcome: `error: ${error instanceof Error ? error.message : String(error)}` };
      }
      state.sweeps[entry.account] = { ...result, at: new Date(now()).toISOString() };
      if (result.outcome === "swept" || result.funds === "0") {
        entry.status = "retired";
        entry.error = reason;
      } else if (result.outcome.startsWith("error")) {
        entry.status = "failed"; // a sweep may have been sent: never hand it out again; sweepDeferred retries
        entry.error = `trim: ${result.outcome}`;
      } else entry.status = "ready"; // nothing moved: still a funded warm account
      save();
      out.push({ account: entry.account, outcome: result.outcome, ...(result.swept ? { swept: result.swept } : {}) });
    }
    return out;
  }

  /**
   * "assigning" entries with no assign in flight here (a crash or an RPC error after sending): read the chain.
   * Still unassigned → back to "ready". Assigned → "assigned", and if the buyer's pool credit failed without an
   * account, finish it (the handover landed; only the receipt read failed).
   */
  async function reconcileAssigning(): Promise<{ account: Address; outcome: string }[]> {
    const out: { account: Address; outcome: string }[] = [];
    for (const entry of Object.values(state.pool)) {
      if (entry.status !== "assigning" || assigningNow.has(entry.account)) continue;
      let unassigned: boolean;
      try {
        unassigned = (await pub.readContract({ address: entry.account, abi: poolAccountAbi, functionName: "unassigned" })) as boolean;
      } catch {
        continue;
      }
      if (entry.status !== "assigning" || assigningNow.has(entry.account)) continue;
      if (unassigned) {
        entry.status = "ready";
        delete entry.assignedTo;
        out.push({ account: entry.account, outcome: "not assigned on chain: back to ready" });
      } else {
        entry.status = "assigned";
        let outcome = "assigned on chain";
        const identity = entry.assignedTo ? parseIdentityId(entry.assignedTo) : undefined;
        const found = entry.assignedTo ? Object.values(state.credits).find((c) => c.identity === entry.assignedTo && c.path === "pool" && c.status === "failed" && !c.account) : undefined;
        if (identity && found && !state.users[entry.assignedTo!]) {
          state.users[entry.assignedTo!] = { owner: ownerOf(identity), account: entry.account, sessionExpiry: entry.sessionExpiry, dataSetId: entry.dataSetId, providerId: entry.providerId, dataSetTx: entry.dataSetTx, via: "pool", ...(found.credential ? { credentialId: found.credential } : {}) };
          found.account = entry.account;
          found.status = "done";
          found.error = "reconciled: handover landed on chain";
          outcome += "; buyer's credit completed";
        }
        out.push({ account: entry.account, outcome });
      }
      save();
    }
    return out;
  }

  /**
   * Watch broadcast and included handover txs: bump fees if a tipset does not include them in time,
   * resubmit on drop/reorg/revert, and unwind only when a resubmit is impossible.
   */
  let landingTail = Promise.resolve();
  async function checkHandoverFinality(): Promise<{ finalized: string[]; dropped: string[]; reverted: string[]; resubmitted: string[]; unwound: string[]; rebroadcast: string[]; stuck: string[] }> {
    const run = landingTail.then(runHandoverFinality, runHandoverFinality);
    landingTail = run.then(() => undefined, () => undefined);
    return run;
  }
  async function runHandoverFinality(): Promise<{ finalized: string[]; dropped: string[]; reverted: string[]; resubmitted: string[]; unwound: string[]; rebroadcast: string[]; stuck: string[] }> {
    const out = { finalized: [] as string[], dropped: [] as string[], reverted: [] as string[], resubmitted: [] as string[], unwound: [] as string[], rebroadcast: [] as string[], stuck: [] as string[] };
    try {
    const head = await headNumber();
    for (const [id, credit] of Object.entries(state.credits)) {
      if (credit.finality === "finalized") continue;
      if (credit.status !== "done" && credit.finality !== "included" && credit.finality !== "sent") continue;
      const hash = latestHandoverHash(credit);
      if (!hash && !credit.inclusion?.length) continue;

      if (credit.finality === "sent" || !credit.inclusion?.length) {
        if (!hash) continue;
        let found: { blockNumber: bigint; blockHash: Hex; reverted?: boolean } | undefined;
        try {
          found = await peekHandoverInclusion(hash);
        } catch {
          found = undefined;
        }
        if (found && !found.reverted) {
          recordInclusion(credit, credit.path === "create" ? "create" : "assign", { transactionHash: hash, blockNumber: found.blockNumber, blockHash: found.blockHash });
          credit.finality = "included";
          delete credit.error;
          markTiming(credit, "assignIncluded", { session: id, assignBlock: found.blockNumber.toString(), assignBlockHash: found.blockHash });
          save();
          if (credit.account) void maybeInstallSession(credit, credit.account);
          continue;
        }
        if (found?.reverted) {
          out.reverted.push(id);
          await recoverHandover(id, credit, "reverted", out);
          continue;
        }
        const sentAt = BigInt(credit.sentAtBlock ?? "0");
        if (sentAt && head >= sentAt + BigInt(includeWithinEpochs)) {
          try {
            const next = await rebroadcastHandover(credit, hash);
            if (next) {
              out.rebroadcast.push(id);
              continue;
            }
          } catch (error) {
            console.warn("[sponsor] rebroadcast failed", error);
          }
          if ((credit.rebroadcasts ?? 0) >= maxRebroadcasts) {
            credit.error = "handover not included after fee bumps; retrying";
            out.stuck.push(id);
            save();
            await recoverHandover(id, credit, "dropped", out);
          }
        }
        continue;
      }

      let worst: "finalized" | "included" | "dropped" | "reverted" = "finalized";
      for (const row of credit.inclusion ?? []) {
        const recorded: RecordedInclusion = { hash: row.hash, blockNumber: row.blockNumber, blockHash: row.blockHash };
        const result = await receiptFate(pub, recorded, { finalityEpochs: FINALITY_EPOCHS });
        if (result.fate === "dropped" || result.fate === "reverted") {
          worst = result.fate;
          break;
        }
        if (result.blockHash && result.blockNumber != null && (result.blockHash.toLowerCase() !== row.blockHash.toLowerCase() || result.blockNumber.toString() !== row.blockNumber)) {
          row.blockHash = result.blockHash;
          row.blockNumber = result.blockNumber.toString();
        }
        if (result.fate === "included") worst = "included";
      }
      if (worst === "finalized") {
        credit.finality = "finalized";
        out.finalized.push(id);
        save();
        continue;
      }
      if (worst === "included") {
        credit.finality = "included";
        save();
        continue;
      }
      if (worst === "dropped" && hash) {
        try {
          const next = await rebroadcastHandover(credit, hash);
          if (next) {
            out.rebroadcast.push(id);
            out.dropped.push(id);
            continue;
          }
        } catch (error) {
          console.warn("[sponsor] rebroadcast after drop failed", error);
        }
      }
      out.dropped.push(id);
      if (worst === "reverted") out.reverted.push(id);
      await recoverHandover(id, credit, worst, out);
    }
    } finally { /* serialized via landingTail */ }
    return out;
  }

  /** Resubmit a failed handover. Unwind the pool account only when that is required to send again. */
  async function recoverHandover(id: string, credit: CreditRecord, reason: "dropped" | "reverted", out: { resubmitted: string[]; unwound: string[]; stuck: string[] }): Promise<void> {
    const account = credit.account;
    credit.error = reason === "reverted" ? "handover tx reverted; retrying" : "handover tx dropped or reorged; retrying";
    save();
    const gate = await resubmitGate(credit).catch(() => "rebroadcast" as const);
    if (gate === "rebroadcast") {
      out.stuck.push(id);
      return; // an earlier nonce is still open: it was re-sent with the same nonce; check again next tick
    }
    if (gate === "landed") {
      credit.status = "done";
      credit.finality = "included";
      delete credit.error;
      save();
      return;
    }
    if (credit.path === "pool" && account) {
      let unassigned = true;
      try {
        unassigned = (await pub.readContract({ address: account, abi: poolAccountAbi, functionName: "unassigned" })) as boolean;
      } catch {
        unassigned = true;
      }
      const entry = Object.values(state.pool).find((item) => item.account.toLowerCase() === account.toLowerCase());
      if (!unassigned && entry) {
        // Still assigned on-chain — keep the credit ready; a receipt drop was a false read.
        credit.account = account;
        credit.status = "done";
        credit.finality = "included";
        delete credit.error;
        entry.status = "assigned";
        save();
        return;
      }
      if (unassigned) {
        if (entry) {
          entry.status = "ready";
          delete entry.assignedTo;
        }
        if (credit.identity && state.users[credit.identity]?.account?.toLowerCase() === account.toLowerCase()) {
          delete state.users[credit.identity];
        }
        credit.status = "pending";
        delete credit.account;
        delete credit.inclusion;
        delete credit.hash;
        credit.finality = "dropped";
        out.unwound.push(id);
        save();
        try {
          await queueCredit(id, credit.credential);
          if (state.credits[id]?.status === "done") out.resubmitted.push(id);
        } catch (error) {
          credit.status = "failed";
          credit.error = `resubmit: ${error instanceof Error ? error.message : String(error)}`;
          out.stuck.push(id);
          save();
        }
        return;
      }
    }
    credit.status = "pending";
    delete credit.account;
    credit.finality = "dropped";
    save();
    try {
      await queueCredit(id, credit.credential);
      if (state.credits[id]?.status === "done") out.resubmitted.push(id);
    } catch (error) {
      credit.status = "failed";
      credit.error = `resubmit: ${error instanceof Error ? error.message : String(error)}`;
      out.stuck.push(id);
      save();
    }
  }


  const poolCare: PoolCareConfig = { ...DEFAULT_POOL_CARE, ...config.poolCare };
  const alertsCfg: AlertThresholds | undefined = config.alerts?.enabled ? config.alerts : undefined;
  const usdfcNeed = usdfcReserveNeed({
    poolSize,
    seedUsdfc: config.pool?.seedUsdfc ?? "1",
    topUpMonths: poolCare.topUpMonths,
    pricing,
  });
  const filFloor = () => gasLimits.filFloorWei > 0n ? gasLimits.filFloorWei : parseUnits("0.05", 18);

  function spareCreatedAtMs(entry: PoolEntry): number {
    if (entry.createdAt) {
      const parsed = Date.parse(entry.createdAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return createdAtFromSessionExpiry(entry.sessionExpiry, ACCOUNT_TTL_SEC, now());
  }

  async function readSparePay(entry: PoolEntry): Promise<{ available: bigint; lockup: bigint; rate: bigint; runwayDays: number }> {
    const epoch = await pub.getBlockNumber();
    const [funds, lockupCurrent, lockupRate, settledAt] = (await pub.readContract({
      address: PAY,
      abi: payAbi,
      functionName: "accounts",
      args: [USDFC, entry.account],
    })) as readonly bigint[];
    const settled = settledPayAccount(funds, lockupCurrent, lockupRate, settledAt, epoch);
    const days = runwayDays(settled.available, lockupRate);
    entry.pay = {
      available: formatUnits(settled.available, 18),
      lockup: formatUnits(settled.lockup, 18),
      ratePerMonth: formatUnits(effectiveRate(lockupRate) * 86_400n, 18),
      runwayDays: days,
      checkedAt: new Date(now()).toISOString(),
    };
    return { available: settled.available, lockup: settled.lockup, rate: lockupRate, runwayDays: days };
  }

  function canSpendForPoolCare(funds: { fil: bigint; usdfc: bigint }, usdfcNeed: bigint): string | null {
    if (funds.fil < filFloor() || funds.fil < minFil()) return `FIL floor ${formatUnits(filFloor(), 18)}`;
    if (funds.usdfc < pendingUsdfc() + usdfcNeed) return "sponsor USDFC reserved for paid credits";
    return null;
  }

  async function withCareGas<T>(account: Address, work: () => Promise<T>): Promise<T> {
    if (!state.gas) state.gas = { budget: emptyGasState() };
    const funds = await sponsorFunds();
    const reservationId = `pool-care:${account}:${now()}`;
    const cost = gasLimits.txMaxFeeWei;
    reserveGas(state.gas.budget, gasLimits, {
      account,
      reservationId,
      costWei: cost,
      gas: 1n,
      maxFeePerGas: cost,
      lifetimeCapWei: lifetimeCapWei(0, gasLimits),
      sponsorFilWei: funds.fil,
      sessionKey: null,
      ip: null,
      now: now(),
    });
    save();
    try {
      const result = await work();
      settleGas(state.gas.budget, reservationId, cost);
      save();
      return result;
    } catch (error) {
      releaseGas(state.gas.budget, reservationId);
      save();
      throw error;
    }
  }

  async function terminateSpareDataset(entry: PoolEntry): Promise<Hex | undefined> {
    const dataSetId = entry.dataSetId;
    if (deps.terminatePoolDataset) return (await deps.terminatePoolDataset(entry.account, dataSetId ?? "")).hash;
    if (!dataSetId) return undefined;
    let unassigned = true;
    try {
      unassigned = Boolean(await pub.readContract({ address: entry.account, abi: lockedAccountAbi, functionName: "unassigned" }));
    } catch { /* treat as unassigned */ }
    if (unassigned) {
      await relayer.relay({
        to: config.factory,
        label: `retire assign ${entry.account}`,
        data: encodeFunctionData({
          abi: lockedFactoryAbi,
          functionName: "assign",
          args: [entry.account, relayer.address, ZERO32, ZERO32, 0n],
        }),
      });
    }
    const sign = deps.sponsorKey
      ? (params: Parameters<NonNullable<Relayer["signTypedData"]>>[0]) => privateKeyToAccount(deps.sponsorKey!).signTypedData(params as never)
      : relayer.signTypedData?.bind(relayer);
    if (!sign) throw new Error("cannot terminate pool dataset: no sponsor signer");
    const nonce = (await pub.readContract({ address: entry.account, abi: lockedAccountAbi, functionName: "nonce" })) as bigint;
    const deadline = BigInt(Math.floor(now() / 1000) + 3600);
    const data = encodeFunctionData({
      abi: parseAbi(["function terminateService(uint256 dataSetId)"]),
      functionName: "terminateService",
      args: [BigInt(dataSetId)],
    });
    const signature = await sign({
      domain: executeDomain(config.chainId, entry.account) as never,
      types: EXECUTE_TYPES,
      primaryType: "Execute",
      message: { target: FWSS, value: 0n, data, nonce, deadline },
    });
    const receipt = await relayer.relay({
      to: entry.account,
      label: `terminate ${entry.account} dataset ${dataSetId}`,
      data: encodeFunctionData({
        abi: lockedAccountAbi,
        functionName: "execute",
        args: [FWSS, 0n, data, nonce, deadline, signature],
      }),
    });
    return receipt.transactionHash;
  }

  /**
   * For each unassigned ready spare: retire if older than max age (terminate + sweep, pool rebuilds);
   * otherwise top up from the sponsor when Filecoin Pay runway is below the configured threshold.
   */
  async function maintainPoolSpares(): Promise<{ toppedUp: Address[]; retired: Address[]; skipped: { account: Address; reason: string }[] }> {
    const out = { toppedUp: [] as Address[], retired: [] as Address[], skipped: [] as { account: Address; reason: string }[] };
    const ready = (await poolOnCurrentFactory("ready")).filter((entry) => entry.status === "ready" && !assigningNow.has(entry.account));
    for (const entry of ready) {
      if (entry.status !== "ready" || assigningNow.has(entry.account)) continue;
      let pay: { available: bigint; lockup: bigint; rate: bigint; runwayDays: number };
      try {
        pay = await readSparePay(entry);
      } catch (error) {
        out.skipped.push({ account: entry.account, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const age = ageDays(spareCreatedAtMs(entry), now());
      const action = decideSpareCare({ ageDays: age, runwayDays: pay.runwayDays, care: poolCare });
      if (action === "ok") {
        entry.care = { at: new Date(now()).toISOString(), action: "ok" };
        save();
        continue;
      }
      let funds: { fil: bigint; usdfc: bigint };
      try {
        funds = await sponsorFunds();
      } catch (error) {
        out.skipped.push({ account: entry.account, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (action === "retire") {
        const blocked = canSpendForPoolCare(funds, 0n);
        if (blocked) {
          entry.care = { at: new Date(now()).toISOString(), action: "skip", error: blocked };
          out.skipped.push({ account: entry.account, reason: blocked });
          save();
          continue;
        }
        entry.status = "trimming";
        save();
        try {
          const hash = await withCareGas(entry.account, () => terminateSpareDataset(entry));
          let result: SweepResult;
          try {
            result = await sweepAccount(pub, relayer, entry.account, config.network);
          } catch (error) {
            result = { account: entry.account, funds: "?", lockup: "?", outcome: `error: ${error instanceof Error ? error.message : String(error)}` };
          }
          state.sweeps[entry.account] = { ...result, at: new Date(now()).toISOString() };
          entry.status = "retired";
          entry.error = "retired: older than max pool age";
          entry.care = { at: new Date(now()).toISOString(), action: "retire", ...(hash ? { hash } : {}), ...(result.swept ? { amount: result.swept } : {}) };
          out.retired.push(entry.account);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof GasBudgetError) {
            entry.status = "ready";
            entry.care = { at: new Date(now()).toISOString(), action: "skip", error: message };
            out.skipped.push({ account: entry.account, reason: message });
          } else {
            entry.status = "failed";
            entry.error = `retire: ${message}`;
            entry.care = { at: new Date(now()).toISOString(), action: "retire", error: message };
            out.skipped.push({ account: entry.account, reason: message });
          }
        }
        save();
        continue;
      }
      const amount = topUpToMonths(pay.available, pay.rate, poolCare.topUpMonths);
      if (amount <= 0n) {
        entry.care = { at: new Date(now()).toISOString(), action: "ok" };
        save();
        continue;
      }
      const blocked = canSpendForPoolCare(funds, amount);
      if (blocked) {
        entry.care = { at: new Date(now()).toISOString(), action: "skip", error: blocked };
        out.skipped.push({ account: entry.account, reason: blocked });
        save();
        continue;
      }
      try {
        const hash = await withCareGas(entry.account, () => deposit(entry.account, amount, `pool top-up ${entry.account}`));
        entry.hashes = [...(entry.hashes ?? []), hash];
        entry.care = { at: new Date(now()).toISOString(), action: "topup", amount: formatUnits(amount, 18), hash };
        await readSparePay(entry).catch(() => undefined);
        out.toppedUp.push(entry.account);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.care = { at: new Date(now()).toISOString(), action: "skip", error: message };
        out.skipped.push({ account: entry.account, reason: message });
      }
      save();
    }
    return out;
  }

  async function spareStatusRows() {
    const rows = [];
    for (const entry of await poolOnCurrentFactory("ready")) {
      try {
        if (!entry.pay) await readSparePay(entry);
      } catch { /* leave last snapshot */ }
      rows.push({
        account: entry.account,
        status: entry.status,
        createdAt: entry.createdAt ?? null,
        ageDays: ageDays(spareCreatedAtMs(entry), now()),
        availableUsdfc: entry.pay?.available ?? null,
        lockupUsdfc: entry.pay?.lockup ?? null,
        rateUsdfcPerMonth: entry.pay?.ratePerMonth ?? null,
        runwayDays: entry.pay?.runwayDays ?? null,
        lastAction: entry.care ?? null,
      });
    }
    return rows;
  }


  function balanceSnapshot(funds: { fil: bigint; usdfc: bigint } | null) {
    if (!funds || !config.alerts) return null;
    const runways = Object.values(state.pool)
      .filter((entry) => entry.status === "ready" && typeof entry.pay?.runwayDays === "number")
      .map((entry) => entry.pay!.runwayDays);
    return classifyBalances({
      filWei: funds.fil,
      usdfcWei: funds.usdfc,
      owedUsdfcWei: pendingUsdfc(),
      spareRunways: runways,
      thresholds: config.alerts,
    });
  }

  function alertView(funds: { fil: bigint; usdfc: bigint } | null) {
    if (!config.alerts) return { enabled: false };
    const snapshot = balanceSnapshot(funds);
    if (!snapshot) return { enabled: config.alerts.enabled, level: "unknown" };
    return alertStatusView(state.alerts?.balance, snapshot, config.alerts, usdfcNeed);
  }

  async function checkBalanceAlerts(): Promise<{ action: AlertAction | null; level: AlertLevel | "unknown"; sent: boolean; error?: string }> {
    if (!alertsCfg) return { action: null, level: "ok", sent: false };
    let funds: { fil: bigint; usdfc: bigint };
    try {
      funds = await sponsorFunds();
    } catch (error) {
      return { action: null, level: "unknown", sent: false, error: error instanceof Error ? error.message : String(error) };
    }
    const snapshot = balanceSnapshot(funds);
    if (!snapshot) return { action: null, level: "ok", sent: false };
    const prev = state.alerts?.balance;
    const action = decideBalanceAlert({
      prev: prev ? { level: prev.level, lastSentAt: prev.lastSentAt ? Date.parse(prev.lastSentAt) : undefined } : undefined,
      level: snapshot.level,
      now: now(),
      reminderMs: alertsCfg.reminderMs,
    });
    state.alerts ??= {};
    const record: BalanceAlertRecord = {
      ...(prev ?? { level: "ok" }),
      level: snapshot.level,
      reasons: snapshot.reasons,
      fil: fmtToken(snapshot.filWei),
      usdfc: fmtToken(snapshot.usdfcWei),
    };
    state.alerts.balance = record;
    if (!action) {
      save();
      return { action: null, level: snapshot.level, sent: false };
    }
    const lastAttempt = record.lastAttemptAt ? Date.parse(record.lastAttemptAt) : 0;
    const retryAfter = deps.sendEmail ? 10 * 60 * 1000 : alertsCfg.reminderMs;
    if (record.lastError && lastAttempt && now() - lastAttempt < retryAfter && record.lastAction === action) {
      save();
      return { action, level: snapshot.level, sent: false, error: record.lastError };
    }
    if (!deps.sendEmail) {
      record.lastError = "no mailer: enable Cloudflare Email Routing send_email on scionbase.ai, or set RESEND_API_KEY";
      record.lastAttemptAt = new Date(now()).toISOString();
      record.lastAction = action;
      save();
      return { action, level: snapshot.level, sent: false, error: record.lastError };
    }
    try {
      const email = composeAlertEmail({
        action,
        snapshot,
        network: config.network,
        sponsor: relayer.address,
        thresholds: alertsCfg,
        need: usdfcNeed,
      });
      const result = await deps.sendEmail(email);
      record.lastSentAt = new Date(now()).toISOString();
      record.lastAction = action;
      record.lastChannel = result?.channel;
      delete record.lastError;
      record.lastAttemptAt = record.lastSentAt;
      save();
      return { action, level: snapshot.level, sent: true };
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error);
      record.lastAttemptAt = new Date(now()).toISOString();
      record.lastAction = action;
      save();
      return { action, level: snapshot.level, sent: false, error: record.lastError };
    }
  }

    /** Background tick (Worker cron / Node interval): owed credits first, then the pool, then deferred sweeps. */
  async function cronTick() {
    const reconciled = await reconcileAssigning();
    const finality = await checkHandoverFinality();
    const credits = await retryAwaiting();
    const trimmed = await trimPool();
    const care = await maintainPoolSpares();
    const alerts = await checkBalanceAlerts();
    void refillPool();
    const swept = await sweepDeferred();
    return { reconciled, finality, credits, trimmed, care, alerts, swept, pool: poolStatus().counts };
  }

  /** Off-chain reserve + creation fees from delivered purchases: dollars owed back to the sponsor. */
  function ledger() {
    let reserve = 0;
    let creation = 0;
    let purchases = 0;
    let first = 0;
    for (const credit of Object.values(state.credits)) {
      if (credit.status !== "done") continue;
      purchases += 1;
      reserve += credit.reserveCents;
      creation += credit.setupCents;
      if (credit.setupCents) first += 1;
    }
    return { purchases, firstPurchases: first, reserveUsd: reserve / 100, creationFeesUsd: creation / 100, owedToSponsorUsd: (reserve + creation) / 100 };
  }

  async function status() {
    let funds: { fil: bigint; usdfc: bigint } | null = null;
    try {
      funds = await sponsorFunds();
    } catch {
      funds = null;
    }
    const lowFil = parseUnits(config.lowFil ?? "0.05", 18);
    const lowUsdfc = parseUnits(config.lowUsdfc ?? "20", 18);
    const owed = pendingUsdfc();
    const level = !funds ? "unknown" : funds.fil < minFil() || funds.usdfc <= owed ? "empty" : funds.fil < lowFil || funds.usdfc - owed < lowUsdfc ? "low" : "ok";
    const credits: Record<string, number> = {};
    for (const credit of Object.values(state.credits)) credits[credit.status] = (credits[credit.status] ?? 0) + 1;
    return {
      network: config.network,
      sponsor: relayer.address,
      funds: {
        level,
        fil: funds ? formatUnits(funds.fil, 18) : null,
        usdfc: funds ? formatUnits(funds.usdfc, 18) : null,
        owedUsdfc: formatUnits(owed, 18),
        thresholds: { minFil: config.minSponsorFil ?? "0.005", lowFil: config.lowFil ?? "0.05", lowUsdfc: config.lowUsdfc ?? "20" },
      },
      checkoutOpen: level === "ok" || level === "low",
      ledger: ledger(),
      pool: {
        ...poolStatus().counts,
        care: poolCare,
        spares: await spareStatusRows(),
      },
      credits,
      refundAfterHours: config.refundAfterHours ?? 24,
      contracts: await chainContracts(),
      gas: gasStatus(state.gas?.budget ?? emptyGasState(), gasLimits, funds?.fil ?? null),
      alerts: alertView(funds),
    };
  }

  async function chainContracts() {
    const factory = config.factory;
    const read = async (fn: "beacon" | "implementation" | "REGISTRY" | "PAY" | "FWSS" | "TOKEN") =>
      pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: fn } as never).catch(() => undefined) as Promise<Address | undefined>;
    const [beacon, implementation, registry, pay, fwss, token] = await Promise.all([
      config.beacon ? Promise.resolve(config.beacon) : read("beacon"),
      read("implementation"),
      config.registry ? Promise.resolve(config.registry) : read("REGISTRY"),
      read("PAY"),
      read("FWSS"),
      read("TOKEN"),
    ]);
    return {
      factory,
      legacyFactory: config.legacyFactory ?? null,
      beacon: beacon ?? null,
      implementation: implementation ?? null,
      registry: registry ?? null,
      allowlist: {
        pay: pay ?? config.contracts.pay,
        fwss: fwss ?? config.contracts.fwss,
        token: token ?? config.contracts.usdfc,
      },
    };
  }

  async function health() {
    const st = await status();
    const warnings: string[] = [];
    if (st.funds.level === "low") warnings.push(`sponsor wallet low: ${st.funds.fil} FIL / ${st.funds.usdfc} USDFC`);
    if (st.funds.level === "empty") warnings.push(`sponsor wallet empty: card checkout paused (${st.funds.fil} FIL / ${st.funds.usdfc} USDFC, ${st.funds.owedUsdfc} USDFC owed)`);
    if (st.funds.level === "unknown") warnings.push("sponsor balance unreadable (RPC)");
    if (poolSize && !poolStatus().counts.ready) warnings.push("warm pool empty: purchases use on-demand creation");
    if (st.credits["awaiting-funds"]) warnings.push(`${st.credits["awaiting-funds"]} paid credit(s) awaiting sponsor funds`);
    const alertLevel = (st.alerts as { level?: string } | undefined)?.level;
    if (alertLevel === "warn" || alertLevel === "critical") {
      const reasons = ((st.alerts as { reasons?: string[] }).reasons ?? []).join("; ") || alertLevel;
      warnings.push(`balance alert (${alertLevel}): ${reasons}`);
    }
    return {
      ok: true,
      funds: st.funds.level,
      checkoutOpen: st.checkoutOpen,
      warnings,
      network: config.network,
      chainId: config.chainId,
      sponsor: relayer.address,
      factory: config.factory,
      providerId: config.providerId.toString(),
      stripe: { checkout: Boolean(config.stripe.secretKey) || Boolean(config.stripe.fake), webhook: Boolean(config.stripe.webhookSecret), fake: Boolean(config.stripe.fake) },
      pool: poolStatus().counts,
    };
  }

  function poolStatus() {
    const counts: Record<string, number> = { target: poolSize };
    for (const entry of Object.values(state.pool)) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return {
      counts,
      refilling: Boolean(refilling),
      entries: Object.values(state.pool).map(({ account, status, dataSetId, providerId, assignedTo, error }) => ({ account, status, dataSetId, providerId, assigned: Boolean(assignedTo), error })),
    };
  }

  async function handle(req: SponsorRequest): Promise<SponsorResponse> {
    try {
      const url = new URL(req.url || "/", "http://sponsor");
      const ok = (body: unknown): SponsorResponse => ({ status: 200, body });
      if (req.method === "OPTIONS") return { status: 204, body: {} };
      if (req.method === "GET" && url.pathname === "/health") return ok(await health());
      if (req.method === "GET" && url.pathname === "/pool") return ok(poolStatus());
      if (req.method === "GET" && url.pathname === "/status") return ok(await status());
      if (req.method === "GET" && url.pathname === "/config") return ok({ network: config.network, chainId: config.chainId, ...(await chainContracts()) });
      if (req.method === "GET" && url.pathname === "/pricing") {
        return ok({ minFirstUsd: pricing.minFirstCents / 100, minTopUpUsd: pricing.minTopUpCents / 100, maxUsd: pricing.maxCents / 100, suggestedUsd: pricing.suggestedCents / 100, setupFeeUsd: pricing.setupCents / 100, reserveUsd: pricing.reserveCents / 100, minCreditUsd: pricing.minCreditCents / 100, minNetUsd: pricing.minNetCents / 100, stripeFee: { pct: pricing.stripeFeeBps / 100, fixedUsd: pricing.stripeFeeFixedCents / 100 }, usdfcPerUsd: pricing.usdfcPerUsd, testMode: config.network !== "mainnet" });
      }
      if (req.method === "GET" && url.pathname === "/account") return ok(lookup(url));
      if (req.method === "GET" && url.pathname === "/credits") {
        const id = url.searchParams.get("session") ?? "";
        const credit = state.credits[id];
        return ok(credit ? { status: credit.status, account: credit.account ?? null, usdfc: credit.usdfc, path: credit.path ?? null, hash: credit.hash ?? null, hashes: credit.hashes, error: credit.error ?? null, finality: credit.finality ?? null, sessionKey: credit.sessionKey ?? null, inclusion: credit.inclusion ?? [], timing: credit.timing ?? null, paidAt: credit.paidAt ?? null } : { status: state.checkouts[id] ? "awaiting-payment" : "unknown" });
      }
      if (req.method === "POST" && url.pathname === "/stripe/webhook") return ok(await onStripeEvent(req.body, req.header("stripe-signature")));
      if (req.method === "POST" && url.pathname === "/checkout") {
        const body = parseJson(req.body);
        return ok(await checkout(await authenticate("checkout", body, limits.checkout), body));
      }
      if (req.method === "POST" && url.pathname === "/dataset") {
        const body = parseJson(req.body);
        return ok(await ensureDataset(await authenticate("dataset", body, limits.setup)));
      }
      if (req.method === "POST" && url.pathname === "/execute") {
        const ip = req.header("cf-connecting-ip") || req.header("x-forwarded-for")?.split(",")[0]?.trim();
        return ok(await relayExecute(parseJson(req.body), ip));
      }
      return { status: 404, body: { error: "not found" } };
    } catch (error) {
      if (error instanceof GasBudgetError) {
        return { status: 429, body: { error: error.message, limit: error.limit, retryAfter: error.retryAfter }, headers: { "Retry-After": String(error.retryAfter) } };
      }
      const status = error instanceof HttpError ? error.status : 500;
      const headers = error instanceof HttpError && error.status === 429 ? { "Retry-After": "60" } : undefined;
      console.error(`[sponsor] ${req.method} ${req.url}:`, error instanceof Error ? error.message : error);
      return { status, body: { error: error instanceof Error ? error.message : String(error) }, headers };
    }
  }

  // Resume credits interrupted by a restart only if nothing was sent yet (never resend).
  for (const [id, credit] of Object.entries(state.credits)) if (credit.status === "pending" && !credit.hashes?.length) void queueCredit(id);

  return { handle, state, relayer, pub, config, pricing, onStripeEvent, refillPool, sweepDeferred, retryAwaiting, trimPool, reconcileAssigning, checkHandoverFinality, maintainPoolSpares, checkBalanceAlerts, cronTick, status, poolStatus, settled: () => creditQueue };
}

export type SponsorCore = ReturnType<typeof createSponsorCore>;
