import { isAddress, type Address, type Hex } from "viem";
import { bytesToPieceCid, decodeUtf8, isByteStream, pieceCidToBytes, readStream, utf8, bytesToBase64Url, base64UrlToBytes } from "./bytes.js";
import { manifestBytes, parseManifest } from "./codec.js";
import { deriveVolumeKey, decryptBytes, encryptBytes, FILE_AAD, NAME_AAD, signVolumeKey, volumeKeyInfo } from "./crypto.js";
import { CasRetryError, IsADirectoryError, NotFoundError, RegistryCasConflict } from "./errors.js";
import { FIL_FOLDERS_NAMESPACE, namespaceId, volumeKey } from "./ids.js";
import { mergeTrees } from "./merge.js";
import { normalizePath } from "./paths.js";
import type { Registry } from "./registry/types.js";
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
  /** Spill a subdirectory into its own piece once its JSON is larger than this. Default 24 KiB. */
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
 * `tx` keeps one draft and commits it once. Piece uploads happen during `put`;
 * the registry commit is the atomic snapshot.
 */
export async function openVolume(options: OpenVolumeOptions): Promise<Volume> {
  if (!options.registry) throw new Error("openVolume requires registry");
  if (!options.owner || !isAddress(options.owner)) throw new Error("openVolume requires an owner address");
  if (typeof options.name !== "string" || options.name.length === 0) throw new Error("openVolume requires a volume name");
  const storage = options.storage ?? (options.synapse ? createSynapseStorage(options.synapse) : undefined);
  if (!storage) throw new Error("openVolume requires storage or synapse");
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
    const bytes = await this.storage.get(node.pieceCid);
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

  /** Apply several edits, then compare-and-swap the root once. */
  async tx<T>(fn: (volume: Volume) => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) return fn(this);
    await this.#reload();
    this.#txBasePiece = this.#basePiece;
    this.#txBaseTree = this.#baseTree;
    this.#pending = this.#baseTree;
    this.#txDepth = 1;
    try {
      const result = await fn(this);
      const pending = this.#pending ?? this.#txBaseTree;
      if (!sameTree(this.#txBaseTree, pending)) await this.#commitTree(this.#txBasePiece, this.#txBaseTree, pending);
      return result;
    } finally {
      this.#txDepth = 0;
      this.#pending = null;
    }
  }

  async #upload(
    data: Uint8Array | ReadableStream<Uint8Array>,
    opts: PutOptions | undefined,
    mtime: number,
  ): Promise<Omit<FileNode, "type" | "name">> {
    const mime = opts?.mime;
    if (this.#cryptoKey) {
      const plain = isByteStream(data) ? await readStream(data) : data;
      const sealed = await encryptBytes(this.#cryptoKey, plain, FILE_AAD);
      const stored = await this.storage.put(sealed.ciphertext);
      const file: Omit<FileNode, "type" | "name"> = {
        pieceCid: stored.pieceCid,
        size: plain.byteLength,
        mtime,
        enc: { alg: "A256GCM", iv: sealed.iv },
      };
      if (mime) file.mime = mime;
      return file;
    }
    const stored = await this.storage.put(data);
    if (!Number.isSafeInteger(stored.size) || stored.size < 0) throw new Error("storage.put did not return a size");
    const file: Omit<FileNode, "type" | "name"> = { pieceCid: stored.pieceCid, size: stored.size, mtime };
    if (mime) file.mime = mime;
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
    if (!stored.pieceCid) throw new Error("root manifest was not stored");
    return stored.pieceCid;
  }

  async #persistDir(dir: DirNode, isRoot: boolean): Promise<{ pieceCid?: string; entries: ManifestEntry[]; size: number }> {
    const entries: ManifestEntry[] = [];
    let size = 0;
    const children = [...dir.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const sealed = await this.#sealName(child.name);
      if (child.type === "file") {
        size += child.size;
        entries.push(fileEntry(child, sealed));
      } else {
        const nested = await this.#persistDir(child, false);
        size += nested.size;
        const entry: ManifestEntry = {
          name: sealed.name,
          type: "dir",
          size: nested.size,
          mtime: child.mtime,
        };
        const enc = packEnc(undefined, sealed.nameIv);
        if (enc) entry.enc = enc;
        if (nested.pieceCid) entry.pieceCid = nested.pieceCid;
        else entry.entries = nested.entries;
        entries.push(entry);
      }
    }
    const manifest: Manifest = { v: 1, mtime: dir.mtime, entries };
    const bytes = manifestBytes(manifest);
    if (isRoot || bytes.byteLength > this.dirThreshold) {
      const uploaded = await this.storage.put(bytes);
      return { pieceCid: uploaded.pieceCid, entries, size };
    }
    return { entries, size };
  }

  async #load(pieceCid: string): Promise<DirNode> {
    const cached = this.#cache.get(pieceCid);
    if (cached) return cached;
    const manifest = parseManifest(await this.storage.get(pieceCid));
    const tree = await this.#hydrate(manifest);
    this.#cache.set(pieceCid, tree);
    return tree;
  }

  async #hydrate(manifest: Manifest): Promise<DirNode> {
    const entries: Node[] = [];
    const seen = new Set<string>();
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
        if (entry.mime !== undefined) file.mime = entry.mime;
        if (entry.enc?.iv) file.enc = { alg: "A256GCM", iv: entry.enc.iv };
        entries.push(file);
      } else if (entry.entries) {
        const child = await this.#hydrate({ v: 1, mtime: entry.mtime, entries: entry.entries });
        child.name = name;
        entries.push(child);
      } else if (entry.pieceCid) {
        const child = structuredClone(await this.#load(entry.pieceCid));
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

function fileEntry(file: FileNode, sealed: { name: string; nameIv?: string }): ManifestEntry {
  const entry: ManifestEntry = {
    name: sealed.name,
    type: "file",
    size: file.size,
    mtime: file.mtime,
    pieceCid: file.pieceCid,
  };
  if (file.mime !== undefined) entry.mime = file.mime;
  const enc = packEnc(file.enc?.iv, sealed.nameIv);
  if (enc) entry.enc = enc;
  return entry;
}

function packEnc(iv: string | undefined, nameIv: string | undefined): ManifestEnc | undefined {
  if (!iv && !nameIv) return undefined;
  const enc: ManifestEnc = { alg: "A256GCM" };
  if (iv) enc.iv = iv;
  if (nameIv) enc.nameIv = nameIv;
  return enc;
}
