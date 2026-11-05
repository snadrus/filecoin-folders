import { isByteStream } from "./bytes.js";
import type { Storage } from "./storage/types.js";

/** Synapse PDP rejects payloads smaller than this. */
export const MIN_PIECE_BYTES = 127;

const MAGIC = [0xff, 0x46, 0x50, 0x01] as const;
const HEADER = 8;

/**
 * Pad a payload so the stored piece is at least {@link MIN_PIECE_BYTES}.
 * Bytes that are already large enough are stored unchanged.
 * Smaller bytes are framed as magic `FF 46 50 01`, a big-endian original
 * length, the payload, and zero fill out to 127 (or header+payload when that
 * is already past 127).
 */
export function padPiece(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength >= MIN_PIECE_BYTES) return bytes;
  const size = Math.max(MIN_PIECE_BYTES, HEADER + bytes.byteLength);
  const out = new Uint8Array(size);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = MAGIC[2];
  out[3] = MAGIC[3];
  new DataView(out.buffer).setUint32(4, bytes.byteLength, false);
  out.set(bytes, HEADER);
  return out;
}

/** Inverse of {@link padPiece}. Unframed pieces are returned as-is. */
export function unpadPiece(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < MIN_PIECE_BYTES || bytes.byteLength > HEADER + (MIN_PIECE_BYTES - 1)) return bytes;
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, false);
  if (length >= MIN_PIECE_BYTES) return bytes;
  const framed = Math.max(MIN_PIECE_BYTES, HEADER + length);
  if (framed !== bytes.byteLength) return bytes;
  for (let i = HEADER + length; i < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0) return bytes;
  }
  return bytes.slice(HEADER, HEADER + length);
}

/** Wrap a piece store so every put/get round-trips the original bytes. */
export function withPiecePadding(inner: Storage): Storage & { inner: Storage } {
  return {
    inner,
    ...(inner.list ? { list: () => inner.list!() } : {}),
    async put(data, options) {
      if (!isByteStream(data)) {
        const original = data.byteLength;
        const stored = await inner.put(padPiece(data), options);
        return { pieceCid: stored.pieceCid, size: original };
      }
      const reader = data.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (total < MIN_PIECE_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
      } catch (error) {
        await reader.cancel(error);
        throw error;
      }
      if (total < MIN_PIECE_BYTES) {
        const buf = concat(chunks, total);
        const stored = await inner.put(padPiece(buf), options);
        return { pieceCid: stored.pieceCid, size: buf.byteLength };
      }
      const head = concat(chunks, total);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
        },
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value && value.byteLength > 0) controller.enqueue(value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      const stored = await inner.put(stream, options);
      return { pieceCid: stored.pieceCid, size: stored.size };
    },
    async get(pieceCid) {
      return unpadPiece(await inner.get(pieceCid));
    },
    async getRange(pieceCid, offset, length) {
      const bytes = unpadPiece(await inner.get(pieceCid));
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new Error("piece range is outside the payload");
      return bytes.subarray(offset, offset + length);
    },
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
