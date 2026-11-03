import { calibration, mainnet } from "@filoz/synapse-core/chains";
import {
  createSynapseStorage,
  createViemRegistry,
  decodeIdentity,
  encodeIdentity,
  fetchPieceFromProviders,
  identityNamespace,
  identityPointerBytes,
  identityProfileKey,
  resolveIdentity,
  bytesToPieceCid,
  type IdentityV1,
} from "fil-folders";
import { createPublicClient, createWalletClient, custom, getAddress, http, type Address, type Chain, type PublicClient } from "viem";
import { discoverWallets } from "../eip6963.js";
import { readNetworkPreference } from "../network.js";
import { CALIBRATION_FROM_BLOCK, CALIBRATION_REGISTRY, CALIBRATION_RPC, MAINNET_RPC, ensureChain, type ChainChoice } from "../session.js";
import { INTENTS, watchWalletPrompts, withWalletIntent } from "../wallet-prompts.js";
import { IDENTITY_INTENTS, IdentityBlocked, type IdentityIO } from "./io.js";

type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown> };

function chainOf(choice: ChainChoice): Chain {
  return (choice === "mainnet" ? mainnet : calibration) as Chain;
}

function registryOf(choice: ChainChoice): { address: Address; fromBlock: bigint } {
  if (choice === "mainnet") {
    const address = import.meta.env.VITE_FOLDER_REGISTRY_MAINNET;
    if (!address) throw new IdentityBlocked("FolderRegistry is not deployed on mainnet yet. Switch FiFolders to Calibration.");
    return { address: getAddress(address), fromBlock: BigInt(import.meta.env.VITE_REGISTRY_FROM_BLOCK_MAINNET || "0") };
  }
  return { address: CALIBRATION_REGISTRY, fromBlock: CALIBRATION_FROM_BLOCK };
}

/** Same chain + storage FiFolders uses: FolderRegistry pointer, Synapse piece in the wallet's FiFolders dataset. */
export function createLiveIdentityIO(choice: ChainChoice = readNetworkPreference()): IdentityIO {
  let provider: Provider | null = null;
  const chain = chainOf(choice);
  const rpc = choice === "mainnet" ? MAINNET_RPC : CALIBRATION_RPC;
  const client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const publicTransport = custom({ request: (args: { method: string; params?: unknown }) => client.request(args as never) });

  async function getProvider(): Promise<Provider> {
    if (provider) return provider;
    const wallets = await discoverWallets();
    const raw = wallets[0]?.provider ?? (window as unknown as { ethereum?: Provider }).ethereum;
    if (!raw) throw new Error("No browser wallet found. Install one such as MetaMask.");
    provider = watchWalletPrompts(raw);
    return provider;
  }

  let providerUrls: Promise<string[]> | null = null;
  async function fetchPiece(pieceCid: string): Promise<Uint8Array> {
    const { Synapse } = await import("@filoz/synapse-sdk");
    try {
      const synapse = Synapse.create({ account: "0x0000000000000000000000000000000000000001", chain, transport: publicTransport, source: "fifolders" } as never);
      return await createSynapseStorage(synapse as never).get(pieceCid);
    } catch {
      providerUrls ??= import("@filoz/synapse-core/sp-registry")
        .then(({ getPDPProviders }) => getPDPProviders(client as never, { onlyActive: true, limit: 200n } as never))
        .then((out) => out.providers.map((p) => p.pdp?.serviceURL ?? (p as unknown as { serviceURL?: string }).serviceURL ?? "").filter(Boolean))
        .catch(() => [] as string[]);
      return fetchPieceFromProviders(pieceCid, await providerUrls, (bytes) => decodeIdentity(bytes) !== null);
    }
  }

  function readRegistry(address: Address) {
    return createViemRegistry({
      ...registryOf(choice),
      publicClient: client,
      walletClient: createWalletClient({ account: address, chain, transport: http(rpc) }),
      scanCache: null,
    });
  }

  return {
    async peek() {
      try {
        const accounts = (await (await getProvider()).request({ method: "eth_accounts" })) as string[];
        return accounts?.[0]?.toLowerCase() || null;
      } catch {
        return null;
      }
    },
    async connect() {
      const p = await getProvider();
      const accounts = (await withWalletIntent(INTENTS.connect, () => p.request({ method: "eth_requestAccounts" }))) as string[];
      const address = accounts?.[0]?.toLowerCase();
      if (!address) throw new Error("The wallet returned no account.");
      return address;
    },
    async load(address) {
      const registry = readRegistry(address as Address);
      return resolveIdentity(address, { head: (o, n, k) => registry.head(o, n, k), fetchPiece, force: true });
    },
    async save(address, identity: IdentityV1, onStep) {
      const owner = getAddress(address);
      const p = await getProvider();
      onStep("Checking your storage setup…");
      await ensureChain(p as never, choice);
      const { Synapse } = await import("@filoz/synapse-sdk");
      const reader = new Synapse({ client: createWalletClient({ account: owner, chain, transport: publicTransport }) as never, source: "fifolders" } as never);
      const info = (await reader.payments.accountInfo()) as { funds?: bigint; availableFunds?: bigint };
      const approval = (await reader.payments.serviceApproval()) as unknown;
      const approved = Array.isArray(approval) ? Boolean(approval[0]) : Boolean((approval as { isApproved?: boolean } | null)?.isApproved);
      if (!((info.availableFunds ?? info.funds ?? 0n) > 0n) || !approved) {
        // Never approve or deposit from here: that is FiFolders' job, with its own cost screen.
        throw new IdentityBlocked("Storage payments are not set up for this wallet. Finish setup in FiFolders (it shows the cost first), then save again.");
      }
      const found = await reader.storage.findDataSets({ address: owner });
      const live = found.filter((d: { isLive?: boolean }) => d.isLive !== false);
      const last = localStorage.getItem(`fifolders:dataset:${chain.id}:${owner.toLowerCase()}`);
      const dataset = live.find((d: { dataSetId: bigint }) => d.dataSetId.toString() === last) ?? live[live.length - 1];
      if (!dataset) {
        // Creating a dataset reserves USDFC: leave it to FiFolders.
        throw new IdentityBlocked("This wallet has no storage dataset yet. Create one in FiFolders (it shows the cost first), then save again.");
      }

      onStep("Storing your identity piece…");
      const synapse = Synapse.create({ account: owner, chain, transport: custom(p), source: "fifolders" } as never);
      const storage = createSynapseStorage(synapse as never, { dataSetId: BigInt(dataset.dataSetId) });
      const { pieceCid } = await withWalletIntent(IDENTITY_INTENTS.upload, () => storage.put(encodeIdentity(identity)));

      onStep("Linking it to your wallet…");
      const registry = createViemRegistry({
        ...registryOf(choice),
        publicClient: client,
        walletClient: createWalletClient({ account: owner, chain, transport: custom(p) }),
        signer: "auto",
        scanCache: null,
      });
      const ns = identityNamespace();
      const key = identityProfileKey();
      const head = await registry.head(owner, ns, key);
      const record = await withWalletIntent(IDENTITY_INTENTS.pointer, () =>
        registry.commit({ owner, ns, key, pieceCid: identityPointerBytes(pieceCid), prevPieceCid: head.pieceCid }),
      );
      return { pieceCid: bytesToPieceCid(record.pieceCid), version: record.version.toString(), txHash: record.txHash };
    },
  };
}
