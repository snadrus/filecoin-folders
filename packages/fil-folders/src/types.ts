import type { Address, Hex } from "viem";

/** AES-GCM parameters for one file's ciphertext. Names are encrypted only in the manifest. */
export interface ContentEnc {
  alg: "A256GCM";
  iv: string;
}

export interface FileNode {
  type: "file";
  name: string;
  pieceCid: string;
  size: number;
  mtime: number;
  mime?: string;
  enc?: ContentEnc;
}

export interface DirNode {
  type: "dir";
  name: string;
  mtime: number;
  entries: Node[];
}

export type Node = FileNode | DirNode;

export interface ManifestEnc {
  alg: "A256GCM";
  /** Content IV. Present on encrypted files. */
  iv?: string;
  /** Name IV. Present on every entry when volume encryption is on. */
  nameIv?: string;
}

export interface ManifestEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
  pieceCid?: string;
  mime?: string;
  enc?: ManifestEnc;
  /** Inlined children. Absent when this directory is stored as its own piece. */
  entries?: ManifestEntry[];
}

export interface Manifest {
  v: 1;
  mtime: number;
  entries: ManifestEntry[];
}

export interface Stat {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
  mime?: string;
  pieceCid?: string;
}

export interface HistoryEntry {
  version: bigint;
  pieceCid: string;
  prevPieceCid: string;
  timestamp: number;
  txHash?: Hex;
  path?: string;
  change?: "added" | "updated" | "removed";
}

export interface PutOptions {
  mime?: string;
}

export interface RmOptions {
  recursive?: boolean;
}

/** Subset of `@filoz/synapse-sdk` `Synapse` used by {@link createSynapseStorage}. */
export interface SynapseLike {
  storage: {
    upload(
      data: Uint8Array | ReadableStream<Uint8Array>,
      options?: unknown,
    ): Promise<{ pieceCid: { toString(): string } | string; size?: number | bigint }>;
    download(options: { pieceCid: string }): Promise<Uint8Array>;
  };
}

export interface EncryptionSigner {
  signTypedData?: (parameters: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    types: {
      VolumeKey: readonly { name: string; type: string }[];
    };
    primaryType: "VolumeKey";
    message: { owner: Address; volume: string; purpose: string };
  }) => Promise<Hex>;
  signMessage?: (parameters: { message: string }) => Promise<Hex>;
}

export interface EncryptionOptions {
  signer: EncryptionSigner;
  /** Defaults to EIP-712. `personal_sign` is the wallet fallback. */
  mode?: "eip712" | "personal_sign";
  chainId: number;
  /** Registry address mixed into the HKDF info and the EIP-712 domain. */
  registryAddress: Address;
}
