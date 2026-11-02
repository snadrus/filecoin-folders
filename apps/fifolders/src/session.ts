import { calibration } from "@filoz/synapse-core/chains";
import {
  MemoryRegistry,
  MemoryStorage,
  RegistryCasConflict,
  createViemRegistry,
  openVolume,
  type Registry,
  type Volume,
} from "fil-folders";
import { mainnetRegistryAddress } from "./network.js";
import { restoreMemoryVolume } from "./volume-persist.js";
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { filecoinCalibration } from "viem/chains";

export const CALIBRATION_REGISTRY = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331" as const;
export const CALIBRATION_FROM_BLOCK = 4207373n;
export const CALIBRATION_RPC = "https://api.calibration.node.glif.io/rpc/v1";
export const MAINNET_RPC = "https://api.node.glif.io/rpc/v1";
export const E2E_OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
export const DEFAULT_VOLUME = "My Drive";
export const DEFAULT_FELARUMI = "./fipen/";
export const DEFAULT_FELANUMIO = "./figrid/";

export type ChainChoice = "calibration" | "mainnet";

export interface CasObserver {
  takeMerged(): boolean;
}

export interface Session {
  volume: Volume;
  owner: Address;
  chain: ChainChoice;
  encrypted: boolean;
  volumeName: string;
  cas: CasObserver;
}

export function observeRegistry(inner: Registry): { registry: Registry; cas: CasObserver } {
  let merged = false;
  const registry: Registry = {
    head: (owner, ns, key) => inner.head(owner, ns, key),
    commit: async (input) => {
      try {
        return await inner.commit(input);
      } catch (error) {
        if (error instanceof RegistryCasConflict) merged = true;
        throw error;
      }
    },
    setWriter: (ns, writer, allowed) => inner.setWriter(ns, writer, allowed),
    isWriter: (owner, ns, writer) => inner.isWriter(owner, ns, writer),
    committed: (query) => inner.committed(query),
  };
  return {
    registry,
    cas: {
      takeMerged() {
        const value = merged;
        merged = false;
        return value;
      },
    },
  };
}

export async function openMockSession(volumeName = DEFAULT_VOLUME): Promise<Session & { registry: MemoryRegistry }> {
  const registry = new MemoryRegistry(E2E_OWNER);
  const observed = observeRegistry(registry);
  const volume = await openVolume({
    storage: new MemoryStorage(),
    registry: observed.registry,
    owner: E2E_OWNER,
    name: volumeName,
  });
  if (import.meta.env.VITE_E2E === "1") await restoreMemoryVolume(volume, E2E_OWNER, volumeName);
  return {
    volume,
    owner: E2E_OWNER,
    chain: "calibration",
    encrypted: false,
    volumeName,
    cas: observed.cas,
    registry,
  };
}

export function chainParams(chain: ChainChoice): {
  chainId: Hex;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
} {
  if (chain === "calibration") {
    return {
      chainId: "0x4cb2f",
      chainName: "Filecoin Calibration",
      rpcUrls: [CALIBRATION_RPC],
      nativeCurrency: { name: "testnet filecoin", symbol: "tFIL", decimals: 18 },
    };
  }
  return {
    chainId: "0x13a",
    chainName: "Filecoin",
    rpcUrls: [MAINNET_RPC],
    nativeCurrency: { name: "filecoin", symbol: "FIL", decimals: 18 },
  };
}

export async function ensureChain(ethereum: Eip1193Provider, chain: ChainChoice): Promise<void> {
  const params = chainParams(chain);
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number((error as { code: number }).code) : 0;
    if (code !== 4902) throw error;
    await ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

export async function connectInjected(options: {
  ethereum: Eip1193Provider;
  chain: ChainChoice;
  volumeName: string;
  encrypt: boolean;
}): Promise<Session> {
  if (options.chain === "mainnet" && !mainnetRegistryAddress()) {
    throw new Error("Registry not deployed");
  }
  const accounts = (await options.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const owner = accounts[0];
  if (!owner) throw new Error("The wallet did not return an account.");
  await ensureChain(options.ethereum, "calibration");
  const account = owner as Address;
  const walletClient = createWalletClient({
    account,
    chain: calibration,
    transport: custom(options.ethereum),
  });
  const publicClient = createPublicClient({
    chain: filecoinCalibration,
    transport: http(CALIBRATION_RPC),
  });
  const { Synapse } = await import("@filoz/synapse-sdk");
  const synapse = new Synapse({
    client: walletClient as never,
    source: "fifolders",
  });
  const observed = observeRegistry(
    createViemRegistry({
      address: CALIBRATION_REGISTRY,
      publicClient,
      walletClient,
      fromBlock: CALIBRATION_FROM_BLOCK,
    }),
  );
  const volume = await openVolume({
    synapse,
    registry: observed.registry,
    owner: account,
    name: options.volumeName,
    encryption: options.encrypt
      ? {
          signer: {
            signTypedData: (parameters) => walletClient.signTypedData(parameters as never),
            signMessage: (parameters) => walletClient.signMessage(parameters),
          },
          mode: "eip712",
          chainId: calibration.id,
          registryAddress: CALIBRATION_REGISTRY,
        }
      : undefined,
  });
  return {
    volume,
    owner: account,
    chain: "calibration",
    encrypted: options.encrypt,
    volumeName: options.volumeName,
    cas: observed.cas,
  };
}

export function storedVolumeName(): string {
  return localStorage.getItem("fifolders:volume-name") || DEFAULT_VOLUME;
}

export function storeVolumeName(name: string): void {
  localStorage.setItem("fifolders:volume-name", name);
}

export function storedEncrypt(chain: ChainChoice, owner: string, volume: string): boolean {
  return localStorage.getItem(`fifolders:enc:${chain}:${owner.toLowerCase()}:${volume}`) === "1";
}

export function storeEncrypt(chain: ChainChoice, owner: string, volume: string, encrypt: boolean): void {
  localStorage.setItem(`fifolders:enc:${chain}:${owner.toLowerCase()}:${volume}`, encrypt ? "1" : "0");
}

function editorUrl(keys: readonly string[], envKeys: readonly string[], fallback: string): string {
  for (const key of keys) {
    const stored = localStorage.getItem(key);
    if (stored) return stored;
  }
  const env = import.meta.env as Record<string, string | undefined>;
  for (const key of envKeys) {
    if (env[key]) return env[key];
  }
  return fallback;
}

export function felBases(): { felarumi: string; felanumio: string } {
  return {
    felarumi: editorUrl(["fifolders:fipen-url", "fifolders:felarumi-url"], ["VITE_FIPEN_URL", "VITE_FELARUMI_URL"], DEFAULT_FELARUMI),
    felanumio: editorUrl(["fifolders:figrid-url", "fifolders:felanumio-url"], ["VITE_FIGRID_URL", "VITE_FELANUMIO_URL"], DEFAULT_FELANUMIO),
  };
}

export function storeFelUrl(kind: "felarumi" | "felanumio", url: string): void {
  localStorage.setItem(kind === "felarumi" ? "fifolders:fipen-url" : "fifolders:figrid-url", url);
}
