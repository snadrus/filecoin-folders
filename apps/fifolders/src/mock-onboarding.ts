import { MemoryRegistry, MemoryStorage, openVolume } from "fil-folders";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  SESSION_TTL_SEC,
  SIGNATURES,
  chooseDataset,
  formatExpiry,
  formatToken,
  loadLastDataset,
  loadSession,
  paymentsReady,
  saveLastDataset,
  saveSession,
  sessionUsable,
  walletStorageKey,
  type DatasetRecord,
  type WalletPanel,
} from "./onboarding-logic.js";
import type { OnboardingIO } from "./onboarding-io.js";
import { observeRegistry, type Session } from "./session.js";

export const MOCK_CHAIN_ID = 314159;
export const MOCK_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const REGISTRY_KEY = "fifolders:mock-registry";
const PAYMENTS_KEY = "fifolders:mock-payments";
const DATASETS_KEY = "fifolders:mock-datasets";
const PERMITTED_KEY = "fifolders:wallet-permitted";

interface RegistryBook {
  [key: string]: string;
}

/**
 * In-browser stand-in for an injected wallet and SessionKeyRegistry.
 * `authorize` is one signature (`loginAndFund`). `fixPayments` is two
 * (permit + deposit). Dataset creation signs with the session key: zero
 * wallet signatures. State that must survive reload lives in localStorage.
 */
export function createMockOnboarding(params: URLSearchParams): OnboardingIO {
  let signatures = 0;
  let connectPrompts = 0;
  let connected = false;
  const legacy = params.get("legacy") === "1";

  const seededPayments = params.get("pay") === "ready";
  if (localStorage.getItem(PAYMENTS_KEY) == null && seededPayments) localStorage.setItem(PAYMENTS_KEY, "1");
  if (!localStorage.getItem(DATASETS_KEY)) {
    const count = Number(params.get("datasets") ?? "0");
    const seed: DatasetRecord[] = [];
    for (let i = 0; i < count; i++) seed.push(sampleDataset(i));
    localStorage.setItem(DATASETS_KEY, JSON.stringify(seed));
  }

  function book(): RegistryBook {
    try {
      return JSON.parse(localStorage.getItem(REGISTRY_KEY) || "{}") as RegistryBook;
    } catch {
      return {};
    }
  }

  function expiryFor(sessionAddress: string): bigint {
    const raw = book()[`${MOCK_ADDRESS.toLowerCase()}:${sessionAddress.toLowerCase()}`];
    return raw ? BigInt(raw) : 0n;
  }

  function datasets(): DatasetRecord[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(DATASETS_KEY) || "[]") as DatasetRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function panel(): WalletPanel {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const stored = loadSession(MOCK_CHAIN_ID, MOCK_ADDRESS);
    const onchain = stored ? expiryFor(stored.sessionAddress) : 0n;
    const sessionReady = sessionUsable(stored, now) && onchain > now;
    const list = datasets();
    const chosen = chooseDataset(list, loadLastDataset(MOCK_CHAIN_ID, MOCK_ADDRESS));
    const deposited = localStorage.getItem(PAYMENTS_KEY) === "1";
    return {
      address: MOCK_ADDRESS,
      fil: formatToken(2_500_000_000_000_000_000n),
      usdfc: formatToken(deposited ? 5n * 10n ** 18n : 0n),
      paymentsReady: paymentsReady(deposited ? 1n : 0n, deposited),
      sessionReady: legacy || sessionReady,
      sessionExpiry: sessionReady ? formatExpiry(onchain) : "",
      datasets: list,
      selectedDatasetId: chosen.selectedId ?? "",
      createPrimary: list.length === 0,
      legacyRegistry: legacy,
      signatures,
      connectPrompts,
    };
  }

  return {
    async discover() {
      return [{ rdns: "mock.wallet", name: "Mock wallet" }];
    },
    async connect(input) {
      if (input.chain === "mainnet") throw new Error("Mainnet has no FolderRegistry yet. Use Calibration.");
      connectPrompts += 1;
      connected = true;
      localStorage.setItem(PERMITTED_KEY, "1");
      localStorage.setItem(walletStorageKey(), JSON.stringify({ rdns: "mock.wallet", address: MOCK_ADDRESS, chain: "calibration" }));
    },
    async silent(chain) {
      if (chain === "mainnet") return false;
      if (localStorage.getItem(PERMITTED_KEY) !== "1") return false;
      connected = true;
      return true;
    },
    async snapshot(input) {
      if (!connected) throw new Error("Connect a wallet first.");
      if (input.chain === "mainnet") throw new Error("Mainnet has no FolderRegistry yet. Use Calibration.");
      return panel();
    },
    async authorize(_chain, force = false) {
      if (!connected) throw new Error("Connect a wallet first.");
      const now = BigInt(Math.floor(Date.now() / 1000));
      const stored = loadSession(MOCK_CHAIN_ID, MOCK_ADDRESS);
      if (!force && sessionUsable(stored, now) && stored && expiryFor(stored.sessionAddress) > now) return;
      signatures += SIGNATURES.sessionLogin;
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const expiry = now + BigInt(SESSION_TTL_SEC);
      const next = book();
      next[`${MOCK_ADDRESS.toLowerCase()}:${account.address.toLowerCase()}`] = expiry.toString();
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(next));
      saveSession({
        v: 1,
        chainId: MOCK_CHAIN_ID,
        root: MOCK_ADDRESS,
        privateKey,
        sessionAddress: account.address,
        expiry: expiry.toString(),
      });
    },
    async fixPayments() {
      if (!connected) throw new Error("Connect a wallet first.");
      if (localStorage.getItem(PAYMENTS_KEY) === "1") return;
      signatures += SIGNATURES.paymentFix;
      localStorage.setItem(PAYMENTS_KEY, "1");
    },
    async createDataset(input) {
      const now = new Date();
      const list = datasets();
      const created: DatasetRecord = {
        id: `${list.length + 1}`,
        provider: "auto provider",
        providerId: "1",
        pieceCount: "0",
        size: "—",
        created: now.toLocaleDateString(),
      };
      list.push(created);
      localStorage.setItem(DATASETS_KEY, JSON.stringify(list));
      saveLastDataset(MOCK_CHAIN_ID, MOCK_ADDRESS, created.id);
      localStorage.setItem(
        `fifolders:dataset-meta:${MOCK_CHAIN_ID}:${MOCK_ADDRESS.toLowerCase()}:${created.id}`,
        JSON.stringify({ volume: input.volumeName, app: "fifolders" }),
      );
    },
    selectDataset(id) {
      saveLastDataset(MOCK_CHAIN_ID, MOCK_ADDRESS, id);
    },
    async enter(input) {
      const current = panel();
      if (!current.paymentsReady || !current.selectedDatasetId) throw new Error("Pick a dataset with storage payment ready.");
      if (!current.legacyRegistry && !current.sessionReady) throw new Error("Authorize the session key first.");
      if (input.encrypt) {
        const key = `fifolders:volume-sig:${MOCK_CHAIN_ID}:${MOCK_ADDRESS.toLowerCase()}:${input.volumeName}`;
        if (!localStorage.getItem(key)) {
          signatures += SIGNATURES.encryptSign;
          localStorage.setItem(key, "0xmock");
        }
      }
      const registry = new MemoryRegistry(MOCK_ADDRESS);
      const observed = observeRegistry(registry);
      const volume = await openVolume({
        storage: new MemoryStorage(),
        registry: observed.registry,
        owner: MOCK_ADDRESS,
        name: input.volumeName,
      });
      const session: Session = {
        volume,
        owner: MOCK_ADDRESS,
        chain: "calibration",
        encrypted: input.encrypt,
        volumeName: input.volumeName,
        cas: observed.cas,
      };
      return session;
    },
    disconnect() {
      connected = false;
      localStorage.removeItem(PERMITTED_KEY);
      localStorage.removeItem(walletStorageKey());
    },
  };
}

function sampleDataset(index: number): DatasetRecord {
  return {
    id: `${index + 1}`,
    provider: index === 0 ? "0x1111…aaaa" : "0x2222…bbbb",
    providerId: `${index + 1}`,
    pieceCount: index === 0 ? "12" : "3",
    size: index === 0 ? "48 MB" : "2 MB",
    created: index === 0 ? "2026-10-02" : "2026-10-18",
  };
}
