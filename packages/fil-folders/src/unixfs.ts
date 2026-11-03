/**
 * Minimal CARv1 + dag-pb + UnixFS reader for Filecoin Pin ("Filecoin Drive") pieces.
 * Enough to unwrap a single file and list directories. HAMT-sharded directories are not expanded.
 */

export interface CarBlocks {
  roots: string[];
  blocks: Map<string, Uint8Array>;
}

export interface UnixfsEntry {
  name: string;
  cid: string;
  size: number;
  kind: "file" | "directory" | "raw" | "other";
  /** Children for directories, when expanded. */
  children?: UnixfsEntry[];
}

const RAW = 0x55;
const DAG_PB = 0x70;

function varint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    if (pos >= bytes.length) throw new Error("varint runs past the end");
    const byte = bytes[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, pos];
    shift += 7;
    if (shift > 49) throw new Error("varint too long");
  }
}

/** Length of a binary CID (v0 or v1) starting at `at`. */
function cidLength(bytes: Uint8Array, at: number): number {
  if (bytes[at] === 0x12 && bytes[at + 1] === 0x20) return 34; // CIDv0
  let pos = at;
  const [version, a] = varint(bytes, pos);
  if (version !== 1) throw new Error(`unsupported CID version ${version}`);
  const [, b] = varint(bytes, a);
  const [, c] = varint(bytes, b);
  const [digestLen, d] = varint(bytes, c);
  pos = d + digestLen;
  return pos - at;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function cidToString(cid: Uint8Array): string {
  const bin = cid.length === 34 && cid[0] === 0x12 ? new Uint8Array([0x01, DAG_PB, ...cid]) : cid;
  let out = "b";
  let buffer = 0;
  let bits = 0;
  for (const byte of bin) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

function codecOf(cid: string): number {
  // base32 decode just enough of the prefix: version + codec varints.
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const ch of cid.slice(1, 8)) {
    buffer = (buffer << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const [, after] = varint(Uint8Array.from(bytes), 0);
  return varint(Uint8Array.from(bytes), after)[0];
}

export function looksLikeCar(bytes: Uint8Array): boolean {
  try {
    const [len, at] = varint(bytes, 0);
    if (len < 8 || len > 4096 || at + len > bytes.length) return false;
    const header = bytes.subarray(at, at + len);
    return header[0] === 0xa2 && new TextDecoder().decode(header).includes("roots");
  } catch {
    return false;
  }
}

export function parseCar(bytes: Uint8Array): CarBlocks {
  const [headerLen, start] = varint(bytes, 0);
  const header = bytes.subarray(start, start + headerLen);
  const roots: string[] = [];
  // Roots are CBOR tag 42 byte strings with a leading 0x00 multibase byte.
  for (let i = 0; i + 4 < header.length; i++) {
    if (header[i] !== 0xd8 || header[i + 1] !== 0x2a) continue;
    let len = 0;
    let at = i + 3;
    if (header[i + 2] === 0x58) {
      len = header[i + 3]!;
      at = i + 4;
    } else if (header[i + 2]! >= 0x40 && header[i + 2]! < 0x58) {
      len = header[i + 2]! - 0x40;
    } else continue;
    roots.push(cidToString(header.subarray(at + 1, at + len)));
    i = at + len - 1;
  }
  const blocks = new Map<string, Uint8Array>();
  let pos = start + headerLen;
  while (pos < bytes.length) {
    const [len, at] = varint(bytes, pos);
    if (len === 0) break; // trailing zero padding
    const cl = cidLength(bytes, at);
    blocks.set(cidToString(bytes.subarray(at, at + cl)), bytes.subarray(at + cl, at + len));
    pos = at + len;
  }
  return { roots, blocks };
}

interface PbLink {
  cid: string;
  name: string;
  tsize: number;
}
interface PbNode {
  data: Uint8Array;
  links: PbLink[];
}

function fields(bytes: Uint8Array, visit: (field: number, wire: number, value: number | Uint8Array) => void): void {
  let pos = 0;
  while (pos < bytes.length) {
    const [key, a] = varint(bytes, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const [value, b] = varint(bytes, a);
      visit(field, wire, value);
      pos = b;
    } else if (wire === 2) {
      const [len, b] = varint(bytes, a);
      visit(field, wire, bytes.subarray(b, b + len));
      pos = b + len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

export function decodePb(bytes: Uint8Array): PbNode {
  const node: PbNode = { data: new Uint8Array(), links: [] };
  fields(bytes, (field, _wire, value) => {
    if (field === 1 && value instanceof Uint8Array) node.data = value;
    if (field === 2 && value instanceof Uint8Array) {
      const link: PbLink = { cid: "", name: "", tsize: 0 };
      fields(value, (f, _w, v) => {
        if (f === 1 && v instanceof Uint8Array) link.cid = cidToString(v);
        if (f === 2 && v instanceof Uint8Array) link.name = new TextDecoder().decode(v);
        if (f === 3 && typeof v === "number") link.tsize = v;
      });
      node.links.push(link);
    }
  });
  return node;
}

interface UnixfsData {
  type: number;
  data: Uint8Array;
  filesize: number;
}

export function decodeUnixfs(bytes: Uint8Array): UnixfsData {
  const out: UnixfsData = { type: -1, data: new Uint8Array(), filesize: 0 };
  fields(bytes, (field, _wire, value) => {
    if (field === 1 && typeof value === "number") out.type = value;
    if (field === 2 && value instanceof Uint8Array) out.data = value;
    if (field === 3 && typeof value === "number") out.filesize = value;
  });
  return out;
}

function block(car: CarBlocks, cid: string): Uint8Array {
  const found = car.blocks.get(cid);
  if (!found) throw new Error(`block ${cid} is not in this piece`);
  return found;
}

/** Concatenated file bytes under `cid` (raw leaf or UnixFS file DAG). */
export function readFile(car: CarBlocks, cid: string): Uint8Array {
  const bytes = block(car, cid);
  if (codecOf(cid) === RAW) return bytes;
  const node = decodePb(bytes);
  const fs = decodeUnixfs(node.data);
  if (fs.type !== 2 && fs.type !== 0) throw new Error("not a UnixFS file");
  const parts = [fs.data, ...node.links.map((link) => readFile(car, link.cid))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function entryKind(car: CarBlocks, cid: string): UnixfsEntry["kind"] {
  if (codecOf(cid) === RAW) return "raw";
  const bytes = car.blocks.get(cid);
  if (!bytes) return "other";
  const fs = decodeUnixfs(decodePb(bytes).data);
  return fs.type === 1 ? "directory" : fs.type === 2 || fs.type === 0 ? "file" : "other";
}

function fileSize(car: CarBlocks, cid: string, fallback: number): number {
  if (codecOf(cid) === RAW) return car.blocks.get(cid)?.length ?? fallback;
  const bytes = car.blocks.get(cid);
  if (!bytes) return fallback;
  return decodeUnixfs(decodePb(bytes).data).filesize || fallback;
}

/** List a UnixFS directory, recursing up to `depth` levels. */
export function listDirectory(car: CarBlocks, cid: string, depth = 4): UnixfsEntry[] {
  const node = decodePb(block(car, cid));
  return node.links.map((link) => {
    const kind = entryKind(car, link.cid);
    const entry: UnixfsEntry = { name: link.name, cid: link.cid, size: fileSize(car, link.cid, link.tsize), kind };
    if (kind === "directory" && depth > 0) entry.children = listDirectory(car, link.cid, depth - 1);
    return entry;
  });
}

/** Find a path ("a/b.txt") under a directory root. */
export function resolvePath(car: CarBlocks, root: string, path: string): string {
  let cid = root;
  for (const part of path.split("/").filter(Boolean)) {
    const link = decodePb(block(car, cid)).links.find((item) => item.name === part);
    if (!link) throw new Error(`${path} is not in this piece`);
    cid = link.cid;
  }
  return cid;
}

// ---- test helpers: build tiny UnixFS CARs (sha256 is not verified by the reader) ----
function enc(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}
function lenField(field: number, bytes: Uint8Array | number[]): number[] {
  return [...enc(field * 8 + 2), ...enc(bytes.length), ...bytes];
}
let fakeSeq = 0;
function fakeCid(codec: number): Uint8Array {
  const digest = new Uint8Array(32);
  const n = ++fakeSeq;
  digest[0] = n & 0xff;
  digest[1] = (n >> 8) & 0xff;
  digest[31] = codec;
  return new Uint8Array([0x01, codec, 0x12, 0x20, ...digest]);
}
export type FixtureNode = Uint8Array | { [name: string]: FixtureNode };
/** Build a CAR from a nested object: Uint8Array = file (raw leaf), object = directory. */
export function buildFixtureCar(rootNode: FixtureNode, wrapFile = true): Uint8Array {
  const blocks: [Uint8Array, Uint8Array][] = [];
  const put = (node: FixtureNode): { cid: Uint8Array; size: number } => {
    if (node instanceof Uint8Array) {
      if (!wrapFile) {
        const cid = fakeCid(RAW);
        blocks.push([cid, node]);
        return { cid, size: node.length };
      }
      const leaf = fakeCid(RAW);
      blocks.push([leaf, node]);
      const data = [...enc(1 * 8 + 0), 2, ...enc(3 * 8 + 0), ...enc(node.length)];
      const link = [...lenField(1, leaf), ...enc(3 * 8 + 0), ...enc(node.length)];
      const pb = new Uint8Array([...lenField(2, link), ...lenField(1, data)]);
      const cid = fakeCid(DAG_PB);
      blocks.push([cid, pb]);
      return { cid, size: node.length };
    }
    const links: number[] = [];
    let size = 0;
    for (const [name, child] of Object.entries(node)) {
      const made = put(child);
      size += made.size;
      links.push(...lenField(2, [...lenField(1, made.cid), ...lenField(2, new TextEncoder().encode(name)), ...enc(3 * 8 + 0), ...enc(made.size)]));
    }
    const pb = new Uint8Array([...links, ...lenField(1, [...enc(1 * 8 + 0), 1])]);
    const cid = fakeCid(DAG_PB);
    blocks.push([cid, pb]);
    return { cid, size };
  };
  const root = put(rootNode).cid;
  const header = new Uint8Array([0xa2, 0x65, ...new TextEncoder().encode("roots"), 0x81, 0xd8, 0x2a, 0x58, root.length + 1, 0x00, ...root, 0x67, ...new TextEncoder().encode("version"), 0x01]);
  const parts: number[] = [...enc(header.length), ...header];
  for (const [cid, data] of blocks) parts.push(...enc(cid.length + data.length), ...cid, ...data);
  return new Uint8Array(parts);
}
