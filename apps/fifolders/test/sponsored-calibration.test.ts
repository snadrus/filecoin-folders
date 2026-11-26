// @vitest-environment node
/**
 * Live Calibration run of gasless FiFolders through the real onboarding/volume code (createLiveOnboarding).
 * Skipped unless SPONSOR_E2E=1. Needs SPONSOR_KEY (funded tFIL + USDFC) and SPONSOR_FACTORY. Without Stripe test
 * keys the card payment is simulated: local Checkout session + webhook signed with a local test secret.
 *
 *   SPONSOR_E2E=1 SPONSOR_KEY=0x… SPONSOR_FACTORY=0x… pnpm --filter fifolders exec vitest run test/sponsored-calibration.test.ts
 */
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPublicClient, erc20Abi, hashTypedData, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { calibration } from "@filoz/synapse-core/chains";

const RUN = process.env.SPONSOR_E2E === "1";
const RPC = "https://api.calibration.node.glif.io/rpc/v1";
const link = (hash: string) => `https://calibration.filfox.info/en/message/${hash}`;

describe.skipIf(!RUN)("gasless FiFolders on Calibration", () => {
  it("zero-FIL wallet: sponsor sets up, user uploads, removes, terminates", { timeout: 90 * 60_000 }, async () => {
    const log: Record<string, unknown> = { started: new Date().toISOString(), txs: {} as Record<string, string> };
    const txs = log.txs as Record<string, string>;
    const out = process.env.SPONSOR_E2E_OUT ?? "/tmp/sponsored-e2e.json";
    const note = (key: string, hash?: string) => {
      if (!hash) return;
      txs[key] = link(hash);
      writeFileSync(out, JSON.stringify(log, null, 2));
      console.log(`${key}: ${link(hash)}`);
    };
    const pub = createPublicClient({ chain: calibration, transport: http(RPC) });

    // Fresh signer-only wallet, injected the way a browser wallet would be. It must never send a transaction.
    const user = privateKeyToAccount((process.env.SPONSOR_E2E_USER_KEY as Hex) || generatePrivateKey());
    log.user = user.address;
    expect(await pub.getBalance({ address: user.address })).toBe(0n);
    let walletSends = 0;
    const ethereum = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [user.address];
        if (method === "eth_chainId") return "0x4cb2f";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_signTypedData_v4") {
          const typed = JSON.parse(String(params?.[1]));
          delete typed.types.EIP712Domain;
          return user.signTypedData(typed);
        }
        if (method === "eth_sendTransaction" || method === "eth_sendRawTransaction") {
          walletSends += 1;
          throw new Error("signer-only wallet: no gas");
        }
        return pub.request({ method, params } as never);
      },
      on() {},
    };
    const store = new Map<string, string>();
    Object.assign(globalThis, {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
          // Upload checkpoints carry the provider's addPieces transaction hashes.
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
      window: Object.assign(new EventTarget(), { ethereum, setTimeout, clearTimeout, location: { origin: "http://localhost" } }),
    });

    // Sponsor backend in-process. Stripe: real test keys if set, else a local session + locally signed webhook.
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_local_e2e";
    const { createSponsor, configFromEnv } = await import("../sponsor/server.js");
    const { stripeSignatureHeader } = await import("../sponsor/stripe.js");
    const sponsor = createSponsor(
      configFromEnv({ ...process.env, STRIPE_WEBHOOK_SECRET: webhookSecret, SPONSOR_STRIPE_FAKE: process.env.STRIPE_SECRET_KEY ? "" : "1", SPONSOR_STATE: process.env.SPONSOR_STATE ?? "/tmp/sponsor-state-e2e.json" }),
    );
    await new Promise<void>((resolve) => sponsor.server.listen(0, "127.0.0.1", resolve));
    const sponsorBase = `http://127.0.0.1:${(sponsor.server.address() as AddressInfo).port}`;
    vi.stubEnv("VITE_SPONSOR_URL", sponsorBase);
    vi.stubEnv("VITE_SPONSOR_CREDIT_USD", process.env.SPONSOR_E2E_USD ?? "2");
    const { createLiveOnboarding } = await import("../src/live-onboarding.js");
    const { schedulePieceRemovals } = await import("../src/removal.js");
    let checkoutUrl = "";
    const io = createLiveOnboarding({ openCheckout: (url) => void (checkoutUrl = url) });
    const chain = "calibration" as const;
    const volumeName = `gasless-${Date.now()}`;

    try {
      await io.connect({ rdns: null, chain });
      let panel = await io.snapshot({ chain, volumeName });
      expect(panel.paymentsReady).toBe(false);

      // 1. Wallet signs a SponsorRequest (free): sponsor creates the account. Then Stripe Checkout for credits.
      await io.fixPayments(chain, (step) => step.phase === "done" && "hash" in step && note("create account (sponsor, owner-signed request)", step.hash));
      const sessionId = new URL(checkoutUrl).searchParams.get("session_id")!;
      log.checkout = { url: checkoutUrl, sessionId };
      const record0 = sponsor.state.users[`eoa:${user.address.toLowerCase()}`]!;
      if (sessionId.startsWith("cs_test_local_")) {
        // Simulated Stripe delivery of checkout.session.completed (twice: idempotent).
        const event = JSON.stringify({ id: `evt_${sessionId}`, type: "checkout.session.completed", livemode: false, data: { object: { id: sessionId, payment_status: "paid", currency: "usd", amount_total: Number(process.env.SPONSOR_E2E_USD ?? "2") * 100, client_reference_id: record0.account, metadata: { account: record0.account, factory: sponsor.config.factory } } } });
        for (let i = 0; i < 2; i += 1) {
          const response = await fetch(`${sponsorBase}/stripe/webhook`, { method: "POST", headers: { "stripe-signature": stripeSignatureHeader(event, webhookSecret) }, body: event });
          log[`webhook${i}`] = await response.json();
        }
      } else {
        console.log(`Pay in Stripe test mode (4242…): ${checkoutUrl}`);
        while (!sponsor.state.credits[sessionId]) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      await sponsor.settled();
      log.credit = sponsor.state.credits[sessionId];
      expect(sponsor.state.credits[sessionId]?.status).toBe("done");
      note("USDFC deposit (sponsor, after Stripe webhook)", sponsor.state.credits[sessionId]?.hash);
      expect(sponsor.relayer.sent!.filter((sent) => sent.label.startsWith("credit")).length).toBe(1);
      // 2. Wallet signs Execute(addSessionKey) (free); sponsor relays.
      await io.authorize(chain, false, (step) => step.phase === "done" && "hash" in step && note("addSessionKey (wallet-signed, relayed)", step.hash));
      // 3. Backend: one-time dataset with an approved provider.
      await io.createDataset({ chain, volumeName });
      const record = sponsor.state.users[`eoa:${user.address.toLowerCase()}`]!;
      log.account = record.account;
      log.dataSetId = record.dataSetId;
      note("createDataSet (provider-submitted, sponsor-authorized)", record.dataSetTx);
      for (const sent of sponsor.relayer.sent!) if (/allowDataSet|approve/.test(sent.label)) note(`sponsor: ${sent.label}`, sent.hash);

      panel = await io.snapshot({ chain, volumeName });
      expect(panel.address.toLowerCase()).toBe(record.account.toLowerCase());
      expect(panel.paymentsReady).toBe(true);
      expect(panel.sessionReady).toBe(true);
      expect(panel.selectedDatasetId).toBe(record.dataSetId);

      // 4. Open the drive and save a small file: provider adds the piece (session-key signed); the manifest commit is a
      //    session-key-signed Execute(FolderRegistryV2.commit) relayed by the sponsor.
      const session = await io.enter({ chain, volumeName, encrypt: false });
      expect(session.owner.toLowerCase()).toBe(record.account.toLowerCase());
      const before = sponsor.relayer.sent!.length;
      const stat = await session.volume.put("/hello.txt", new TextEncoder().encode(`gasless fifolders ${new Date().toISOString()}\n`.repeat(20)));
      log.filePiece = stat.pieceCid;
      for (const sent of sponsor.relayer.sent!.slice(before)) note(`registry commit (session-signed, relayed): ${sent.label}`, sent.hash);
      expect((await session.volume.get("/hello.txt")).byteLength).toBe(stat.size);

      // 5. Delete the file (relayed commit) and schedule removal of its piece (session-key signed, provider-submitted).
      const beforeRm = sponsor.relayer.sent!.length;
      await session.volume.rm("/hello.txt");
      for (const sent of sponsor.relayer.sent!.slice(beforeRm)) note(`registry commit rm (session-signed, relayed): ${sent.label}`, sent.hash);
      expect(session.removalAdapters).toBeDefined();
      // Small files ride inside the commit CAR: remove the storage piece that held the file.
      const storagePiece = stat.located ?? (await session.volume.history())[0]!.pieceCid;
      log.storagePiece = storagePiece;
      const file = { pieceCid: storagePiece, datasetIds: [record.dataSetId!], checkpoints: {} as Record<string, { transactionHash?: string }> };
      await schedulePieceRemovals(file, async (_id, next) => note("schedulePieceRemovals (provider-submitted)", next?.transactionHash), session.removalAdapters!);

      // 6. Terminate the dataset: session-key-signed Execute(FWSS.terminateService), sponsor-relayed.
      const terminate = await io.terminateDataset!(chain, record.dataSetId!);
      const receipt = await pub.waitForTransactionReceipt({ hash: terminate, timeout: 10 * 60_000, pollingInterval: 5_000 });
      expect(receipt.status).toBe("success");
      note("terminateService (session-signed, relayed)", terminate);

      // 7. Passkey owner (WebAuthn P-256, verified in Solidity): sponsor creates the account from a passkey-signed
      //    request, then relays a passkey-signed Execute(addSessionKey).
      const { webcrypto } = await import("node:crypto");
      const { bytesToHex } = await import("viem");
      const { encodeContractAssertion, derToRS } = await import("../src/passkey.js");
      const { passkeySponsorSigner, ensureSponsoredAccount, addSessionKeyData } = await import("../src/sponsored.js");
      const { EXECUTE_TYPES, executeDomain, lockedAccountAbi } = await import("../src/sponsored-abi.js");
      const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
      const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
      const key = { x: bytesToHex(raw.slice(1, 33)), y: bytesToHex(raw.slice(33, 65)) };
      const assert = async (challenge: Hex) => {
        const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), origin: "http://localhost", crossOrigin: false });
        const authenticatorData = new Uint8Array(37);
        authenticatorData[32] = 0x05;
        const clientHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(clientDataJSON)));
        const p1363 = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array([...authenticatorData, ...clientHash])));
        // Same path a browser takes: DER → low-s.
        const toInt = (b: Uint8Array) => { const t = b[0]! >= 0x80 ? [0, ...b] : [...b]; return [0x02, t.length, ...t]; };
        const der = [...toInt(p1363.slice(0, 32)), ...toInt(p1363.slice(32))];
        const { r, s } = derToRS(new Uint8Array([0x30, der.length, ...der]));
        return { authenticatorData: bytesToHex(authenticatorData), clientDataJSON, signature: `${r}${s.slice(2)}` as Hex };
      };
      const made = await ensureSponsoredAccount(passkeySponsorSigner(key, assert), calibration.id);
      log.passkeyAccount = made.account;
      note("passkey account create (sponsor, passkey-signed request)", made.hash);
      const sessionKey = privateKeyToAccount(generatePrivateKey()).address;
      const message = { target: made.account, value: 0n, data: addSessionKeyData(sessionKey, BigInt(Math.floor(Date.now() / 1000) + 86400)), nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
      const digest = hashTypedData({ domain: executeDomain(calibration.id, made.account), types: EXECUTE_TYPES, primaryType: "Execute", message });
      const signature = encodeContractAssertion(await assert(digest));
      const response = await fetch(`${sponsorBase}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: made.account, ...message, value: "0", nonce: "0", deadline: message.deadline.toString(), signature }) });
      const relayed = (await response.json()) as { hash?: Hex; error?: string };
      expect(relayed.error).toBeUndefined();
      const pkReceipt = await pub.waitForTransactionReceipt({ hash: relayed.hash!, timeout: 10 * 60_000, pollingInterval: 5_000 });
      expect(pkReceipt.status).toBe("success");
      log.passkeyExecuteGas = pkReceipt.gasUsed.toString();
      note("addSessionKey (passkey-signed Execute, relayed)", relayed.hash);
      expect(await pub.readContract({ address: made.account, abi: lockedAccountAbi, functionName: "sessionSigners", args: [sessionKey] })).toBeGreaterThan(0n);
    } finally {
      sponsor.server.close();
    }

    const fil = await pub.getBalance({ address: user.address });
    const nonce = await pub.getTransactionCount({ address: user.address });
    const usdfc = await pub.readContract({ address: calibration.contracts.usdfc.address, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
    log.end = { fil: fil.toString(), nonce, usdfc: usdfc.toString(), walletSends };
    writeFileSync(out, JSON.stringify(log, null, 2));
    expect(walletSends).toBe(0);
    expect(fil).toBe(0n);
    expect(nonce).toBe(0);
    expect(usdfc).toBe(0n);
  });
});
