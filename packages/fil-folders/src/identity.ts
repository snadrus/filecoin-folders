import type { Address, Hex } from "viem";
import { bytesToPieceCid, pieceCidToBytes } from "./bytes.js";
import { guestName } from "./guest-name.js";
import { namespaceId, volumeKey } from "./ids.js";
import { MIN_PIECE_BYTES } from "./pad.js";

/**
 * Wallet identity: a small JSON piece on Filecoin, pointed to from FolderRegistry under the
 * owner's wallet at `(ns = keccak256("fil-identity"), key = keccak256("profile"))`.
 * See docs/identity.md. Future address-book data uses the same namespace with key "contacts".
 */
export const IDENTITY_NAMESPACE = "fil-identity";
export const IDENTITY_PROFILE_KEY = "profile";
export const IDENTITY_CONTACTS_KEY = "contacts";
export const IDENTITY_SCHEMA = "fil-identity/profile";
export const IDENTITY_VERSION = 1;
/** localStorage key prefix shared by every app on the origin (FiFolders, FiPen, FiGrid, /identity/). */
export const IDENTITY_CACHE_PREFIX = "fil-identity:v1:";
export const DISPLAY_NAME_MAX = 60;
export const BIO_MAX = 280;

export function identityNamespace(): Hex {
  return namespaceId(IDENTITY_NAMESPACE);
}

export function identityProfileKey(): Hex {
  return volumeKey(IDENTITY_PROFILE_KEY);
}

export function identityContactsKey(): Hex {
  return volumeKey(IDENTITY_CONTACTS_KEY);
}

export interface IdentityAvatar {
  /** One emoji (grapheme cluster), e.g. "🦊". */
  emoji?: string;
  /** `#rrggbb`. */
  color?: string;
}

/** Version 1 profile document. Unknown fields are kept on read so newer writers are not lossy. */
export interface IdentityV1 {
  v: 1;
  schema: typeof IDENTITY_SCHEMA;
  /** Lowercase 0x wallet address that owns the chain pointer. */
  address: Address;
  displayName: string;
  avatar?: IdentityAvatar;
  bio?: string;
  /** ISO-8601 time of this edit. */
  updatedAt: string;
  [extra: string]: unknown;
}

export type Identity = IdentityV1;

export interface IdentityDraft {
  displayName: string;
  avatar?: IdentityAvatar;
  bio?: string;
}

export class IdentityError extends Error {
  override name = "IdentityError";
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanEmoji(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const first = Seg ? ([...new Seg(undefined, { granularity: "grapheme" }).segment(trimmed)][0]?.segment ?? "") : [...trimmed].slice(0, 2).join("");
  return first.slice(0, 16);
}

/** Validate and normalize a draft into a v1 identity document. Throws {@link IdentityError}. */
export function buildIdentity(address: string, draft: IdentityDraft, now: Date = new Date()): IdentityV1 {
  if (!ADDRESS.test(address)) throw new IdentityError("Connect a wallet first.");
  const displayName = cleanText(draft.displayName, DISPLAY_NAME_MAX);
  if (!displayName) throw new IdentityError("Display name is required.");
  const doc: IdentityV1 = {
    v: 1,
    schema: IDENTITY_SCHEMA,
    address: address.toLowerCase() as Address,
    displayName,
    updatedAt: now.toISOString(),
  };
  const emoji = cleanEmoji(draft.avatar?.emoji);
  const color = typeof draft.avatar?.color === "string" && COLOR.test(draft.avatar.color) ? draft.avatar.color.toLowerCase() : "";
  if (emoji || color) doc.avatar = { ...(emoji ? { emoji } : {}), ...(color ? { color } : {}) };
  const bio = cleanText(draft.bio, BIO_MAX);
  if (bio) doc.bio = bio;
  return doc;
}

/** Parse a stored identity. Returns null for anything that is not a valid v1 doc for `expected` (when given). */
export function parseIdentity(input: unknown, expected?: string): IdentityV1 | null {
  let value = input;
  if (input instanceof Uint8Array) {
    try {
      value = JSON.parse(new TextDecoder().decode(input));
    } catch {
      return null;
    }
  } else if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.address !== "string" || !ADDRESS.test(raw.address)) return null;
  if (expected && raw.address.toLowerCase() !== expected.toLowerCase()) return null;
  try {
    const built = buildIdentity(raw.address, {
      displayName: raw.displayName as string,
      avatar: raw.avatar as IdentityAvatar | undefined,
      bio: raw.bio as string | undefined,
    }, new Date(typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : 0));
    const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !(k in built) && !["avatar", "bio"].includes(k)));
    return { ...extra, ...built };
  } catch {
    return null;
  }
}

/** JSON bytes for a piece, space-padded to the minimum piece size (JSON ignores trailing whitespace). */
export function encodeIdentity(identity: IdentityV1): Uint8Array {
  const json = JSON.stringify(identity);
  return new TextEncoder().encode(json.length < MIN_PIECE_BYTES ? json.padEnd(MIN_PIECE_BYTES, " ") : json);
}

export function decodeIdentity(bytes: Uint8Array, expected?: string): IdentityV1 | null {
  return parseIdentity(bytes, expected);
}

/** What every app shows for an address. */
export interface ResolvedIdentity {
  address: Address;
  displayName: string;
  avatar?: IdentityAvatar;
  bio?: string;
  /** chain: read from chain this call; cache: fresh localStorage copy; guest: no identity set. */
  source: "chain" | "cache" | "guest";
  identity: IdentityV1 | null;
  pieceCid?: string;
  version?: string;
}

interface CacheEntry {
  pieceCid: string;
  version: string;
  identity: IdentityV1 | null;
  checkedAt: number;
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultCache(): KV | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis ? (globalThis as unknown as { localStorage: KV }).localStorage : null;
  } catch {
    return null;
  }
}

export function identityCacheKey(address: string): string {
  return IDENTITY_CACHE_PREFIX + address.toLowerCase();
}

export function readIdentityCache(address: string, cache: KV | null = defaultCache()): CacheEntry | null {
  try {
    const raw = cache?.getItem(identityCacheKey(address));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    return { ...entry, identity: entry.identity ? parseIdentity(entry.identity, address) : null };
  } catch {
    return null;
  }
}

/** Remember an identity (e.g. right after saving it) so every app on the origin shows it at once. */
export function writeIdentityCache(
  address: string,
  entry: { identity: IdentityV1 | null; pieceCid: string; version?: string | bigint },
  cache: KV | null = defaultCache(),
  now = Date.now(),
): void {
  try {
    const value: CacheEntry = { identity: entry.identity, pieceCid: entry.pieceCid, version: String(entry.version ?? ""), checkedAt: now };
    cache?.setItem(identityCacheKey(address), JSON.stringify(value));
  } catch {
    // Storage full or blocked: resolution still works, just uncached.
  }
}

function shape(address: string, entry: { identity: IdentityV1 | null; pieceCid?: string; version?: string } | null, source: ResolvedIdentity["source"]): ResolvedIdentity {
  const lower = address.toLowerCase() as Address;
  const id = entry?.identity ?? null;
  if (!id) return { address: lower, displayName: guestName(lower), source: "guest", identity: null, pieceCid: entry?.pieceCid || undefined, version: entry?.version };
  return {
    address: lower,
    displayName: id.displayName,
    ...(id.avatar ? { avatar: id.avatar } : {}),
    ...(id.bio ? { bio: id.bio } : {}),
    source,
    identity: id,
    pieceCid: entry?.pieceCid,
    version: entry?.version,
  };
}

/** Synchronous best guess: cached identity, else the deterministic guest name. Never touches the network. */
export function cachedIdentity(address: string, cache: KV | null = defaultCache()): ResolvedIdentity {
  const entry = readIdentityCache(address, cache);
  return shape(address, entry, entry?.identity ? "cache" : "guest");
}

export interface IdentityResolverOptions {
  /** FolderRegistry `head(owner, ns, key)`; e.g. `registry.head` from {@link createViemRegistry}. */
  head(owner: Address, ns: Hex, key: Hex): Promise<{ pieceCid: Uint8Array; version: bigint }>;
  /** Fetch piece bytes by PieceCID (Synapse download, provider /piece/ fallback, ...). */
  fetchPiece(pieceCid: string): Promise<Uint8Array>;
  cache?: KV | null;
  /** Cached entries younger than this skip the chain read. Default 5 minutes. */
  maxAgeMs?: number;
  now?: () => number;
}

const inflight = new Map<string, Promise<ResolvedIdentity>>();

/**
 * Resolve an address: chain pointer -> identity piece, cached in localStorage.
 * A piece is only re-fetched when the pointer changes. Network errors fall back to cache, then the guest name.
 */
export function resolveIdentity(address: string, options: IdentityResolverOptions & { force?: boolean }): Promise<ResolvedIdentity> {
  if (!ADDRESS.test(address)) return Promise.resolve({ address: address as Address, displayName: guestName(address), source: "guest", identity: null });
  const lower = address.toLowerCase() as Address;
  const cache = options.cache === undefined ? defaultCache() : options.cache;
  const now = options.now ?? Date.now;
  const cached = readIdentityCache(lower, cache);
  if (!options.force && cached && now() - cached.checkedAt < (options.maxAgeMs ?? 5 * 60_000)) {
    return Promise.resolve(shape(lower, cached, cached.identity ? "cache" : "guest"));
  }
  const running = inflight.get(lower);
  if (running) return running;
  const work = (async (): Promise<ResolvedIdentity> => {
    try {
      const head = await options.head(lower, identityNamespace(), identityProfileKey());
      const pieceCid = bytesToPieceCid(head.pieceCid);
      const version = head.version.toString();
      if (!pieceCid) {
        writeIdentityCache(lower, { identity: null, pieceCid: "", version }, cache, now());
        return shape(lower, null, "guest");
      }
      if (cached && cached.pieceCid === pieceCid && cached.identity) {
        writeIdentityCache(lower, { identity: cached.identity, pieceCid, version }, cache, now());
        return shape(lower, { identity: cached.identity, pieceCid, version }, "chain");
      }
      const identity = decodeIdentity(await options.fetchPiece(pieceCid), lower);
      writeIdentityCache(lower, { identity, pieceCid, version }, cache, now());
      return shape(lower, { identity, pieceCid, version }, "chain");
    } catch {
      return shape(lower, cached, cached?.identity ? "cache" : "guest");
    } finally {
      inflight.delete(lower);
    }
  })();
  inflight.set(lower, work);
  return work;
}

/** Bytes for `commit`'s `pieceCid` / `prevPieceCid`. */
export function identityPointerBytes(pieceCid: string): Uint8Array {
  return pieceCidToBytes(pieceCid);
}

/**
 * Try `GET {base}/piece/{cid}` on each provider in parallel; first good answer wins.
 * `accept` lets callers verify bytes (e.g. PieceCID hash, or "parses as identity").
 */
export async function fetchPieceFromProviders(
  pieceCid: string,
  baseUrls: readonly string[],
  accept: (bytes: Uint8Array) => boolean = () => true,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (!baseUrls.length) throw new Error("no storage providers to ask");
  return Promise.any(
    baseUrls.map(async (base) => {
      const response = await fetchImpl(new URL(`/piece/${encodeURIComponent(pieceCid)}`, base), { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!accept(bytes)) throw new Error("piece rejected");
      return bytes;
    }),
  );
}
