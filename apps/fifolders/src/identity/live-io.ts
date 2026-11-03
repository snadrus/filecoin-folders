import { calibration, mainnet } from "@filoz/synapse-core/chains";
import { createSynapseStorage, createViemRegistry } from "fil-folders";
import { assertStorageReady, saveIdentity, type IdentityV1 } from "fiperson/edit";
import { createPublicClient, createWalletClient, custom, getAddress, http, type Address, type Chain, type PublicClient } from "viem";
import { discoverWallets } from "../eip6963.js";
import { readNetworkPreference } from "../network.js";
import { CALIBRATION_FROM_BLOCK, CALIBRATION_REGISTRY, CALIBRATION_RPC, MAINNET_RPC, ensureChain, type ChainChoice } from "../session.js";
import { INTENTS, watchWalletPrompts, withWalletIntent } from "../wallet-prompts.js";
import { IdentityBlocked, type IdentityIO } from "./io.js";
import { resolvePerson } from "../person.js";

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
    load: (address) => resolvePerson(address, choice, true),
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
      const found = await reader.storage.findDataSets({ address: owner });
      const live = found.filter((d: { isLive?: boolean }) => d.isLive !== false);
      const last = localStorage.getItem(`fifolders:dataset:${chain.id}:${owner.toLowerCase()}`);
      const dataset = live.find((d: { dataSetId: bigint }) => d.dataSetId.toString() === last) ?? live[live.length - 1];
      // Never approves, deposits or creates a dataset: those are FiFolders' cost-labeled steps.
      assertStorageReady({ funds: info.availableFunds ?? info.funds ?? 0n, approved, datasetId: dataset ? BigInt(dataset.dataSetId) : null });
      const synapse = Synapse.create({ account: owner, chain, transport: custom(p), source: "fifolders" } as never);
      const storage = createSynapseStorage(synapse as never, { dataSetId: BigInt(dataset!.dataSetId) });
      const registry = createViemRegistry({
        ...registryOf(choice),
        publicClient: client,
        walletClient: createWalletClient({ account: owner, chain, transport: custom(p) }),
        signer: "auto",
        scanCache: null,
      });
      return saveIdentity(identity as IdentityV1, { storage, registry, onStep, withIntent: (intent, fn) => withWalletIntent(intent, fn) });
    },
  };
}
