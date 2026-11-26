// @vitest-environment node
/**
 * Live Calibration run of gasless FiFolders through the real onboarding/volume code (createLiveOnboarding).
 * Skipped unless SPONSOR_E2E=1. Needs SPONSOR_KEY (funded tFIL + USDFC) and SPONSOR_FACTORY.
 *
 *   SPONSOR_E2E=1 SPONSOR_KEY=0x… SPONSOR_FACTORY=0x… pnpm --filter fifolders exec vitest run test/sponsored-calibration.test.ts
 */
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
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

    // Sponsor backend in-process.
    const sponsor = await import("../sponsor/server.js");
    await new Promise<void>((resolve) => sponsor.server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("VITE_SPONSOR_URL", `http://127.0.0.1:${(sponsor.server.address() as AddressInfo).port}`);
    const { createLiveOnboarding } = await import("../src/live-onboarding.js");
    const { schedulePieceRemovals } = await import("../src/removal.js");
    const io = createLiveOnboarding();
    const chain = "calibration" as const;
    const volumeName = `gasless-${Date.now()}`;

    try {
      await io.connect({ rdns: null, chain });
      let panel = await io.snapshot({ chain, volumeName });
      expect(panel.paymentsReady).toBe(false);

      // 1. Backend: account + credits (sponsor gas, sponsor USDFC).
      await io.fixPayments(chain, (step) => step.phase === "done" && "hash" in step && note(`payment ${Object.keys(txs).length}`, step.hash));
      // 2. Wallet signs Execute(addSessionKey) (free); sponsor relays.
      await io.authorize(chain, false, (step) => step.phase === "done" && "hash" in step && note("addSessionKey (wallet-signed, relayed)", step.hash));
      // 3. Backend: one-time dataset with an approved provider.
      await io.createDataset({ chain, volumeName });
      const record = sponsor.state[user.address.toLowerCase()]!;
      log.account = record.account;
      log.dataSetId = record.dataSetId;
      note("createDataSet (provider-submitted, sponsor-authorized)", record.dataSetTx);
      for (const sent of sponsor.relayer.sent) if (/create account|credit|allowDataSet|approve/.test(sent.label)) note(`sponsor: ${sent.label}`, sent.hash);

      panel = await io.snapshot({ chain, volumeName });
      expect(panel.address.toLowerCase()).toBe(record.account.toLowerCase());
      expect(panel.paymentsReady).toBe(true);
      expect(panel.sessionReady).toBe(true);
      expect(panel.selectedDatasetId).toBe(record.dataSetId);

      // 4. Open the drive and save a small file: provider adds the piece (session-key signed); the manifest commit is a
      //    session-key-signed Execute(FolderRegistryV2.commit) relayed by the sponsor.
      const session = await io.enter({ chain, volumeName, encrypt: false });
      expect(session.owner.toLowerCase()).toBe(record.account.toLowerCase());
      const before = sponsor.relayer.sent.length;
      const stat = await session.volume.put("/hello.txt", new TextEncoder().encode(`gasless fifolders ${new Date().toISOString()}\n`.repeat(20)));
      log.filePiece = stat.pieceCid;
      for (const sent of sponsor.relayer.sent.slice(before)) note(`registry commit (session-signed, relayed): ${sent.label}`, sent.hash);
      expect((await session.volume.get("/hello.txt")).byteLength).toBe(stat.size);

      // 5. Delete the file (relayed commit) and schedule removal of its piece (session-key signed, provider-submitted).
      const beforeRm = sponsor.relayer.sent.length;
      await session.volume.rm("/hello.txt");
      for (const sent of sponsor.relayer.sent.slice(beforeRm)) note(`registry commit rm (session-signed, relayed): ${sent.label}`, sent.hash);
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
