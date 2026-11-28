/**
 * Private (read-restricted) pieces: Keysmith keys + Filecoin Encryption Envelope (FEE), packed as
 * `encrypted.fee` in an outer CAR. Uses the official libraries, `@filoz/keysmith` and
 * `filecoin-encryption-envelope` (FilOzone/synapse-sdk), so pieces interoperate with filecoin-pin,
 * Filecoin Drive, the Filecoin encryption viewer and Curio's gate.
 *
 *   plaintext (a TreFolders commit CAR, or any bytes)
 *     └─ FEE scheme 2 (chunked AES-256-GCM STREAM, 256 KiB), content type application/vnd.ipld.car,
 *        appMetadata = Keysmith pieceMetadata { foc/v: 2, foc/own, foc/gkid, foc/group?, foc/salt }
 *          └─ outer CAR: UnixFS directory { "encrypted.fee" }  ← the uploaded piece
 */
import * as Keysmith from "@filoz/keysmith";
import * as fee from "filecoin-encryption-envelope";
import { concat, isAddress, keccak256, slice, toHex, type Address, type Hex } from "viem";
import { packFeeCar, unpackFeeCar, type FeeCar } from "./unixfs-pack.js";

/** Curio's data-set metadata key for read access, and the value that makes a data set private. */
export const READ_KEY = "read";
export const READ_RESTRICTED = "restricted";
/** filecoin-pin / Filecoin Drive: marks a data set as holding Keysmith-encrypted pieces. */
export const ENCRYPTION_VERSION_KEY = "foc/enc";
export const ENCRYPTION_VERSION = "1";
export const GROUP_KEY_ID_KEY = "foc/gkid";
export const GROUP_KEY_COMMITMENT_KEY = Keysmith.COMMITMENT_KEY;
/** The FEE content type of the inner bytes (the same label the filecoin-pin CLI writes). */
export const CAR_CONTENT_TYPE = "application/vnd.ipld.car";

/** Keysmith group for TrePerson identity pieces: a share link carries this group's key, not one piece's. */
export const IDENTITY_GROUP = "FiPerson/identity";

export type Visibility = "public" | "private" | "encrypted";

/**
 * A data set's visibility from its on-chain metadata.
 * - `private`: `read: "restricted"`. Curio serves its pieces only at `/download/` to a valid FOC-Grant.
 * - `encrypted`: Keysmith-encrypted (`foc/enc`) but public reads (Filecoin Drive's default): anyone can
 *   fetch the ciphertext.
 * - `public`: everything else.
 */
export function datasetVisibility(metadata: Readonly<Record<string, string | undefined>> | null | undefined): Visibility {
  if (!metadata) return "public";
  if ((metadata[READ_KEY] ?? "").trim().toLowerCase() === READ_RESTRICTED) return "private";
  if (metadata[ENCRYPTION_VERSION_KEY] != null || metadata[GROUP_KEY_ID_KEY] != null) return "encrypted";
  return "public";
}

/**
 * Data-set metadata for a new private data set (FWSS allows 10 keys). The Keysmith keys follow
 * filecoin-pin `add --private`, so the CLI and Drive recognise the group key.
 */
export function privateDataSetMetadata(input: {
  owner: Address;
  groupKeyId: Hex;
  commitment: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(input.extra ?? {}),
    [READ_KEY]: READ_RESTRICTED,
    [ENCRYPTION_VERSION_KEY]: ENCRYPTION_VERSION,
    ...Keysmith.dataSetMetadata({ owner: input.owner, groupKeyId: input.groupKeyId }, input.commitment),
  };
}

/**
 * The owner's default group key id, identical across filecoin-pin, Filecoin Drive and TreFolders:
 * `keccak256(utf8("filecoin/default-group-key") ‖ owner as 20 raw bytes)[0:16]`.
 */
export function defaultGroupKeyId(owner: Address): Hex {
  if (!isAddress(owner, { strict: false })) throw new Error(`Not an address: ${owner}`);
  return slice(keccak256(concat([toHex("filecoin/default-group-key"), owner])), 0, 16);
}

/** Opaque Keysmith group for one TreFolders volume (group names travel in the clear, volume names should not). */
export function volumeGroup(volumeName: string): string {
  return `FiFolders/v${keccak256(toHex(`fil-folders/volume/${volumeName}`)).slice(2, 18)}`;
}

export interface SealedPiece extends FeeCar {
  /** Keysmith envelope labels (also the FEE appMetadata). */
  labels: Keysmith.PieceMetadata;
  salt: Hex;
}

/**
 * Encrypt `plaintext` as one private piece under `target` (from `Keysmith.writeTarget`), with a fresh salt.
 */
export async function sealPiece(target: Keysmith.WriteTarget, plaintext: Uint8Array): Promise<SealedPiece> {
  const salt = Keysmith.newSalt();
  const labels = Keysmith.pieceMetadata(target.ref, { salt, ...(target.group ? { group: target.group } : {}) });
  const cek = Keysmith.pieceKey(target.key, salt);
  try {
    const envelope = await collect(
      streamOf(plaintext).pipeThrough(
        fee.encrypt({ cek, contentType: CAR_CONTENT_TYPE, appMetadata: labels as never, contentLength: plaintext.byteLength }),
      ),
    );
    const packed = await packFeeCar(envelope);
    return { ...packed, labels, salt };
  } finally {
    cek.fill(0);
  }
}

/** The envelope labels of an outer CAR (unauthenticated until decrypted). */
export async function readLabels(outerCar: Uint8Array): Promise<Keysmith.PieceLabels> {
  const envelope = unpackFeeCar(outerCar);
  const info = await fee.parse(envelope);
  Keysmith.readPieceMetadata(info.appMetadata as never);
  return info.appMetadata as unknown as Keysmith.PieceLabels;
}

/**
 * Decrypt an outer CAR with whichever node key the caller holds (group key, a group's key, or a piece key);
 * `holding` is the grant descriptor or holding that delivered it.
 */
export async function openPiece(
  outerCar: Uint8Array,
  nodeKey: Uint8Array,
  holding: Keysmith.Holding | Keysmith.GrantDescriptor = "groupKey",
): Promise<{ plaintext: Uint8Array; labels: Keysmith.PieceMetadataView; raw: Keysmith.PieceLabels }> {
  const envelope = unpackFeeCar(outerCar);
  const info = await fee.parse(envelope);
  if (info.contentType !== undefined && info.contentType !== CAR_CONTENT_TYPE) {
    throw new Error("This private piece does not hold a CAR.");
  }
  const labels = Keysmith.readPieceMetadata(info.appMetadata as never);
  const plaintext = await collect(streamOf(envelope).pipeThrough(fee.decrypt(Keysmith.keyResolver(nodeKey, holding))));
  return { plaintext, labels, raw: info.appMetadata as unknown as Keysmith.PieceLabels };
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    total += next.value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
