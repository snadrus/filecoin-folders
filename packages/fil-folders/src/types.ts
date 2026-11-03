import type { Address, Hex } from "viem";

/** AES-GCM parameters for one file's ciphertext. Names are encrypted only in the manifest. */
export interface ContentEnc {
  alg: "A256GCM";
  iv: string;
}

export interface FileNode {
  type: "file";
  name: string;
  /** Content CID inside a CAR, or a legacy piece that is the file itself. */
  pieceCid: string;
  /**
   * Storage piece that contains `pieceCid` when the bytes live in a CAR.
   * Absent for a legacy per-file piece.
   */
  located?: string;
  size: number;
  mtime: number;
  mime?: string;
  /** IPFS root CID recorded for share links and gateway preview. */
  ipfs?: string;
  /** True when the file bytes are an imported CAR archive, stored unchanged. */
  importedCar?: boolean;
  /**
   * "unixfs": the bytes are a UnixFS DAG inside a foreign CAR piece (e.g. Filecoin Pin's
   * Filecoin Drive). `pieceCid` is the file's UnixFS CID and `located` the storage piece.
   * With `importedCar`, the whole located piece is the file. Never encrypted.
   */
  format?: "unixfs";
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
  ipfs?: string;
  importedCar?: boolean;
  /** Additive (v1-compatible): "unixfs" for adopted Filecoin Drive pieces. Old readers ignore it. */
  format?: "unixfs";
  /** Storage piece holding a `format: "unixfs"` entry. */
  located?: string;
  enc?: ManifestEnc;
  /** Inlined children. Absent when this directory is stored as its own piece. */
  entries?: ManifestEntry[];
}

export interface Manifest {
  v: 1;
  mtime: number;
  entries: ManifestEntry[];
  /** Content CID → storage piece that holds that block. Omitted for blocks in the current CAR and for legacy pieces. */
  located?: Record<string, string>;
  /** Root manifests only: previous root manifest piece CID ("" = first version). Absent on pre-v2 manifests. */
  prev?: string;
  /** Root manifests only: commit time, unix seconds. */
  t?: number;
}

export interface Stat {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
  mime?: string;
  pieceCid?: string;
  /** Storage piece that holds this file when it lives inside a CAR. */
  located?: string;
  ipfs?: string;
  importedCar?: boolean;
  format?: "unixfs";
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
  ipfs?: string;
  importedCar?: boolean;
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
    prepare?(options: unknown): Promise<{ costs?: { ready?: boolean; depositNeeded?: bigint; needsFwssMaxApproval?: boolean } }>;
    createContext?(options: unknown): Promise<unknown>;
    createContexts?(options: unknown): Promise<unknown[]>;
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

/** A Filecoin Drive (UnixFS) piece to reference from the manifest without re-uploading. */
export interface AdoptRef {
  /** UnixFS CID of the file inside the piece (or the CAR root for an imported CAR). */
  cid: string;
  /** Storage piece CID that holds the CAR. */
  piece: string;
  size: number;
  mime?: string;
  /** IPFS root CID recorded by filecoin-pin. */
  ipfs?: string;
  /** The piece is an imported CAR: the file is the whole piece, served raw. */
  importedCar?: boolean;
  mtime?: number;
}
