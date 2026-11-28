/**
 * Hooks the live onboarding calls for private data sets. Each returns quickly (null) for public data sets.
 */
import type { Address, Hex } from "viem";
import { createSynapseStorage, type Storage, type SynapseStorageOptions, type Volume } from "fil-folders";
import { installPrivateShares, privateCredential, privateCreateMetadata, privateVolumeName, privateVolumeParts, type WalletSigner } from "./private-volume.js";
import { knownVisibility, rememberVisibility, visibilityOf, type Visibility } from "./visibility.js";
import { setPrivateShareMaker } from "./share-hook.js";

type Prompt = <T>(intent: object, run: () => Promise<T>) => Promise<T>;

interface ContextLike {
  dataSetMetadata?: Record<string, string>;
  provider?: { pdp?: { serviceURL?: string }; id?: bigint };
}

interface SynapseLike {
  storage: { createContext(options: unknown): Promise<unknown> };
}

const pendingKey = (chainId: number, owner: string, providerId: string) => `fifolders:pending-private:${chainId}:${owner.toLowerCase()}:${providerId}`;

/** Remember the metadata of a private data set that opens on its first upload. */
export function savePendingPrivate(chainId: number, owner: string, providerId: string, metadata: Record<string, string>): void {
  localStorage.setItem(pendingKey(chainId, owner, providerId), JSON.stringify(metadata));
}

function pendingPrivate(chainId: number, owner: string, providerId: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(pendingKey(chainId, owner, providerId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** createDataset: metadata for a private data set (GroupKey signature), or null for a public one. */
export async function createDatasetMetadata(input: {
  visibility?: "public" | "private";
  wallet: WalletSigner | null;
  chainId: number;
  base: Record<string, string>;
  prompt: Prompt;
}): Promise<Record<string, string> | null> {
  if (input.visibility !== "private") return null;
  if (!input.wallet) throw new Error("Private folders need a wallet sign-in (passkey and sponsored accounts cannot sign the encryption key).");
  return privateCreateMetadata(input.wallet, input.chainId, input.base, input.prompt);
}

/** Record the visibility of a data set seen in a listing. */
export function noteVisibility(chainId: number, id: string, metadata: Record<string, string> | undefined): Visibility {
  const v = visibilityOf(metadata);
  rememberVisibility(chainId, id, v);
  return v;
}

/** enter: when the selected data set is private, the storage, encryption and registry name to open it with. */
export async function privateEnter(input: {
  synapse: SynapseLike;
  datasetId: string;
  chain: "calibration" | "mainnet";
  chainId: number;
  owner: Address;
  wallet: WalletSigner | null;
  session: { privateKey: Hex; expiry: string } | null;
  volumeName: string;
  storageOptions: SynapseStorageOptions;
  wrap: (storage: Storage) => Storage;
  prompt: Prompt;
}): Promise<{ storage: Storage; encryption: { key: Uint8Array; perFileKeys: true }; name: string; opened(volume: Volume): void } | null> {
  setPrivateShareMaker(null);
  const { datasetId } = input;
  let metadata: Record<string, string> | null = null;
  let context: ContextLike | null = null;
  if (datasetId.startsWith("provider:")) {
    metadata = pendingPrivate(input.chainId, input.owner, datasetId.slice("provider:".length));
    if (!metadata) return null;
    context = (await input.synapse.storage.createContext({ providerId: BigInt(datasetId.slice("provider:".length)), withCDN: false })) as ContextLike;
  } else if (/^\d+$/.test(datasetId)) {
    const known = knownVisibility(input.chainId, datasetId);
    if (known && known !== "private") return null;
    context = (await input.synapse.storage.createContext({ dataSetId: BigInt(datasetId), withCDN: false })) as ContextLike;
    metadata = context.dataSetMetadata ?? {};
    if (noteVisibility(input.chainId, datasetId, metadata) !== "private") return null;
  } else {
    return null;
  }
  if (!input.wallet) throw new Error("This dataset is private. Sign in with the wallet that owns it to open it.");
  if (!input.session) throw new Error("Authorize the session key first.");
  const providers = [context?.provider?.pdp?.serviceURL].filter((u): u is string => Boolean(u));
  console.info("TreFolders private dataset", datasetId, "providers", providers.join(",") || "(none)");
  const credential = await privateCredential({
    chainId: input.chainId,
    wallet: input.wallet,
    session: { privateKey: input.session.privateKey, expiry: Number(input.session.expiry) },
    ...(metadata?.["foc/kc"] ? { commitment: metadata["foc/kc"] } : {}),
    prompt: input.prompt,
  });
  // One copy: Curio cannot replicate a private piece to a second provider yet.
  const inner = createSynapseStorage(input.synapse as never, {
    ...input.storageOptions,
    copies: 1,
    ...(datasetId.startsWith("provider:") && metadata ? { dataSetMetadata: metadata } : {}),
  });
  const parts = await privateVolumeParts({ inner, providers, credential, volumeName: input.volumeName });
  return {
    storage: input.wrap(parts.storage),
    encryption: parts.encryption,
    name: privateVolumeName(input.volumeName),
    opened(volume) {
      installPrivateShares({ volume, credential, labels: parts.labels, storage: parts.storage, providers, chain: input.chain, chainId: input.chainId });
    },
  };
}
