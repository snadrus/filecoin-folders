// @vitest-environment node
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, getAddress, hashTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyAuth, requestDigest } from "../sponsor/auth.js";
import { RateLimiter } from "../sponsor/ratelimit.js";
import { createSponsor, usdfcForCents, type SponsorConfig } from "../sponsor/server.js";
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

describe("sponsor server (fake chain)", () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const wallet = walletSponsorSigner(user.address, (typed) => user.signTypedData(typed));
  const ACCOUNT = getAddress("0x00000000000000000000000000000000000000cc");
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(overrides: Partial<SponsorConfig["stripe"]> = {}) {
    const sends: { label: string; to?: Address }[] = [];
    const factoryAccounts = new Set<string>();
    const pub = {
      async readContract({ functionName, args }: { functionName: string; args?: unknown[] }) {
        if (functionName === "predict") return ACCOUNT;
        if (functionName === "isAccount") return factoryAccounts.has(String(args?.[0]).toLowerCase());
        if (functionName === "allowance") return 10n ** 30n;
        if (functionName === "accounts") return [0n, 0n, 0n, 0n];
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
      async send(call: { label: string; to?: Address }) {
        sends.push(call);
        if (call.label.startsWith("create account")) factoryAccounts.add(ACCOUNT.toLowerCase());
        return `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      },
      async relay(call: { label: string; to?: Address }) {
        const hash = await this.send(call);
        return { status: "success", transactionHash: hash } as never;
      },
    };
    const sponsor = createSponsor(
      {
        network: "calibration",
        chainId: CHAIN_ID,
        factory: FACTORY,
        providerId: 2n,
        contracts: { pay: getAddress("0x0000000000000000000000000000000000000001"), usdfc: getAddress("0x0000000000000000000000000000000000000002"), fwss: getAddress("0x0000000000000000000000000000000000000003"), pdp: getAddress("0x0000000000000000000000000000000000000004") },
        stripe: { webhookSecret: WHSEC, fake: true, usdfcPerUsd: "1", minUsd: 1, maxUsd: 100, allowedOrigins: ["http://localhost"], ...overrides },
        limits: { executePerMinute: 2 },
      },
      { pub: pub as never, relayer: relayer as never },
    );
    await new Promise<void>((resolve) => sponsor.server.listen(0, "127.0.0.1", resolve));
    close = () => sponsor.server.close();
    const base = `http://127.0.0.1:${(sponsor.server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    const signedPost = async (action: string, body: Record<string, unknown>) => post(`/${action}`, { ...body, auth: await wallet.auth(CHAIN_ID, action, body) });
    return { sponsor, sends, post, signedPost, base };
  }

  const event = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: `evt_${id}`, type: "checkout.session.completed", livemode: false, data: { object: { id, payment_status: "paid", currency: "usd", amount_total: 500, metadata: { account: ACCOUNT, factory: FACTORY }, ...extra } } });

  it("requires owner auth, then checkout, then credits once per session", async () => {
    const { sponsor, sends, post, signedPost } = await start();
    expect((await post("/account", {})).status).toBe(401);
    expect((await signedPost("account", {})).json.account).toBe(ACCOUNT);
    expect((await signedPost("checkout", { usd: 5, successUrl: "https://evil.example/", cancelUrl: "http://localhost/c" })).status).toBe(400);
    const checkout = await signedPost("checkout", { usd: 5, successUrl: "http://localhost/?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "http://localhost/c" });
    expect(checkout.status).toBe(200);
    const id = String(checkout.json.id);
    expect(id).toMatch(/^cs_test_local_/);

    const raw = event(id);
    expect((await post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, "whsec_wrong") })).status).toBe(400);
    const first = await post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, WHSEC) });
    expect(first.json).toMatchObject({ received: true, credited: (5n * 10n ** 18n).toString() });
    const again = await post("/stripe/webhook", raw, { "stripe-signature": stripeSignatureHeader(raw, WHSEC) });
    expect(again.json).toMatchObject({ duplicate: true });
    await sponsor.settled();
    expect(sends.filter((s) => s.label.startsWith("credit")).length).toBe(1);
    expect(sponsor.state.credits[id]).toMatchObject({ status: "done", account: ACCOUNT });

    const live = event("cs_live_1");
    expect((await post("/stripe/webhook", live.replace('"livemode":false', '"livemode":true'), { "stripe-signature": stripeSignatureHeader(live.replace('"livemode":false', '"livemode":true'), WHSEC) })).status).toBe(400);
    const unpaid = event("cs_unpaid", { payment_status: "unpaid" });
    expect((await post("/stripe/webhook", unpaid, { "stripe-signature": stripeSignatureHeader(unpaid, WHSEC) })).json).toMatchObject({ ignored: "payment_status unpaid" });
  });

  it("relays only to factory accounts, rate limited per account", async () => {
    const { post, signedPost } = await start();
    const exec = { account: ACCOUNT, target: ACCOUNT, value: "0", data: "0x12345678", nonce: "0", deadline: String(now() + 60), signature: "0x" };
    expect((await post("/execute", exec)).status).toBe(404);
    await signedPost("account", {});
    expect((await post("/execute", exec)).status).toBe(200);
    expect((await post("/execute", exec)).status).toBe(429);
  });

  it("refuses fake Stripe and test keys on mainnet", () => {
    const base = { network: "mainnet", chainId: 314, factory: FACTORY, providerId: 1n, contracts: { pay: FACTORY, usdfc: FACTORY, fwss: FACTORY, pdp: FACTORY } } as const;
    expect(() => createSponsor({ ...base, stripe: { fake: true, usdfcPerUsd: "1", minUsd: 1, maxUsd: 1, allowedOrigins: [] } }, { pub: {} as never, relayer: {} as never })).toThrow();
    expect(() => createSponsor({ ...base, stripe: { secretKey: "sk_test_x", webhookSecret: WHSEC, usdfcPerUsd: "1", minUsd: 1, maxUsd: 1, allowedOrigins: ["https://x"] } }, { pub: {} as never, relayer: {} as never })).toThrow(/live key/);
  });
});
