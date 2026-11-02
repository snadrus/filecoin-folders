import { isAddress, type Address, type Hex } from "viem";
import { contentCid, decodeCar, encodeCar, isCar } from "./car.js";
import { bytesToPieceCid, decodeUtf8, isByteStream, pieceCidToBytes, readStream, utf8, bytesToBase64Url, base64UrlToBytes } from "./bytes.js";
import { manifestBytes, parseManifest } from "./codec.js";
import { deriveVolumeKey, decryptBytes, encryptBytes, FILE_AAD, NAME_AAD, signVolumeKey, volumeKeyInfo } from "./crypto.js";
import { CasRetryError, IsADirectoryError, NotFoundError, RegistryCasConflict } from "./errors.js";
import { FIL_FOLDERS_NAMESPACE, namespaceId, volumeKey } from "./ids.js";
import { mergeTrees } from "./merge.js";
import { normalizePath } from "./paths.js";
import type { Registry } from "./registry/types.js";
import { withPiecePadding } from "./pad.js";
import { createSynapseStorage } from "./storage/synapse.js";
import type { Storage } from "./storage/types.js";
import {
  copy,
  emptyDir,
  find,
  fingerprint,
  list,
  mkdir,
  move,
  putFile,
  remove,
  sameTree,
  toStat,
} from "./tree.js";
import type {
  DirNode,
  EncryptionOptions,
  FileNode,
  HistoryEntry,
  Manifest,
  ManifestEnc,
  ManifestEntry,
  Node,
  PutOptions,
  RmOptions,
  Stat,
  SynapseLike,
} from "./types.js";

/** Inline a subdirectory until its manifest JSON exceeds this many bytes. */
export const DEFAULT_DIR_THRESHOLD = 24 * 1024;

export interface OpenVolumeOptions {
  /** `@filoz/synapse-sdk` instance. Wrapped with {@link createSynapseStorage}. */
  synapse?: SynapseLike;
  /** Piece store. Used instead of `synapse` when both are set. */
  storage?: Storage;
  registry: Registry;
  owner: Address;
  /** Volume name. The registry key is `keccak256(utf8(name))`. */
  name: string;
  encryption?: EncryptionOptions;
  /** Spill a subdirectory into its own manifest block once its JSON is larger than this. Default 24 KiB. */
  dirThreshold?: number;
  /** Compare-and-swap attempts, including the first. Default 5. */
  maxRetries?: number;
  now?: () => number;
}

/**
 * Open a folder volume. The registry head at
 * `(owner, keccak256("fil-folders"), keccak256(name))` is the root manifest PieceCID.
 *
 * Calls outside {@link Volume.tx} rebase on the latest head and commit immediately.
 * `tx` keeps one draft and commits it once.
 * Each commit uploads one CARv1 piece: the new manifest plus any new or changed
 * file bytes. Creating a parent directory and a file in one `tx` is still one
 * piece; the manifest entry and the file bytes are both in it. A commit with
 * no new file bytes is manifest-only. Unchanged files stay in the piece that
 * already holds them.
 * The registry head is that piece. Older heads that are raw manifest JSON,
 * and files that are their own pieces, still load.
 */
export async function openVolume(options: OpenVolumeOptions): Promise<Volume> {
  if (!options.registry) throw new Error("openVolume requires registry");
  if (!options.owner || !isAddress(options.owner)) throw new Error("openVolume requires an owner address");
  if (typeof options.name !== "string" || options.name.length === 0) throw new Error("openVolume requires a volume name");
  const raw = options.storage ?? (options.synapse ? createSynapseStorage(options.synapse) : undefined);
  if (!raw) throw new Error("openVolume requires storage or synapse");
  const storage = withPiecePadding(raw);
  const volume = new Volume(options, storage);
  await volume.init();
  return volume;
}

export class Volume {
  readonly owner: Address;
  readonly name: string;
  readonly ns: Hex;
  readonly key: Hex;
  readonly storage: Storage;
  readonly registry: Registry;
  readonly dirThreshold: number;
  readonly maxRetries: number;

  #now: () => number;
  #encryption?: EncryptionOptions;
  #cryptoKey?: CryptoKey;
  #basePiece = "";
  #baseVersion = 0n;
  #baseTree: DirNode = emptyDir();
  #loaded = false;
  #pending: DirNode | null = null;
  #txDepth = 0;
  #txBasePiece = "";
  #txBaseTree: DirNode = emptyDir();
  #cache = new Map<string, DirNode>();
  /** File bytes waiting for the next CAR. Keyed by content CID. */
  #blobs = new Map<string, Uint8Array>();
  /** Parsed CAR blocks and legacy directory pieces, keyed by content or piece CID. */
  #blockIndex = new Map<string, Uint8Array>();
  #pieceBytes = new Map<string, Uint8Array>();
  #ranges = new Map<string, Map<string, { offset: number; length: number }>>();

  constructor(options: OpenVolumeOptions, storage: Storage) {
    this.owner = options.owner;
    this.name = options.name;
    this.ns = namespaceId(FIL_FOLDERS_NAMESPACE);
    this.key = volumeKey(options.name);
    this.storage = storage;
    this.registry = options.registry;
    this.dirThreshold = options.dirThreshold ?? DEFAULT_DIR_THRESHOLD;
    this.maxRetries = options.maxRetries ?? 5;
    this.#now = options.now ?? (() => Date.now());
    this.#encryption = options.encryption;
    if (this.dirThreshold < 0 || !Number.isFinite(this.dirThreshold)) throw new Error("dirThreshold must be >= 0");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 1) throw new Error("maxRetries must be >= 1");
  }

  async init(): Promise<void> {
    if (this.#encryption) {
      const mode = this.#encryption.mode ?? "eip712";
      const signature = await signVolumeKey({
        mode,
        signer: this.#encryption.signer,
        chainId: this.#encryption.chainId,
        registryAddress: this.#encryption.registryAddress,
        owner: this.owner,
        volume: this.name,
      });
      this.#cryptoKey = await deriveVolumeKey(
        signature,
        volumeKeyInfo({
          mode,
          chainId: this.#encryption.chainId,
          registryAddress: this.#encryption.registryAddress,
          owner: this.owner,
          volume: this.name,
        }),
      );
    }
    await this.#reload();
  }

  async mkdir(path: string): Promise<void> {
    const now = this.#now();
    await this.#edit((tree) => mkdir(tree, path, now));
  }

  async put(path: string, data: Uint8Array | ReadableStream<Uint8Array>, opts?: PutOptions): Promise<Stat> {
    const now = this.#now();
    const file = await this.#upload(data, opts, now);
    let stat: Stat | undefined;
    await this.#edit((tree) => {
      const next = putFile(tree, path, file, now);
      const norm = normalizePath(path);
      const node = find(next, norm);
      if (!node) throw new NotFoundError(norm);
      stat = toStat(node, norm, this.name);
      return next;
    });
    if (!stat) throw new Error("put did not produce a file");
    return stat;
  }

  async get(path: string): Promise<Uint8Array> {
    const norm = normalizePath(path);
    const node = find(await this.#read(), norm);
    if (!node) throw new NotFoundError(norm);
    if (node.type !== "file") throw new IsADirectoryError(norm);
    const bytes = await this.#readFile(node);
    if (!node.enc) return bytes;
    if (!this.#cryptoKey) throw new Error("volume is encrypted; pass encryption to openVolume");
    return decryptBytes(this.#cryptoKey, bytes, node.enc.iv, FILE_AAD);
  }

  async ls(path = "/"): Promise<Stat[]> {
    return list(await this.#read(), path);
  }

  async stat(path = "/"): Promise<Stat> {
    const norm = normalizePath(path);
    const node = find(await this.#read(), norm);
    if (!node) throw new NotFoundError(norm);
    return toStat(node, norm, this.name);
  }

  async mv(from: string, to: string): Promise<void> {
    const now = this.#now();
    await this.#edit((tree) => move(tree, from, to, now));
  }

  async cp(from: string, to: string): Promise<void> {
    const now = this.#now();
    await this.#edit((tree) => copy(tree, from, to, now));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const now = this.#now();
    await this.#edit((tree) => remove(tree, path, options?.recursive ?? false, now));
  }

  /**
   * Committed registry events for this volume. A path limits the result to
   * versions where that file or directory changed.
   */
  async history(path?: string): Promise<HistoryEntry[]> {
    const events = [...(await this.registry.committed({ owner: this.owner, ns: this.ns, key: this.key }))].sort((a, b) =>
      a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
    );
    if (path === undefined) {
      return events.map((event) => this.#historyEntry(event));
    }
    const norm = normalizePath(path);
    const out: HistoryEntry[] = [];
    let previous: string | null = null;
    let started = false;
    for (const event of events) {
      const cid = bytesToPieceCid(event.pieceCid);
      const tree = cid === "" ? emptyDir() : await this.#load(cid);
      const next = fingerprint(tree, norm);
      if (!started) {
        started = true;
        if (next === null) continue;
      } else if (next === previous) {
        continue;
      }
      const change: HistoryEntry["change"] = previous === null && next !== null ? "added" : next === null ? "removed" : "updated";
      previous = next;
      out.push({ ...this.#historyEntry(event), path: norm, change });
    }
    return out;
  }

  /**
   * Storage piece ids the live tree still needs: the registry head, each
   * file's `located` piece, and a legacy per-file piece when it has no locator.
   * A piece absent from this set is safe to schedule for removal.
   */
  async referencedPieces(): Promise<string[]> {
    const head = await this.registry.head(this.owner, this.ns, this.key);
    const ids = new Set<string>();
    const headCid = bytesToPieceCid(head.pieceCid);
    if (head.version > 0n && headCid) ids.add(headCid);
    const walk = (node: Node): void => {
      if (node.type === "dir") {
        for (const child of node.entries) walk(child);
        return;
      }
      if (node.located) ids.add(node.located);
      else if (node.pieceCid) ids.add(node.pieceCid);
    };
    walk(await this.#read());
    return [...ids];
  }

  /** Apply several edits, then compare-and-swap the root once. */
  async tx<T>(fn: (volume: Volume) => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) return fn(this);
    await this.#reload();
    this.#txBasePiece = this.#basePiece;
    this.#txBaseTree = this.#baseTree;
    this.#pending = this.#baseTree;
    this.#txDepth = 1;
    const blobsBefore = new Set(this.#blobs.keys());
    try {
      const result = await fn(this);
      const pending = this.#pending ?? this.#txBaseTree;
      if (!sameTree(this.#txBaseTree, pending)) await this.#commitTree(this.#txBasePiece, this.#txBaseTree, pending);
      return result;
    } catch (error) {
      for (const cid of this.#blobs.keys()) {
        if (!blobsBefore.has(cid)) this.#blobs.delete(cid);
      }
      throw error;
    } finally {
      this.#txDepth = 0;
      this.#pending = null;
    }
  }

  async #readFile(node: FileNode): Promise<Uint8Array> {
    const staged = this.#blobs.get(node.pieceCid);
    if (staged) return staged;
    const cached = this.#blockIndex.get(node.pieceCid);
    if (cached && node.located) return cached;
    if (node.located) {
      await this.#ensurePiece(node.located);
      const block = await this.#blockFromPiece(node.located, node.pieceCid);
      if (block) return block;
    }
    const inline = this.#blockIndex.get(node.pieceCid);
    if (inline) return inline;
    return this.storage.get(node.pieceCid);
  }

  async #blockFromPiece(piece: string, cid: string): Promise<Uint8Array | undefined> {
    const cached = this.#blockIndex.get(cid);
    if (cached) return cached;
    const range = this.#ranges.get(piece)?.get(cid);
    if (range && this.storage.getRange) {
      const slice = await this.storage.getRange(piece, range.offset, range.length);
      this.#blockIndex.set(cid, slice);
      return slice;
    }
    return undefined;
  }

  async #ensurePiece(piece: string): Promise<void> {
    if (this.#pieceBytes.has(piece)) return;
    const bytes = await this.storage.get(piece);
    this.#pieceBytes.set(piece, bytes);
    if (!isCar(bytes)) return;
    const car = decodeCar(bytes);
    this.#ranges.set(piece, car.ranges);
    for (const [cid, block] of car.blocks) this.#blockIndex.set(cid, block);
  }

  async #upload(
    data: Uint8Array | ReadableStream<Uint8Array>,
    opts: PutOptions | undefined,
    mtime: number,
  ): Promise<Omit<FileNode, "type" | "name">> {
    const mime = opts?.mime;
    const plain = isByteStream(data) ? await readStream(data) : data;
    if (this.#cryptoKey) {
      const sealed = await encryptBytes(this.#cryptoKey, plain, FILE_AAD);
      const pieceCid = await contentCid(sealed.ciphertext);
      this.#blobs.set(pieceCid, sealed.ciphertext);
      const file: Omit<FileNode, "type" | "name"> = {
        pieceCid,
        size: plain.byteLength,
        mtime,
        enc: { alg: "A256GCM", iv: sealed.iv },
      };
      if (mime) file.mime = mime;
      stampShare(file, opts);
      return file;
    }
    const pieceCid = await contentCid(plain);
    this.#blobs.set(pieceCid, plain);
    const file: Omit<FileNode, "type" | "name"> = { pieceCid, size: plain.byteLength, mtime };
    if (mime) file.mime = mime;
    stampShare(file, opts);
    return file;
  }

  async #edit(mutate: (tree: DirNode) => DirNode): Promise<void> {
    if (this.#txDepth === 0) {
      await this.#reload();
      const basePiece = this.#basePiece;
      const baseTree = this.#baseTree;
      const next = mutate(baseTree);
      if (sameTree(baseTree, next)) return;
      await this.#commitTree(basePiece, baseTree, next);
      return;
    }
    const current = this.#pending ?? this.#baseTree;
    this.#pending = mutate(current);
  }

  async #read(): Promise<DirNode> {
    if (this.#txDepth > 0 && this.#pending) return this.#pending;
    await this.#reload();
    return this.#baseTree;
  }

  async #reload(): Promise<void> {
    const head = await this.registry.head(this.owner, this.ns, this.key);
    const cid = bytesToPieceCid(head.pieceCid);
    if (this.#loaded && cid === this.#basePiece && head.version === this.#baseVersion) return;
    this.#basePiece = cid;
    this.#baseVersion = head.version;
    this.#baseTree = cid === "" ? emptyDir() : await this.#load(cid);
    this.#loaded = true;
  }

  async #commitTree(basePiece: string, baseTree: DirNode, next: DirNode): Promise<void> {
    let prevPiece = basePiece;
    let base = baseTree;
    let ours = next;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const pieceCid = await this.#storeRoot(ours);
      try {
        const record = await this.registry.commit({
          owner: this.owner,
          ns: this.ns,
          key: this.key,
          pieceCid: pieceCidToBytes(pieceCid),
          prevPieceCid: pieceCidToBytes(prevPiece),
        });
        this.#basePiece = pieceCid;
        this.#baseVersion = record.version;
        this.#baseTree = ours;
        this.#loaded = true;
        this.#cache.set(pieceCid, ours);
        return;
      } catch (error) {
        if (!(error instanceof RegistryCasConflict)) throw error;
        if (attempt === this.maxRetries) throw new CasRetryError(this.maxRetries);
        const theirCid = bytesToPieceCid(error.currentPieceCid);
        const theirs = theirCid === "" ? emptyDir() : await this.#load(theirCid);
        ours = mergeTrees(base, ours, theirs);
        base = theirs;
        prevPiece = theirCid;
      }
    }
  }

  async #storeRoot(dir: DirNode): Promise<string> {
    const stored = await this.#persistDir(dir, true);
    if (!stored.root) throw new Error("root manifest was not stored");
    const car = encodeCar(stored.root, stored.blocks);
    const uploaded = await this.storage.put(car);
    const decoded = decodeCar(car);
    this.#pieceBytes.set(uploaded.pieceCid, car);
    this.#ranges.set(uploaded.pieceCid, decoded.ranges);
    for (const [cid, block] of stored.blocks) this.#blockIndex.set(cid, block);
    stampLocated(dir, uploaded.pieceCid, stored.blocks);
    for (const cid of stored.blocks.keys()) this.#blobs.delete(cid);
    return uploaded.pieceCid;
  }

  async #persistDir(dir: DirNode, isRoot: boolean): Promise<{ root?: string; entries: ManifestEntry[]; size: number; blocks: Map<string, Uint8Array> }> {
    const entries: ManifestEntry[] = [];
    const blocks = new Map<string, Uint8Array>();
    let size = 0;
    const children = [...dir.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const sealed = await this.#sealName(child.name);
      if (child.type === "file") {
        size += child.size;
        const blob = this.#blobs.get(child.pieceCid);
        if (blob) blocks.set(child.pieceCid, blob);
        entries.push(fileEntry(child, sealed));
      } else {
        const nested = await this.#persistDir(child, false);
        size += nested.size;
        for (const [cid, block] of nested.blocks) blocks.set(cid, block);
        const entry: ManifestEntry = {
          name: sealed.name,
          type: "dir",
          size: nested.size,
          mtime: child.mtime,
        };
        const enc = packEnc(undefined, sealed.nameIv);
        if (enc) entry.enc = enc;
        if (nested.root) entry.pieceCid = nested.root;
        else entry.entries = nested.entries;
        entries.push(entry);
      }
    }
    const located = isRoot ? locatedIndex(dir, blocks) : undefined;
    const manifest: Manifest = { v: 1, mtime: dir.mtime, entries };
    if (located && Object.keys(located).length > 0) manifest.located = located;
    const bytes = manifestBytes(manifest);
    if (isRoot || bytes.byteLength > this.dirThreshold) {
      const root = await contentCid(bytes);
      blocks.set(root, bytes);
      return { root, entries, size, blocks };
    }
    return { entries, size, blocks };
  }

  async #load(pieceCid: string, ctx?: HydrateCtx): Promise<DirNode> {
    const cached = this.#cache.get(pieceCid);
    if (cached) return cached;
    const inline = this.#blockIndex.get(pieceCid);
    if (inline && ctx) {
      const tree = await this.#hydrate(parseManifest(inline), ctx);
      this.#cache.set(pieceCid, tree);
      return tree;
    }
    const bytes = await this.#fetchPiece(pieceCid);
    if (isCar(bytes)) {
      const car = decodeCar(bytes);
      this.#ranges.set(pieceCid, car.ranges);
      for (const [cid, block] of car.blocks) this.#blockIndex.set(cid, block);
      const root = car.blocks.get(car.root);
      if (!root) throw new Error("CAR root block is missing");
      const manifest = parseManifest(root);
      const tree = await this.#hydrate(manifest, { piece: pieceCid, located: manifest.located });
      this.#cache.set(pieceCid, tree);
      return tree;
    }
    const manifest = parseManifest(bytes);
    const tree = await this.#hydrate(manifest, ctx ?? { piece: pieceCid, located: manifest.located });
    this.#cache.set(pieceCid, tree);
    return tree;
  }

  async #fetchPiece(piece: string): Promise<Uint8Array> {
    const cached = this.#pieceBytes.get(piece);
    if (cached) return cached;
    const bytes = await this.storage.get(piece);
    this.#pieceBytes.set(piece, bytes);
    return bytes;
  }

  async #hydrate(manifest: Manifest, ctx?: HydrateCtx): Promise<DirNode> {
    const entries: Node[] = [];
    const seen = new Set<string>();
    const located = ctx?.located ?? manifest.located;
    const nextCtx: HydrateCtx | undefined = ctx ? { piece: ctx.piece, located } : undefined;
    for (const entry of manifest.entries) {
      const name = await this.#openName(entry.name, entry.enc?.nameIv);
      if (seen.has(name)) throw new Error(`duplicate manifest name: ${name}`);
      seen.add(name);
      if (entry.type === "file") {
        if (!entry.pieceCid) throw new Error("file entry is missing pieceCid");
        const file: FileNode = {
          type: "file",
          name,
          pieceCid: entry.pieceCid,
          size: entry.size,
          mtime: entry.mtime,
        };
        if (ctx && this.#blockIndex.has(entry.pieceCid)) file.located = ctx.piece;
        else if (located?.[entry.pieceCid]) file.located = located[entry.pieceCid];
        if (entry.mime !== undefined) file.mime = entry.mime;
        if (entry.ipfs !== undefined) file.ipfs = entry.ipfs;
        if (entry.importedCar) file.importedCar = true;
        if (entry.enc?.iv) file.enc = { alg: "A256GCM", iv: entry.enc.iv };
        entries.push(file);
      } else if (entry.entries) {
        const child = await this.#hydrate({ v: 1, mtime: entry.mtime, entries: entry.entries }, nextCtx);
        child.name = name;
        child.mtime = entry.mtime;
        entries.push(child);
      } else if (entry.pieceCid) {
        const child = structuredClone(await this.#load(entry.pieceCid, nextCtx));
        child.name = name;
        child.mtime = entry.mtime;
        entries.push(child);
      } else {
        entries.push({ type: "dir", name, mtime: entry.mtime, entries: [] });
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { type: "dir", name: "", mtime: manifest.mtime, entries };
  }

  async #sealName(name: string): Promise<{ name: string; nameIv?: string }> {
    if (!this.#cryptoKey) return { name };
    const sealed = await encryptBytes(this.#cryptoKey, utf8(name), NAME_AAD);
    return { name: bytesToBase64Url(sealed.ciphertext), nameIv: sealed.iv };
  }

  async #openName(name: string, nameIv: string | undefined): Promise<string> {
    if (!this.#cryptoKey) return name;
    if (!nameIv) throw new Error("encrypted volume entry is missing nameIv");
    return decodeUtf8(await decryptBytes(this.#cryptoKey, base64UrlToBytes(name), nameIv, NAME_AAD));
  }

  #historyEntry(event: { version: bigint; pieceCid: Uint8Array; prevPieceCid: Uint8Array; timestamp: bigint; txHash?: Hex }): HistoryEntry {
    const entry: HistoryEntry = {
      version: event.version,
      pieceCid: bytesToPieceCid(event.pieceCid),
      prevPieceCid: bytesToPieceCid(event.prevPieceCid),
      timestamp: Number(event.timestamp),
    };
    if (event.txHash) entry.txHash = event.txHash;
    return entry;
  }
}

interface HydrateCtx {
  piece: string;
  located?: Record<string, string>;
}

function locatedIndex(dir: DirNode, blocks: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  const located: Record<string, string> = {};
  const walk = (node: DirNode): void => {
    for (const child of node.entries) {
      if (child.type === "dir") walk(child);
      else if (child.located && !blocks.has(child.pieceCid)) located[child.pieceCid] = child.located;
    }
  };
  walk(dir);
  return located;
}

function stampLocated(dir: DirNode, piece: string, blocks: ReadonlyMap<string, Uint8Array>): void {
  for (const child of dir.entries) {
    if (child.type === "dir") stampLocated(child, piece, blocks);
    else if (blocks.has(child.pieceCid)) child.located = piece;
  }
}

function fileEntry(file: FileNode, sealed: { name: string; nameIv?: string }): ManifestEntry {
  const entry: ManifestEntry = {
    name: sealed.name,
    type: "file",
    size: file.size,
    mtime: file.mtime,
    pieceCid: file.pieceCid,
  };
  if (file.mime !== undefined) entry.mime = file.mime;
  if (file.ipfs !== undefined) entry.ipfs = file.ipfs;
  if (file.importedCar) entry.importedCar = true;
  const enc = packEnc(file.enc?.iv, sealed.nameIv);
  if (enc) entry.enc = enc;
  return entry;
}

function stampShare(file: Omit<FileNode, "type" | "name">, opts: PutOptions | undefined): void {
  if (opts?.ipfs) file.ipfs = opts.ipfs;
  if (opts?.importedCar) file.importedCar = true;
}

function packEnc(iv: string | undefined, nameIv: string | undefined): ManifestEnc | undefined {
  if (!iv && !nameIv) return undefined;
  const enc: ManifestEnc = { alg: "A256GCM" };
  if (iv) enc.iv = iv;
  if (nameIv) enc.nameIv = nameIv;
  return enc;
}
