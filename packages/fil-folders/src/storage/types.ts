/** Content-addressed piece store. The Synapse adapter is the production implementation. */
export interface Storage {
  put(data: Uint8Array | ReadableStream<Uint8Array>): Promise<{ pieceCid: string; size: number }>;
  get(pieceCid: string): Promise<Uint8Array>;
  /** Optional byte range inside a piece. Offsets are into the unpadded payload. */
  getRange?(pieceCid: string, offset: number, length: number): Promise<Uint8Array>;
  /** Optional: every piece CID currently in the backing dataset. */
  list?(): Promise<string[]>;
}
