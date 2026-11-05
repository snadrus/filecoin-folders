import { ipfsSha256, withPieceFallback } from "./piece-fallback.js";
import { reportLoadStep } from "./load-steps.js";
import { walletWithPublicReads } from "./split-transport.js";
import { withTransientRetry } from "fil-folders";
import { INTENTS, intentText, sessionIntent, watchWalletPrompts, withWalletIntent, labelMigration } from "./wallet-prompts.js";
import { calibration, mainnet, type Chain } from "@filoz/synapse-core/chains";
import { isLegacyRegistry } from "./onboarding-logic.js";
import {
  AddPiecesPermission,
  CreateDataSetPermission,
  DeleteDataSetPermission,
  SchedulePieceRemovalsPermission,
  fromSecp256k1,
  getExpirations,
} from "@filoz/synapse-core/session-key";
import { bytesToPieceCid, createSynapseStorage, createViemRegistry, folderCommitPermission, folderRegistryAbi, namespaceId, openVolume, volumeKey } from "fil-folders";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { discoverWallets, safeOn, type AnnouncedWallet } from "./eip6963.js";
import { activeProviderUrls } from "./filecoin-api.js";
import { FILECOIN_DRIVE_SOURCE, isDriveSource, loadPieceDetails, setPieceDetailSource, type PieceDetail } from "./drive-pieces.js";
import { REGISTRY_NOT_DEPLOYED, registryReady } from "./network.js";
import { WALLETCONNECT_RDNS, connectWalletConnect, walletChoices, walletConnectConfig, type WalletConnectLike } from "./wallets.js";
import { saveCheckpoint, type UploadCheckpoint } from "./copies.js";
import type { ChainReporter, OnboardingIO } from "./onboarding-io.js";
import {
  PAYMENT_DEPOSIT,
  SESSION_FUND_WEI,
  SESSION_ORIGIN,
  SESSION_TTL_SEC,
  SIGNATURES,
  chooseDataset,
  fifoldersPermissions,
  formatExpiry,
  formatToken,
  loadLastDataset,
  loadSession,
  clearSession,
  paymentsReady,
  saveLastDataset,
  loadDriveMark,
  saveDriveMark,
  markDrives,
  type DriveMark,
  wasAutoPicked,
  saveSession,
  sessionGateFromExpiries,
  sessionUsable,
  SESSION_PERMISSION_ERROR,
  walletStorageKey,
  type DatasetRecord,
  type SessionGate,
  type StoredSession,
  type WalletPanel,
} from "./onboarding-logic.js";
import {
  CALIBRATION_FROM_BLOCK,
  CALIBRATION_REGISTRY,
  CALIBRATION_RPC,
  MAINNET_RPC,
  ensureChain,
  observeRegistry,
  type ChainChoice,
  type Session,
} from "./session.js";

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface StoredWallet {
  rdns: string;
  address: Address;
  chain: ChainChoice;
}

/**
 * Real wallet path. Session-key login is `loginAndFund` (one signature) and
 * funds the key with {@link SESSION_FUND_WEI} so later registry commits and
 * Synapse uploads sign locally. The payment fix is one guided action:
 * permit + `depositWithPermitAndApproveOperator` (two signatures).
 */
const FRESH_LOGIN_MS = 10 * 60 * 1000;

export function createLiveOnboarding(): OnboardingIO {
  const confirmedLogins = new Map<string, number>();
  let wallets: AnnouncedWallet[] = [];
  let provider: Eip1193Provider | null = null;
  let root: Address | null = null;
  let signatures = 0;
  let connectPrompts = 0;
  let selectedDataset = "";

  function chainOf(choice: ChainChoice): Chain {
    return choice === "mainnet" ? mainnet : calibration;
  }

  function rpcOf(choice: ChainChoice): string {
    return choice === "mainnet" ? MAINNET_RPC : CALIBRATION_RPC;
  }

  function requireRoot(): Address {
    if (!root) throw new Error("Connect a wallet first.");
    return root;
  }

  function requireProvider(): Eip1193Provider {
    if (!provider) throw new Error("No injected wallet found. Install a browser wallet such as MetaMask.");
    return provider;
  }

  async function walletClient(choice: ChainChoice): Promise<WalletClient> {
    return createWalletClient({
      account: requireRoot(),
      chain: chainOf(choice),
      transport: walletWithPublicReads(requireProvider(), rpcOf(choice)),
    });
  }

  function publicClient(choice: ChainChoice): PublicClient {
    return createPublicClient({ chain: chainOf(choice), transport: withTransientRetry(http(rpcOf(choice))) });
  }

  function registryConfig(choice: ChainChoice): { address: Address; fromBlock: bigint } {
    const env = import.meta.env;
    if (choice === "mainnet") {
      const address = env.VITE_FOLDER_REGISTRY_MAINNET;
      if (!address) throw new Error(REGISTRY_NOT_DEPLOYED);
      const from = env.VITE_REGISTRY_FROM_BLOCK_MAINNET;
      if (!from) throw new Error("Set VITE_REGISTRY_FROM_BLOCK_MAINNET to the deployment block.");
      return { address: getAddress(address), fromBlock: BigInt(from) };
    }
    const address = getAddress(env.VITE_FOLDER_REGISTRY || CALIBRATION_REGISTRY);
    if (env.VITE_REGISTRY_FROM_BLOCK) return { address, fromBlock: BigInt(env.VITE_REGISTRY_FROM_BLOCK) };
    if (address.toLowerCase() === CALIBRATION_REGISTRY.toLowerCase()) {
      return { address, fromBlock: CALIBRATION_FROM_BLOCK };
    }
    throw new Error("Set VITE_REGISTRY_FROM_BLOCK to the deployment block of VITE_FOLDER_REGISTRY.");
  }

  async function legacyRegistry(choice: ChainChoice, client: PublicClient): Promise<boolean> {
    const config = registryConfig(choice);
    return isLegacyRegistry(
      async () => String(await client.readContract({ address: config.address, abi: folderRegistryAbi, functionName: "PERMISSION_COMMIT" })),
      folderCommitPermission(),
    );
  }

  function rememberWallet(choice: ChainChoice, rdns: string): void {
    const stored: StoredWallet = { rdns, address: requireRoot(), chain: choice };
    localStorage.setItem(walletStorageKey(), JSON.stringify(stored));
    localStorage.setItem("fifolders:wallet-permitted", "1");
  }

  const followed = new WeakSet<object>();

  async function bindProvider(rdns: string | null): Promise<void> {
    wallets = await discoverWallets();
    const match = rdns ? wallets.find((wallet) => wallet.rdns === rdns) : undefined;
    const stored = readStoredWallet();
    const remembered = stored ? wallets.find((wallet) => wallet.rdns === stored.rdns) : undefined;
    const chosen = match ?? remembered ?? wallets[0];
    const picked = chosen?.provider ?? window.ethereum ?? null;
    provider = picked ? watchWalletPrompts(picked) : null;
    if (!provider) throw new Error("No injected wallet found. Install a browser wallet such as MetaMask.");
    if (picked) followWallet(picked as Eip1193Provider & { on?: (event: string, fn: (value: unknown) => void) => void });
  }

  /** A different account or chain in the wallet: tell the controller, which restarts the session in place. */
  let walletChange: (change: { account?: string; chainId?: string }) => void = () => undefined;
  function followWallet(source: { on?: (event: string, fn: (value: unknown) => void) => void }): void {
    if (followed.has(source)) return;
    followed.add(source);
    safeOn(source, "accountsChanged", (value) => {
      const next = Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
      if (!root || next.toLowerCase() === root.toLowerCase()) return;
      const stored = readStoredWallet();
      if (next && stored) localStorage.setItem(walletStorageKey(), JSON.stringify({ ...stored, address: getAddress(next) }));
      walletChange({ account: next });
    });
    safeOn(source, "chainChanged", (value) => {
      if (root) walletChange({ chainId: String(value) });
    });
  }


  async function onchainExpiries(choice: ChainChoice, sessionAddress: Address): Promise<bigint[]> {
    const permissions = fifoldersPermissions();
    // viem types the public client's chain as optional; this client was created with one.
    const expirations = await getExpirations(publicClient(choice) as never, {
      address: requireRoot(),
      sessionKeyAddress: sessionAddress,
      permissions,
    });
    return permissions.map((permission) => expirations[permission] ?? 0n);
  }

  function rememberSoonest(stored: StoredSession, expiries: readonly bigint[]): void {
    if (!expiries.length) return;
    const soonest = expiries.reduce((min, value) => (value < min ? value : min));
    if (soonest <= 0n || stored.expiry === soonest.toString()) return;
    saveSession({ ...stored, expiry: soonest.toString() });
  }

  async function gateFor(choice: ChainChoice): Promise<SessionGate> {
    const chain = chainOf(choice);
    const stored = loadSession(chain.id, requireRoot());
    if (!stored) return "expired";
    const now = BigInt(Math.floor(Date.now() / 1000));
    try {
      const expiries = await onchainExpiries(choice, stored.sessionAddress);
      rememberSoonest(stored, expiries);
      const gate = sessionGateFromExpiries(expiries, now);
      return gate === "expired" && justAuthorized(stored, now) ? "ok" : gate;
    } catch {
      return sessionUsable(stored, now) ? "ok" : "expired";
    }
  }

  let providerUrls: Promise<string[]> | null = null;
  /**
   * The SDK only retrieves from providers it can tie to the piece on chain. When that fails
   * (piece added under another dataset, or an upload whose receipt was never recorded),
   * ask every active PDP provider directly so a readable head never looks like an empty drive.
   */
  function withProviderFallback<T extends { get(pieceCid: string): Promise<Uint8Array> }>(storage: T, choice: ChainChoice): T {
    const sdkGet = storage.get.bind(storage);
    const urls = () =>
      (providerUrls ??= activeProviderUrls({
        network: choice,
        chainFallback: () =>
          import("@filoz/synapse-core/sp-registry")
            .then(({ getPDPProviders }) => getPDPProviders(publicClient(choice) as never, { onlyActive: true, limit: 200n } as never))
            .then((out) => out.providers.map((provider) => provider.pdp?.serviceURL ?? (provider as unknown as { serviceURL?: string }).serviceURL ?? "").filter(Boolean)),
      })
        .then((urls) => {
          if (!urls.length) providerUrls = null;
          return urls;
        })
        .catch(() => {
          providerUrls = null;
          return [] as string[];
        }));
    const fallback = withPieceFallback(sdkGet, {
      providerUrls: urls,
      // Some hosts answer 200 with an HTML page: only accept bytes that hash to this piece.
      verify: async (bytes, pieceCid) => {
        const digest = ipfsSha256(pieceCid);
        if (digest) {
          const got = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
          return got.length === digest.length && got.every((v, i) => v === digest[i]);
        }
        return (await import("@filoz/synapse-core/piece")).calculate(bytes).toString() === pieceCid;
      },
    });
    storage.get = (pieceCid: string) => fallback.get(pieceCid);
    return storage;
  }

  /** Synapse wants a custom transport; back it with the public RPC so reads never touch the wallet. */
  function publicTransport(choice: ChainChoice) {
    const client = publicClient(choice);
    return custom({ request: (args: { method: string; params?: unknown }) => client.request(args as never) });
  }

  async function listDatasets(choice: ChainChoice): Promise<DatasetRecord[]> {
    const { Synapse } = await import("@filoz/synapse-sdk");
    const synapse = Synapse.create({
      account: requireRoot(),
      chain: chainOf(choice),
      // Reads go to public RPC, never through the wallet.
      transport: publicTransport(choice),
      source: "fifolders",
    });
    const found = await synapse.storage.findDataSets({ address: requireRoot() });
    const remote = found.filter((dataset) => dataset.isLive !== false).map((dataset) => toDataset(choice, dataset));
    const pending = loadPending(choice, requireRoot());
    const ids = new Set(remote.map((dataset) => dataset.id));
    return [...remote, ...pending.filter((dataset) => !ids.has(dataset.id))];
  }

  /**
   * Which datasets hold FiFolders manifests: every manifest piece the wallet committed to the
   * FolderRegistry (chunked, cached log scan) plus the current head, matched against each
   * dataset's piece list. Results cache per dataset+piece count; best effort, never blocks long.
   */
  /** Loose pieces view reads Filecoin Drive per-piece metadata for the open dataset. */
  function installPieceDetails(choice: ChainChoice, datasetId: string, synapse: { storage: unknown }): void {
    if (!/^\d+$/.test(datasetId)) {
      setPieceDetailSource(null);
      return;
    }
    const chain = chainOf(choice);
    setPieceDetailSource(() =>
      loadPieceDetails({
        network: choice,
        dataSetId: datasetId,
        genesisTimestamp: (chain as unknown as { genesisTimestamp?: number }).genesisTimestamp ?? 0,
        chainFallback: async () => {
          const storage = synapse.storage as {
            createContext?: (o: unknown) => Promise<{ getPieces?: () => AsyncIterable<{ pieceId: bigint; pieceCid: { toString(): string } }> }>;
          };
          const context = await storage.createContext?.({ dataSetId: BigInt(datasetId), withCDN: false });
          if (!context?.getPieces) return [];
          const { getAllPieceMetadata } = await import("@filoz/synapse-core/warm-storage");
          const out: PieceDetail[] = [];
          for await (const piece of context.getPieces()) {
            const metadata = (await getAllPieceMetadata(publicClient(choice) as never, { dataSetId: BigInt(datasetId), pieceId: piece.pieceId }).catch(() => ({}))) as Record<string, string>;
            out.push({ pieceCid: piece.pieceCid.toString(), pieceId: piece.pieceId.toString(), metadata });
          }
          return out;
        },
      }),
    );
  }

  async function detectDrives(choice: ChainChoice, volumeName: string, datasets: DatasetRecord[], owner?: Address): Promise<DatasetRecord[]> {
    const address = owner ?? requireRoot();
    const chainId = chainOf(choice).id;
    const cached = datasets.map((dataset) => loadDriveMark(chainId, address, dataset.id, dataset.pieceCount));
    const missing = datasets.filter((dataset, index) => !cached[index] && /^\d+$/.test(dataset.id) && dataset.pieceCount !== "0");
    let fresh = new Map<string, DriveMark>();
    if (missing.length && registryReady(choice)) {
      const work = (async () => {
        const config = registryConfig(choice);
        const client = publicClient(choice);
        const registry = createViemRegistry({
      wrapMigration: labelMigration,
          address: config.address,
          publicClient: client,
          walletClient: createWalletClient({ account: address, chain: chainOf(choice), transport: withTransientRetry(http(rpcOf(choice))) }),
          fromBlock: config.fromBlock,
          signer: "session-key",
        });
        const ns = namespaceId();
        const currentKey = volumeKey(volumeName);
        const manifests = new Map<string, string>();
        const records = await registry.committed({ owner: address, ns }).catch(() => []);
        for (const record of records) {
          const cid = safeCid(record.pieceCid);
          if (cid) manifests.set(cid, record.key === currentKey ? volumeName : manifests.get(cid) ?? "");
        }
        const head = await registry.head(address, ns, currentKey).catch(() => null);
        const headCid = head ? safeCid(head.pieceCid) : "";
        if (headCid) manifests.set(headCid, volumeName);
        const { Synapse } = await import("@filoz/synapse-sdk");
        const synapse = Synapse.create({ account: address, chain: chainOf(choice), transport: publicTransport(choice), source: "fifolders" });
        const pieces = new Map<string, string[]>();
        await Promise.all(
          missing.map(async (dataset) => {
            try {
              pieces.set(dataset.id, (await createSynapseStorage(synapse, { dataSetId: BigInt(dataset.id) }).list?.()) ?? []);
            } catch {
              // Unknown stays unmarked and uncached so the next snapshot retries.
            }
          }),
        );
        const out = new Map<string, DriveMark>();
        for (const marked of markDrives(missing.filter((dataset) => pieces.has(dataset.id)), pieces, manifests)) {
          const mark: DriveMark = { pieces: marked.pieceCount, drive: marked.drive, ...(marked.driveName ? { driveName: marked.driveName } : {}) };
          saveDriveMark(chainId, address, marked.id, mark);
          out.set(marked.id, mark);
        }
        return out;
      })();
      const timeout = new Promise<Map<string, DriveMark>>((resolve) => setTimeout(() => resolve(new Map()), 12_000));
      fresh = await Promise.race([work.catch(() => new Map<string, DriveMark>()), timeout]);
    }
    return datasets.map((dataset, index) => {
      const mark = cached[index] ?? fresh.get(dataset.id);
      if (!mark) return dataset;
      return { ...dataset, drive: mark.drive, ...(mark.driveName ? { driveName: mark.driveName } : {}) };
    });
  }

  return {
    async discover() {
      wallets = await discoverWallets();
      return walletChoices(wallets.map((wallet) => ({ rdns: wallet.rdns, name: wallet.name })));
    },
    async connect(input) {
      if (!registryReady(input.chain)) throw new Error(REGISTRY_NOT_DEPLOYED);
      if (input.rdns === WALLETCONNECT_RDNS) {
        const connected = await connectWalletConnect({
          network: input.chain,
          origin: window.location.origin,
          init: initWalletConnect,
        });
        provider = watchWalletPrompts(connected.provider as Eip1193Provider);
        root = getAddress(connected.address);
        await ensureChain(provider, input.chain);
        rememberWallet(input.chain, WALLETCONNECT_RDNS);
        return;
      }
      await bindProvider(input.rdns);
      const ethereum = requireProvider();
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      connectPrompts += 1;
      const account = accounts[0];
      if (!account) throw new Error("The wallet did not return an account.");
      root = getAddress(account);
      await ensureChain(ethereum, input.chain);
      rememberWallet(input.chain, input.rdns || readStoredWallet()?.rdns || wallets[0]?.rdns || "window.ethereum");
      registryConfig(input.chain);
    },
    onWalletChange(fn) {
      walletChange = fn;
    },
    async silent(chain) {
      if (localStorage.getItem("fifolders:wallet-permitted") !== "1") return false;
      const stored = readStoredWallet();
      if (!stored || stored.chain !== chain) return false;
      await bindProvider(stored.rdns);
      const accounts = (await requireProvider().request({ method: "eth_accounts" })) as string[];
      const match = accounts.find((account) => account.toLowerCase() === stored.address.toLowerCase());
      if (!match) return false;
      root = getAddress(match);
      const ethereum = requireProvider();
      const current = (await ethereum.request({ method: "eth_chainId" })) as string;
      const want = inputChainId(chain);
      if (current.toLowerCase() !== want.toLowerCase()) await ensureChain(ethereum, chain);
      return true;
    },
    async snapshot(input) {
      const address = requireRoot();
      const client = publicClient(input.chain);
      const chain = chainOf(input.chain);
      const [fil, usdfc, legacy, datasets] = await Promise.all([
        client.getBalance({ address }),
        client.readContract({
          address: chain.contracts.usdfc.address,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>,
        legacyRegistry(input.chain, client),
        listDatasets(input.chain).then((list) => detectDrives(input.chain, input.volumeName, list)),
      ]);
      const stored = loadSession(chain.id, address);
      const now = BigInt(Math.floor(Date.now() / 1000));
      let gate: SessionGate = "expired";
      let soonest = stored ? BigInt(stored.expiry) : 0n;
      if (stored) {
        try {
          const expiries = await onchainExpiries(input.chain, stored.sessionAddress);
          rememberSoonest(stored, expiries);
          gate = sessionGateFromExpiries(expiries, now);
          // RPC nodes can lag the block that confirmed loginAndFund; trust our own fresh receipt.
          if (gate === "expired" && justAuthorized(stored, now)) gate = "ok";
          if (expiries.length) soonest = expiries.reduce((min, value) => (value < min ? value : min));
        } catch {
          gate = sessionUsable(stored, now) ? "ok" : "expired";
        }
      }
      const sessionReady = Boolean(stored && gate !== "expired");
      const remembered = selectedDataset || loadLastDataset(chain.id, address);
      const chosen = chooseDataset(datasets, remembered);
      const autoPicked = wasAutoPicked(datasets, remembered, chosen.selectedId);
      selectedDataset = chosen.selectedId ?? "";
      const pay = await readPayments(input.chain, address);
      return {
        address,
        fil: formatToken(fil),
        usdfc: formatToken(usdfc),
        deposit: formatToken(pay.deposited),
        availableFunds: pay.availableFunds.toString(),
        lockupRate: pay.lockupRate.toString(),
        paymentsReady: paymentsReady(pay.deposited, pay.approved),
        sessionReady,
        sessionExpiry: sessionReady ? formatExpiry(soonest) : "",
        datasets,
        selectedDatasetId: selectedDataset,
        createPrimary: datasets.length === 0,
        autoPicked,
        legacyRegistry: legacy,
        signatures,
        connectPrompts,
      };
    },
    async authorize(choice, force = false, report?: ChainReporter) {
      const address = requireRoot();
      const chain = chainOf(choice);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const existing = loadSession(chain.id, address);
      if (!force && existing && (await gateFor(choice)) !== "expired") return;
      const privateKey = existing?.privateKey ?? generatePrivateKey();
      const sessionKey = fromSecp256k1({
        privateKey,
        root: address,
        chain,
        transport: withTransientRetry(http(rpcOf(choice))),
      });
      const expiresAt = now + BigInt(SESSION_TTL_SEC);
      const permissions = fifoldersPermissions();
      const client = await walletClient(choice);
      const intent = sessionIntent();
      report?.({ flow: "session", phase: "signing", label: intentText(intent) });
      // Same browser, key still holds gas from an earlier login: re-authorize it without sending more tFIL.
      const leftover = existing ? await publicClient(choice).getBalance({ address: sessionKey.address }).catch(() => 0n) : 0n;
      const reuse = leftover >= SESSION_FUND_WEI / 2n;
      const hash = await withWalletIntent(intent, () => reuse
        ? client.writeContract({
            address: chain.contracts.sessionKeyRegistry.address,
            abi: chain.contracts.sessionKeyRegistry.abi,
            functionName: "login",
            args: [sessionKey.address, expiresAt, permissions, SESSION_ORIGIN],
            account: address,
            chain,
          })
        : client.writeContract({
            address: chain.contracts.sessionKeyRegistry.address,
            abi: chain.contracts.sessionKeyRegistry.abi,
            functionName: "loginAndFund",
            args: [sessionKey.address, expiresAt, permissions, SESSION_ORIGIN],
            value: SESSION_FUND_WEI,
            account: address,
            chain,
          }));
      signatures += SIGNATURES.sessionLogin;
      const receipt = await watchReceipt(choice, hash, "session", report);
      if (receipt.status !== "success") throw new Error("Session key login failed.");
      report?.({ flow: "session", phase: "done", hash });
      await sessionKey.syncExpirations(permissions);
      const stored: StoredSession = {
        v: 1,
        chainId: chain.id,
        root: address,
        privateKey,
        sessionAddress: sessionKey.address,
        expiry: expiresAt.toString(),
      };
      saveSession(stored);
      confirmedLogins.set(sessionKey.address.toLowerCase(), Date.now());
    },
    sessionGate(choice) {
      return gateFor(choice);
    },
    async refundSession(choice, report?: ChainReporter) {
      const address = requireRoot();
      const chain = chainOf(choice);
      const stored = loadSession(chain.id, address);
      if (!stored) return { refunded: 0n };
      const account = privateKeyToAccount(stored.privateKey as Hex);
      const reader = publicClient(choice);
      const balance = await reader.getBalance({ address: account.address });
      let refunded = 0n;
      if (balance > 0n) {
        const fees = await reader.estimateFeesPerGas();
        const maxFee = fees.maxFeePerGas ?? (await reader.getGasPrice());
        const gas = await reader.estimateGas({ account, to: address, value: 1n }).catch(() => 3_000_000n);
        // FEVM gas estimates are loose; keep a 30% margin so the sweep never underfunds itself.
        const reserve = ((gas * 13n) / 10n) * maxFee;
        if (balance > reserve) {
          const sender = createWalletClient({ account, chain, transport: withTransientRetry(http(rpcOf(choice))) });
          refunded = balance - reserve;
          const hash = await sender.sendTransaction({ account, chain, to: address, value: refunded, gas: (gas * 13n) / 10n, maxFeePerGas: maxFee });
          const receipt = await watchReceipt(choice, hash, "session", report);
          if (receipt.status !== "success") throw new Error("Refund transaction failed.");
          report?.({ flow: "session", phase: "done", hash });
        }
      }
      clearSession(chain.id, address);
      confirmedLogins.delete(stored.sessionAddress.toLowerCase());
      return { refunded };
    },
    async fixPayments(choice, report?: ChainReporter, force = false) {
      const address = requireRoot();
      const { Synapse } = await import("@filoz/synapse-sdk");
      const synapse = new Synapse({
        client: (await walletClient(choice)) as never,
        source: "fifolders",
      });
      const before = await readPayments(choice, address);
      if (!force && paymentsReady(before.deposited, before.approved)) return;
      // Funded but not max-approved (what uploads need): approve only, no second deposit.
      const approveOnly = before.deposited > 0n && !before.approved;
      const intent = approveOnly ? INTENTS.approvePayments : INTENTS.depositAndApprove(formatToken(PAYMENT_DEPOSIT));
      report?.({ flow: "payment", phase: "signing", label: intentText(intent) });
      const hash = await withWalletIntent(intent, () =>
        approveOnly
          ? synapse.payments.approveService()
          : synapse.payments.depositWithPermitAndApproveOperator({ amount: PAYMENT_DEPOSIT }),
      );
      if (!paymentsReady(before.deposited, before.approved)) signatures += SIGNATURES.paymentFix;
      await watchReceipt(choice, hash, "payment", report);
      report?.({ flow: "payment", phase: "done", hash });
    },
    async createDataset(input) {
      const address = requireRoot();
      const session = await sessionFor(input.chain, address);
      const { Synapse } = await import("@filoz/synapse-sdk");
      const synapse = Synapse.create({
        account: address,
        chain: chainOf(input.chain),
        transport: walletWithPublicReads(requireProvider(), rpcOf(input.chain)),
        source: "fifolders",
        sessionKey: session,
      });
      const createdAt = new Date().toISOString();
      const context = await synapse.storage.createContext({
        withCDN: false,
        metadata: { app: "fifolders", volume: input.volumeName, created: createdAt },
      });
      const providerId = context.provider.id.toString();
      const id = context.dataSetId != null ? context.dataSetId.toString() : `provider:${providerId}`;
      const record: DatasetRecord = {
        id,
        provider: shorten(context.serviceProvider),
        providerId,
        pieceCount: "0",
        size: "—",
        created: createdAt.slice(0, 10),
      };
      if (id.startsWith("provider:")) savePending(input.chain, address, record);
      saveLastDataset(chainOf(input.chain).id, address, id);
      selectedDataset = id;
    },
    selectDataset(id, choice) {
      selectedDataset = id;
      if (root) saveLastDataset(chainOf(choice).id, root, id);
    },
    async enter(input) {
      reportLoadStep("Finding your folders…");
      const address = requireRoot();
      const chain = chainOf(input.chain);
      const config = registryConfig(input.chain);
      const client = publicClient(input.chain);
      const legacy = await legacyRegistry(input.chain, client);
      reportLoadStep("Checking this browser's wallet session…");
      const session = await sessionFor(input.chain, address);
      reportLoadStep("Connecting to storage…");
      const { Synapse } = await import("@filoz/synapse-sdk");
      const synapse = Synapse.create({
        account: address,
        chain,
        transport: walletWithPublicReads(requireProvider(), rpcOf(input.chain)),
        source: "fifolders",
        sessionKey: session,
      });
      const datasetId = selectedDataset || loadLastDataset(chain.id, address) || "";
      // Cache the preferred dataset so the next visit can render it before the wallet connects.
      if (datasetId) saveLastDataset(chain.id, address, datasetId);
      const storageOptions = datasetId.startsWith("provider:")
        ? { providerId: BigInt(datasetId.slice("provider:".length) || "0") }
        : datasetId
          ? { dataSetId: BigInt(datasetId) }
          : {};
      installPieceDetails(input.chain, datasetId, synapse);
      const storage = withProviderFallback(createSynapseStorage(synapse, {
        ...storageOptions,
        copies: 2,
        onReplication: (notice) => {
          const checkpoint: UploadCheckpoint = {
            phase: notice.phase,
            expectedCopies: notice.expectedCopies,
            providers: notice.providers,
            checks: 0,
            nextCheckAt: 0,
            ...(notice.error ? { error: notice.error } : {}),
          };
          saveCheckpoint(`${address.toLowerCase()}:${input.volumeName}`, checkpoint);
        },
      }), input.chain);
      const registryWallet = legacy
        ? await walletClient(input.chain)
        : createWalletClient({
            account: privateKeyToAccount(loadSession(chain.id, address)!.privateKey),
            chain,
            transport: withTransientRetry(http(rpcOf(input.chain))),
          });
      const observed = observeRegistry(
        createViemRegistry({
      wrapMigration: labelMigration,
          address: config.address,
          publicClient: client,
          walletClient: registryWallet,
          fromBlock: config.fromBlock,
          signer: legacy ? "auto" : "session-key",
        }),
      );
      const cacheKey = `fifolders:volume-sig:${chain.id}:${address.toLowerCase()}:${config.address.toLowerCase()}:${input.volumeName}`;
      const wallet = await walletClient(input.chain);
      reportLoadStep("Reading your folders from Filecoin…");
      const volume = await openVolume({
        storage,
        registry: observed.registry,
        owner: address,
        name: input.volumeName,
        encryption: input.encrypt
          ? {
              signer: {
                signTypedData: async (parameters) => {
                  const cached = localStorage.getItem(cacheKey) as Hex | null;
                  if (cached) return cached;
                  const signature = await withWalletIntent(INTENTS.unlock, () => wallet.signTypedData(parameters as never));
                  localStorage.setItem(cacheKey, signature);
                  signatures += SIGNATURES.encryptSign;
                  return signature;
                },
              },
              mode: "eip712",
              chainId: chain.id,
              registryAddress: config.address,
            }
          : undefined,
      });
      const opened: Session = {
        volume,
        owner: address,
        chain: input.chain,
        encrypted: input.encrypt,
        volumeName: input.volumeName,
        cas: observed.cas,
      };
      return opened;
    },
    async peek(input) {
      reportLoadStep("Finding your folders…");
      const owner = input.owner ?? root ?? readStoredWallet()?.address;
      if (!owner) return null;
      const address = getAddress(owner);
      const chain = chainOf(input.chain);
      const config = registryConfig(input.chain);
      const client = publicClient(input.chain);
      const { Synapse } = await import("@filoz/synapse-sdk");
      // Public reads only: no wallet transport, so nothing here can prompt or sign.
      const synapse = Synapse.create({ account: address, chain, transport: publicTransport(input.chain), source: "fifolders" });
      let datasetId = selectedDataset || loadLastDataset(chain.id, address) || "";
      if (!datasetId || datasetId.startsWith("provider:")) {
        // New origin or cleared storage: find the owner's datasets on chain instead of showing nothing.
        const found = await synapse.storage.findDataSets({ address });
        const live = found.filter((dataset) => dataset.isLive !== false).map((dataset) => toDataset(input.chain, dataset));
        datasetId = chooseDataset(await detectDrives(input.chain, input.volumeName, live, address), null).selectedId ?? "";
      }
      if (!datasetId || datasetId.startsWith("provider:")) return null;
      installPieceDetails(input.chain, datasetId, synapse);
      const storage = withProviderFallback(createSynapseStorage(synapse, { dataSetId: BigInt(datasetId), copies: 2 }), input.chain);
      const observed = observeRegistry(
        createViemRegistry({
      wrapMigration: labelMigration,
          address: config.address,
          publicClient: client,
          walletClient: createWalletClient({ account: address, chain, transport: withTransientRetry(http(rpcOf(input.chain))) }),
          fromBlock: config.fromBlock,
          signer: "session-key",
        }),
      );
      const volume = await openVolume({ storage, registry: observed.registry, owner: address, name: input.volumeName });
      return { volume, owner: address, chain: input.chain, encrypted: false, volumeName: input.volumeName, cas: observed.cas };
    },
    async reopen(input) {
      return this.enter(input);
    },
    disconnect() {
      root = null;
      provider = null;
      localStorage.removeItem("fifolders:wallet-permitted");
      localStorage.removeItem(walletStorageKey());
    },
  };

  /** Session keys whose loginAndFund receipt succeeded in this tab, by address. */
  function justAuthorized(stored: StoredSession, nowSec: bigint): boolean {
    const at = confirmedLogins.get(stored.sessionAddress.toLowerCase());
    return Boolean(at && Date.now() - at < FRESH_LOGIN_MS && sessionUsable(stored, nowSec));
  }

  async function sessionFor(choice: ChainChoice, address: Address) {
    const chain = chainOf(choice);
    const stored = loadSession(chain.id, address);
    if (!stored) throw new Error("Authorize the session key first.");
    const expiry = BigInt(stored.expiry);
    const sessionKey = fromSecp256k1({
      privateKey: stored.privateKey,
      root: address,
      chain,
      transport: withTransientRetry(http(rpcOf(choice))),
      expirations: {
        [CreateDataSetPermission]: expiry,
        [AddPiecesPermission]: expiry,
        [SchedulePieceRemovalsPermission]: expiry,
        [DeleteDataSetPermission]: expiry,
        [folderCommitPermission()]: expiry,
      },
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    // Right after login the RPC may still read zero expiries; keep the stored ones instead.
    if (justAuthorized(stored, now)) return sessionKey;
    try {
      await sessionKey.syncExpirations(fifoldersPermissions());
    } catch {
      // A failed read keeps the stored expirations. Synapse.create still rejects a dead key.
    }
    const expiries = fifoldersPermissions().map((permission) => sessionKey.expirations[permission] ?? 0n);
    if (sessionGateFromExpiries(expiries, now) === "expired") throw new Error(SESSION_PERMISSION_ERROR);
    return sessionKey;
  }

  async function watchReceipt(choice: ChainChoice, hash: Hex, flow: "session" | "payment", report?: ChainReporter) {
    report?.({ flow, phase: "submitted", hash });
    const reader = publicClient(choice);
    const started = Date.now();
    const startBlock = await reader.getBlockNumber().catch(() => 0n);
    report?.({ flow, phase: "confirming", hash, blocks: 0, elapsedSec: 0 });
    const timer = setInterval(() => {
      void reader
        .getBlockNumber()
        .then((block) => {
          report?.({
            flow,
            phase: "confirming",
            hash,
            blocks: Number(block > startBlock ? block - startBlock : 0n),
            elapsedSec: Math.max(0, Math.round((Date.now() - started) / 1000)),
          });
        })
        .catch(() => undefined);
    }, 2000);
    try {
      return await reader.waitForTransactionReceipt({ hash });
    } finally {
      clearInterval(timer);
    }
  }

  async function readPayments(
    choice: ChainChoice,
    address: Address,
  ): Promise<{ deposited: bigint; approved: boolean; availableFunds: bigint; lockupRate: bigint }> {
    const { Synapse } = await import("@filoz/synapse-sdk");
    const synapse = new Synapse({
      client: createWalletClient({
        account: address,
        chain: chainOf(choice),
        transport: walletWithPublicReads(requireProvider(), rpcOf(choice)),
      }) as never,
      source: "fifolders",
    });
    const info = (await synapse.payments.accountInfo()) as { funds?: bigint; availableFunds?: bigint; lockupRate?: bigint };
    const approval = await synapse.payments.serviceApproval();
    const approved = isMaxApproved(approval);
    const availableFunds = info.availableFunds ?? info.funds ?? 0n;
    return { deposited: availableFunds, approved, availableFunds, lockupRate: info.lockupRate ?? 0n };
  }
}

function readStoredWallet(): StoredWallet | null {
  const raw = localStorage.getItem(walletStorageKey());
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredWallet;
    if (!parsed?.address || !parsed.rdns) return null;
    return parsed;
  } catch {
    return null;
  }
}

function inputChainId(chain: ChainChoice): string {
  return chain === "mainnet" ? "0x13a" : "0x4cb2f";
}

function toDataset(choice: ChainChoice, dataset: {
  dataSetId: bigint;
  serviceProvider?: string;
  providerId?: bigint;
  activePieceCount?: bigint;
  metadata?: Record<string, string>;
}): DatasetRecord {
  const id = dataset.dataSetId.toString();
  const meta = readMeta(choice, id);
  return {
    id,
    provider: dataset.serviceProvider ? shorten(dataset.serviceProvider) : `provider ${dataset.providerId?.toString() ?? "?"}`,
    providerId: dataset.providerId?.toString() ?? "",
    pieceCount: (dataset.activePieceCount ?? 0n).toString(),
    size: meta?.size ?? "—",
    created: dataset.metadata?.created?.slice(0, 10) || meta?.created || "—",
    ...(isDriveSource(dataset.metadata?.source) ? { source: FILECOIN_DRIVE_SOURCE } : {}),
  };
}

function shorten(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function pendingKey(choice: ChainChoice, root: Address): string {
  const chainId = choice === "mainnet" ? mainnet.id : calibration.id;
  return `fifolders:pending-datasets:${chainId}:${root.toLowerCase()}`;
}

function loadPending(choice: ChainChoice, root: Address): DatasetRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingKey(choice, root)) || "[]") as DatasetRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePending(choice: ChainChoice, root: Address, record: DatasetRecord): void {
  const list = loadPending(choice, root).filter((item) => item.id !== record.id);
  list.push(record);
  localStorage.setItem(pendingKey(choice, root), JSON.stringify(list));
}

async function initWalletConnect(config: ReturnType<typeof walletConnectConfig>): Promise<WalletConnectLike> {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  return EthereumProvider.init(config) as Promise<WalletConnectLike>;
}

function readMeta(choice: ChainChoice, id: string): { created?: string; size?: string } | null {
  const chainId = choice === "mainnet" ? mainnet.id : calibration.id;
  const raw = localStorage.getItem(`fifolders:dataset-meta:${chainId}:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { created?: string; size?: string };
  } catch {
    return null;
  }
}

const MAX_UINT256 = 2n ** 256n - 1n;
/** synapse-core LOCKUP_PERIOD: 30 days of 30 s epochs. */
const FWSS_LOCKUP_PERIOD = 30n * 2880n;

/** Same rule as synapse-core isFwssMaxApproved, which uploads check via prepare(). */
export function isMaxApproved(approval: unknown): boolean {
  if (Array.isArray(approval)) {
    const [isApproved, rateAllowance, lockupAllowance, , , maxLockupPeriod] = approval as unknown[];
    return isMaxApproved({ isApproved, rateAllowance, lockupAllowance, maxLockupPeriod });
  }
  if (!approval || typeof approval !== "object") return false;
  const a = approval as { isApproved?: unknown; rateAllowance?: unknown; lockupAllowance?: unknown; maxLockupPeriod?: unknown };
  const big = (value: unknown) => (typeof value === "bigint" ? value : typeof value === "number" ? BigInt(Math.trunc(value)) : 0n);
  return Boolean(a.isApproved) && big(a.rateAllowance) === MAX_UINT256 && big(a.lockupAllowance) >= MAX_UINT256 / 2n && big(a.maxLockupPeriod) >= FWSS_LOCKUP_PERIOD;
}

function safeCid(bytes: Uint8Array): string {
  try {
    return bytes.length ? bytesToPieceCid(bytes) : "";
  } catch {
    return "";
  }
}
