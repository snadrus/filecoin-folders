// @vitest-environment node
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, decodeFunctionData, getAddress, hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyAuth, requestDigest } from "../sponsor/auth.js";
import { RateLimiter } from "../sponsor/ratelimit.js";
import { createSponsor, type SponsorConfig } from "../sponsor/server.js";
import { DEFAULT_PRICING, creditFor, minChargeCents, poolTopUp, pricingFromEnv, stripeFeeModelCents, usdfcForCents } from "../sponsor/pricing.js";
import { lockedFactoryAbi } from "../src/sponsored-abi.js";
import { assertStripeMode, stripeSignatureHeader, verifyStripeSignature } from "../sponsor/stripe.js";
import { derToRS, encodeContractAssertion } from "../src/passkey.js";
import { passkeySponsorSigner, sessionSponsorSigner, sponsorRequestTyped, walletSponsorSigner } from "../src/sponsored.js";

const CHAIN_ID = 314159;
const WHSEC = "whsec_test_local";
const FACTORY = getAddress("0x00000000000000000000000000000000000000fa");
const now = () => Math.floor(Date.now() / 1000);

describe("stripe webhook signatures", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  it("accepts a valid v1 signature and rejects tampering, wrong secret, staleness", () => {
    expect(() => verifyStripeSignature(payload, stripeSignatureHeader(payload, WHSEC), WHSEC)).not.toThrow();
    expect(() => verifyStripeSignature(`${payload} `, stripeSignatureHeader(payload, WHSEC), WHSEC)).toThrow(/mismatch/);
    expect(() => verifyStripeSignature(payload, stripeSignatureHeader(payload, "whsec_other"), WHSEC)).toThrow(/mismatch/);
    expect(() => verifyStripeSignature(payload, stripeSignatureHeader(payload, WHSEC, now() - 3600), WHSEC)).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(payload, undefined, WHSEC)).toThrow(/missing/);
  });
  it("pins test keys to Calibration and live keys to mainnet", () => {
    expect(() => assertStripeMode("sk_test_x", "calibration")).not.toThrow();
    expect(() => assertStripeMode("sk_live_x", "calibration")).toThrow();
    expect(() => assertStripeMode("sk_test_x", "mainnet")).toThrow();
    expect(() => assertStripeMode("sk_live_x", "mainnet")).not.toThrow();
  });
  it("converts cents to USDFC", () => {
    expect(usdfcForCents(500, "1")).toBe(5n * 10n ** 18n);
    expect(usdfcForCents(250, "0.5")).toBe(125n * 10n ** 16n);
    expect(usdfcForCents(-5, "1")).toBe(0n);
  });
});

async function passkey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const x = bytesToHex(raw.slice(1, 33));
  const y = bytesToHex(raw.slice(33, 65));
  const assert = async (challenge: Hex, opts: { type?: string } = {}) => {
    const clientDataJSON = JSON.stringify({ type: opts.type ?? "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), origin: "http://localhost" });
    const authenticatorData = new Uint8Array(37);
    authenticatorData[32] = 0x05;
    const clientHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(clientDataJSON)));
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array([...authenticatorData, ...clientHash])));
    return { authenticatorData: bytesToHex(authenticatorData), clientDataJSON, signature: bytesToHex(sig) };
  };
  return { x, y, assert };
}

describe("sponsor request auth", () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const wallet = walletSponsorSigner(user.address, (typed) => user.signTypedData(typed));
  const expiry = async () => BigInt(now() + 3600);

  it("owner wallet: binds action and body; refuses replay, tampering, staleness", async () => {
    const seen = new Map<string, number>();
    const body = { usd: 5, successUrl: "http://localhost/ok", cancelUrl: "http://localhost/no" };
    const auth = await wallet.auth(CHAIN_ID, "checkout", body);
    const identity = await verifyAuth({ chainId: CHAIN_ID, action: "checkout", body: { ...body, auth }, seen, sessionExpiry: expiry });
    expect(identity).toMatchObject({ kind: "eoa", address: user.address });
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "checkout", body: { ...body, auth }, seen, sessionExpiry: expiry })).rejects.toThrow(/replayed/);
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "checkout", body: { ...body, usd: 500, auth }, seen: new Map(), sessionExpiry: expiry })).rejects.toThrow(/bad owner/);
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "dataset", body: { ...body, auth }, seen: new Map(), sessionExpiry: expiry })).rejects.toThrow(/bad owner/);
    const typed = sponsorRequestTyped(CHAIN_ID, "account", {}, BigInt(now() - 3600));
    const stale = { kind: "eoa", address: user.address, issuedAt: typed.message.issuedAt.toString(), signature: await user.signTypedData(typed) };
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "account", body: { auth: stale }, seen, sessionExpiry: expiry })).rejects.toThrow(/stale/);
  });

  it("session key: only while the account lists it", async () => {
    const account = getAddress("0x00000000000000000000000000000000000000aa");
    const signer = sessionSponsorSigner(account, generatePrivateKey());
    const auth = await signer.auth(CHAIN_ID, "dataset", { metadata: {} });
    const ok = await verifyAuth({ chainId: CHAIN_ID, action: "dataset", body: { metadata: {}, auth }, seen: new Map(), sessionExpiry: expiry });
    expect(ok).toMatchObject({ kind: "session", account });
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "dataset", body: { metadata: {}, auth }, seen: new Map(), sessionExpiry: async () => 0n })).rejects.toThrow(/not authorized/);
  });

  it("passkey: WebAuthn assertion over the request digest", async () => {
    const key = await passkey();
    const auth = await passkeySponsorSigner(key, (challenge) => key.assert(challenge)).auth(CHAIN_ID, "account", {});
    expect(await verifyAuth({ chainId: CHAIN_ID, action: "account", body: { auth }, seen: new Map(), sessionExpiry: expiry })).toMatchObject({ kind: "passkey", x: key.x });
    const wrongType = await passkeySponsorSigner(key, (challenge) => key.assert(challenge, { type: "webauthn.create" })).auth(CHAIN_ID, "account", {});
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "account", body: { auth: wrongType }, seen: new Map(), sessionExpiry: expiry })).rejects.toThrow(/passkey/);
    const other = await passkey();
    const forged = { ...(await passkeySponsorSigner(other, (challenge) => other.assert(challenge)).auth(CHAIN_ID, "account", {})), x: key.x, y: key.y };
    await expect(verifyAuth({ chainId: CHAIN_ID, action: "account", body: { auth: forged }, seen: new Map(), sessionExpiry: expiry })).rejects.toThrow(/passkey/);
    expect(requestDigest(CHAIN_ID, "account", {}, 1n)).toBe(hashTypedData(sponsorRequestTyped(CHAIN_ID, "account", {}, 1n)));
  });
});

describe("passkey encoding", () => {
  it("normalizes DER s to low-s and finds clientDataJSON indexes", () => {
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const high = N - 5n;
    const int = (v: bigint) => {
      let hex = v.toString(16);
      if (hex.length % 2) hex = `0${hex}`;
      if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
      return [0x02, hex.length / 2, ...Buffer.from(hex, "hex")];
    };
    const body = [...int(7n), ...int(high)];
    const { r, s } = derToRS(new Uint8Array([0x30, body.length, ...body]));
    expect(BigInt(r)).toBe(7n);
    expect(BigInt(s)).toBe(5n);
    const json = '{"type":"webauthn.get","challenge":"abc","origin":"x"}';
    const encoded = encodeContractAssertion({ authenticatorData: "0x00", clientDataJSON: json, signature: `0x${"11".repeat(32)}${"22".repeat(32)}` });
    expect(encoded).toContain(json.indexOf('"challenge"').toString(16).padStart(64, "0"));
  });
});

describe("rate limiter", () => {
  it("caps calls per window", () => {
    let t = 0;
    const limiter = new RateLimiter(2, 1000, () => t);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("b")]).toEqual([true, true, false, true]);
    t = 1000;
    expect(limiter.take("a")).toBe(true);
  });
});

describe("pricing", () => {
  const E = 10n ** 16n; // USDFC per cent
  it("credit = charge − Stripe fee − $0.20 reserve − setup fee (first purchase)", () => {
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 500, feeCents: 45, first: true })).toMatchObject({ netCents: 455, creditCents: 285, creditUsdfc: 285n * E });
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 500, feeCents: 45, first: false })).toMatchObject({ creditCents: 435 });
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 305, feeCents: 39, first: true }).creditCents).toBe(96);
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 310, feeCents: 39, first: true }).creditCents).toBe(101);
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 155, feeCents: 34, first: false }).creditCents).toBe(101);
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 100, feeCents: 33, first: true }).creditCents).toBe(0);
  });
  it("minimums: charge − Stripe fee (2.9% + 30¢) ≥ $1.20, + $1.50 setup on a first purchase", () => {
    expect(DEFAULT_PRICING).toMatchObject({ minTopUpCents: 155, minFirstCents: 310, minNetCents: 120 });
    expect(stripeFeeModelCents(310)).toBe(39);
    for (let c = DEFAULT_PRICING.minTopUpCents; c <= DEFAULT_PRICING.maxCents; c += 1) expect(c - stripeFeeModelCents(c)).toBeGreaterThanOrEqual(120);
    for (let c = DEFAULT_PRICING.minFirstCents; c <= DEFAULT_PRICING.maxCents; c += 1) {
      expect(creditFor(DEFAULT_PRICING, { chargeCents: c, feeCents: stripeFeeModelCents(c), first: true }).creditCents).toBeGreaterThanOrEqual(100);
    }
    expect(minChargeCents(120, DEFAULT_PRICING, 1)).toBe(154);
    expect(minChargeCents(270, DEFAULT_PRICING, 1)).toBe(309);
    // configurable; overrides can only raise a minimum
    expect(pricingFromEnv({ SPONSOR_MIN_NET_USD: "2", SPONSOR_SETUP_FEE_USD: "1" })).toMatchObject({ minTopUpCents: 240, minFirstCents: 340 });
    expect(pricingFromEnv({ SPONSOR_MIN_FIRST_USD: "1" }).minFirstCents).toBe(310);
    expect(pricingFromEnv({ SPONSOR_MIN_FIRST_USD: "4" }).minFirstCents).toBe(400);
  });
  it("pool handover deposits only the credit above the 1 USDFC seed", () => {
    expect(poolTopUp(285n * E, 100n * E)).toBe(185n * E);
    expect(poolTopUp(96n * E, 100n * E)).toBe(0n);
  });
});

describe("sponsor server (fake chain)", () => {
  const E = 10n ** 16n;
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(opts: { pool?: number; secretKey?: string; fetch?: typeof fetch; noStripe?: boolean } = {}) {
    const sends: { label: string; to?: Address; data: Hex }[] = [];
    const factoryAccounts = new Set<string>();
    const predicted = (args: readonly unknown[]) => getAddress(keccak256(toHex(JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v)))).slice(0, 42));
    const pub = {
      async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
        if (functionName === "predict") return predicted(args!);
        if (functionName === "isAccount") return factoryAccounts.has(String(args?.[0]).toLowerCase());
        if (functionName === "allowance") return 0n;
        if (functionName === "accounts") return [10n ** 18n, 0n, 0n, 0n];
        if (functionName === "sessionSigners") return 0n;
        if (functionName === "isAllowed") return true;
        throw new Error(functionName);
      },
      async waitForTransactionReceipt({ hash }: { hash: Hex }) {
        return { status: "success", transactionHash: hash, logs: [] };
      },
      async call() {
        return { data: "0x" };
      },
    };
    let n = 0;
    const relayer = {
      name: "fake",
      address: getAddress("0x00000000000000000000000000000000000000bb"),
      sent: [] as { label: string; hash: Hex }[],
      async send(call: { label: string; to?: Address; data: Hex }) {
        sends.push(call);
        if (call.data.startsWith("0x") && call.to === FACTORY) {
          const decoded = decodeFunctionData({ abi: lockedFactoryAbi, data: call.data });
          if (decoded.functionName === "createPooled") factoryAccounts.add(predicted([getAddress(`0x${"0".repeat(40)}`), `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, ...(decoded.args as readonly unknown[])]).toLowerCase());
          if (decoded.functionName === "create") factoryAccounts.add(predicted(decoded.args as readonly unknown[]).toLowerCase());
        }
        return `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      },
      async relay(call: { label: string; to?: Address; data: Hex }) {
        const hash = await this.send(call);
        return { status: "success", transactionHash: hash } as never;
      },
    };
    let datasets = 1000;
    const opened: Address[] = [];
    const sponsor = createSponsor(
      {
        network: "calibration",
        chainId: CHAIN_ID,
        factory: FACTORY,
        providerId: 2n,
        contracts: { pay: getAddress("0x0000000000000000000000000000000000000001"), usdfc: getAddress("0x0000000000000000000000000000000000000002"), fwss: getAddress("0x0000000000000000000000000000000000000003"), pdp: getAddress("0x0000000000000000000000000000000000000004") },
        pool: { size: opts.pool ?? 0, seedUsdfc: "1" },
        stripe: opts.noStripe ? { allowedOrigins: [] } : { webhookSecret: WHSEC, ...(opts.secretKey ? { secretKey: opts.secretKey } : { fake: true }), allowedOrigins: ["http://localhost"] },
        limits: { executePerMinute: 2 },
      },
      {
        pub: pub as never,
        relayer: relayer as never,
        fetch: opts.fetch,
        openDataset: async (account) => {
          opened.push(account);
          return { dataSetId: String(++datasets), txHash: `0x${"d".repeat(64)}` as Hex };
        },
      },
    );
    await new Promise<void>((resolve) => sponsor.server.listen(0, "127.0.0.1", resolve));
    close = () => sponsor.server.close();
    const base = `http://127.0.0.1:${(sponsor.server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    const as = (signer: ReturnType<typeof walletSponsorSigner>) => async (action: string, body: Record<string, unknown>) => post(`/${action}`, { ...body, auth: await signer.auth(CHAIN_ID, action, body) });
    const pay = async (sessionId: string, identity: string, cents: number) => {
      const raw = JSON.stringify({ id: `evt_${sessionId}`, type: "checkout.session.completed", livemode: false, data: { object: { id: sessionId, payment_status: "paid", currency: "usd", amount_total: cents, metadata: { identity, factory: FACTORY } } } });
      return post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, WHSEC) });
    };
    const get = async (path: string) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    return { sponsor, sends, post, get, as, pay, opened, factoryAccounts };
  }

  const newUser = () => {
    const key = privateKeyToAccount(generatePrivateKey());
    return { key, id: `eoa:${key.address.toLowerCase()}`, signed: walletSponsorSigner(key.address, (typed) => key.signTypedData(typed)) };
  };
  const checkoutBody = (usd: number) => ({ usd, successUrl: "http://localhost/?checkout=success&session_id={CHECKOUT_SESSION_ID}", cancelUrl: "http://localhost/?checkout=cancel" });

  it("health, pool status, and a clear error while Stripe is not configured", async () => {
    const { sponsor, get, as, pay } = await start({ pool: 1, noStripe: true });
    await sponsor.refillPool();
    expect((await get("/health")).json).toMatchObject({ ok: true, network: "calibration", factory: FACTORY, stripe: { checkout: false, webhook: false }, pool: { target: 1, ready: 1 } });
    expect((await get("/pool")).json).toMatchObject({ counts: { ready: 1 }, entries: [{ status: "ready", dataSetId: "1001" }] });
    expect((await get("/pricing")).json).toMatchObject({ minFirstUsd: 3.1, minTopUpUsd: 1.55, minNetUsd: 1.2 });
    const user = newUser();
    const checkout = await as(user.signed)("checkout", checkoutBody(5));
    expect(checkout).toMatchObject({ status: 503, json: { error: expect.stringMatching(/^Stripe not configured/) } });
    expect((await pay("cs_x", user.id, 500)).status).toBe(503);
  });

  it("warm pool: first purchase hands over a ready account in one assign tx; top-up above the 1 USDFC seed", async () => {
    const { sponsor, sends, post, as, pay, opened } = await start({ pool: 1 });
    await sponsor.refillPool();
    const [pooled] = Object.values(sponsor.state.pool);
    expect(pooled).toMatchObject({ status: "ready", dataSetId: "1001" });
    expect(sends.map((s) => s.label.split(" ")[0])).toEqual(["pool", "USDFC", "pool"]); // createPooled, approve, seed

    const user = newUser();
    expect((await post("/checkout", checkoutBody(5))).status).toBe(401);
    const forged = await user.signed.auth(CHAIN_ID, "checkout", checkoutBody(5));
    expect((await post("/checkout", { ...checkoutBody(5), auth: { ...forged, signature: `0x${"11".repeat(65)}` } })).status).toBe(401); // malformed, not 500
    expect((await as(user.signed)("checkout", checkoutBody(3.09))).status).toBe(400); // first-purchase minimum $3.10
    const checkout = await as(user.signed)("checkout", checkoutBody(5));
    expect(checkout.json).toMatchObject({ first: true });
    const sessionId = String(checkout.json.id);

    const before = sends.length;
    expect((await pay(sessionId, user.id, 500)).json).toMatchObject({ credited: (285n * E).toString() }); // 500 − 45 fee − 20 − 150
    expect((await pay(sessionId, user.id, 500)).json).toMatchObject({ duplicate: true });
    await sponsor.settled();
    const assigns = sends.slice(before).filter((s) => s.label.startsWith("assign"));
    expect(assigns).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: lockedFactoryAbi, data: assigns[0]!.data });
    expect(decoded.args).toEqual([pooled!.account, user.key.address, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 185n * E]);
    expect(sponsor.state.credits[sessionId]).toMatchObject({ status: "done", path: "pool", depositUsdfc: (185n * E).toString(), feeCents: 45, setupCents: 150, reserveCents: 20 });
    expect(sponsor.state.users[user.id]).toMatchObject({ account: pooled!.account, dataSetId: "1001", via: "pool" });
    expect(sponsor.state.pool[pooled!.account]!.status).toBe("assigned");

    await sponsor.refillPool(); // refilled in the background after the handover
    expect(Object.values(sponsor.state.pool).filter((e) => e.status === "ready")).toHaveLength(1);
    expect(opened).toHaveLength(2);

    // Top-up: no setup fee, minimum $1.55, plain deposit.
    expect((await as(user.signed)("checkout", checkoutBody(1.54))).status).toBe(400);
    const topUp = await as(user.signed)("checkout", checkoutBody(1.55));
    expect(topUp.json).toMatchObject({ first: false });
    await pay(String(topUp.json.id), user.id, 155);
    await sponsor.settled();
    expect(sponsor.state.credits[String(topUp.json.id)]).toMatchObject({ status: "done", path: "topup", creditCents: 101 });
  });

  it("warm pool: a credit under 1 USDFC still hands over the account, without a top-up", async () => {
    const { sponsor, sends, as, pay } = await start({ pool: 1 });
    await sponsor.refillPool();
    await sponsor.refillPool(); // no-op on a full pool must not block later refills
    const user = newUser();
    const checkout = await as(user.signed)("checkout", checkoutBody(3.1));
    await pay(String(checkout.json.id), user.id, 305); // e.g. a higher-fee card left less than the modelled net
    await sponsor.settled();
    const assign = sends.find((s) => s.label.startsWith("assign"))!;
    expect(decodeFunctionData({ abi: lockedFactoryAbi, data: assign.data }).args[4]).toBe(0n);
    expect(sponsor.state.credits[String(checkout.json.id)]).toMatchObject({ path: "pool", creditCents: 96, usdfc: (100n * E).toString(), depositUsdfc: "0" });
    await sponsor.refillPool();
    expect(Object.values(sponsor.state.pool).filter((e) => e.status === "ready")).toHaveLength(1);
  });

  it("empty pool: slow path creates, funds, and opens a dataset", async () => {
    const { sponsor, sends, as, pay, opened } = await start({ pool: 0 });
    const user = newUser();
    const checkout = await as(user.signed)("checkout", checkoutBody(5));
    await pay(String(checkout.json.id), user.id, 500);
    await sponsor.settled();
    expect(sends.map((s) => s.label.split(" ")[0])).toEqual(["create", "USDFC", "credit"]);
    expect(opened).toHaveLength(1);
    expect(sponsor.state.users[user.id]).toMatchObject({ via: "create", dataSetId: "1001" });
    expect(sponsor.state.credits[String(checkout.json.id)]).toMatchObject({ path: "create", depositUsdfc: (285n * E).toString() });
  });

  it("real Stripe keys: fee comes from the charge's balance transaction", async () => {
    const calls: string[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "cs_test_real", url: "https://checkout.stripe.com/c/pay/cs_test_real" }));
      return new Response(JSON.stringify({ id: "cs_test_real", payment_intent: { latest_charge: { balance_transaction: { fee: 175, currency: "usd" } } } }));
    }) as typeof fetch;
    const { sponsor, as, pay } = await start({ pool: 0, secretKey: "sk_test_x", fetch: fetchMock });
    const user = newUser();
    const checkout = await as(user.signed)("checkout", checkoutBody(10));
    expect(checkout.json).toMatchObject({ id: "cs_test_real", first: true });
    expect(calls[0]).toBe("POST https://api.stripe.com/v1/checkout/sessions");
    await pay("cs_test_real", user.id, 1000);
    await sponsor.settled();
    expect(calls[1]).toContain("expand[]=payment_intent.latest_charge.balance_transaction");
    expect(sponsor.state.credits.cs_test_real).toMatchObject({ feeCents: 175, netCents: 825, creditCents: 655 });
  });

  it("relays only to factory accounts, rate limited per account", async () => {
    const { sponsor, post } = await start({ pool: 1 });
    await sponsor.refillPool();
    const account = Object.values(sponsor.state.pool)[0]!.account;
    const exec = (to: Address) => ({ account: to, target: to, value: "0", data: "0x12345678", nonce: "0", deadline: String(now() + 60), signature: "0x" });
    expect((await post("/execute", exec(getAddress("0x00000000000000000000000000000000000000cc")))).status).toBe(404);
    expect((await post("/execute", exec(account))).status).toBe(200);
    expect((await post("/execute", exec(account))).status).toBe(200);
    expect((await post("/execute", exec(account))).status).toBe(429);
  });

  it("refuses fake Stripe and test keys on mainnet", () => {
    const base = { network: "mainnet", chainId: 314, factory: FACTORY, providerId: 1n, contracts: { pay: FACTORY, usdfc: FACTORY, fwss: FACTORY, pdp: FACTORY } } as const;
    expect(() => createSponsor({ ...base, stripe: { fake: true, allowedOrigins: [] } }, { pub: {} as never, relayer: {} as never })).toThrow();
    expect(() => createSponsor({ ...base, stripe: { secretKey: "sk_test_x", webhookSecret: WHSEC, allowedOrigins: ["https://x"] } }, { pub: {} as never, relayer: {} as never })).toThrow(/live key/);
  });
});
