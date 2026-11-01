import type { Address, Hex } from "viem";

export interface CommittedRecord {
  owner: Address;
  ns: Hex;
  key: Hex;
  pieceCid: Uint8Array;
  prevPieceCid: Uint8Array;
  version: bigint;
  timestamp: bigint;
  txHash?: Hex;
  blockNumber?: bigint;
}

export interface RegistryCommit {
  owner: Address;
  ns: Hex;
  key: Hex;
  pieceCid: Uint8Array;
  prevPieceCid: Uint8Array;
}

export interface Registry {
  head(owner: Address, ns: Hex, key: Hex): Promise<{ pieceCid: Uint8Array; version: bigint }>;
  /** Uses `commit` when the signer is `owner`, otherwise `commitFor`. */
  commit(input: RegistryCommit): Promise<CommittedRecord>;
  setWriter(ns: Hex, writer: Address, allowed: boolean): Promise<void>;
  isWriter(owner: Address, ns: Hex, writer: Address): Promise<boolean>;
  committed(query: { owner: Address; ns: Hex; key?: Hex; fromBlock?: bigint }): Promise<CommittedRecord[]>;
}
