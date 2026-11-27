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
  it("credit = charge − Stripe fee − $1.00 reserve − $1.50 creation fee (first purchase), at least 1 USDFC", () => {
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 1000, feeCents: 59, first: true })).toMatchObject({ netCents: 941, reserveCents: 100, setupCents: 150, creditCents: 691, creditUsdfc: 691n * E });
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 500, feeCents: 45, first: true })).toMatchObject({ creditCents: 205 }); // $5 still ≥ 1 USDFC
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 500, feeCents: 45, first: false })).toMatchObject({ reserveCents: 100, setupCents: 0, creditCents: 355 });
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 391, feeCents: 41, first: true }).creditCents).toBe(100);
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 237, feeCents: 37, first: false }).creditCents).toBe(100);
    // A pricier card (fee above the model) still credits 1 USDFC; the shortfall comes out of the reserve.
    expect(creditFor(DEFAULT_PRICING, { chargeCents: 391, feeCents: 50, first: true })).toMatchObject({ creditCents: 100, reserveCents: 91, setupCents: 150 });
  });
  it("minimums (exact): charge − Stripe fee (2.9% + 30¢) ≥ $2.00, + $1.50 creation fee on a first purchase", () => {
    expect(DEFAULT_PRICING).toMatchObject({ minTopUpCents: 237, minFirstCents: 391, minNetCents: 200, reserveCents: 100, minCreditCents: 100, suggestedCents: 1000 });
    expect(236 - stripeFeeModelCents(236)).toBe(199);
    expect(390 - stripeFeeModelCents(390) - 150).toBe(199);
    for (let c = DEFAULT_PRICING.minTopUpCents; c <= DEFAULT_PRICING.maxCents; c += 1) expect(c - stripeFeeModelCents(c)).toBeGreaterThanOrEqual(200);
    for (let c = DEFAULT_PRICING.minFirstCents; c <= DEFAULT_PRICING.maxCents; c += 1) {
      const q = creditFor(DEFAULT_PRICING, { chargeCents: c, feeCents: stripeFeeModelCents(c), first: true });
      expect(q.creditCents).toBeGreaterThanOrEqual(100);
      expect(q.reserveCents + q.setupCents).toBe(250); // reserve + creation fee stay whole at the modelled fee
    }
    // configurable; overrides can only raise a minimum
    expect(pricingFromEnv({ SPONSOR_RESERVE_USD: "0.20" })).toMatchObject({ minNetCents: 120, minTopUpCents: 154, minFirstCents: 309 });
    expect(pricingFromEnv({ SPONSOR_MIN_FIRST_USD: "1" }).minFirstCents).toBe(391);
    expect(pricingFromEnv({ SPONSOR_MIN_FIRST_USD: "4" }).minFirstCents).toBe(400);
    expect(pricingFromEnv({ SPONSOR_SUGGESTED_USD: "20" }).suggestedCents).toBe(2000);
    expect(pricingFromEnv({})).toEqual(DEFAULT_PRICING);
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

  async function start(opts: { pool?: number; secretKey?: string; fetch?: typeof fetch; noStripe?: boolean; poolCare?: { minRunwayDays?: number; topUpMonths?: number; maxAgeDays?: number } } = {}) {
    const sends: { label: string; to?: Address; data: Hex }[] = [];
    const sponsorUsdfc = { value: 10n ** 24n };
    const sponsorFil = { value: 10n ** 20n };
    const payAccounts = new Map<string, readonly [bigint, bigint, bigint, bigint]>();
    const terminated: { account: string; dataSetId: string }[] = [];
    const clock = { value: Date.now() };
    const onChainUnassigned = new Map<string, boolean>();
    const droppedReceipts = new Set<string>();
    const revertedReceipts = new Set<string>();
    const blockTxs: string[] = [];
    const receiptsHidden = { value: false };
    const factoryAccounts = new Set<string>();
    const block = { number: 1000n, hash: (`0x${"ab".repeat(32)}`) as Hex };
    const holdInclusion = { value: false };
    const predicted = (args: readonly unknown[]) => getAddress(keccak256(toHex(JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v)))).slice(0, 42));
    const pub = {
      async readContract({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address?: Address }) {
        if (functionName === "predict") return predicted(args!);
        if (functionName === "isAccount") return factoryAccounts.has(String(args?.[0]).toLowerCase());
        if (functionName === "allowance") return 0n;
        if (functionName === "accounts") {
          const owner = String(args?.[1] ?? args?.[0] ?? "").toLowerCase();
          return payAccounts.get(owner) ?? [10n ** 18n, 0n, 0n, 0n];
        }
        if (functionName === "sessionSigners") return 0n;
        if (functionName === "isAllowed") return true;
        if (functionName === "balanceOf") return sponsorUsdfc.value;
        if (functionName === "FACTORY") return FACTORY;
        if (functionName === "admin" || functionName === "treasury") return getAddress("0x00000000000000000000000000000000000000bb");
        if (functionName === "unassigned") return onChainUnassigned.get(String(address).toLowerCase()) ?? true;
        throw new Error(functionName);
      },
      async getBalance() {
        return sponsorFil.value;
      },
      async getTransactionReceipt({ hash }: { hash: Hex }) {
        if (receiptsHidden.value || droppedReceipts.has(hash.toLowerCase())) throw new Error("not found");
        if (revertedReceipts.has(hash.toLowerCase())) return { status: "reverted", transactionHash: hash, logs: [], blockNumber: block.number, blockHash: block.hash };
        return { status: "success", transactionHash: hash, logs: [], blockNumber: block.number, blockHash: block.hash };
      },
      async getBlockNumber() {
        return block.number;
      },
      async getBlock(args?: { blockTag?: string }) {
        if (args?.blockTag === "finalized" || args?.blockTag === "safe") {
          return { number: 0n, hash: (`0x${"00".repeat(32)}`) as Hex, transactions: [] };
        }
        return { number: block.number, hash: block.hash, transactions: blockTxs.slice() };
      },
      async call() {
        return { data: "0x" };
      },
      async estimateGas() {
        return 21_000n;
      },
      async estimateFeesPerGas() {
        return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: 1n };
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
        const sentHash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
        if (!holdInclusion.value) blockTxs.push(sentHash);
        return sentHash;
      },
      async replace(hash: Hex) {
        const next = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
        const idx = blockTxs.findIndex((item) => item.toLowerCase() === hash.toLowerCase());
        if (idx >= 0) blockTxs.splice(idx, 1, next);
        else if (!holdInclusion.value) blockTxs.push(next);
        return next;
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
        poolCare: { minRunwayDays: 0, topUpMonths: 3, maxAgeDays: 0, ...opts.poolCare },
        stripe: opts.noStripe ? { allowedOrigins: [] } : { webhookSecret: WHSEC, ...(opts.secretKey ? { secretKey: opts.secretKey } : { fake: true }), allowedOrigins: ["http://localhost"] },
        limits: { executePerMinute: 2 },
      },
      {
        pub: pub as never,
        relayer: relayer as never,
        fetch: opts.fetch,
        now: () => clock.value,
        openDataset: async (account) => {
          opened.push(account);
          return { dataSetId: String(++datasets), txHash: `0x${"d".repeat(64)}` as Hex };
        },
        terminatePoolDataset: async (account, dataSetId) => {
          terminated.push({ account, dataSetId });
          return { hash: `0x${"e".repeat(64)}` as Hex };
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
      const raw = JSON.stringify({ id: `evt_${sessionId}`, type: "checkout.session.completed", livemode: false, data: { object: { id: sessionId, payment_status: "paid", currency: "usd", amount_total: cents, payment_intent: `pi_${sessionId}`, metadata: { identity, factory: FACTORY } } } });
      return post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, WHSEC) });
    };
    const get = async (path: string) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    return { sponsor, sends, post, get, as, pay, opened, factoryAccounts, sponsorUsdfc, sponsorFil, payAccounts, terminated, clock, onChainUnassigned, droppedReceipts, revertedReceipts, receiptsHidden, blockTxs, block, holdInclusion, relayer };
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
    expect((await get("/pricing")).json).toMatchObject({ minFirstUsd: 3.91, minTopUpUsd: 2.37, minNetUsd: 2, reserveUsd: 1, setupFeeUsd: 1.5, minCreditUsd: 1, suggestedUsd: 10 });
    const user = newUser();
    const checkout = await as(user.signed)("checkout", checkoutBody(5));
    expect(checkout).toMatchObject({ status: 503, json: { error: expect.stringMatching(/^Stripe not configured/) } });
    expect((await pay("cs_x", user.id, 500)).status).toBe(503);
  });

  it("refuses card payments the sponsor wallet could not honor", async () => {
    const { as, sponsorUsdfc, sponsor } = await start({ pool: 0 });
    const user = newUser();
    sponsorUsdfc.value = 2n * 10n ** 18n; // 2 USDFC < $5 − $1.50 creation − $1.00 reserve
    expect(await as(user.signed)("checkout", checkoutBody(5))).toMatchObject({ status: 503, json: { error: expect.stringMatching(/temporarily unavailable.*not been charged/) } });
    expect(Object.keys(sponsor.state.checkouts)).toHaveLength(0);
    sponsorUsdfc.value = 25n * 10n ** 17n;
    expect((await as(user.signed)("checkout", checkoutBody(4.99))).status).toBe(200); // a fresh request (no replay)
  });

  it("warm pool: first purchase hands over a ready account in one assign tx; top-up above the 1 USDFC seed", async () => {
    const { sponsor, sends, post, get, as, pay, opened } = await start({ pool: 1 });
    await sponsor.refillPool();
    const [pooled] = Object.values(sponsor.state.pool);
    expect(pooled).toMatchObject({ status: "ready", dataSetId: "1001" });
    expect(sends.map((s) => s.label.split(" ")[0])).toEqual(["pool", "USDFC", "pool"]); // createPooled, approve, seed

    const user = newUser();
    expect((await post("/checkout", checkoutBody(5))).status).toBe(401);
    const forged = await user.signed.auth(CHAIN_ID, "checkout", checkoutBody(5));
    expect((await post("/checkout", { ...checkoutBody(5), auth: { ...forged, signature: `0x${"11".repeat(65)}` } })).status).toBe(401); // malformed, not 500
    expect((await as(user.signed)("checkout", checkoutBody(3.9))).status).toBe(400); // first-purchase minimum $3.91
    const checkout = await as(user.signed)("checkout", checkoutBody(5));
    expect(checkout.json).toMatchObject({ first: true });
    const sessionId = String(checkout.json.id);

    const before = sends.length;
    expect((await pay(sessionId, user.id, 500)).json).toMatchObject({ credited: (205n * E).toString() }); // 500 − 45 fee − 100 − 150
    expect((await pay(sessionId, user.id, 500)).json).toMatchObject({ duplicate: true });
    await sponsor.settled();
    const assigns = sends.slice(before).filter((s) => s.label.startsWith("assign"));
    expect(assigns).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: lockedFactoryAbi, data: assigns[0]!.data });
    expect(decoded.args).toEqual([pooled!.account, user.key.address, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 105n * E]);
    expect(sponsor.state.credits[sessionId]).toMatchObject({ status: "done", path: "pool", depositUsdfc: (105n * E).toString(), feeCents: 45, setupCents: 150, reserveCents: 100 });
    expect(sponsor.state.users[user.id]).toMatchObject({ account: pooled!.account, dataSetId: "1001", via: "pool" });
    expect(sponsor.state.pool[pooled!.account]!.status).toBe("assigned");

    await sponsor.refillPool(); // refilled in the background after the handover
    expect(Object.values(sponsor.state.pool).filter((e) => e.status === "ready")).toHaveLength(1);
    expect(opened).toHaveLength(2);

    // Top-up: no creation fee, minimum $2.37, plain deposit.
    expect((await as(user.signed)("checkout", checkoutBody(2.36))).status).toBe(400);
    const topUp = await as(user.signed)("checkout", checkoutBody(2.37));
    expect(topUp.json).toMatchObject({ first: false });
    await pay(String(topUp.json.id), user.id, 237);
    await sponsor.settled();
    expect(sponsor.state.credits[String(topUp.json.id)]).toMatchObject({ status: "done", path: "topup", creditCents: 100, reserveCents: 100, setupCents: 0 });
    // Ledger: reserve + creation fee owed to the sponsor.
    expect((await get("/status")).json).toMatchObject({ ledger: { purchases: 2, firstPurchases: 1, reserveUsd: 2, creationFeesUsd: 1.5, owedToSponsorUsd: 3.5 } });
  });

  it("warm pool: a minimum (1 USDFC) credit hands over the account without a top-up", async () => {
    const { sponsor, sends, as, pay } = await start({ pool: 1 });
    await sponsor.refillPool();
    await sponsor.refillPool(); // no-op on a full pool must not block later refills
    const user = newUser();
    const checkout = await as(user.signed)("checkout", checkoutBody(3.91));
    await pay(String(checkout.json.id), user.id, 391);
    await sponsor.settled();
    const assign = sends.find((s) => s.label.startsWith("assign"))!;
    expect(decodeFunctionData({ abi: lockedFactoryAbi, data: assign.data }).args[4]).toBe(0n);
    expect(sponsor.state.credits[String(checkout.json.id)]).toMatchObject({ path: "pool", creditCents: 100, usdfc: (100n * E).toString(), depositUsdfc: "0" });
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
    expect(sponsor.state.credits[String(checkout.json.id)]).toMatchObject({ path: "create", depositUsdfc: (205n * E).toString() });
  });

  it("a first purchase from a ready pool account needs only the USDFC above its seed", async () => {
    const { as, sponsor, sponsorUsdfc } = await start({ pool: 1 });
    await sponsor.refillPool();
    sponsorUsdfc.value = 16n * 10n ** 17n; // 1.6 USDFC: enough for $5 − $2.50 − 1 USDFC seed, not for $2.50 outright
    expect((await as(newUser().signed)("checkout", checkoutBody(5))).status).toBe(200);
    sponsorUsdfc.value = 14n * 10n ** 17n;
    expect((await as(newUser().signed)("checkout", checkoutBody(5))).status).toBe(503);
  });

  it("trims ready accounts above the pool target back to the sponsor, never one being handed over", async () => {
    const { sponsor, sends, as, pay } = await start({ pool: 2 });
    await sponsor.refillPool();
    // Three extra ready accounts, as after lowering SPONSOR_POOL_SIZE from 5 to 2.
    const template = Object.values(sponsor.state.pool)[0]!;
    for (const i of [1, 2, 3]) {
      const account = getAddress(`0x${String(i).repeat(40)}`);
      sponsor.state.pool[account] = { ...template, account, hashes: [] };
    }
    expect(sponsor.poolStatus().counts).toMatchObject({ target: 2, ready: 5 });
    // A purchase races the trim: it must get a ready account that is not being swept.
    const user = newUser();
    const trimming = sponsor.trimPool();
    await as(user.signed)("checkout", checkoutBody(5));
    await pay("cs_trim_race", user.id, 500);
    const trimmed = await trimming;
    await sponsor.settled();
    const assigned = sponsor.state.credits.cs_trim_race!.account!;
    const swept = trimmed.filter((t) => t.outcome === "swept").map((t) => t.account);
    expect(swept).not.toContain(assigned);
    expect(sends.filter((s) => s.label.startsWith("sweep ")).map((s) => s.label.slice(6))).toEqual(swept);
    for (const account of swept) expect(sponsor.state.pool[account]).toMatchObject({ status: "retired", error: "trimmed: pool above target" });
    await sponsor.trimPool(); // idempotent once at target
    expect(Object.values(sponsor.state.pool).filter((e) => e.status === "ready").length).toBeLessThanOrEqual(2);
    expect(Object.values(sponsor.state.pool).some((e) => e.status === "trimming")).toBe(false);
  });

  it("trims ready accounts from a previous factory so the pool can refill on the current one", async () => {
    const { sponsor } = await start({ pool: 2 });
    await sponsor.refillPool();
    const ready = Object.values(sponsor.state.pool).filter((e) => e.status === "ready");
    expect(ready.length).toBe(2);
    const old = getAddress(`0x${"11".repeat(20)}`);
    for (const entry of ready) entry.factory = old;
    sponsor.config.legacyFactory = old;
    const trimmed = await sponsor.trimPool();
    expect(trimmed).toHaveLength(2);
    for (const entry of ready) {
      expect(sponsor.state.pool[entry.account]).toMatchObject({ status: "retired", error: "trimmed: not on current factory" });
    }
  });

  it("reconciles a pool account stuck in 'assigning' from the chain", async () => {
    const { sponsor, onChainUnassigned } = await start({ pool: 2 });
    await sponsor.refillPool();
    const [landed, lost] = Object.values(sponsor.state.pool);
    const user = newUser();
    Object.assign(landed!, { status: "assigning", assignedTo: user.id });
    Object.assign(lost!, { status: "assigning", assignedTo: newUser().id });
    sponsor.state.credits.cs_stuck = { identity: user.id, chargeCents: 500, feeCents: 45, netCents: 455, reserveCents: 20, setupCents: 150, creditCents: 285, usdfc: "2850000000000000000", depositUsdfc: "0", path: "pool", status: "failed", hashes: [], error: "null round" };
    onChainUnassigned.set(landed!.account.toLowerCase(), false);
    onChainUnassigned.set(lost!.account.toLowerCase(), true);
    const out = await sponsor.reconcileAssigning();
    expect(out).toHaveLength(2);
    expect(sponsor.state.pool[landed!.account]!.status).toBe("assigned");
    expect(sponsor.state.credits.cs_stuck).toMatchObject({ status: "done", account: landed!.account });
    expect(sponsor.state.users[user.id]).toMatchObject({ account: landed!.account, via: "pool" });
    expect(sponsor.state.pool[lost!.account]).toMatchObject({ status: "ready" });
    expect(sponsor.state.pool[lost!.account]!.assignedTo).toBeUndefined();
  });

  it("paid while the sponsor ran dry: parked without sending, shown on /status, delivered by cron once funded", async () => {
    const { sponsor, sends, as, pay, get, sponsorUsdfc } = await start({ pool: 0 });
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    sponsorUsdfc.value = 10n ** 17n; // drained between checkout and payment (race)
    await pay("cs_race", user.id, 500);
    await sponsor.settled();
    expect(sponsor.state.credits.cs_race).toMatchObject({ status: "awaiting-funds", paymentIntent: "pi_cs_race", hashes: [] });
    expect(sends).toHaveLength(0);
    const status = (await get("/status")).json as { funds: { level: string }; checkoutOpen: boolean; credits: Record<string, number>; pool: { target: number } };
    expect(status).toMatchObject({ funds: { level: "empty" }, checkoutOpen: false, credits: { "awaiting-funds": 1 }, pool: { target: 0 } });
    expect((await get("/health")).json).toMatchObject({ ok: true, funds: "empty", warnings: expect.arrayContaining([expect.stringMatching(/awaiting sponsor funds/)]) });
    expect((await sponsor.retryAwaiting()).retried).toEqual([]); // still short: stays parked
    expect(sponsor.state.credits.cs_race!.status).toBe("awaiting-funds");
    sponsorUsdfc.value = 10n ** 21n;
    expect((await sponsor.cronTick()).credits.retried).toEqual(["cs_race"]);
    expect(sponsor.state.credits.cs_race).toMatchObject({ status: "done", path: "create" });
    expect((await get("/status")).json).toMatchObject({ funds: { level: "ok" }, checkoutOpen: true, credits: { done: 1 } });
  });

  it("refunds a parked credit through Stripe after refundAfterHours (default 24h)", async () => {
    const calls: { url: string; body?: string; key?: string | null }[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? String(init.body) : undefined, key: new Headers(init?.headers).get("idempotency-key") });
      if (url.endsWith("/v1/refunds")) return new Response(JSON.stringify({ id: "re_1", status: "succeeded" }));
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "cs_test_late", url: "https://checkout.stripe.com/c/pay/cs_test_late" }));
      return new Response(JSON.stringify({ id: "cs_test_late", payment_intent: { latest_charge: { balance_transaction: { fee: 45, currency: "usd" } } } }));
    }) as typeof fetch;
    const { sponsor, as, pay, sponsorUsdfc, clock } = await start({ pool: 0, secretKey: "sk_test_x", fetch: fetchMock });
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    sponsorUsdfc.value = 0n;
    await pay("cs_test_late", user.id, 500);
    await sponsor.settled();
    expect(sponsor.state.credits.cs_test_late!.status).toBe("awaiting-funds");
    clock.value += 23 * 3600_000;
    expect(await sponsor.retryAwaiting()).toMatchObject({ refunded: [] });
    clock.value += 2 * 3600_000;
    expect(await sponsor.retryAwaiting()).toMatchObject({ refunded: ["cs_test_late"] });
    expect(sponsor.state.credits.cs_test_late).toMatchObject({ status: "refunded", refundId: "re_1" });
    const refund = calls.find((c) => c.url.endsWith("/v1/refunds"))!;
    expect(refund.body).toContain("payment_intent=pi_cs_test_late");
    expect(refund.key).toBe("refund-cs_test_late");
    expect(await sponsor.retryAwaiting()).toMatchObject({ refunded: [], retried: [] }); // once
  });

  it("pool refill pauses rather than spending owed USDFC", async () => {
    const { sponsor, sends, sponsorUsdfc } = await start({ pool: 3 });
    sponsorUsdfc.value = 5n * 10n ** 17n; // 0.5 USDFC < 1 USDFC seed
    await sponsor.refillPool();
    expect(sends).toHaveLength(0);
    sponsorUsdfc.value = 10n ** 21n;
    await sponsor.refillPool();
    expect(sponsor.poolStatus().counts).toMatchObject({ target: 3, ready: 3 });
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
    expect(sponsor.state.credits.cs_test_real).toMatchObject({ feeCents: 175, netCents: 825, creditCents: 575 });
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

  it("payment_intent.succeeded starts the handover (same credit as the checkout session)", async () => {
    const { sponsor, post, as, get } = await start({ pool: 1 });
    await sponsor.refillPool();
    const user = newUser();
    const checkout = await as(user.signed)("checkout", { ...checkoutBody(5), sessionKey: user.key.address, sessionExpiry: String(now() + 86400) });
    expect(checkout.status).toBe(200);
    const sessionId = String(checkout.json.id);
    const raw = JSON.stringify({
      id: "evt_pi_1",
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: { id: "pi_pi_1", amount: 500, currency: "usd", status: "succeeded", metadata: { identity: user.id, factory: FACTORY, session: sessionId, sessionKey: user.key.address, sessionExpiry: String(now() + 86400) } } },
    });
    const hook = await post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, WHSEC) });
    expect(hook.status).toBe(200);
    expect(hook.json).toMatchObject({ received: true });
    await sponsor.settled();
    await sponsor.checkHandoverFinality();
    expect(sponsor.state.credits[sessionId]).toMatchObject({ status: "done", path: "pool", sessionKey: user.key.address });
    expect(["included", "finalized"]).toContain(sponsor.state.credits[sessionId]!.finality);
    expect((await get(`/credits?session=${sessionId}`)).json).toMatchObject({ status: "done", account: expect.any(String) });
    const again = await post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, WHSEC) });
    expect(again.json).toMatchObject({ received: true, duplicate: true });
  });

  it("flips a credit back to pending when its handover receipt was dropped", async () => {
    const { sponsor, as, pay, get, droppedReceipts, onChainUnassigned, blockTxs, block } = await start({ pool: 1 });
    await sponsor.refillPool();
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    await pay("cs_drop", user.id, 500);
    await sponsor.settled();
    await sponsor.checkHandoverFinality();
    const credit = sponsor.state.credits.cs_drop!;
    expect(credit.status).toBe("done");
    expect(credit.finality).toBe("included");
    expect(credit.inclusion?.length).toBeGreaterThan(0);
    const account = credit.account!;
    const hash = credit.inclusion![0]!.hash;
    droppedReceipts.add(hash.toLowerCase());
    const idx = blockTxs.indexOf(hash);
    if (idx >= 0) blockTxs.splice(idx, 1);
    block.hash = `0x${"cd".repeat(32)}` as typeof block.hash;
    onChainUnassigned.set(account.toLowerCase(), true);
    const tick = await sponsor.cronTick();
    expect(tick.finality.dropped).toContain("cs_drop");
    const after = sponsor.state.credits.cs_drop!;
    if (tick.finality.resubmitted.includes("cs_drop") || tick.finality.rebroadcast.includes("cs_drop") || (after.status === "done" && after.hash !== hash)) {
      expect(after.status).toBe("done");
      expect(after.hash).not.toBe(hash);
    } else {
      expect(after.status).toBe("pending");
      expect(after.account).toBeUndefined();
      expect((await get("/credits?session=cs_drop")).json).toMatchObject({ status: "pending" });
    }
  });

  it("marks a credit ready when the assign tx is in a new head before a receipt exists", async () => {
    const { sponsor, as, pay, get, receiptsHidden, blockTxs } = await start({ pool: 1 });
    await sponsor.refillPool();
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    receiptsHidden.value = true;
    await pay("cs_head", user.id, 500);
    await sponsor.settled();
    await sponsor.checkHandoverFinality();
    const credit = sponsor.state.credits.cs_head!;
    expect(credit.status).toBe("done");
    expect(credit.finality).toBe("included");
    expect(credit.inclusion?.length).toBeGreaterThan(0);
    expect(blockTxs.length).toBeGreaterThan(0);
    expect((await get("/credits?session=cs_head")).json).toMatchObject({ status: "done", account: expect.any(String), finality: "included" });
    receiptsHidden.value = false;
  });

  it("flips a credit back to pending when the assign receipt reverts after optimistic ready", async () => {
    const { sponsor, as, pay, get, receiptsHidden, revertedReceipts, onChainUnassigned } = await start({ pool: 1 });
    await sponsor.refillPool();
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    receiptsHidden.value = true;
    await pay("cs_revert", user.id, 500);
    await sponsor.settled();
    await sponsor.checkHandoverFinality();
    const credit = sponsor.state.credits.cs_revert!;
    expect(credit.status).toBe("done");
    const account = credit.account!;
    const hash = credit.inclusion![0]!.hash;
    receiptsHidden.value = false;
    revertedReceipts.add(hash.toLowerCase());
    onChainUnassigned.set(account.toLowerCase(), true);
    // Background confirmer may unwind first; cron still catches it if not.
    await new Promise((r) => setTimeout(r, 20));
    let tick = { finality: { reverted: [] as string[], dropped: [] as string[], resubmitted: [] as string[] } };
    const mid = sponsor.state.credits.cs_revert!;
    if (mid.status === "done") tick = await sponsor.cronTick();
    const after = sponsor.state.credits.cs_revert!;
    const caught = tick.finality.reverted.includes("cs_revert") || /reverted/i.test(after.error ?? "");
    expect(caught).toBe(true);
    if (tick.finality.resubmitted.includes("cs_revert") || (after.status === "done" && after.hash !== hash)) {
      expect(after.status).toBe("done");
      expect(after.hash).not.toBe(hash);
    } else {
      expect(after.status).toBe("pending");
      expect(after.account).toBeUndefined();
      expect((await get("/credits?session=cs_revert")).json).toMatchObject({ status: "pending" });
    }
  });

  it("marks a credit usable as soon as prepareSession + assign are broadcast", async () => {
    const { sponsor, as, pay, get, receiptsHidden, holdInclusion } = await start({ pool: 1 });
    await sponsor.refillPool();
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    receiptsHidden.value = true;
    holdInclusion.value = true;
    await pay("cs_sent", user.id, 500);
    await sponsor.settled();
    const credit = sponsor.state.credits.cs_sent!;
    expect(credit.status).toBe("done");
    expect(credit.finality).toBe("sent");
    expect(credit.account).toBeTruthy();
    expect((await get("/credits?session=cs_sent")).json).toMatchObject({ status: "done", account: expect.any(String), finality: "sent" });
  });

  it("rebroadcasts a handover that is not included within N epochs", async () => {
    const { sponsor, as, pay, receiptsHidden, holdInclusion, block } = await start({ pool: 1 });
    await sponsor.refillPool();
    const user = newUser();
    expect((await as(user.signed)("checkout", checkoutBody(5))).status).toBe(200);
    receiptsHidden.value = true;
    holdInclusion.value = true;
    await pay("cs_rebroadcast", user.id, 500);
    await sponsor.settled();
    const credit = sponsor.state.credits.cs_rebroadcast!;
    expect(credit.finality).toBe("sent");
    const hash = credit.hash;
    block.number += 2n;
    holdInclusion.value = false;
    const tick = await sponsor.cronTick();
    expect(tick.finality.rebroadcast).toContain("cs_rebroadcast");
    const after = sponsor.state.credits.cs_rebroadcast!;
    expect(after.hash).toBeTruthy();
    expect(after.hash).not.toBe(hash);
  });

  it("reports runway for ready pool spares on /status", async () => {
    const { sponsor, get, payAccounts } = await start({ pool: 1, poolCare: { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 } });
    await sponsor.refillPool();
    const account = Object.values(sponsor.state.pool).find((e) => e.status === "ready")!.account;
    const rate = 10n ** 18n / 86_400n; // 1 USDFC / 30-day month
    payAccounts.set(account.toLowerCase(), [10n ** 18n, 0n, rate, 1000n]);
    const body = (await get("/status")).json as { pool: { ready: number; spares?: { account: string; runwayDays: number; availableUsdfc: string }[] } };
    expect(body.pool.ready).toBe(1);
    expect(body.pool.spares).toEqual(expect.arrayContaining([expect.objectContaining({ account, runwayDays: 30, availableUsdfc: "1" })]));
  });

  it("tops up a ready spare when Filecoin Pay runway is below the threshold", async () => {
    const { sponsor, sends, payAccounts } = await start({ pool: 1, poolCare: { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 } });
    await sponsor.refillPool();
    const account = Object.values(sponsor.state.pool).find((e) => e.status === "ready")!.account;
    const rate = 10n ** 18n / 86_400n;
    payAccounts.set(account.toLowerCase(), [10n ** 18n, 0n, rate, 1000n]);
    const tick = await sponsor.cronTick();
    expect(tick.care.toppedUp).toContain(account);
    expect(sends.some((s) => s.label === `pool top-up ${account}`)).toBe(true);
    expect(sponsor.state.pool[account]!.care).toMatchObject({ action: "topup" });
  });

  it("does not top up a spare with enough runway", async () => {
    const { sponsor, sends, payAccounts } = await start({ pool: 1, poolCare: { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 } });
    await sponsor.refillPool();
    const account = Object.values(sponsor.state.pool).find((e) => e.status === "ready")!.account;
    const rate = 10n ** 18n / 86_400n;
    payAccounts.set(account.toLowerCase(), [4n * 10n ** 18n, 0n, rate, 1000n]); // ~120 days
    const before = sends.filter((s) => s.label.startsWith("pool top-up")).length;
    const tick = await sponsor.cronTick();
    expect(tick.care.toppedUp).toEqual([]);
    expect(sends.filter((s) => s.label.startsWith("pool top-up")).length).toBe(before);
    expect((await sponsor.status()).pool.spares[0]).toMatchObject({ account, runwayDays: 120 });
  });

  it("retires a ready spare older than max age (terminate + sweep) instead of topping up", async () => {
    const { sponsor, terminated, clock, payAccounts } = await start({ pool: 1, poolCare: { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 } });
    await sponsor.refillPool();
    const account = Object.values(sponsor.state.pool).find((e) => e.status === "ready")!.account;
    const rate = 10n ** 18n / 86_400n;
    payAccounts.set(account.toLowerCase(), [10n ** 18n, 0n, rate, 1000n]);
    sponsor.state.pool[account]!.createdAt = new Date(clock.value - 91 * 86_400_000).toISOString();
    const tick = await sponsor.cronTick();
    expect(tick.care.retired).toContain(account);
    expect(terminated.some((row) => row.account === account)).toBe(true);
    expect(sponsor.state.pool[account]).toMatchObject({ status: "retired", error: "retired: older than max pool age" });
  });

  it("skips pool care when the sponsor is under the 0.05 FIL floor", async () => {
    const { sponsor, sponsorFil, payAccounts, terminated } = await start({ pool: 1, poolCare: { minRunwayDays: 45, topUpMonths: 3, maxAgeDays: 90 } });
    await sponsor.refillPool();
    const account = Object.values(sponsor.state.pool).find((e) => e.status === "ready")!.account;
    const rate = 10n ** 18n / 86_400n;
    payAccounts.set(account.toLowerCase(), [10n ** 18n, 0n, rate, 1000n]);
    sponsorFil.value = 4n * 10n ** 16n; // 0.04 FIL
    const tick = await sponsor.cronTick();
    expect(tick.care.toppedUp).toEqual([]);
    expect(tick.care.retired).toEqual([]);
    expect(tick.care.skipped.some((row: { account: string }) => row.account === account)).toBe(true);
    expect(terminated).toEqual([]);
    expect(sponsor.state.pool[account]!.status).toBe("ready");
  });
});
