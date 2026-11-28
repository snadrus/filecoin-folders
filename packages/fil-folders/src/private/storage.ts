/**
 * A Storage wrapper for a private (read-restricted) data set.
 *
 * `put` seals each piece as a FEE envelope under the volume's Keysmith group with a fresh salt and uploads
 * the outer CAR (`encrypted.fee`) through the inner store (Synapse). `get` fetches from Curio's gated
 * `/download/` (or, for tests, `inner.get`) and returns the plaintext. Piece metadata never carries names:
 * only `label: "encrypted.fee"` and the encrypted root CID, as filecoin-pin writes.
 */
import * as Keysmith from "@filoz/keysmith";
import { isByteStream, readStream } from "../bytes.js";
import type { Storage } from "../storage/types.js";
import { openPiece, sealPiece } from "./envelope.js";
import { isFeeCar } from "./unixfs-pack.js";

export interface PrivateStorageOptions {
  /** Where new pieces are written: `Keysmith.writeTarget(descriptor, nodeKey, group)`. */
  target: Keysmith.WriteTarget;
  /** The key the reader holds, and what it covers (default the whole group key). */
  readKey: Uint8Array;
  holding?: Keysmith.Holding | Keysmith.GrantDescriptor;
  /** Fetch the stored outer CAR of a piece (gated `/download/`). Defaults to `inner.get`. */
  fetchPiece?: (pieceCid: string) => Promise<Uint8Array>;
  /** Called with each piece's envelope labels, written or read (share links need the salt). */
  onLabels?: (pieceCid: string, labels: Keysmith.PieceLabels, rootCid?: string) => void;
}

export function createPrivateStorage(inner: Storage, options: PrivateStorageOptions): Storage & { labels: Map<string, Keysmith.PieceLabels> } {
  const labels = new Map<string, Keysmith.PieceLabels>();
  const fetchPiece = options.fetchPiece ?? ((cid: string) => inner.get(cid));
  return {
    labels,
    ...(inner.list ? { list: () => inner.list!() } : {}),
    async put(data) {
      const plain = isByteStream(data) ? await readStream(data) : data;
      const sealed = await sealPiece(options.target, plain);
      const stored = await inner.put(sealed.car, { metadata: { label: "encrypted.fee", ipfsRootCID: sealed.rootCid } });
      const raw = sealed.labels as unknown as Keysmith.PieceLabels;
      labels.set(stored.pieceCid, raw);
      options.onLabels?.(stored.pieceCid, raw, sealed.rootCid);
      return { pieceCid: stored.pieceCid, size: plain.byteLength };
    },
    async get(pieceCid) {
      const outer = await fetchPiece(pieceCid);
      // A volume that moved to a private data set may still reference older public pieces.
      if (!isFeeCar(outer)) return outer;
      const opened = await openPiece(outer, options.readKey, options.holding ?? "groupKey");
      labels.set(pieceCid, opened.raw);
      options.onLabels?.(pieceCid, opened.raw);
      return opened.plaintext;
    },
  };
}
