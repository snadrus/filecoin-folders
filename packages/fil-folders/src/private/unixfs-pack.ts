/**
 * The outer CAR of a private (read-restricted) piece: a UnixFS directory holding exactly one file,
 * `encrypted.fee`, whose bytes are a Filecoin Encryption Envelope followed by its ciphertext.
 *
 * This is the "CAR-in-CAR" packaging filecoin-pin (`add --encrypt`/`--private`) and Filecoin Drive write,
 * and what Curio's gate (`lib/keysmith/envelope.go`, `ReadEnvelopeLabels`) requires of every piece added
 * to a data set whose metadata says `read: "restricted"`: a CAR with one root, that root a UnixFS file or a
 * one-entry directory whose entry is named `encrypted.fee`, and the file starting with a COSE envelope.
 *
 * Layout follows the unixfs-v1-2025 profile: CIDv1, sha2-256, 1 MiB raw leaves, at most 1024 links per node.
 * Blocks are written leaves first, in file order, the file node, then the directory root last, the order
 * filecoin-pin uses so a reader can find the envelope header in the first leaf.
 */
import { asBuffer } from "../bytes.js";
import { cidToString, decodePb, decodeUnixfs, parseCar, readFile } from "../unixfs.js";

export const ENCRYPTED_FEE_NAME = "encrypted.fee";
export const LEAF_BYTES = 1024 * 1024;
export const MAX_LINKS = 1024;
/** One balanced layer of 1024 one-MiB leaves: filecoin-pin refuses encrypted uploads past ~1 GiB too. */
export const MAX_ENVELOPE_BYTES = LEAF_BYTES * MAX_LINKS;

const RAW = 0x55;
const DAG_PB = 0x70;

function varint(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("varint is invalid");
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function field(num: number, wire: 0 | 2): number[] {
  return varint(num * 8 + wire);
}

function bytesField(num: number, value: Uint8Array): number[] {
  return [...field(num, 2), ...varint(value.byteLength), ...value];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function cidOf(codec: number, block: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asBuffer(block)));
  return Uint8Array.from([0x01, codec, 0x12, 0x20, ...digest]);
}

interface PbLinkIn {
  cid: Uint8Array;
  name: string;
  tsize: number;
}

/** dag-pb PBNode, canonical order: Links (field 2) before Data (field 1). */
export function encodePb(links: PbLinkIn[], data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const link of links) {
    const inner = [...bytesField(1, link.cid), ...bytesField(2, new TextEncoder().encode(link.name)), ...field(3, 0), ...varint(link.tsize)];
    out.push(...field(2, 2), ...varint(inner.length), ...inner);
  }
  out.push(...bytesField(1, data));
  return Uint8Array.from(out);
}

/** UnixFS `Data` message. `blocksizes` is proto2 repeated (not packed), as go-unixfs and js-ipfs-unixfs write it. */
export function encodeUnixfsData(type: 1 | 2, opts: { filesize?: number; blocksizes?: number[] } = {}): Uint8Array {
  const out = [...field(1, 0), ...varint(type)];
  if (opts.filesize !== undefined) out.push(...field(3, 0), ...varint(opts.filesize));
  for (const size of opts.blocksizes ?? []) out.push(...field(4, 0), ...varint(size));
  return Uint8Array.from(out);
}

function carHeader(root: Uint8Array): Uint8Array {
  const tag = [0xd8, 0x2a, 0x58, root.byteLength + 1, 0x00, ...root];
  const text = (s: string) => [0x60 | s.length, ...new TextEncoder().encode(s)];
  return Uint8Array.from([0xa2, ...text("roots"), 0x81, ...tag, ...text("version"), 0x01]);
}

export interface FeeCar {
  /** The outer CAR: the piece that is uploaded. */
  car: Uint8Array;
  /** Its root, the "Encrypted root CID": the directory holding `encrypted.fee`. */
  rootCid: string;
  /** The `encrypted.fee` file's own CID. */
  fileCid: string;
}

/** Pack envelope bytes (FEE header ‖ ciphertext) as `encrypted.fee` in a one-entry UnixFS directory CAR. */
export async function packFeeCar(envelope: Uint8Array): Promise<FeeCar> {
  if (envelope.byteLength > MAX_ENVELOPE_BYTES) throw new Error("A private piece holds at most 1 GiB.");
  const blocks: [Uint8Array, Uint8Array][] = [];
  const leaves: { cid: Uint8Array; size: number }[] = [];
  for (let at = 0; at < envelope.byteLength || leaves.length === 0; at += LEAF_BYTES) {
    const chunk = envelope.subarray(at, Math.min(envelope.byteLength, at + LEAF_BYTES));
    const cid = await cidOf(RAW, chunk);
    blocks.push([cid, chunk]);
    leaves.push({ cid, size: chunk.byteLength });
    if (envelope.byteLength === 0) break;
  }
  let fileCid: Uint8Array;
  let fileTsize: number;
  if (leaves.length === 1) {
    fileCid = leaves[0]!.cid;
    fileTsize = leaves[0]!.size;
  } else {
    const node = encodePb(
      leaves.map((leaf) => ({ cid: leaf.cid, name: "", tsize: leaf.size })),
      encodeUnixfsData(2, { filesize: envelope.byteLength, blocksizes: leaves.map((leaf) => leaf.size) }),
    );
    fileCid = await cidOf(DAG_PB, node);
    fileTsize = node.byteLength + leaves.reduce((sum, leaf) => sum + leaf.size, 0);
    blocks.push([fileCid, node]);
  }
  const dir = encodePb([{ cid: fileCid, name: ENCRYPTED_FEE_NAME, tsize: fileTsize }], encodeUnixfsData(1));
  const dirCid = await cidOf(DAG_PB, dir);
  blocks.push([dirCid, dir]);
  const header = carHeader(dirCid);
  const parts: Uint8Array[] = [Uint8Array.from(varint(header.byteLength)), header];
  for (const [cid, data] of blocks) parts.push(Uint8Array.from(varint(cid.byteLength + data.byteLength)), cid, data);
  return { car: concat(parts), rootCid: cidToString(dirCid), fileCid: cidToString(fileCid) };
}

/** True when `bytes` is an outer CAR in the shape Curio's gate accepts. */
export function isFeeCar(bytes: Uint8Array): boolean {
  try {
    unpackFeeCar(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `encrypted.fee` bytes inside an outer CAR, with the same shape rules as Curio's
 * `ReadEnvelopeLabels`: one root; a file root, or a directory with exactly one entry named `encrypted.fee`.
 * Every block's hash is checked against its CID.
 */
export function unpackFeeCar(bytes: Uint8Array): Uint8Array {
  const car = parseCar(bytes);
  if (car.roots.length !== 1) throw new Error("A private piece's CAR must have exactly one root.");
  const root = car.roots[0]!;
  const rootBlock = car.blocks.get(root);
  if (!rootBlock) throw new Error("A private piece's CAR is missing its root block.");
  let file = root;
  if (codecOf(root) === DAG_PB) {
    const node = decodePb(rootBlock);
    const fs = decodeUnixfs(node.data);
    if (fs.type === 1) {
      if (node.links.length !== 1) throw new Error("A private piece's directory must hold exactly one file.");
      if (node.links[0]!.name !== ENCRYPTED_FEE_NAME) throw new Error(`A private piece's file must be named ${ENCRYPTED_FEE_NAME}.`);
      file = node.links[0]!.cid;
    } else if (fs.type !== 2 && fs.type !== 0) {
      throw new Error("A private piece's root must be a file or a one-entry directory.");
    }
  }
  return readFile(car, file);
}

/** Verify every block of a CAR hashes to its CID (sha2-256 only). Resolves to the number of blocks checked. */
export async function verifyCarBlocks(bytes: Uint8Array): Promise<number> {
  const car = parseCar(bytes);
  let n = 0;
  for (const [cid, data] of car.blocks) {
    const expected = await cidOf(codecOf(cid), data);
    if (cidToString(expected) !== cid) throw new Error(`Block ${cid} does not match its hash.`);
    n += 1;
  }
  return n;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Binary form of a base32 (`b…`) CID string, any version or codec (piece CIDs included). */
export function cidBytes(cid: string): Uint8Array {
  if (!cid.startsWith("b") || cid.length < 2) throw new Error(`Not a base32 CID: ${cid}`);
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cid.slice(1).toLowerCase()) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error(`Not a base32 CID: ${cid}`);
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function codecOf(cid: string): number {
  const bin = cidBytes(cid);
  return bin[1] ?? -1;
}
