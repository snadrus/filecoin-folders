import { reportLoadStep } from "./load-steps.js";
import { PieceUnavailableError } from "./piece-fallback.js";
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
  clearSession,
  paymentsReady,
  saveLastDataset,
  wasAutoPicked,
  saveSession,
  sessionGateFromExpiries,
  walletStorageKey,
  type DatasetRecord,
  type WalletPanel,
} from "./onboarding-logic.js";
import type { ChainReporter, OnboardingIO } from "./onboarding-io.js";
import { observeRegistry, type Session } from "./session.js";
import { setPieceDetailSource, type PieceDetail } from "./drive-pieces.js";
import { buildFixtureCar } from "./unixfs.js";
import { INTENTS, intentText, sessionIntent } from "./wallet-prompts.js";

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
/** E2E: localStorage "fifolders:mock-piecefail" = "1" makes file reads fail as if no provider had the piece. */
function failReadsWhenFlagged(volume: { get(path: string): Promise<Uint8Array> }): void {
  const get = volume.get.bind(volume);
  volume.get = async (path: string) => {
    if (localStorage.getItem("fifolders:mock-piecefail") === "1") throw new PieceUnavailableError(path);
    return get(path);
  };
}

export function createMockOnboarding(params: URLSearchParams): OnboardingIO {
  let signatures = 0;
  let connectPrompts = 0;
  let connected = false;
  const legacy = params.get("legacy") === "1";
  const authDelay = Number(params.get("authdelay") ?? "0");
  // One in-memory backing store so the public read and the signed session see the same drive.
  const storage = new MemoryStorage();
  const registry = new MemoryRegistry(MOCK_ADDRESS);
  // E2E: a lagging load-balanced RPC node — the first N commits fail like glif's "future epoch".
  let rpcLag = Number(params.get("rpclag") ?? "0");
  if (rpcLag > 0) {
    const commit = registry.commit.bind(registry);
    registry.commit = async (input) => {
      if (rpcLag-- > 0) throw Object.assign(new Error("RPC Request failed."), { details: 'RPC error (-32603): requested a future epoch (beyond "latest")' });
      return commit(input);
    };
  }

  const seededPayments = params.get("pay") === "ready";
  if (localStorage.getItem(PAYMENTS_KEY) == null && seededPayments) localStorage.setItem(PAYMENTS_KEY, "1");
  if (!localStorage.getItem("fifolders:mock-pay") && (params.get("funds") || params.get("rate") || params.get("ens"))) {
    localStorage.setItem(
      "fifolders:mock-pay",
      JSON.stringify({ funds: params.get("funds") || "", rate: params.get("rate") || "", ens: params.get("ens") || "" }),
    );
  }
  if (!localStorage.getItem(DATASETS_KEY)) {
    const count = Number(params.get("datasets") ?? "0");
    const seed: DatasetRecord[] = [];
    for (let i = 0; i < count; i++) seed.push(sampleDataset(i));
    localStorage.setItem(DATASETS_KEY, JSON.stringify(seed));
  }

  if (params.get("fcdrive") === "1") seedFilecoinDrive(storage);
  // E2E: slow piece reads so the Loose pieces loading state is observable.
  const pieceDelay = Number(params.get("piecedelay") ?? "0");
  // E2E: every provider is down (opening a file shows "unavailable" + Retry).
  // Toggled by localStorage "fifolders:mock-piecefail" = "1" so a test can fail reads after the folders load.
  {
    const get = storage.get.bind(storage);
    storage.get = async (cid: string) => {
      if (localStorage.getItem("fifolders:mock-piecefail") === "1") throw new PieceUnavailableError(cid);
      return get(cid);
    };
  }
  if (pieceDelay > 0) {
    const get = storage.get.bind(storage);
    storage.get = async (cid: string) => {
      await new Promise((resolve) => setTimeout(resolve, pieceDelay));
      return get(cid);
    };
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

  /** One on-chain expiry stands in for every required permission. */
  function permissionExpiries(sessionAddress: string): bigint[] {
    const expiry = expiryFor(sessionAddress);
    return [expiry, expiry, expiry, expiry, expiry];
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
    const gate = stored ? sessionGateFromExpiries(permissionExpiries(stored.sessionAddress), now) : "expired";
    const sessionReady = Boolean(stored && gate !== "expired");
    const driveIds = new Set((params.get("drives") ?? "").split(",").filter(Boolean));
    const fc: DatasetRecord[] = params.get("fcdrive") === "1"
      ? [{ id: "77", provider: "0x7777…cccc", providerId: "7", pieceCount: "3", size: "1 KB", created: "2026-11-01", source: "filecoin-pin" }]
      : [];
    const list = [...datasets(), ...fc].map((dataset) => (driveIds.has(dataset.id) ? { ...dataset, drive: true, driveName: "My Drive" } : dataset));
    const remembered = loadLastDataset(MOCK_CHAIN_ID, MOCK_ADDRESS);
    const chosen = chooseDataset(list, remembered);
    const deposited = localStorage.getItem(PAYMENTS_KEY) === "1";
    const pay = mockPay();
    const baseFunds = deposited ? 5n * 10n ** 18n : 0n;
    const available = pay.funds ? BigInt(pay.funds) : baseFunds;
    return {
      address: MOCK_ADDRESS,
      fil: formatToken(2_500_000_000_000_000_000n),
      usdfc: formatToken(deposited ? 5n * 10n ** 18n : 0n),
      deposit: formatToken(deposited ? 5n * 10n ** 18n : 0n),
      availableFunds: available.toString(),
      lockupRate: pay.rate || "0",
      ens: pay.ens || undefined,
      paymentsReady: paymentsReady(deposited ? 1n : 0n, deposited),
      sessionReady: legacy || sessionReady,
      sessionExpiry: sessionReady ? formatExpiry(onchain) : "",
      datasets: list,
      selectedDatasetId: chosen.selectedId ?? "",
      createPrimary: list.length === 0,
      autoPicked: wasAutoPicked(list, remembered, chosen.selectedId),
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
      if (input.chain === "mainnet") throw new Error("Registry not deployed");
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
      if (input.chain === "mainnet") throw new Error("Registry not deployed");
      return panel();
    },
    async authorize(_chain, force = false, report?: ChainReporter) {
      if (!connected) throw new Error("Connect a wallet first.");
      const now = BigInt(Math.floor(Date.now() / 1000));
      const stored = loadSession(MOCK_CHAIN_ID, MOCK_ADDRESS);
      if (!force && stored && sessionGateFromExpiries(permissionExpiries(stored.sessionAddress), now) !== "expired") return;
      report?.({ flow: "session", phase: "signing", label: intentText(sessionIntent()) });
      if (authDelay > 0) await new Promise((resolve) => setTimeout(resolve, authDelay));
      report?.({ flow: "session", phase: "submitted", hash: "0xsession" });
      report?.({ flow: "session", phase: "confirming", hash: "0xsession", blocks: 1, elapsedSec: 1 });
      signatures += SIGNATURES.sessionLogin;
      const privateKey = stored?.privateKey ?? generatePrivateKey();
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
      report?.({ flow: "session", phase: "done", hash: "0xsession" });
    },
    async sessionGate() {
      if (!connected) throw new Error("Connect a wallet first.");
      const stored = loadSession(MOCK_CHAIN_ID, MOCK_ADDRESS);
      if (!stored) return "expired";
      const now = BigInt(Math.floor(Date.now() / 1000));
      return sessionGateFromExpiries(permissionExpiries(stored.sessionAddress), now);
    },
    async fixPayments(_chain, report?: ChainReporter, force = false) {
      if (!connected) throw new Error("Connect a wallet first.");
      const ready = localStorage.getItem(PAYMENTS_KEY) === "1";
      if (ready && !force) return;
      report?.({ flow: "payment", phase: "signing", label: intentText(INTENTS.depositAndApprove("5")) });
      report?.({ flow: "payment", phase: "submitted", hash: "0xpay" });
      report?.({ flow: "payment", phase: "confirming", hash: "0xpay", blocks: 1, elapsedSec: 1 });
      if (!ready) signatures += SIGNATURES.paymentFix;
      localStorage.setItem(PAYMENTS_KEY, "1");
      if (force && ready) {
        const pay = mockPay();
        const current = pay.funds ? BigInt(pay.funds) : 5n * 10n ** 18n;
        localStorage.setItem("fifolders:mock-pay", JSON.stringify({ ...pay, funds: (current + 5n * 10n ** 18n).toString() }));
      }
      report?.({ flow: "payment", phase: "done", hash: "0xpay" });
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
      reportLoadStep("Finding your folders…");
      // E2E: a slow session open so the step text and the slow-load Retry are observable.
      const enterDelay = Number(params.get("enterdelay") ?? "0");
      if (enterDelay > 0) {
        await new Promise((r) => setTimeout(r, enterDelay / 2));
        reportLoadStep("Fetching from storage provider…");
        await new Promise((r) => setTimeout(r, enterDelay / 2));
      }
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
      const observed = observeRegistry(registry);
      const volume = await openVolume({
        storage,
        registry: observed.registry,
        owner: MOCK_ADDRESS,
        name: input.volumeName,
      });
      failReadsWhenFlagged(volume);
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
    async peek(input) {
      reportLoadStep("Finding your folders…");
      const peekDelay = Number(params.get("enterdelay") ?? "0");
      if (peekDelay > 0) {
        await new Promise((r) => setTimeout(r, peekDelay / 2));
        reportLoadStep("Fetching from storage provider…");
        await new Promise((r) => setTimeout(r, peekDelay / 2));
      }
      if (params.get("peek") === "0") return null;
      const stored = localStorage.getItem(walletStorageKey());
      if (!stored || !chooseDataset(datasets(), loadLastDataset(MOCK_CHAIN_ID, MOCK_ADDRESS)).selectedId) return null;
      const observed = observeRegistry(registry);
      const volume = await openVolume({ storage, registry: observed.registry, owner: MOCK_ADDRESS, name: input.volumeName });
      failReadsWhenFlagged(volume);
      return { volume, owner: MOCK_ADDRESS, chain: "calibration", encrypted: false, volumeName: input.volumeName, cas: observed.cas };
    },
    async reopen() {
      return null;
    },
    async refundSession(_chain, report?: ChainReporter) {
      const stored = loadSession(MOCK_CHAIN_ID, MOCK_ADDRESS);
      if (!stored) return { refunded: 0n };
      report?.({ flow: "session", phase: "submitted", hash: "0xrefund" });
      const next = book();
      delete next[`${MOCK_ADDRESS.toLowerCase()}:${stored.sessionAddress.toLowerCase()}`];
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(next));
      clearSession(MOCK_CHAIN_ID, MOCK_ADDRESS);
      report?.({ flow: "session", phase: "done", hash: "0xrefund" });
      return { refunded: 49_000_000_000_000_000n };
    },
    disconnect() {
      connected = false;
      localStorage.removeItem(PERMITTED_KEY);
      localStorage.removeItem(walletStorageKey());
    },
  };
}

function mockPay(): { funds?: string; rate?: string; ens?: string } {
  try {
    return JSON.parse(localStorage.getItem("fifolders:mock-pay") || "{}") as { funds?: string; rate?: string; ens?: string };
  } catch {
    return {};
  }
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

/** E2E fixture modeled on filecoin-pin-website PR #250: one piece per file, label/path metadata. */
export function filecoinDriveFixture(): { pieceCid: string; bytes: Uint8Array; detail: PieceDetail }[] {
  const text = (value: string) => new TextEncoder().encode(value);
  const day = Date.UTC(2026, 9, 30);
  return [
    { pieceCid: "bafkzcibfixturehello", bytes: buildFixtureCar({ "hello.txt": text("Hello from Filecoin Drive\n") }), detail: { pieceCid: "bafkzcibfixturehello", pieceId: "0", metadata: { label: "hello.txt", path: "/" }, addedAt: day } },
    { pieceCid: "bafkzcibfixturereport", bytes: buildFixtureCar(text("Q3 numbers: 42\n")), detail: { pieceCid: "bafkzcibfixturereport", pieceId: "1", metadata: { label: "report.txt", path: "docs/reports" }, addedAt: day + 3600_000 } },
    {
      pieceCid: "bafkzcibfixturesite",
      bytes: buildFixtureCar({ "index.html": text("<h1>site</h1>"), css: { "main.css": text("h1{color:blue}") } }),
      detail: { pieceCid: "bafkzcibfixturesite", pieceId: "2", metadata: { label: "site", path: "projects" }, addedAt: day + 7200_000 },
    },
  ];
}

function seedFilecoinDrive(storage: MemoryStorage): void {
  const fixture = filecoinDriveFixture();
  for (const piece of fixture) storage.pieces.set(piece.pieceCid, piece.bytes);
  setPieceDetailSource(async () => fixture.map((piece) => piece.detail));
}
