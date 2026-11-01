import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  MemoryRegistry,
  MemoryStorage,
  openVolume,
  type EncryptionSigner,
  type Volume,
} from "../src/index.js";

export const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export const ownerAccount = privateKeyToAccount(OWNER_KEY);
export const OWNER = ownerAccount.address;

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function signerOf(account: PrivateKeyAccount): EncryptionSigner {
  return {
    signTypedData: (parameters) => account.signTypedData(parameters as never),
    signMessage: (parameters) => account.signMessage(parameters),
  };
}

export async function makeVolume(options?: {
  name?: string;
  storage?: MemoryStorage;
  registry?: MemoryRegistry;
  encryption?: boolean | "personal_sign";
  dirThreshold?: number;
}): Promise<{ volume: Volume; storage: MemoryStorage; registry: MemoryRegistry }> {
  const storage = options?.storage ?? new MemoryStorage();
  const registry = options?.registry ?? new MemoryRegistry(OWNER);
  const mode = options?.encryption === "personal_sign" ? "personal_sign" : "eip712";
  const volume = await openVolume({
    storage,
    registry,
    owner: OWNER,
    name: options?.name ?? "demo",
    dirThreshold: options?.dirThreshold,
    now: () => 1_700_000_000_000,
    encryption: options?.encryption
      ? {
          signer: signerOf(ownerAccount),
          mode,
          chainId: 314159,
          registryAddress: "0x00000000000000000000000000000000000000c0",
        }
      : undefined,
  });
  return { volume, storage, registry };
}

export function contains(haystack: Uint8Array, needle: string): boolean {
  const encoded = text(needle);
  outer: for (let i = 0; i + encoded.length <= haystack.length; i++) {
    for (let j = 0; j < encoded.length; j++) {
      if (haystack[i + j] !== encoded[j]) continue outer;
    }
    return true;
  }
  return false;
}
