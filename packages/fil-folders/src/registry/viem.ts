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
  /** Max blocks per `eth_getLogs` request. Lotus/Glif cap ranges (2880 epochs). Default 2000. */
  maxBlockRange?: bigint;
}

/**
 * FolderRegistry client. `commit` is used when the wallet is the owner;
 * `commitFor` is used for an approved writer.
 */
export function createViemRegistry(options: ViemRegistryOptions): Registry {
  return new ViemRegistry(options);
}

class ViemRegistry implements Registry {
  readonly address: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly signer: "auto" | "session-key";
  readonly fromBlock: bigint;
  readonly maxBlockRange: bigint;

  constructor(options: ViemRegistryOptions) {
    this.fromBlock = options.fromBlock ?? 0n;
    this.maxBlockRange = options.maxBlockRange ?? 2000n;
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
    const prev = toHex(input.prevPieceCid);
    try {
      const hash = await this.#write(
        asOwner ? "commit" : "commitFor",
        asOwner ? [input.ns, input.key, piece, prev] : [input.owner, input.ns, input.key, piece, prev],
      );
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const decoded = committedFromReceipt(receipt.logs);
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
      await this.publicClient.waitForTransactionReceipt({ hash });
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
      const logs = [];
      for (let from = query.fromBlock ?? this.fromBlock; from <= latest; from += this.maxBlockRange) {
        const to = from + this.maxBlockRange - 1n < latest ? from + this.maxBlockRange - 1n : latest;
        logs.push(
          ...(await this.publicClient.getLogs({ address: this.address, event: committedEvent, args, fromBlock: from, toBlock: to })),
        );
      }
      return logs.map((log) => {
        const args = log.args;
        if (
          args.owner === undefined ||
          args.ns === undefined ||
          args.key === undefined ||
          args.pieceCid === undefined ||
          args.prevPieceCid === undefined ||
          args.version === undefined ||
          args.timestamp === undefined
        ) {
          throw new Error("Committed log is missing fields");
        }
        const record: CommittedRecord = {
          owner: args.owner,
          ns: args.ns,
          key: args.key,
          pieceCid: hexToBytes(args.pieceCid),
          prevPieceCid: hexToBytes(args.prevPieceCid),
          version: args.version,
          timestamp: args.timestamp,
        };
        if (log.transactionHash) record.txHash = log.transactionHash;
        if (log.blockNumber != null) record.blockNumber = log.blockNumber;
        return record;
      });
    } catch (error) {
      rethrowRegistry(error);
    }
  }

  async #write(functionName: "commit" | "commitFor" | "setWriter", args: readonly unknown[]): Promise<Hex> {
    const account = this.walletClient.account;
    if (!account) throw new Error("walletClient has no account");
    return this.walletClient.writeContract({
      address: this.address,
      abi: folderRegistryAbi,
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

function committedFromReceipt(logs: readonly { data: Hex; topics: readonly Hex[] }[]): { version: bigint; timestamp: bigint } | undefined {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: folderRegistryAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "Committed") {
        return { version: decoded.args.version, timestamp: decoded.args.timestamp };
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
