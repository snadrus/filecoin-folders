import type { Address, Hex } from "viem";
import { bytesEqual } from "../bytes.js";
import { RegistryCallError, RegistryCasConflict, RegistryNotAuthorized } from "../errors.js";
import { PIECE_CID_MAX_BYTES } from "../ids.js";
import type { CommittedRecord, Registry, RegistryCommit } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000";

interface HeadState {
  pieceCid: Uint8Array;
  version: bigint;
}

/** In-memory FolderRegistry. `signer` is the wallet that would send `commit` / `setWriter`. */
export class MemoryRegistry implements Registry {
  commits = 0;
  readonly signer: Address;
  #heads = new Map<string, HeadState>();
  #writers = new Set<string>();
  #events: CommittedRecord[] = [];
  #clock = 1_700_000_000n;
  #seq = 0n;

  constructor(signer: Address) {
    this.signer = signer;
  }

  async head(owner: Address, ns: Hex, key: Hex): Promise<{ pieceCid: Uint8Array; version: bigint }> {
    const head = this.#head(owner, ns, key);
    return { pieceCid: new Uint8Array(head.pieceCid), version: head.version };
  }

  async commit(input: RegistryCommit): Promise<CommittedRecord> {
    assertPieceSize(input.pieceCid);
    assertPieceSize(input.prevPieceCid);
    if (input.owner.toLowerCase() === ZERO) throw new RegistryCallError("ZeroAddress");
    if (!(await this.isWriter(input.owner, input.ns, this.signer))) throw new RegistryNotAuthorized();

    const current = this.#head(input.owner, input.ns, input.key);
    if (!bytesEqual(current.pieceCid, input.prevPieceCid)) {
      throw new RegistryCasConflict(new Uint8Array(current.pieceCid), current.version);
    }

    const next: HeadState = {
      pieceCid: new Uint8Array(input.pieceCid),
      version: current.version + 1n,
    };
    this.#heads.set(slot(input.owner, input.ns, input.key), next);
    this.commits += 1;
    this.#seq += 1n;
    const record: CommittedRecord = {
      owner: input.owner,
      ns: input.ns,
      key: input.key,
      pieceCid: next.pieceCid,
      prevPieceCid: new Uint8Array(input.prevPieceCid),
      version: next.version,
      timestamp: this.#clock++,
      txHash: `0x${this.#seq.toString(16).padStart(64, "0")}` as Hex,
      blockNumber: this.#seq,
    };
    this.#events.push(record);
    return record;
  }

  async setWriter(ns: Hex, writer: Address, allowed: boolean): Promise<void> {
    if (writer.toLowerCase() === ZERO) throw new RegistryCallError("ZeroAddress");
    const id = writerId(this.signer, ns, writer);
    if (allowed) this.#writers.add(id);
    else this.#writers.delete(id);
  }

  async isWriter(owner: Address, ns: Hex, writer: Address): Promise<boolean> {
    if (owner.toLowerCase() === writer.toLowerCase()) return true;
    return this.#writers.has(writerId(owner, ns, writer));
  }

  async committed(query: { owner: Address; ns: Hex; key?: Hex; fromBlock?: bigint }): Promise<CommittedRecord[]> {
    return this.#events.filter((event) => {
      if (event.owner.toLowerCase() !== query.owner.toLowerCase()) return false;
      if (event.ns.toLowerCase() !== query.ns.toLowerCase()) return false;
      if (query.key !== undefined && event.key.toLowerCase() !== query.key.toLowerCase()) return false;
      if (query.fromBlock !== undefined && (event.blockNumber ?? 0n) < query.fromBlock) return false;
      return true;
    });
  }

  #head(owner: Address, ns: Hex, key: Hex): HeadState {
    return this.#heads.get(slot(owner, ns, key)) ?? { pieceCid: new Uint8Array(), version: 0n };
  }
}

export function createMemoryRegistry(signer: Address): MemoryRegistry {
  return new MemoryRegistry(signer);
}

function assertPieceSize(bytes: Uint8Array): void {
  if (bytes.byteLength > PIECE_CID_MAX_BYTES) throw new RegistryCallError("PieceCidTooLarge");
}

function slot(owner: Address, ns: Hex, key: Hex): string {
  return `${owner.toLowerCase()}:${ns.toLowerCase()}:${key.toLowerCase()}`;
}

function writerId(owner: Address, ns: Hex, writer: Address): string {
  return `${owner.toLowerCase()}:${ns.toLowerCase()}:${writer.toLowerCase()}`;
}
