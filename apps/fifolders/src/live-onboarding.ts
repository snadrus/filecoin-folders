import { calibration, mainnet, type Chain } from "@filoz/synapse-core/chains";
import {
  AddPiecesPermission,
  CreateDataSetPermission,
  DeleteDataSetPermission,
  SchedulePieceRemovalsPermission,
  fromSecp256k1,
} from "@filoz/synapse-core/session-key";
import { createSynapseStorage, createViemRegistry, folderCommitPermission, folderRegistryAbi, openVolume } from "fil-folders";
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
import { discoverWallets, type AnnouncedWallet } from "./eip6963.js";
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
  paymentsReady,
  saveLastDataset,
  saveSession,
  sessionUsable,
  walletStorageKey,
  type DatasetRecord,
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
export function createLiveOnboarding(): OnboardingIO {
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
      transport: custom(requireProvider()),
    });
  }

  function publicClient(choice: ChainChoice): PublicClient {
    return createPublicClient({ chain: chainOf(choice), transport: http(rpcOf(choice)) });
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
    try {
      const config = registryConfig(choice);
      const permission = await client.readContract({
        address: config.address,
        abi: folderRegistryAbi,
        functionName: "PERMISSION_COMMIT",
      });
      return permission !== folderCommitPermission();
    } catch {
      return true;
    }
  }

  function rememberWallet(choice: ChainChoice, rdns: string): void {
    const stored: StoredWallet = { rdns, address: requireRoot(), chain: choice };
    localStorage.setItem(walletStorageKey(), JSON.stringify(stored));
    localStorage.setItem("fifolders:wallet-permitted", "1");
  }

  async function bindProvider(rdns: string | null): Promise<void> {
    wallets = await discoverWallets();
    const match = rdns ? wallets.find((wallet) => wallet.rdns === rdns) : undefined;
    const stored = readStoredWallet();
    const remembered = stored ? wallets.find((wallet) => wallet.rdns === stored.rdns) : undefined;
    const chosen = match ?? remembered ?? wallets[0];
    provider = chosen?.provider ?? window.ethereum ?? null;
    if (!provider) throw new Error("No injected wallet found. Install a browser wallet such as MetaMask.");
  }

  async function onchainExpiry(choice: ChainChoice, sessionAddress: Address): Promise<bigint> {
    const chain = chainOf(choice);
    const client = publicClient(choice);
    return (await client.readContract({
      address: chain.contracts.sessionKeyRegistry.address,
      abi: chain.contracts.sessionKeyRegistry.abi,
      functionName: "authorizationExpiry",
      args: [requireRoot(), sessionAddress, folderCommitPermission()],
    })) as bigint;
  }

  async function listDatasets(choice: ChainChoice): Promise<DatasetRecord[]> {
    const { Synapse } = await import("@filoz/synapse-sdk");
    const synapse = Synapse.create({
      account: requireRoot(),
      chain: chainOf(choice),
      transport: custom(requireProvider()),
      source: "fifolders",
    });
    const found = await synapse.storage.findDataSets({ address: requireRoot() });
    const remote = found.filter((dataset) => dataset.isLive !== false).map((dataset) => toDataset(choice, dataset));
    const pending = loadPending(choice, requireRoot());
    const ids = new Set(remote.map((dataset) => dataset.id));
    return [...remote, ...pending.filter((dataset) => !ids.has(dataset.id))];
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
        provider = connected.provider as Eip1193Provider;
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
        listDatasets(input.chain),
      ]);
      const stored = loadSession(chain.id, address);
      const now = BigInt(Math.floor(Date.now() / 1000));
      let onchain = 0n;
      if (stored && sessionUsable(stored, now)) {
        try {
          onchain = await onchainExpiry(input.chain, stored.sessionAddress);
        } catch {
          onchain = 0n;
        }
      }
      const sessionReady = Boolean(stored && sessionUsable(stored, now) && onchain > now);
      const remembered = selectedDataset || loadLastDataset(chain.id, address);
      const chosen = chooseDataset(datasets, remembered);
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
        sessionExpiry: sessionReady && stored ? formatExpiry(BigInt(stored.expiry)) : "",
        datasets,
        selectedDatasetId: selectedDataset,
        createPrimary: datasets.length === 0,
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
      if (!force && existing && sessionUsable(existing, now)) {
        const expiry = await onchainExpiry(choice, existing.sessionAddress);
        if (expiry > now) return;
      }
      const privateKey = generatePrivateKey();
      const sessionKey = fromSecp256k1({
        privateKey,
        root: address,
        chain,
        transport: http(rpcOf(choice)),
      });
      const expiresAt = now + BigInt(SESSION_TTL_SEC);
      const permissions = fifoldersPermissions();
      const client = await walletClient(choice);
      report?.({ flow: "session", phase: "signing" });
      const hash = await client.writeContract({
        address: chain.contracts.sessionKeyRegistry.address,
        abi: chain.contracts.sessionKeyRegistry.abi,
        functionName: "loginAndFund",
        args: [sessionKey.address, expiresAt, permissions, SESSION_ORIGIN],
        value: SESSION_FUND_WEI,
        account: address,
        chain,
      });
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
      report?.({ flow: "payment", phase: "signing" });
      const hash = await synapse.payments.depositWithPermitAndApproveOperator({ amount: PAYMENT_DEPOSIT });
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
        transport: custom(requireProvider()),
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
      const address = requireRoot();
      const chain = chainOf(input.chain);
      const config = registryConfig(input.chain);
      const client = publicClient(input.chain);
      const legacy = await legacyRegistry(input.chain, client);
      const session = await sessionFor(input.chain, address);
      const { Synapse } = await import("@filoz/synapse-sdk");
      const synapse = Synapse.create({
        account: address,
        chain,
        transport: custom(requireProvider()),
        source: "fifolders",
        sessionKey: session,
      });
      const datasetId = selectedDataset || loadLastDataset(chain.id, address) || "";
      const storageOptions = datasetId.startsWith("provider:")
        ? { providerId: BigInt(datasetId.slice("provider:".length) || "0") }
        : datasetId
          ? { dataSetId: BigInt(datasetId) }
          : {};
      const storage = createSynapseStorage(synapse, {
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
      });
      const registryWallet = legacy
        ? await walletClient(input.chain)
        : createWalletClient({
            account: privateKeyToAccount(loadSession(chain.id, address)!.privateKey),
            chain,
            transport: http(rpcOf(input.chain)),
          });
      const observed = observeRegistry(
        createViemRegistry({
          address: config.address,
          publicClient: client,
          walletClient: registryWallet,
          fromBlock: config.fromBlock,
          signer: legacy ? "auto" : "session-key",
        }),
      );
      const cacheKey = `fifolders:volume-sig:${chain.id}:${address.toLowerCase()}:${config.address.toLowerCase()}:${input.volumeName}`;
      const wallet = await walletClient(input.chain);
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
                  const signature = await wallet.signTypedData(parameters as never);
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
    disconnect() {
      root = null;
      provider = null;
      localStorage.removeItem("fifolders:wallet-permitted");
      localStorage.removeItem(walletStorageKey());
    },
  };

  async function sessionFor(choice: ChainChoice, address: Address) {
    const chain = chainOf(choice);
    const stored = loadSession(chain.id, address);
    if (!stored) throw new Error("Authorize the session key first.");
    const expiry = BigInt(stored.expiry);
    const sessionKey = fromSecp256k1({
      privateKey: stored.privateKey,
      root: address,
      chain,
      transport: http(rpcOf(choice)),
      expirations: {
        [CreateDataSetPermission]: expiry,
        [AddPiecesPermission]: expiry,
        [SchedulePieceRemovalsPermission]: expiry,
        [DeleteDataSetPermission]: expiry,
        [folderCommitPermission()]: expiry,
      },
    });
    try {
      await sessionKey.syncExpirations(fifoldersPermissions());
    } catch {
      // The stored expiry still lets local signing proceed. The chain check happens on the next snapshot.
    }
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
        transport: custom(requireProvider()),
      }) as never,
      source: "fifolders",
    });
    const info = (await synapse.payments.accountInfo()) as { funds?: bigint; availableFunds?: bigint; lockupRate?: bigint };
    const approval = await synapse.payments.serviceApproval();
    const approved =
      (typeof approval === "object" && approval !== null && "isApproved" in approval && Boolean(approval.isApproved)) ||
      (Array.isArray(approval) && Boolean(approval[0]));
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
