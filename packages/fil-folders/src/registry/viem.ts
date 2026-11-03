import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeEventLog,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { RegistryCallError, RegistryCasConflict, RegistryNotAuthorized } from "../errors.js";
import { PIECE_CID_MAX_BYTES } from "../ids.js";
import { committedEvent, folderRegistryAbi } from "./abi.js";
import { committedEventV2, folderRegistryV2Abi } from "./abi-v2.js";
import { REGISTRY_SUCCESSORS } from "./deployments.js";
import { createMigratingRegistry } from "./migrating.js";
import { bytesEqual } from "../bytes.js";
import type { CommittedRecord, Registry, RegistryCommit } from "./types.js";

export interface ViemRegistryOptions {
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /**
   * `session-key` always sends `commitFor(owner)` from this wallet.
   * The wallet account is the session key; `owner` on the commit is the root wallet.
   * Omit it to use `commit` when the wallet is the owner and `commitFor` otherwise.
   */
  signer?: "auto" | "session-key";
  /** Default start block for `committed` log scans, e.g. the deployment block. Public FEVM RPCs reject `fromBlock: 0`. */
  fromBlock?: bigint;
  /** Max blocks per `eth_getLogs` request. Glif Calibration rejects more than 360. Default 360. */
  maxBlockRange?: bigint;
  /**
   * Where scanned `Committed` logs and the last scanned block are kept, so a reload only scans new blocks.
   * Defaults to `globalThis.localStorage` when present; pass `null` to disable.
   */
  scanCache?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Contract ABI. 1 = FolderRegistry (default), 2 = FolderRegistryV2 (version CAS, minimal event). */
  abiVersion?: 1 | 2;
  /**
   * A v1 address with a known v2 successor ({@link REGISTRY_SUCCESSORS}) returns a migrating registry:
   * v2 head first, v1 fallback, one-time move on the next commit. Default true; false pins plain v1.
   */
  migrate?: boolean;
  /** Wraps the one-time v1 → v2 move (label the wallet prompt). */
  wrapMigration?: <T>(info: { owner: Address; ns: Hex; key: Hex }, fn: () => Promise<T>) => Promise<T>;
}

/** Glif's public Calibration endpoint caps `eth_getLogs` at 360 blocks. */
export const DEFAULT_MAX_BLOCK_RANGE = 360n;

interface CachedScan {
  v: 1;
  to: string;
  records: { owner: Address; ns: Hex; key: Hex; pieceCid: Hex; prevPieceCid: Hex; version: string; timestamp: string; txHash?: Hex; blockNumber?: string }[];
}

/**
 * FolderRegistry client. `commit` is used when the wallet is the owner;
 * `commitFor` is used for an approved writer.
 */
export function createViemRegistry(options: ViemRegistryOptions): Registry {
  const successor = options.abiVersion === 2 || options.migrate === false ? undefined : REGISTRY_SUCCESSORS[options.address.toLowerCase()];
  if (!successor) return new ViemRegistry(options);
  return createMigratingRegistry({
    current: new ViemRegistry({ ...options, address: successor.address, fromBlock: successor.fromBlock, abiVersion: 2 }),
    legacy: new ViemRegistry({ ...options, abiVersion: 1 }),
    wrapMigration: options.wrapMigration,
  });
}

class ViemRegistry implements Registry {
  readonly address: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly signer: "auto" | "session-key";
  readonly fromBlock: bigint;
  readonly maxBlockRange: bigint;
  readonly scanCache: Pick<Storage, "getItem" | "setItem"> | null;
  readonly v2: boolean;

  constructor(options: ViemRegistryOptions) {
    this.v2 = options.abiVersion === 2;
    this.fromBlock = options.fromBlock ?? 0n;
    this.maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE;
    this.scanCache =
      options.scanCache !== undefined
        ? options.scanCache
        : typeof globalThis !== "undefined" && "localStorage" in globalThis
          ? (globalThis as { localStorage: Pick<Storage, "getItem" | "setItem"> }).localStorage
          : null;
    if (this.maxBlockRange < 1n) throw new Error("maxBlockRange must be >= 1");
    this.address = options.address;
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
    this.signer = options.signer ?? "auto";
  }

  async head(owner: Address, ns: Hex, key: Hex): Promise<{ pieceCid: Uint8Array; version: bigint }> {
    try {
      const result = (await this.publicClient.readContract({
        address: this.address,
        abi: folderRegistryAbi,
        functionName: "head",
        args: [owner, ns, key],
      })) as readonly [Hex, bigint];
      const piece = result[0] ?? "0x";
      const version = result[1] ?? 0n;
      return { pieceCid: hexToBytes(piece), version };
    } catch (error) {
      rethrowRegistry(error);
    }
  }

  async commit(input: RegistryCommit): Promise<CommittedRecord> {
    assertPieceSize(input.pieceCid);
    assertPieceSize(input.prevPieceCid);
    const signer = signerAddress(this.walletClient);
    const asOwner = this.signer !== "session-key" && signer.toLowerCase() === input.owner.toLowerCase();
    const piece = toHex(input.pieceCid);
    let prev: Hex | bigint = toHex(input.prevPieceCid);
    if (this.v2) {
      // v2 CAS is on the head version: check the observed piece here, the contract re-checks the version.
      const current = await this.head(input.owner, input.ns, input.key);
      if (!bytesEqual(current.pieceCid, input.prevPieceCid)) throw new RegistryCasConflict(current.pieceCid, current.version);
      prev = current.version;
    }
    try {
      const hash = await this.#write(
        asOwner ? "commit" : "commitFor",
        asOwner ? [input.ns, input.key, piece, prev] : [input.owner, input.ns, input.key, piece, prev],
      );
      const receipt = await waitReceipt(this.publicClient, hash);
      const decoded = committedFromReceipt(receipt.logs, this.v2);
      return {
        owner: input.owner,
        ns: input.ns,
        key: input.key,
        pieceCid: new Uint8Array(input.pieceCid),
        prevPieceCid: new Uint8Array(input.prevPieceCid),
        version: decoded?.version ?? (await this.head(input.owner, input.ns, input.key)).version,
        timestamp: decoded?.timestamp ?? 0n,
        txHash: hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      rethrowRegistry(error);
    }
  }

  async setWriter(ns: Hex, writer: Address, allowed: boolean): Promise<void> {
    try {
      const hash = await this.#write("setWriter", [ns, writer, allowed]);
      await waitReceipt(this.publicClient, hash);
    } catch (error) {
      rethrowRegistry(error);
    }
  }

  async isWriter(owner: Address, ns: Hex, writer: Address): Promise<boolean> {
    try {
      return (await this.publicClient.readContract({
        address: this.address,
        abi: folderRegistryAbi,
        functionName: "isWriter",
        args: [owner, ns, writer],
      })) as boolean;
    } catch (error) {
      rethrowRegistry(error);
    }
  }

  async committed(query: { owner: Address; ns: Hex; key?: Hex; fromBlock?: bigint }): Promise<CommittedRecord[]> {
    try {
      const args =
        query.key === undefined
          ? { owner: query.owner, ns: query.ns }
          : { owner: query.owner, ns: query.ns, key: query.key };
      const latest = await this.publicClient.getBlockNumber();
      const start = query.fromBlock ?? this.fromBlock;
      const cacheKey = `fil-folders:committed:${this.address.toLowerCase()}:${query.owner.toLowerCase()}:${query.ns}:${query.key ?? "*"}:${start}`;
      const cached = this.#readCache(cacheKey);
      const logs: never[] = [];
      let scannedTo = start - 1n;
      if (cached && BigInt(cached.to) <= latest) scannedTo = BigInt(cached.to);
      for (let from = scannedTo + 1n; from <= latest; from += this.maxBlockRange) {
        const to = from + this.maxBlockRange - 1n < latest ? from + this.maxBlockRange - 1n : latest;
        logs.push(
          ...((await this.publicClient.getLogs({ address: this.address, event: (this.v2 ? committedEventV2 : committedEvent) as typeof committedEvent, args, fromBlock: from, toBlock: to })) as never[]),
        );
        scannedTo = to;
      }
      const fresh = this.#toRecords(logs);
      const records = [...(cached && BigInt(cached.to) <= latest ? cached.records.map(fromCached) : []), ...fresh];
      this.#writeCache(cacheKey, scannedTo, records);
      return records;
    } catch (error) {
      rethrowRegistry(error);
    }
  }

  #readCache(key: string): CachedScan | null {
    if (!this.scanCache) return null;
    try {
      const parsed = JSON.parse(this.scanCache.getItem(key) || "null") as CachedScan | null;
      return parsed && parsed.v === 1 && typeof parsed.to === "string" && Array.isArray(parsed.records) ? parsed : null;
    } catch {
      return null;
    }
  }

  #writeCache(key: string, to: bigint, records: CommittedRecord[]): void {
    if (!this.scanCache) return;
    try {
      const value: CachedScan = { v: 1, to: to.toString(), records: records.map(toCached) };
      this.scanCache.setItem(key, JSON.stringify(value));
    } catch {
      // Quota or a blocked store: next load scans again.
    }
  }

  #toRecords(logs: readonly { args: { owner?: Address; ns?: Hex; key?: Hex; pieceCid?: Hex; prevPieceCid?: Hex; version?: bigint; timestamp?: bigint }; transactionHash?: Hex | null; blockNumber?: bigint | null }[]): CommittedRecord[] {
    {
      return logs.map((log) => {
        const args = log.args;
        if (
          args.owner === undefined ||
          args.ns === undefined ||
          args.key === undefined ||
          args.pieceCid === undefined ||
          args.version === undefined ||
          (!this.v2 && (args.prevPieceCid === undefined || args.timestamp === undefined))
        ) {
          throw new Error("Committed log is missing fields");
        }
        const record: CommittedRecord = {
          owner: args.owner,
          ns: args.ns,
          key: args.key,
          pieceCid: hexToBytes(args.pieceCid),
          // v2 events carry no prev / timestamp: history comes from manifest `prev` links.
          prevPieceCid: args.prevPieceCid ? hexToBytes(args.prevPieceCid) : new Uint8Array(),
          version: args.version,
          timestamp: args.timestamp ?? 0n,
        };
        if (log.transactionHash) record.txHash = log.transactionHash;
        if (log.blockNumber != null) record.blockNumber = log.blockNumber;
        return record;
      });
    }
  }

  async #write(functionName: "commit" | "commitFor" | "setWriter", args: readonly unknown[]): Promise<Hex> {
    const account = this.walletClient.account;
    if (!account) throw new Error("walletClient has no account");
    return this.walletClient.writeContract({
      address: this.address,
      abi: this.v2 ? folderRegistryV2Abi : folderRegistryAbi,
      functionName,
      args,
      account,
      chain: this.walletClient.chain,
    } as never);
  }
}

function signerAddress(wallet: WalletClient): Address {
  const account = wallet.account;
  if (!account) throw new Error("walletClient has no account");
  return typeof account === "string" ? account : account.address;
}

function assertPieceSize(bytes: Uint8Array): void {
  if (bytes.byteLength > PIECE_CID_MAX_BYTES) throw new RegistryCallError("PieceCidTooLarge");
}

function hexToBytes(hex: Hex): Uint8Array {
  if (hex === "0x") return new Uint8Array();
  return toBytes(hex);
}

function committedFromReceipt(logs: readonly { data: Hex; topics: readonly Hex[] }[], v2 = false): { version: bigint; timestamp: bigint } | undefined {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: (v2 ? folderRegistryV2Abi : folderRegistryAbi) as typeof folderRegistryAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "Committed") {
        return { version: decoded.args.version, timestamp: (decoded.args as { timestamp?: bigint }).timestamp ?? 0n };
      }
    } catch {
      // unrelated log
    }
  }
  return undefined;
}

function rethrowRegistry(error: unknown): never {
  const decoded = decodeRegistryError(error);
  if (decoded?.errorName === "CasConflict") {
    const current = decoded.args?.[0];
    const version = decoded.args?.[1];
    throw new RegistryCasConflict(
      typeof current === "string" ? hexToBytes(current as Hex) : new Uint8Array(),
      typeof version === "bigint" ? version : BigInt(Number(version ?? 0)),
    );
  }
  if (decoded?.errorName === "NotAuthorized") throw new RegistryNotAuthorized();
  if (decoded?.errorName) throw new RegistryCallError(decoded.errorName);
  throw error;
}

function decodeRegistryError(error: unknown): { errorName: string; args?: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    if (revert.data?.errorName) return { errorName: revert.data.errorName, args: revert.data.args };
    if (typeof revert.raw === "string" && revert.raw.startsWith("0x")) {
      try {
        const decoded = decodeErrorResult({ abi: folderRegistryAbi, data: revert.raw });
        return { errorName: decoded.errorName, args: decoded.args };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toCached(record: CommittedRecord): CachedScan["records"][number] {
  return {
    owner: record.owner,
    ns: record.ns,
    key: record.key,
    pieceCid: toHex(record.pieceCid),
    prevPieceCid: toHex(record.prevPieceCid),
    version: record.version.toString(),
    timestamp: record.timestamp.toString(),
    ...(record.txHash ? { txHash: record.txHash } : {}),
    ...(record.blockNumber != null ? { blockNumber: record.blockNumber.toString() } : {}),
  };
}

function fromCached(item: CachedScan["records"][number]): CommittedRecord {
  const record: CommittedRecord = {
    owner: item.owner,
    ns: item.ns,
    key: item.key,
    pieceCid: hexToBytes(item.pieceCid),
    prevPieceCid: hexToBytes(item.prevPieceCid),
    version: BigInt(item.version),
    timestamp: BigInt(item.timestamp),
  };
  if (item.txHash) record.txHash = item.txHash;
  if (item.blockNumber) record.blockNumber = BigInt(item.blockNumber);
  return record;
}

/** FEVM RPCs can fail a receipt poll with "requested epoch was a null round"; keep waiting. */
async function waitReceipt(client: PublicClient, hash: Hex) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.waitForTransactionReceipt({ hash });
    } catch (error) {
      const text = String((error as { message?: string })?.message ?? error) + String((error as { details?: string })?.details ?? "");
      if (attempt >= 5 || !/null round/i.test(text)) throw error;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
