import { asBuffer, isByteStream, readStream } from "../bytes.js";
import type { PutPieceOptions, Storage } from "./types.js";

/** Process-local piece store. Piece ids are `mem:` plus the hex SHA-256 of the bytes. */
export class MemoryStorage implements Storage {
  readonly pieces = new Map<string, Uint8Array>();
  /** Piece metadata as a Synapse upload would record it. */
  readonly metadata = new Map<string, Record<string, string>>();

  async put(data: Uint8Array | ReadableStream<Uint8Array>, options?: PutPieceOptions): Promise<{ pieceCid: string; size: number }> {
    const bytes = isByteStream(data) ? await readStream(data) : asBuffer(data);
    const pieceCid = await digestCid(bytes);
    this.pieces.set(pieceCid, bytes);
    if (options?.metadata && Object.keys(options.metadata).length) this.metadata.set(pieceCid, { ...options.metadata });
    return { pieceCid, size: bytes.byteLength };
  }

  async get(pieceCid: string): Promise<Uint8Array> {
    const bytes = this.pieces.get(pieceCid);
    if (!bytes) throw new Error(`unknown piece ${pieceCid}`);
    return bytes;
  }

  async list(): Promise<string[]> {
    return [...this.pieces.keys()];
  }

  async getRange(pieceCid: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.get(pieceCid);
    if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new Error("piece range is outside the payload");
    return bytes.subarray(offset, offset + length);
  }
}

export function createMemoryStorage(): MemoryStorage {
  return new MemoryStorage();
}

async function digestCid(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", asBuffer(bytes)));
  let hex = "";
  for (const byte of hash) hex += byte.toString(16).padStart(2, "0");
  return `mem:${hex}`;
}
