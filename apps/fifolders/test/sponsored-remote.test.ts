// @vitest-environment node
/**
 * Live smoke + e2e against the deployed sponsor Worker (Calibration, Stripe TEST mode): health, pool status,
 * signed-request auth, then a passkey user buys credits through real Stripe Checkout (test card 4242, headless
 * Chromium), the real Stripe webhook hands over a warm-pool account, a second "device" signs in with the existing
 * passkey, and the user saves, removes and terminates. Skipped unless SPONSOR_REMOTE_E2E=1.
 *
 *   SPONSOR_REMOTE_E2E=1 [SPONSOR_REMOTE_URL=https://fast.scionbase.ai] pnpm --filter fifolders exec vitest run test/sponsored-remote.test.ts
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPublicClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { calibration } from "@filoz/synapse-core/chains";
import { softAuthenticator } from "./support/soft-authenticator.js";
import { payTestCheckout } from "./support/stripe-pay.js";

const RUN = process.env.SPONSOR_REMOTE_E2E === "1";
const BASE = (process.env.SPONSOR_REMOTE_URL ?? "https://fast.scionbase.ai").replace(/\/+$/, "");
const RPC = "https://api.calibration.node.glif.io/rpc/v1";
const link = (hash: string) => `https://calibration.filfox.info/en/message/${hash}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe.skipIf(!RUN)("deployed sponsor Worker (Calibration, Stripe test mode)", () => {
  it("health, auth, pool; passkey user pays by card → warm-pool handover; existing passkey on a new device; save/remove/terminate", { timeout: 60 * 60_000 }, async () => {
    const log: Record<string, unknown> = { base: BASE, started: new Date().toISOString(), txs: {} as Record<string, string> };
    const txs = log.txs as Record<string, string>;
    const out = process.env.SPONSOR_E2E_OUT ?? "/tmp/sponsored-remote-e2e.json";
    const save = () => writeFileSync(out, JSON.stringify(log, null, 2));
    const note = (key: string, hash?: string | null) => {
      if (!hash) return;
      txs[key] = link(hash);
      save();
      console.log(`${key}: ${link(hash)}`);
    };

    // 1. Health + pricing + pool.
    const health = await json("/health");
    expect(health).toMatchObject({ status: 200, body: { ok: true, network: "calibration", stripe: { checkout: true, webhook: true, fake: false } } });
    log.health = health.body;
    expect((await json("/pricing")).body).toMatchObject({ minFirstUsd: 3.91, minTopUpUsd: 2.37, testMode: true });
    expect((await json("/mainnet/health")).body).toMatchObject({ network: "mainnet" });

    // 2. Signed-request auth: missing, forged and tampered signatures are refused.
    const body = { usd: 5, successUrl: "http://localhost/?checkout=success", cancelUrl: "http://localhost/" };
    const post = (payload: unknown) => json("/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect((await post(body)).status).toBe(401);
    const { walletSponsorSigner } = await import("../src/sponsored.js");
    const stranger = privateKeyToAccount(generatePrivateKey());
    const auth = await walletSponsorSigner(stranger.address, (typed) => stranger.signTypedData(typed)).auth(calibration.id, "checkout", body);
    expect((await post({ ...body, usd: 50, auth })).status).toBe(401); // body changed after signing
    expect((await post({ ...body, auth: { ...auth, signature: `0x${"11".repeat(65)}` } })).status).toBe(401);
    log.auth = "missing/tampered/forged → 401";

    // 3. Warm pool has a ready account.
    let pool = (await json("/pool")).body as { counts: Record<string, number> };
    for (let i = 0; !(pool.counts.ready > 0) && i < 90; i += 1) {
      await sleep(10_000);
      pool = (await json("/pool")).body as typeof pool;
    }
    expect(pool.counts.ready).toBeGreaterThan(0);
    log.poolBefore = pool.counts;

    // 4. Browser-like globals: storage, window, a software passkey.
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
    // Record relayed Execute hashes (the sponsor returns them to the client).
    const realFetch = globalThis.fetch;
    let lastExecute = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${BASE}/execute`)) {
        const copy = (await response.clone().json().catch(() => ({}))) as { hash?: string };
        if (copy.hash) note(`relayed Execute ${lastExecute || ""}`.trim() + ` #${Object.keys(txs).length}`, copy.hash);
      }
      return response;
    }) as typeof fetch;
    vi.stubEnv("VITE_SPONSOR_URL", BASE);
    vi.stubEnv("VITE_SPONSOR_CREDIT_USD", "5");
    const { createLiveOnboarding, PASSKEY_EXISTING, PASSKEY_NEW } = await import("../src/live-onboarding.js");
    const { schedulePieceRemovals } = await import("../src/removal.js");
    const pub = createPublicClient({ chain: calibration, transport: http(RPC) });
    const chain = "calibration" as const;
    const volumeName = `remote-${Date.now()}`;

    try {
      // 5. New passkey (default path), buy $5 of credits through real Stripe Checkout in test mode.
      let checkoutUrl = "";
      const io = createLiveOnboarding({ openCheckout: (url) => void (checkoutUrl = url) });
      const choices = await io.discover();
      expect(choices.map((choice) => choice.rdns).slice(0, 2)).toEqual([PASSKEY_NEW, PASSKEY_EXISTING]);
      await io.connect({ rdns: PASSKEY_NEW, chain });
      let panel = await io.snapshot({ chain, volumeName });
      expect(panel.paymentsReady).toBe(false);
      await io.fixPayments(chain);
      const sessionId = /cs_test_[A-Za-z0-9]+/.exec(checkoutUrl)?.[0];
      expect(sessionId).toBeTruthy();
      log.checkout = { sessionId };
      const t0 = Date.now();
      await payTestCheckout(checkoutUrl, { screenshot: "/tmp/stripe-pay-fail.png" });
      log.paidSeconds = Math.round((Date.now() - t0) / 1000);

      // 6. Real webhook (signed by Stripe) → one assign tx hands over a pooled account.
      let credit = (await json(`/credits?session=${sessionId}`)).body as { status: string; account?: string; path?: string; usdfc?: string; hashes?: string[] };
      for (let i = 0; credit.status !== "done" && credit.status !== "failed" && i < 120; i += 1) {
        await sleep(5_000);
        credit = (await json(`/credits?session=${sessionId}`)).body as typeof credit;
      }
      log.credit = { ...credit, handoverSeconds: Math.round((Date.now() - t0) / 1000) };
      expect(credit).toMatchObject({ status: "done", path: "pool" });
      for (const hash of credit.hashes ?? []) note(`handover: assign (Stripe webhook)`, hash);

      // 7. Back from Stripe: balance + dataset shown.
      location.search = `?checkout=success&session_id=${sessionId}`;
      panel = await io.snapshot({ chain, volumeName });
      expect(panel.address.toLowerCase()).toBe(credit.account!.toLowerCase());
      expect(panel.paymentsReady).toBe(true);
      log.balanceShown = panel.deposit;

      // 8. Same person, new device: nothing stored locally; pick the existing passkey.
      const saved = new Map(store);
      store.clear();
      const io2 = createLiveOnboarding({ openCheckout: () => undefined });
      await io2.connect({ rdns: PASSKEY_EXISTING, chain });
      const panel2 = await io2.snapshot({ chain, volumeName });
      expect(panel2.address.toLowerCase()).toBe(credit.account!.toLowerCase());
      log.newDevice = { account: panel2.address, deposit: panel2.deposit };
      store.clear();
      for (const [key, value] of saved) store.set(key, value);

      // 9. Passkey-signed addSessionKey (relayed), save a file, remove it, terminate the dataset.
      await io.createDataset({ chain, volumeName });
      lastExecute = "addSessionKey (passkey)";
      await io.authorize(chain, false);
      panel = await io.snapshot({ chain, volumeName });
      expect(panel.sessionReady).toBe(true);
      const dataSetId = panel.selectedDatasetId;
      log.dataSetId = dataSetId;
      const session = await io.enter({ chain, volumeName, encrypt: false });
      lastExecute = "registry commit";
      const stat = await session.volume.put("/hello.txt", new TextEncoder().encode(`fast.scionbase.ai ${new Date().toISOString()}\n`.repeat(20)));
      expect((await session.volume.get("/hello.txt")).byteLength).toBe(stat.size);
      lastExecute = "registry commit rm";
      await session.volume.rm("/hello.txt");
      const storagePiece = stat.located ?? (await session.volume.history())[0]!.pieceCid;
      await schedulePieceRemovals({ pieceCid: storagePiece, datasetIds: [dataSetId], checkpoints: {} }, async (_id, next) => note("schedulePieceRemovals (provider-submitted)", next?.transactionHash), session.removalAdapters!);
      lastExecute = "terminateService";
      const terminate = await io.terminateDataset!(chain, dataSetId);
      expect((await pub.waitForTransactionReceipt({ hash: terminate, timeout: 10 * 60_000, pollingInterval: 5_000 })).status).toBe("success");

      // 10. Zero-FIL user; pool status after handover.
      const sessionKey = store.get([...store.keys()].find((key) => key.startsWith("fifolders:session:"))!)!;
      const sessionAddress = privateKeyToAccount(JSON.parse(sessionKey).privateKey as Hex).address;
      log.end = { sessionKey: sessionAddress, fil: (await pub.getBalance({ address: sessionAddress })).toString(), nonce: await pub.getTransactionCount({ address: sessionAddress }), passkeyAssertions: authenticator.assertions };
      expect(log.end).toMatchObject({ fil: "0", nonce: 0 });
      log.poolAfter = ((await json("/pool")).body as { counts: unknown }).counts;
    } finally {
      globalThis.fetch = realFetch;
      save();
    }
  });
});
