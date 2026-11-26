// @vitest-environment node
/**
 * Live Calibration run of gasless FiFolders through the real onboarding/volume code (createLiveOnboarding), passkey
 * sign-in (default path) and the warm-pool fast path. Skipped unless SPONSOR_E2E=1. Needs SPONSOR_KEY (funded tFIL +
 * USDFC) and SPONSOR_FACTORY. Without Stripe test keys the card payment is simulated: local Checkout session + a
 * webhook signed with a local test secret. The passkey is a software P-256 authenticator behind navigator.credentials.
 *
 *   SPONSOR_E2E=1 SPONSOR_KEY=0x… SPONSOR_FACTORY=0x… pnpm --filter fifolders exec vitest run test/sponsored-calibration.test.ts
 */
import { webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calibration } from "@filoz/synapse-core/chains";

const RUN = process.env.SPONSOR_E2E === "1";
const RPC = "https://api.calibration.node.glif.io/rpc/v1";
const link = (hash: string) => `https://calibration.filfox.info/en/message/${hash}`;

/** Software WebAuthn authenticator (ES256), shaped like the browser API surface src/passkey.ts uses. */
async function softAuthenticator() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = await webcrypto.subtle.exportKey("spki", pair.publicKey);
  const rawId = webcrypto.getRandomValues(new Uint8Array(16));
  let assertions = 0;
  const der = (p1363: Uint8Array) => {
    const int = (b: Uint8Array) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i += 1;
      const t = b[i]! >= 0x80 ? [0, ...b.slice(i)] : [...b.slice(i)];
      return [0x02, t.length, ...t];
    };
    const body = [...int(p1363.slice(0, 32)), ...int(p1363.slice(32))];
    return new Uint8Array([0x30, body.length, ...body]);
  };
  return {
    get assertions() {
      return assertions;
    },
    credentials: {
      async create() {
        return { rawId: rawId.buffer, response: { getPublicKey: () => spki } };
      },
      async get({ publicKey }: { publicKey: { challenge: Uint8Array } }) {
        assertions += 1;
        const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(publicKey.challenge).toString("base64url"), origin: "http://localhost", crossOrigin: false });
        const authenticatorData = new Uint8Array(37);
        authenticatorData[32] = 0x05; // UP | UV
        const clientHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(clientDataJSON)));
        const sig = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array([...authenticatorData, ...clientHash])));
        return { rawId: rawId.buffer, response: { authenticatorData: authenticatorData.buffer, clientDataJSON: new TextEncoder().encode(clientDataJSON).buffer, signature: der(sig).buffer } };
      },
    },
  };
}

describe.skipIf(!RUN)("gasless FiFolders on Calibration (passkey, warm pool)", () => {
  it("passkey user, card purchase → pooled account handover, upload, remove, terminate", { timeout: 90 * 60_000 }, async () => {
    const log: Record<string, unknown> = { started: new Date().toISOString(), txs: {} as Record<string, string> };
    const txs = log.txs as Record<string, string>;
    const out = process.env.SPONSOR_E2E_OUT ?? "/tmp/sponsored-e2e.json";
    const note = (key: string, hash?: string | null) => {
      if (!hash) return;
      txs[key] = link(hash);
      writeFileSync(out, JSON.stringify(log, null, 2));
      console.log(`${key}: ${link(hash)}`);
    };
    const pub = createPublicClient({ chain: calibration, transport: http(RPC) });

    const authenticator = await softAuthenticator();
    const store = new Map<string, string>();
    const location = { origin: "http://localhost", pathname: "/", search: "", hash: "" };
    Object.assign(globalThis, {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
          if (key.startsWith("fifolders:replication:")) {
            for (const provider of (JSON.parse(value) as { providers?: { transactionHash?: string }[] }).providers ?? []) {
              if (provider.transactionHash && !Object.values(txs).includes(link(provider.transactionHash))) note(`addPieces (provider-submitted) #${Object.keys(txs).length}`, provider.transactionHash);
            }
          }
        },
        removeItem: (key: string) => void store.delete(key),
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() {
          return store.size;
        },
        clear: () => store.clear(),
      },
      PublicKeyCredential: class {},
      window: Object.assign(new EventTarget(), { setTimeout, clearTimeout, location, history: { replaceState: (_: unknown, __: string, url: string) => void (location.search = new URL(url, "http://localhost").search) } }),
    });
    Object.defineProperty(globalThis, "navigator", { value: { credentials: authenticator.credentials }, configurable: true });

    // Sponsor backend in-process, warm pool of 1.
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_local_e2e";
    const { createSponsor, configFromEnv } = await import("../sponsor/server.js");
    const { stripeSignatureHeader } = await import("../sponsor/stripe.js");
    const sponsor = createSponsor(
      configFromEnv({ ...process.env, STRIPE_WEBHOOK_SECRET: webhookSecret, SPONSOR_STRIPE_FAKE: process.env.STRIPE_SECRET_KEY ? "" : "1", SPONSOR_POOL_SIZE: process.env.SPONSOR_POOL_SIZE ?? "1", SPONSOR_STATE: process.env.SPONSOR_STATE ?? "/tmp/sponsor-state-e2e.json" }),
    );
    await new Promise<void>((resolve) => sponsor.server.listen(0, "127.0.0.1", resolve));
    const sponsorBase = `http://127.0.0.1:${(sponsor.server.address() as AddressInfo).port}`;
    vi.stubEnv("VITE_SPONSOR_URL", sponsorBase);
    vi.stubEnv("VITE_SPONSOR_CREDIT_USD", process.env.SPONSOR_E2E_USD ?? "5");
    const { createLiveOnboarding, PASSKEY_RDNS } = await import("../src/live-onboarding.js");
    const { schedulePieceRemovals } = await import("../src/removal.js");
    let checkoutUrl = "";
    const io = createLiveOnboarding({ openCheckout: (url) => void (checkoutUrl = url) });
    const chain = "calibration" as const;
    const volumeName = `gasless-${Date.now()}`;
    const sentFrom = (start: number, pattern: RegExp, prefix: string) => {
      for (const sent of sponsor.relayer.sent!.slice(start)) if (pattern.test(sent.label)) note(`${prefix}${sent.label}`, sent.hash);
    };

    try {
      // 0. Warm pool: ownerless account, 1 USDFC deposited, dataset open (sponsor only).
      const t0 = Date.now();
      await sponsor.refillPool();
      const pooled = Object.values(sponsor.state.pool).find((entry) => entry.status === "ready");
      expect(pooled).toBeDefined();
      log.pool = { account: pooled!.account, dataSetId: pooled!.dataSetId, buildSeconds: Math.round((Date.now() - t0) / 1000) };
      sentFrom(0, /^pool|allowDataSet|approve/, "pool: ");
      note("pool: createDataSet (provider-submitted)", pooled!.dataSetTx);

      // 1. Passkey sign-in is offered first; no wallet anywhere.
      const choices = await io.discover();
      expect(choices[0]?.rdns).toBe(PASSKEY_RDNS);
      await io.connect({ rdns: PASSKEY_RDNS, chain });
      let panel = await io.snapshot({ chain, volumeName });
      expect(panel.paymentsReady).toBe(false);

      // 2. "Buy storage credits": passkey-signed request → Stripe Checkout ($5 default; first purchase incl. setup).
      await io.fixPayments(chain);
      const sessionId = new URL(checkoutUrl).searchParams.get("session_id")!;
      log.checkout = { url: checkoutUrl, sessionId };
      const identity = sponsor.state.checkouts[sessionId]!.identity;
      expect(identity).toMatch(/^passkey:/);
      const beforeAssign = sponsor.relayer.sent!.length;
      if (sessionId.startsWith("cs_test_local_")) {
        const cents = Math.round(Number(process.env.SPONSOR_E2E_USD ?? "5") * 100);
        const event = JSON.stringify({ id: `evt_${sessionId}`, type: "checkout.session.completed", livemode: false, data: { object: { id: sessionId, payment_status: "paid", currency: "usd", amount_total: cents, metadata: { identity, first: "1", factory: sponsor.config.factory } } } });
        for (let i = 0; i < 2; i += 1) {
          const response = await fetch(`${sponsorBase}/stripe/webhook`, { method: "POST", headers: { "stripe-signature": stripeSignatureHeader(event, webhookSecret) }, body: event });
          log[`webhook${i}`] = await response.json();
        }
      } else {
        console.log(`Pay in Stripe test mode (4242…): ${checkoutUrl}`);
        while (!sponsor.state.credits[sessionId]) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      const t1 = Date.now();
      await sponsor.settled();
      log.credit = { ...sponsor.state.credits[sessionId], handoverSeconds: Math.round((Date.now() - t1) / 1000) };
      expect(sponsor.state.credits[sessionId]).toMatchObject({ status: "done", path: "pool", account: pooled!.account });
      sentFrom(beforeAssign, /^assign|approve/, "handover: ");
      expect(sponsor.relayer.sent!.slice(beforeAssign).filter((sent) => sent.label.startsWith("assign"))).toHaveLength(1);
      const record = sponsor.state.users[identity]!;
      log.account = record.account;
      log.dataSetId = record.dataSetId;

      // 3. Back from Stripe: the app waits for /credits, then shows the account, its balance and the dataset.
      location.search = `?checkout=success&session_id=${sessionId}`;
      panel = await io.snapshot({ chain, volumeName });
      expect(location.search).toBe("");
      expect(panel.address.toLowerCase()).toBe(record.account.toLowerCase());
      expect(panel.paymentsReady).toBe(true);
      log.balanceShown = panel.deposit;
      await io.createDataset({ chain, volumeName }); // returns the pooled dataset (no new one)
      // 4. Passkey signs Execute(addSessionKey); sponsor relays (Solidity P-256 verification on chain).
      await io.authorize(chain, false, (step) => step.phase === "done" && "hash" in step && note("addSessionKey (passkey-signed Execute, relayed)", step.hash));
      panel = await io.snapshot({ chain, volumeName });
      expect(panel.sessionReady).toBe(true);
      expect(panel.selectedDatasetId).toBe(record.dataSetId);

      // 5. Save a file: provider adds the piece (session-key signed); manifest commit is a relayed Execute.
      const session = await io.enter({ chain, volumeName, encrypt: false });
      const before = sponsor.relayer.sent!.length;
      const stat = await session.volume.put("/hello.txt", new TextEncoder().encode(`gasless fifolders ${new Date().toISOString()}\n`.repeat(20)));
      log.filePiece = stat.pieceCid;
      sentFrom(before, /^execute/, "registry commit (session-signed, relayed): ");
      expect((await session.volume.get("/hello.txt")).byteLength).toBe(stat.size);

      // 6. Delete + schedule removal (provider-submitted), then terminate (relayed Execute).
      const beforeRm = sponsor.relayer.sent!.length;
      await session.volume.rm("/hello.txt");
      sentFrom(beforeRm, /^execute/, "registry commit rm (session-signed, relayed): ");
      const storagePiece = stat.located ?? (await session.volume.history())[0]!.pieceCid;
      log.storagePiece = storagePiece;
      const file = { pieceCid: storagePiece, datasetIds: [record.dataSetId!], checkpoints: {} as Record<string, { transactionHash?: string }> };
      await schedulePieceRemovals(file, async (_id, next) => note("schedulePieceRemovals (provider-submitted)", next?.transactionHash), session.removalAdapters!);
      const terminate = await io.terminateDataset!(chain, record.dataSetId!);
      expect((await pub.waitForTransactionReceipt({ hash: terminate, timeout: 10 * 60_000, pollingInterval: 5_000 })).status).toBe("success");
      note("terminateService (session-signed, relayed)", terminate);

      // 7. Pool refilled in the background after the handover.
      const beforeRefill = sponsor.relayer.sent!.length;
      await sponsor.refillPool();
      expect(Object.values(sponsor.state.pool).filter((entry) => entry.status === "ready")).toHaveLength(1);
      sentFrom(beforeRefill, /^pool|allowDataSet/, "refill: ");

      // Zero-FIL user: no wallet exists; the browser session key never held or spent FIL.
      const sessionKey = store.get([...store.keys()].find((key) => key.startsWith("fifolders:session:"))!)!;
      const sessionAddress = privateKeyToAccount(JSON.parse(sessionKey).privateKey as Hex).address;
      const fil = await pub.getBalance({ address: sessionAddress });
      const nonce = await pub.getTransactionCount({ address: sessionAddress });
      log.end = { sessionKey: sessionAddress, fil: fil.toString(), nonce, passkeyAssertions: authenticator.assertions };
      expect(fil).toBe(0n);
      expect(nonce).toBe(0);
    } finally {
      writeFileSync(out, JSON.stringify(log, null, 2));
      sponsor.server.close();
    }
  });
});
