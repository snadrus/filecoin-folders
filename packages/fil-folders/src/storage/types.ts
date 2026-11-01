/** Content-addressed piece store. The Synapse adapter is the production implementation. */
export interface Storage {
  put(data: Uint8Array | ReadableStream<Uint8Array>): Promise<{ pieceCid: string; size: number }>;
  get(pieceCid: string): Promise<Uint8Array>;
}
