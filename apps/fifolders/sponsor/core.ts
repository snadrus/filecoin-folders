// Sponsor backend ("money processor") for gasless FiFolders. Holds the gas wallet, which is also the factory admin and
// treasury. Users never hold FIL or USDFC: they pay by card (Stripe) and the sponsor deposits USDFC into their
// LockedSignerAccount, where the fixed call policy only lets it pay FWSS storage.
//
//   GET  /pricing                             → minimums, setup fee, reserve, default purchase
//   GET  /account?user=0x… | ?x=0x…&y=0x… | ?credential=… → { account, x?, y? } (null before the first purchase)
//   POST /checkout  {auth, usd, successUrl, cancelUrl} → Stripe Checkout Session → { id, url, first }
//   POST /stripe/webhook                      → Stripe-signed checkout.session.completed → credit (once per session)
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
import { encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, formatUnits, getAddress, isAddress, isHex, parseAbi, parseUnits, recoverAddress, type Address, type Hex, type PublicClient } from "viem";
import { createDataSetApiRequest } from "@filoz/synapse-core/sp";
import { getPDPProvider } from "@filoz/synapse-core/sp-registry";
import { lockedAccountAbi, lockedFactoryAbi, type SponsorOwner } from "../src/sponsored-abi.js";
import { AuthError, parseIdentityId, passkeyId, verifyAuth, type Identity } from "./auth.js";
import { DEFAULT_PRICING, creditFor, poolTopUp, pricingFromEnv, type Pricing } from "./pricing.js";
import { RateLimiter } from "./ratelimit.js";
import { SponsorWalletRelayer, chainFor, publicClient, type Relayer } from "./relayer.js";
import { sweepAccount, type SweepResult } from "./sweeplib.js";
import { assertStripeMode, createCheckoutSession, estimateStripeFeeCents, fakeCheckoutSession, refundPayment, stripeFeeCents, verifyStripeSignature, type CheckoutSession, type Network } from "./stripe.js";
import { waitForReceipt } from "../src/receipt.js";
import { emptyGasState, gasStatus, lifetimeCapWei, limitsFromEnv, releaseGas, reserveGas, reservedCostWei, settleGas, GasBudgetError, type GasBudgetLimits, type GasBudgetState } from "./gas-budget.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ZERO_ADDRESS = getAddress(`0x${"0".repeat(40)}`);
const ACCOUNT_TTL_SEC = 365n * 86400n;
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
  contracts: { pay: Address; usdfc: Address; fwss: Address; pdp: Address };
  pricing?: Pricing;
  /** Warm pool: ready accounts to keep (0 disables) and the USDFC each holds. */
  pool?: { size: number; seedUsdfc: string };
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
  limits?: { executePerMinute?: number; setupPerHour?: number; checkoutPerHour?: number };
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
    },
    pricing: pricingFromEnv(env),
    pool: { size: Number(env.SPONSOR_POOL_SIZE ?? 2), seedUsdfc: env.SPONSOR_POOL_SEED_USDFC ?? "1" },
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
  const { pay: PAY, usdfc: USDFC, fwss: FWSS, pdp: PDP } = config.contracts;
  const loaded = deps.state ?? {};
  const state: SponsorState = {
    users: loaded.users ?? {},
    checkouts: loaded.checkouts ?? {},
    credits: loaded.credits ?? {},
    pool: loaded.pool ?? {},
    sweeps: loaded.sweeps ?? {},
    gas: { budget: loaded.gas?.budget ?? emptyGasState() },
  };
  const gasLimits = config.gasLimits ?? limitsFromEnv();
  // A pool build interrupted by a restart (or an evicted Durable Object) is not resumable: park it for a sweep.
  for (const entry of Object.values(state.pool)) {
    if (entry.status === "seeding") Object.assign(entry, { status: "failed", error: "interrupted while seeding" });
  }
  const save = () => deps.persist?.(state);
  const seen = new Map<string, number>();
  const limits = {
    execute: new RateLimiter(config.limits?.executePerMinute ?? 30, 60_000),
    setup: new RateLimiter(config.limits?.setupPerHour ?? 20, 3_600_000),
    checkout: new RateLimiter(config.limits?.checkoutPerHour ?? 10, 3_600_000),
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

  async function deposit(account: Address, amount: bigint, label: string): Promise<Hex> {
    await ensureAllowance(PAY, amount);
    const hash = await relayer.send({ to: PAY, label, data: encodeFunctionData({ abi: payAbi, functionName: "deposit", args: [USDFC, account, amount] }) });
    const receipt = await waitForReceipt(pub, hash);
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
    const receipt = await waitForReceipt(pub, created.txHash);
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
    const entry: PoolEntry = { account, salt: salt.toString(), sessionExpiry: sessionExpiry.toString(), status: "seeding", hashes: [], factory: config.factory };
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

  /** Apply one paid session, at most once. Each send is recorded before the next; a failure is never auto-resent. */
  function queueCredit(sessionId: string, credentialArg?: string): Promise<unknown> {
    creditQueue = creditQueue.then(async () => {
      const credit = state.credits[sessionId];
      if (!credit || credit.status !== "pending") return;
      const credential = credentialArg ?? credit.credential;
      let inFlight: string | undefined;
      const identity = parseIdentityId(credit.identity);
      try {
        // Pre-flight: if the sponsor is short, park the credit before sending anything (so a retry is always safe).
        const amount0 = BigInt(credit.usdfc);
        const viaPool = !state.users[credit.identity] && (await poolOnCurrentFactory("ready")).length > 0;
        const needUsdfc = viaPool ? poolTopUp(amount0, seed) : amount0;
        const funds = await sponsorFunds();
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
          if (amount > 0n) credit.hashes.push((credit.hash = await deposit(record.account, amount, `credit ${record.account} (${sessionId})`)));
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
            const receipt = await relayer.relay({ to: config.factory, label: `assign ${pooled.account} (${sessionId})`, data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "assign", args: [pooled.account, ...ownerArgs(identity), topUp] }) });
            credit.hashes.push((credit.hash = receipt.transactionHash));
            pooled.status = "assigned";
            record = state.users[credit.identity] = { owner: ownerOf(identity), account: pooled.account, sessionExpiry: pooled.sessionExpiry, dataSetId: pooled.dataSetId, providerId: pooled.providerId, dataSetTx: pooled.dataSetTx, via: "pool", ...(credential ? { credentialId: credential } : {}) };
            credit.account = pooled.account;
            credit.depositUsdfc = topUp.toString();
            credit.usdfc = (amount > seed ? amount : seed).toString();
            void refillPool();
          } else {
            // Slow path: create, fund, open the dataset.
            credit.path = "create";
            const sessionExpiry = BigInt(Math.floor(Date.now() / 1000)) + ACCOUNT_TTL_SEC;
            const args = ownerArgs(identity);
            const account = getAddress((await pub.readContract({ address: config.factory, abi: lockedFactoryAbi, functionName: "predict", args: [...args, 0n, sessionExpiry] })) as Address);
            credit.hashes.push((await relayer.relay({ to: config.factory, label: `create account for ${credit.identity}`, data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "create", args: [...args, 0n, sessionExpiry] }) })).transactionHash);
            record = state.users[credit.identity] = { owner: ownerOf(identity), account, sessionExpiry: sessionExpiry.toString(), via: "create", ...(credential ? { credentialId: credential } : {}) };
            credit.account = account;
            save();
            if (amount > 0n) credit.hashes.push((credit.hash = await deposit(account, amount, `credit ${account} (${sessionId})`)));
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

  /** Verified Stripe event → credit record (idempotent by session id). */
  async function onStripeEvent(raw: string, signature: string | undefined): Promise<{ received: true; credited?: string; duplicate?: boolean; ignored?: string }> {
    const secret = config.stripe.webhookSecret;
    if (!secret) throw new HttpError(503, "Stripe not configured: STRIPE_WEBHOOK_SECRET not set");
    try {
      verifyStripeSignature(raw, signature, secret);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const event = JSON.parse(raw) as { type?: string; livemode?: boolean; data?: { object?: Record<string, unknown> } };
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return { received: true, ignored: event.type };
    const session = event.data?.object ?? {};
    const id = String(session.id ?? "");
    if (!id) throw new HttpError(400, "event without session id");
    if (session.payment_status !== "paid") return { received: true, ignored: `payment_status ${String(session.payment_status)}` };
    if (Boolean(event.livemode) !== (config.network === "mainnet")) throw new HttpError(400, `livemode ${event.livemode} on ${config.network}`);
    if (String(session.currency).toLowerCase() !== "usd") throw new HttpError(400, "currency must be usd");
    if (state.credits[id]) return { received: true, duplicate: true, credited: state.credits[id]!.usdfc };
    const metadata = (session.metadata ?? {}) as Record<string, string>;
    if (metadata.factory && getAddress(metadata.factory) !== config.factory) return { received: true, ignored: "other factory" };
    const identityId = String(metadata.identity ?? "");
    if (!parseIdentityId(identityId)) throw new HttpError(400, "metadata.identity missing");
    const chargeCents = Number(session.amount_total);
    if (!Number.isInteger(chargeCents) || chargeCents <= 0) throw new HttpError(400, "bad amount_total");
    // Fee: Stripe's balance transaction (real keys) or the standard-pricing estimate (local fake only).
    const feeCents = config.stripe.secretKey ? await stripeFeeCents(config.stripe.secretKey, id, deps.fetch) : estimateStripeFeeCents(chargeCents, pricing);
    const raced = state.credits[id] as CreditRecord | undefined; // a duplicate delivery may have landed during the fee lookup
    if (raced) return { received: true, duplicate: true, credited: raced.usdfc };
    const first = !state.users[identityId]?.dataSetId;
    const { creditUsdfc, ...quote } = creditFor(pricing, { chargeCents, feeCents, first });
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : undefined;
    state.credits[id] = { identity: identityId, ...quote, usdfc: creditUsdfc.toString(), depositUsdfc: "0", status: "pending", hashes: [], paidAt: new Date(now()).toISOString(), ...(paymentIntent ? { paymentIntent } : {}), ...(metadata.credential ? { credential: metadata.credential } : {}) };
    save();
    void queueCredit(id, metadata.credential);
    return { received: true, credited: creditUsdfc.toString() };
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

  const FUND_SELECTORS = new Set([
    "0xa9059cbb", // transfer
    "0x23b872dd", // transferFrom
    "0x095ea7b3", // approve
    "0x39509351", // increaseAllowance
    "0xa457c2d7", // decreaseAllowance
    "0xd505accf", // permit
    "0x47e7ef24", // deposit(address,address,uint256)
    "0x2d83993e", // withdraw(address,uint256) — computed later if needed; also match prefix checks in-contract
  ]);

  async function ownerSignedExecute(account: Address, target: Address, value: bigint, data: Hex, nonce: bigint, deadline: bigint, signature: Hex): Promise<{ asOwner: boolean; signer?: Address }> {
    if (signature.length !== 132) return { asOwner: true }; // passkey assertion is always the owner
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
    if (!limits.execute.take(`execute:${account}`)) throw new HttpError(429, "rate limited");
    if (!(await isSponsoredAccount(account))) throw new HttpError(404, "not a sponsored account");
    const target = asAddress(body.target, "target");
    const data = String(body.data) as Hex;
    if (!isHex(data) || data.length < 10) throw new HttpError(400, "data must be calldata");
    const value = BigInt(String(body.value ?? 0));
    const nonce = BigInt(String(body.nonce));
    const deadline = BigInt(String(body.deadline));
    const signature = String(body.signature) as Hex;
    const signed = await ownerSignedExecute(account, target, value, data, nonce, deadline, signature);
    const asOwner = signed.asOwner;
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
    const fees = await pub.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const cost = reservedCostWei(gas, maxFee);
    const funds = await sponsorFunds();
    const reservationId = `${account}:${nonce}:${now()}`;
    if (!state.gas) state.gas = { budget: emptyGasState() };
    reserveGas(state.gas.budget, gasLimits, {
      account,
      reservationId,
      costWei: cost,
      gas,
      maxFeePerGas: maxFee,
      lifetimeCapWei: lifetimeCapWei(purchasesFor(account), gasLimits),
      sponsorFilWei: funds.fil,
      sessionKey: asOwner ? null : signed.signer ?? null,
      ip: ip ?? null,
      now: now(),
    });
    save();
    try {
      const receipt = await relayer.relay({ to: account, data: call, label: `execute ${target} ${data.slice(0, 10)}` });
      const priced = receipt as { gasUsed?: bigint | number; effectiveGasPrice?: bigint | number; gasPrice?: bigint | number };
      const actual = priced.gasUsed && (priced.effectiveGasPrice || priced.gasPrice)
        ? BigInt(priced.gasUsed) * BigInt(priced.effectiveGasPrice ?? priced.gasPrice ?? maxFee)
        : cost;
      settleGas(state.gas.budget, reservationId, actual);
      save();
      return { hash: receipt.transactionHash };
    } catch (error) {
      releaseGas(state.gas.budget, reservationId);
      save();
      throw error;
    }
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

  /** Background tick (Worker cron / Node interval): owed credits first, then the pool, then deferred sweeps. */
  async function cronTick() {
    const reconciled = await reconcileAssigning();
    const credits = await retryAwaiting();
    const trimmed = await trimPool();
    void refillPool();
    const swept = await sweepDeferred();
    return { reconciled, credits, trimmed, swept, pool: poolStatus().counts };
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
      pool: poolStatus().counts,
      credits,
      refundAfterHours: config.refundAfterHours ?? 24,
      contracts: await chainContracts(),
      gas: gasStatus(state.gas?.budget ?? emptyGasState(), gasLimits, funds?.fil ?? null),
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
    if (poolSize && !st.pool.ready) warnings.push("warm pool empty: purchases use on-demand creation");
    if (st.credits["awaiting-funds"]) warnings.push(`${st.credits["awaiting-funds"]} paid credit(s) awaiting sponsor funds`);
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
        return ok(credit ? { status: credit.status, account: credit.account ?? null, usdfc: credit.usdfc, path: credit.path ?? null, hash: credit.hash ?? null, hashes: credit.hashes, error: credit.error ?? null } : { status: state.checkouts[id] ? "awaiting-payment" : "unknown" });
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

  return { handle, state, relayer, pub, config, pricing, onStripeEvent, refillPool, sweepDeferred, retryAwaiting, trimPool, reconcileAssigning, cronTick, status, poolStatus, settled: () => creditQueue };
}

export type SponsorCore = ReturnType<typeof createSponsorCore>;
