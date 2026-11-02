import { asBuffer } from "./bytes.js";

/**
 * One volume commit is one CARv1 piece.
 * The root block is the volume manifest (raw JSON). File bytes are sibling raw blocks.
 * A metadata-only commit is a CAR whose only block is that manifest.
 */

const RAW_CODEC = 0x55;
const SHA2_256 = 0x12;
const DIGEST_LEN = 32;
const CID_LEN = 36;

export interface CarBlockRange {
  offset: number;
  length: number;
}

export interface DecodedCar {
  root: string;
  blocks: Map<string, Uint8Array>;
  /** Byte offsets into the unpadded CAR bytes, for a later range read. */
  ranges: Map<string, CarBlockRange>;
}

export async function contentCid(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asBuffer(bytes)));
  return cidToString(cidBytes(digest));
}

export function encodeCar(root: string, blocks: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const rootBytes = cidFromString(root);
  if (!blocks.has(root)) throw new Error("CAR root block is missing");
  const header = carHeader(rootBytes);
  const parts: Uint8Array[] = [varint(header.byteLength), header];
  const ordered = [root, ...[...blocks.keys()].filter((cid) => cid !== root).sort()];
  for (const cid of ordered) {
    const data = blocks.get(cid);
    if (!data) throw new Error(`CAR block ${cid} is missing`);
    const cidBin = cidFromString(cid);
    parts.push(varint(cidBin.byteLength + data.byteLength), cidBin, data);
  }
  return concat(parts);
}

export function decodeCar(bytes: Uint8Array): DecodedCar {
  const reader = new Reader(bytes);
  const headerLen = reader.varint();
  const header = reader.take(headerLen);
  const root = readHeaderRoot(header);
  const blocks = new Map<string, Uint8Array>();
  const ranges = new Map<string, CarBlockRange>();
  while (!reader.done) {
    const len = reader.varint();
    const start = reader.offset;
    const cidBin = reader.take(CID_LEN);
    const dataLen = len - CID_LEN;
    if (dataLen < 0) throw new Error("CAR block is shorter than a CID");
    const data = reader.take(dataLen);
    const cid = cidToString(cidBin);
    blocks.set(cid, data);
    ranges.set(cid, { offset: start + CID_LEN, length: dataLen });
    if (reader.offset !== start + len) throw new Error("CAR block length does not match");
  }
  if (!blocks.has(root)) throw new Error("CAR root block is missing");
  return { root, blocks, ranges };
}

export function isCar(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2 || bytes[0]! >= 0x80 || bytes[1] !== 0xa2) return false;
  try {
    decodeCar(bytes);
    return true;
  } catch {
    return false;
  }
}

function cidBytes(digest: Uint8Array): Uint8Array {
  if (digest.byteLength !== DIGEST_LEN) throw new Error("sha2-256 digest must be 32 bytes");
  const out = new Uint8Array(CID_LEN);
  out[0] = 0x01;
  out[1] = RAW_CODEC;
  out[2] = SHA2_256;
  out[3] = DIGEST_LEN;
  out.set(digest, 4);
  return out;
}

function carHeader(root: Uint8Array): Uint8Array {
  // dag-cbor map { "roots": [cid], "version": 1 } with keys sorted by encoded length.
  const cidTagged = new Uint8Array(2 + 2 + 1 + root.byteLength);
  cidTagged[0] = 0xd8;
  cidTagged[1] = 0x2a;
  cidTagged[2] = 0x58;
  cidTagged[3] = 1 + root.byteLength;
  cidTagged[4] = 0x00;
  cidTagged.set(root, 5);
  return concat([
    Uint8Array.of(0xa2),
    text("roots"),
    Uint8Array.of(0x81),
    cidTagged,
    text("version"),
    Uint8Array.of(0x01),
  ]);
}

function readHeaderRoot(header: Uint8Array): string {
  if (header[0] !== 0xa2) throw new Error("CAR header is not a map");
  const reader = new Reader(header.subarray(1));
  const first = reader.text();
  if (first !== "roots") throw new Error("CAR header is missing roots");
  if (reader.byte() !== 0x81) throw new Error("CAR header must list one root");
  if (reader.byte() !== 0xd8 || reader.byte() !== 0x2a) throw new Error("CAR root is not a CID");
  if (reader.byte() !== 0x58) throw new Error("CAR root CID length is invalid");
  const len = reader.byte();
  const wrapped = reader.take(len);
  if (wrapped[0] !== 0x00) throw new Error("CAR root CID identity prefix is missing");
  const cid = wrapped.subarray(1);
  const versionKey = reader.text();
  if (versionKey !== "version" || reader.byte() !== 0x01) throw new Error("CAR header version is invalid");
  if (!reader.done) throw new Error("CAR header has trailing bytes");
  return cidToString(cid);
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function cidToString(cid: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of cid) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function cidFromString(cid: string): Uint8Array {
  if (!cid.startsWith("b") || cid.length < 2) throw new Error("content CID is invalid");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cid.slice(1)) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("content CID is invalid");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const bytes = Uint8Array.from(out);
  if (bytes.byteLength !== CID_LEN || bytes[0] !== 0x01 || bytes[1] !== RAW_CODEC) throw new Error("content CID is invalid");
  return bytes;
}

function text(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength >= 24) throw new Error("CAR text is too long");
  return concat([Uint8Array.of(0x60 | bytes.byteLength), bytes]);
}

function varint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("varint is invalid");
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

class Reader {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.byteLength;
  }

  byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new Error("CAR ended early");
    this.offset += 1;
    return value;
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.byteLength) throw new Error("CAR ended early");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  varint(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
    throw new Error("CAR varint is too long");
  }

  text(): string {
    const major = this.byte();
    const length = major & 0x1f;
    if ((major & 0xe0) !== 0x60 || length >= 24) throw new Error("CAR text is invalid");
    return new TextDecoder().decode(this.take(length));
  }
}

/** A CAR that declares roots but does not contain them. */
export class CarArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarArchiveError";
  }
}

/**
 * Read CARv1 roots and confirm each root block is present.
 * Returns the original bytes' root CIDs. Does not re-encode the archive.
 */
export function readCarRoots(bytes: Uint8Array): string[] {
  const reader = new Reader(bytes);
  let headerLen: number;
  try {
    headerLen = reader.varint();
  } catch {
    throw new Error("not a CAR");
  }
  const header = reader.take(headerLen);
  const decoded = decodeCbor(header);
  if (!decoded || typeof decoded !== "object" || decoded instanceof Uint8Array || !("roots" in (decoded as object))) {
    throw new Error("not a CAR");
  }
  const record = decoded as { roots?: unknown; version?: unknown };
  if (record.version !== 1) throw new CarArchiveError("CAR header version is invalid");
  if (!Array.isArray(record.roots) || record.roots.length === 0) {
    throw new CarArchiveError("The CAR archive needs at least one root CID for Drive to track and retrieve it.");
  }
  const roots = record.roots.map((root) => {
    if (!(root instanceof Uint8Array) || root.byteLength === 0) throw new CarArchiveError("CAR root CID is invalid");
    return root;
  });
  const present = new Set<string>();
  while (!reader.done) {
    const len = reader.varint();
    const start = reader.offset;
    const cid = takeCid(reader);
    const consumed = reader.offset - start;
    const dataLen = len - consumed;
    if (dataLen < 0) throw new CarArchiveError("CAR block is shorter than a CID");
    reader.take(dataLen);
    present.add(cidToString(cid));
  }
  return roots.map((root) => {
    const cid = cidToString(root);
    if (!present.has(cid)) throw new CarArchiveError(`The CAR archive is missing its root block: ${cid}`);
    return cid;
  });
}

function takeCid(reader: Reader): Uint8Array {
  const start = reader.offset;
  const marker = reader.bytes[reader.offset];
  if (marker === 0x12 && reader.bytes[reader.offset + 1] === 0x20) return reader.take(34);
  if (marker !== 0x01) throw new CarArchiveError("CAR block CID is invalid");
  reader.byte();
  reader.varint();
  reader.varint();
  const digestLen = reader.varint();
  reader.take(digestLen);
  return reader.bytes.subarray(start, reader.offset);
}

function decodeCbor(bytes: Uint8Array): unknown {
  const reader = new Reader(bytes);
  const value = readCbor(reader);
  if (!reader.done) throw new Error("CAR header has trailing bytes");
  return value;
}

function readCbor(reader: Reader): unknown {
  const major = reader.byte();
  const type = major >> 5;
  const info = major & 0x1f;
  if (type === 0) return readArg(reader, info);
  if (type === 2) return reader.take(readArg(reader, info));
  if (type === 3) return new TextDecoder().decode(reader.take(readArg(reader, info)));
  if (type === 4) {
    const count = readArg(reader, info);
    const items: unknown[] = [];
    for (let i = 0; i < count; i += 1) items.push(readCbor(reader));
    return items;
  }
  if (type === 5) {
    const count = readArg(reader, info);
    const map: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      const key = readCbor(reader);
      const value = readCbor(reader);
      if (typeof key === "string") map[key] = value;
    }
    return map;
  }
  if (type === 6) {
    const tag = readArg(reader, info);
    const value = readCbor(reader);
    if (tag === 42 && value instanceof Uint8Array) {
      if (value[0] !== 0x00) throw new CarArchiveError("CAR root CID identity prefix is missing");
      return value.subarray(1);
    }
    return value;
  }
  if (type === 7 && info === 20) return false;
  if (type === 7 && info === 21) return true;
  if (type === 7 && info === 22) return null;
  throw new Error("CAR header is not a map");
}

function readArg(reader: Reader, info: number): number {
  if (info < 24) return info;
  if (info === 24) return reader.byte();
  if (info === 25) return (reader.byte() << 8) | reader.byte();
  if (info === 26) return reader.byte() * 2 ** 24 + (reader.byte() << 16) + (reader.byte() << 8) + reader.byte();
  throw new Error("CAR header length is invalid");
}
