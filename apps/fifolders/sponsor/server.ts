// Sponsor backend ("money processor") for gasless FiFolders. Holds the gas wallet, which is also the factory admin and
// treasury. Users never hold FIL; they pay by card (Stripe) and the sponsor deposits the matching USDFC into their
// LockedSignerAccount, where it can only pay FWSS storage.
//
//   GET  /account?user=0x… | ?x=0x…&y=0x…   → { account | null }
//   POST /account   {auth}                    → create the caller's LockedSignerAccount (owner EOA or passkey)
//   POST /checkout  {auth, usd, successUrl, cancelUrl} → Stripe Checkout Session for storage credits → { id, url }
//   POST /stripe/webhook                      → Stripe-signed checkout.session.completed → USDFC deposit (once per session)
//   GET  /credits?session=cs_…                → { status, account, usdfc, hash }
//   POST /dataset   {auth, metadata}          → one-time dataset: admin allowDataSet + provider createDataSet
//   POST /execute   {account, target, value, data, nonce, deadline, signature} → relay an owner/session-signed Execute
//
// `auth` is an EIP-712 SponsorRequest signed by the account owner, a live session key of the account, or the owner's
// passkey (see auth.ts). /execute needs no extra auth: the Execute signature is checked by the account itself (and
// simulated here first), the account must be one this factory deployed, and calls are rate limited per account.
//
//   SPONSOR_KEY=0x… SPONSOR_FACTORY=0x… STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… pnpm --filter fifolders sponsor
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, getAddress, isAddress, isHex, parseAbi, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { createDataSetApiRequest } from "@filoz/synapse-core/sp";
import { getPDPProvider } from "@filoz/synapse-core/sp-registry";
import { lockedAccountAbi, lockedFactoryAbi, type SponsorOwner } from "../src/sponsored-abi.js";
import { AuthError, passkeyId, verifyAuth, type Identity } from "./auth.js";
import { RateLimiter } from "./ratelimit.js";
import { CHAIN, NETWORK, SponsorWalletRelayer, publicClient, type Relayer } from "./relayer.js";
import { assertStripeMode, createCheckoutSession, fakeCheckoutSession, verifyStripeSignature, type CheckoutSession, type Network } from "./stripe.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ACCOUNT_TTL_SEC = 365n * 86400n;
const payAbi = parseAbi([
  "function deposit(address token, address to, uint256 amount) payable",
  "function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)",
]);

export interface SponsorConfig {
  network: Network;
  chainId: number;
  factory: Address;
  providerId: bigint;
  statePath?: string;
  contracts: { pay: Address; usdfc: Address; fwss: Address; pdp: Address };
  stripe: {
    secretKey?: string;
    webhookSecret?: string;
    /** Calibration only, and only without a secret key: checkout returns a local session and the webhook is simulated. */
    fake?: boolean;
    /** USDFC (decimal string) credited per USD paid. */
    usdfcPerUsd: string;
    minUsd: number;
    maxUsd: number;
    /** success/cancel URLs must start with one of these (empty = any, Calibration only). */
    allowedOrigins: string[];
  };
  limits?: { executePerMinute?: number; setupPerHour?: number; checkoutPerHour?: number };
}

export interface UserRecord {
  owner: SponsorOwner;
  account: Address;
  sessionExpiry: string;
  dataSetId?: string;
  providerId?: string;
  dataSetTx?: Hex;
}

export interface CreditRecord {
  account: Address;
  cents: number;
  usdfc: string;
  status: "pending" | "done" | "failed";
  hash?: Hex;
  error?: string;
}

export interface SponsorState {
  users: Record<string, UserRecord>;
  checkouts: Record<string, { account: Address; cents: number }>;
  credits: Record<string, CreditRecord>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SponsorConfig {
  const factory = env.SPONSOR_FACTORY;
  if (!factory) throw new Error("Set SPONSOR_FACTORY");
  const contracts = CHAIN.contracts as unknown as Record<string, { address: Address }>;
  const secretKey = env.STRIPE_SECRET_KEY || undefined;
  const config: SponsorConfig = {
    network: NETWORK,
    chainId: CHAIN.id,
    factory: getAddress(factory),
    providerId: BigInt(env.SPONSOR_PROVIDER_ID ?? "2"),
    statePath: env.SPONSOR_STATE ?? new URL("./sponsor-state.json", import.meta.url).pathname,
    contracts: {
      pay: getAddress(contracts.filecoinPay!.address),
      usdfc: getAddress(contracts.usdfc!.address),
      fwss: getAddress(contracts.fwss!.address),
      pdp: getAddress(contracts.pdp!.address),
    },
    stripe: {
      secretKey,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
      fake: env.SPONSOR_STRIPE_FAKE === "1",
      usdfcPerUsd: env.SPONSOR_USDFC_PER_USD ?? "1",
      minUsd: Number(env.SPONSOR_MIN_USD ?? 1),
      maxUsd: Number(env.SPONSOR_MAX_USD ?? 200),
      allowedOrigins: (env.SPONSOR_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    },
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
}

function asAddress(value: unknown, name: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(400, `${name} must be an address`);
  return getAddress(value);
}

function asBytes32(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new HttpError(400, `${name} must be bytes32`);
  return value.toLowerCase() as Hex;
}

/** USDFC (18 decimals) for a card payment of `cents`. */
export function usdfcForCents(cents: number, usdfcPerUsd: string): bigint {
  return (BigInt(cents) * parseUnits(usdfcPerUsd, 18)) / 100n;
}

export function createSponsor(config: SponsorConfig, deps: { pub?: PublicClient; relayer?: Relayer & { sent?: { label: string; hash: Hex }[] }; fetch?: typeof fetch } = {}) {
  validateConfig(config);
  const pub = deps.pub ?? publicClient();
  const relayer = deps.relayer ?? new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex);
  const { pay: PAY, usdfc: USDFC, fwss: FWSS, pdp: PDP } = config.contracts;
  const loaded = config.statePath && existsSync(config.statePath) ? (JSON.parse(readFileSync(config.statePath, "utf8")) as Partial<SponsorState>) : {};
  const state: SponsorState = { users: loaded.users ?? {}, checkouts: loaded.checkouts ?? {}, credits: loaded.credits ?? {} };
  const save = () => config.statePath && writeFileSync(config.statePath, JSON.stringify(state, null, 2));
  const seen = new Map<string, number>();
  const limits = {
    execute: new RateLimiter(config.limits?.executePerMinute ?? 30, 60_000),
    setup: new RateLimiter(config.limits?.setupPerHour ?? 20, 3_600_000),
    checkout: new RateLimiter(config.limits?.checkoutPerHour ?? 10, 3_600_000),
  };

  const recordFor = (identity: Identity): UserRecord | undefined =>
    identity.kind === "session" ? Object.values(state.users).find((record) => record.account === identity.account) : state.users[identity.id];

  async function authenticate(action: string, body: Record<string, unknown>, limiter: RateLimiter): Promise<Identity> {
    let identity: Identity;
    try {
      identity = await verifyAuth({
        chainId: config.chainId,
        action,
        body,
        seen,
        sessionExpiry: async (account, key) => {
          if (!Object.values(state.users).some((record) => record.account === account)) return 0n;
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

  /** Create (once) the caller's account. Owner wallet or passkey only; no credit (credits come from Stripe). */
  async function ensureAccount(identity: Identity): Promise<{ account: Address; hash?: Hex }> {
    const existing = recordFor(identity);
    if (existing) return { account: existing.account };
    if (identity.kind === "session") throw new HttpError(403, "session keys cannot create accounts");
    const owner: SponsorOwner = identity.kind === "eoa" ? { kind: "eoa", address: identity.address } : { kind: "passkey", x: identity.x, y: identity.y };
    const args = [identity.kind === "eoa" ? identity.address : getAddress(`0x${"0".repeat(40)}`), identity.kind === "passkey" ? identity.x : ZERO32, identity.kind === "passkey" ? identity.y : ZERO32, 0n] as const;
    const sessionExpiry = BigInt(Math.floor(Date.now() / 1000)) + ACCOUNT_TTL_SEC;
    const account = getAddress((await pub.readContract({ address: config.factory, abi: lockedFactoryAbi, functionName: "predict", args: [...args, sessionExpiry] })) as Address);
    const receipt = await relayer.relay({ to: config.factory, label: `create account for ${identity.id}`, data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "create", args: [...args, sessionExpiry] }) });
    state.users[identity.id] = { owner, account, sessionExpiry: sessionExpiry.toString() };
    save();
    return { account, hash: receipt.transactionHash };
  }

  function checkRedirect(url: unknown, name: string): string {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new HttpError(400, `${name} must be an http(s) URL`);
    const origins = config.stripe.allowedOrigins;
    if (origins.length && !origins.some((origin) => url.startsWith(origin))) throw new HttpError(400, `${name} origin not allowed`);
    return url;
  }

  async function checkout(identity: Identity, body: Record<string, unknown>): Promise<CheckoutSession> {
    const record = recordFor(identity);
    if (!record) throw new HttpError(404, "create the account first");
    const usd = Number(body.usd);
    if (!Number.isInteger(usd) || usd < config.stripe.minUsd || usd > config.stripe.maxUsd) throw new HttpError(400, `usd must be a whole number from ${config.stripe.minUsd} to ${config.stripe.maxUsd}`);
    const cents = usd * 100;
    const input = {
      cents,
      successUrl: checkRedirect(body.successUrl, "successUrl"),
      cancelUrl: checkRedirect(body.cancelUrl, "cancelUrl"),
      clientReferenceId: record.account,
      metadata: { account: record.account, network: config.network, factory: config.factory },
    };
    let session: CheckoutSession;
    if (config.stripe.secretKey) session = await createCheckoutSession(config.stripe.secretKey, input, deps.fetch);
    else if (config.stripe.fake) session = fakeCheckoutSession(input);
    else throw new HttpError(503, "card payments are not configured (STRIPE_SECRET_KEY)");
    state.checkouts[session.id] = { account: record.account, cents };
    save();
    return session;
  }

  let depositQueue: Promise<unknown> = Promise.resolve();

  /** Deposit for one paid session, at most once (state.credits keyed by session id, persisted before sending). */
  function queueDeposit(sessionId: string): Promise<unknown> {
    depositQueue = depositQueue.then(async () => {
      const credit = state.credits[sessionId];
      if (!credit || credit.status === "done" || credit.hash) return;
      try {
        if (!(await pub.readContract({ address: config.factory, abi: lockedFactoryAbi, functionName: "isAccount", args: [credit.account] }))) throw new Error(`not a factory account: ${credit.account}`);
        const amount = BigInt(credit.usdfc);
        const allowance = await pub.readContract({ address: USDFC, abi: erc20Abi, functionName: "allowance", args: [relayer.address, PAY] });
        if (allowance < amount) await relayer.relay({ to: USDFC, label: "USDFC approve", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAY, amount * 100n] }) });
        const hash = await relayer.send({ to: PAY, label: `credit ${credit.account} (${sessionId})`, data: encodeFunctionData({ abi: payAbi, functionName: "deposit", args: [USDFC, credit.account, amount] }) });
        credit.hash = hash;
        save();
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 10 * 60_000, pollingInterval: 5_000 });
        if (receipt.status !== "success") throw new Error(`deposit reverted: ${hash}`);
        credit.status = "done";
        delete credit.error;
      } catch (error) {
        credit.status = "failed";
        credit.error = error instanceof Error ? error.message : String(error);
        // A sent-but-unconfirmed deposit keeps its hash so it is never sent twice; an operator reconciles it.
      }
      save();
    });
    return depositQueue;
  }

  /** Verified Stripe event → credit record (idempotent by session id). Returns what happened. */
  function onStripeEvent(raw: string, signature: string | undefined): { received: true; credited?: string; duplicate?: boolean; ignored?: string } {
    const secret = config.stripe.webhookSecret;
    if (!secret) throw new HttpError(503, "STRIPE_WEBHOOK_SECRET not set");
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
    const account = asAddress(metadata.account ?? session.client_reference_id, "metadata.account");
    const cents = Number(session.amount_total);
    if (!Number.isInteger(cents) || cents <= 0) throw new HttpError(400, "bad amount_total");
    const usdfc = usdfcForCents(cents, config.stripe.usdfcPerUsd);
    state.credits[id] = { account, cents, usdfc: usdfc.toString(), status: "pending" };
    save();
    void queueDeposit(id);
    return { received: true, credited: usdfc.toString() };
  }

  /** One dataset per account, opened by the sponsor with an FWSS-approved provider. */
  async function ensureDataset(identity: Identity, metadata: Record<string, string>): Promise<{ dataSetId: string; providerId: string; hash?: Hex }> {
    const record = recordFor(identity);
    if (!record) throw new HttpError(404, "create the account first");
    if (record.dataSetId) return { dataSetId: record.dataSetId, providerId: record.providerId ?? "" };
    const [funds] = (await pub.readContract({ address: PAY, abi: payAbi, functionName: "accounts", args: [USDFC, record.account] })) as readonly bigint[];
    if (!funds) throw new HttpError(402, "buy storage credits first");
    const account = record.account;
    const keys = Object.keys(metadata).sort();
    const values = keys.map((key) => String(metadata[key]));
    const clientDataSetId = BigInt(Date.now());
    await relayer.relay({ to: account, label: `allowDataSet ${account}`, data: encodeFunctionData({ abi: lockedAccountAbi, functionName: "allowDataSet", args: [config.providerId, clientDataSetId, keys, values] }) });
    const provider = (await getPDPProvider(pub as never, { providerId: config.providerId } as never)) as { pdp?: { serviceURL?: string }; products?: { PDP?: { data?: { serviceURL?: string } } } };
    const serviceURL = provider.pdp?.serviceURL ?? provider.products?.PDP?.data?.serviceURL;
    if (!serviceURL) throw new HttpError(502, `provider ${config.providerId} has no PDP service URL`);
    // Keyless "Nick's method" signature (r = s = 1, v = 27): its signer was authorized for exactly this message.
    const one = `0x${"0".repeat(63)}1` as Hex;
    const signature = encodePacked(["bytes32", "bytes32", "uint8"], [one, one, 27]);
    const extraData = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "string[]" }, { type: "string[]" }, { type: "bytes" }],
      [account, clientDataSetId, keys, values, signature],
    );
    const created = await createDataSetApiRequest({ serviceURL, recordKeeper: FWSS, extraData });
    const receipt = await pub.waitForTransactionReceipt({ hash: created.txHash, timeout: 10 * 60_000, pollingInterval: 5_000 });
    if (receipt.status !== "success") throw new HttpError(502, `createDataSet reverted: ${created.txHash}`);
    const log = receipt.logs.find((entry) => getAddress(entry.address) === PDP && entry.topics[1]);
    if (!log?.topics[1]) throw new HttpError(502, "createDataSet receipt has no DataSetCreated log");
    record.dataSetId = BigInt(log.topics[1]).toString();
    record.providerId = config.providerId.toString();
    record.dataSetTx = created.txHash;
    save();
    return { dataSetId: record.dataSetId, providerId: record.providerId, hash: created.txHash };
  }

  /** Relay a signed Execute, only to accounts this factory deployed (checked on chain), within the fixed policy. */
  async function relayExecute(body: Record<string, unknown>): Promise<{ hash: Hex }> {
    const account = asAddress(body.account, "account");
    if (!limits.execute.take(`execute:${account}`)) throw new HttpError(429, "rate limited");
    if (!(await pub.readContract({ address: config.factory, abi: lockedFactoryAbi, functionName: "isAccount", args: [account] }))) throw new HttpError(404, "not a sponsored account");
    const target = asAddress(body.target, "target");
    const data = String(body.data) as Hex;
    if (!isHex(data) || data.length < 10) throw new HttpError(400, "data must be calldata");
    const allowed = await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "isAllowed", args: [target, data.slice(0, 10) as Hex] });
    if (!allowed) throw new HttpError(403, `call not allowed: ${target} ${data.slice(0, 10)}`);
    if (BigInt(String(body.value ?? 0)) !== 0n) throw new HttpError(400, "value must be 0");
    const call = encodeFunctionData({
      abi: lockedAccountAbi,
      functionName: "execute",
      args: [target, 0n, data, BigInt(String(body.nonce)), BigInt(String(body.deadline)), String(body.signature) as Hex],
    });
    try {
      await pub.call({ account: relayer.address, to: account, data: call });
    } catch (error) {
      throw new HttpError(422, `execute would revert: ${(error as { shortMessage?: string }).shortMessage ?? String(error)}`);
    }
    return { hash: await relayer.send({ to: account, data: call, label: `execute ${target} ${data.slice(0, 10)}` }) };
  }

  async function readRaw(req: IncomingMessage): Promise<string> {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 256 * 1024) throw new HttpError(413, "body too large");
    }
    return raw;
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readRaw(req);
    try {
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(JSON.stringify(body));
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://sponsor");
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (req.method === "GET" && url.pathname === "/account") {
        const user = url.searchParams.get("user");
        const id = user ? `eoa:${asAddress(user, "user").toLowerCase()}` : passkeyId(asBytes32(url.searchParams.get("x"), "x"), asBytes32(url.searchParams.get("y"), "y"));
        return send(res, 200, { account: state.users[id]?.account ?? null });
      }
      if (req.method === "GET" && url.pathname === "/credits") {
        const id = url.searchParams.get("session") ?? "";
        const credit = state.credits[id];
        return send(res, 200, credit ? { status: credit.status, account: credit.account, usdfc: credit.usdfc, hash: credit.hash ?? null } : { status: state.checkouts[id] ? "awaiting-payment" : "unknown" });
      }
      if (req.method === "POST" && url.pathname === "/stripe/webhook") {
        return send(res, 200, onStripeEvent(await readRaw(req), req.headers["stripe-signature"] as string | undefined));
      }
      if (req.method === "POST" && url.pathname === "/account") {
        const body = await readJson(req);
        return send(res, 200, await ensureAccount(await authenticate("account", body, limits.setup)));
      }
      if (req.method === "POST" && url.pathname === "/checkout") {
        const body = await readJson(req);
        return send(res, 200, await checkout(await authenticate("checkout", body, limits.checkout), body));
      }
      if (req.method === "POST" && url.pathname === "/dataset") {
        const body = await readJson(req);
        const identity = await authenticate("dataset", body, limits.setup);
        const metadata = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<string, string>;
        return send(res, 200, await ensureDataset(identity, metadata));
      }
      if (req.method === "POST" && url.pathname === "/execute") return send(res, 200, await relayExecute(await readJson(req)));
      send(res, 404, { error: "not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      console.error(`[sponsor] ${req.method} ${req.url}:`, error instanceof Error ? error.message : error);
      send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Resume deposits interrupted by a restart (pending without a hash only; never resend a sent one).
  for (const [id, credit] of Object.entries(state.credits)) if (credit.status !== "done" && !credit.hash) void queueDeposit(id);

  return { server, state, relayer, config, onStripeEvent, settled: () => depositQueue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const sponsor = createSponsor(config);
  const port = Number(process.env.SPONSOR_PORT ?? 8787);
  const stripe = config.stripe.secretKey ? config.stripe.secretKey.slice(0, 8) + "…" : config.stripe.fake ? "fake (local webhook)" : "off";
  sponsor.server.listen(port, () => console.log(`[sponsor] ${config.network} ${sponsor.relayer.address} factory ${config.factory} stripe ${stripe} on :${port}`));
}
