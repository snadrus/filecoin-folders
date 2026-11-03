import { guestName } from "./guest-name.js";
import { CALIBRATION_REGISTRY, CALIBRATION_REGISTRY_V2, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID, isAddress, parseIdentity, type Address, type Hex, type IdentityAvatar, type IdentityV1 } from "./schema.js";

/** localStorage key prefix shared by every app on the origin. */
export const IDENTITY_CACHE_PREFIX = "fil-identity:v1:";
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;

export interface ResolvedIdentity {
  address: Address;
  displayName: string;
  avatar?: IdentityAvatar;
  bio?: string;
  /** chain: read this call; cache: fresh localStorage copy; guest: none set. */
  source: "chain" | "cache" | "guest";
  identity: IdentityV1 | null;
  pieceCid?: string;
  version?: string;
}

export interface IdentityCacheEntry {
  pieceCid: string;
  version: string;
  identity: IdentityV1 | null;
  checkedAt: number;
}

export type KV = Pick<Storage, "getItem" | "setItem">;

function defaultCache(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function identityCacheKey(address: string): string {
  return IDENTITY_CACHE_PREFIX + address.toLowerCase();
}

export function readIdentityCache(address: string, cache: KV | null = defaultCache()): IdentityCacheEntry | null {
  try {
    const raw = cache?.getItem(identityCacheKey(address));
    if (!raw) return null;
    const entry = JSON.parse(raw) as IdentityCacheEntry;
    return { ...entry, identity: entry.identity ? parseIdentity(entry.identity, address) : null };
  } catch {
    return null;
  }
}

export function writeIdentityCache(
  address: string,
  entry: { identity: IdentityV1 | null; pieceCid: string; version?: string | bigint },
  cache: KV | null = defaultCache(),
  now = Date.now(),
): void {
  try {
    cache?.setItem(identityCacheKey(address), JSON.stringify({ identity: entry.identity, pieceCid: entry.pieceCid, version: String(entry.version ?? ""), checkedAt: now }));
  } catch {
    // Storage blocked: still resolves, uncached.
  }
}

function shape(address: string, entry: { identity: IdentityV1 | null; pieceCid?: string; version?: string } | null, source: ResolvedIdentity["source"]): ResolvedIdentity {
  const lower = address.toLowerCase() as Address;
  const id = entry?.identity ?? null;
  if (!id) return { address: lower, displayName: guestName(lower), source: "guest", identity: null, pieceCid: entry?.pieceCid || undefined, version: entry?.version };
  return { address: lower, displayName: id.displayName, ...(id.avatar ? { avatar: id.avatar } : {}), ...(id.bio ? { bio: id.bio } : {}), source, identity: id, pieceCid: entry?.pieceCid, version: entry?.version };
}

/** Synchronous: cached identity, else the guest name. No network. */
export function cachedIdentity(address: string, cache: KV | null = defaultCache()): ResolvedIdentity {
  const entry = isAddress(address) ? readIdentityCache(address, cache) : null;
  return shape(address, entry, entry?.identity ? "cache" : "guest");
}

export interface IdentityResolverOptions {
  /** FolderRegistry `head(owner, ns, key)`. See {@link registryHeadReader} for a fetch-only one. */
  head(owner: Address, ns: Hex, key: Hex): Promise<{ pieceCid: Uint8Array; version: bigint }>;
  fetchPiece(pieceCid: string): Promise<Uint8Array>;
  cache?: KV | null;
  maxAgeMs?: number;
  force?: boolean;
  now?: () => number;
}

const inflight = new Map<string, Promise<ResolvedIdentity>>();

/** Chain pointer -> identity piece, cached. Refetches the piece only when the pointer changes; errors fall back to cache, then guest. */
export function resolveIdentity(address: string, options: IdentityResolverOptions): Promise<ResolvedIdentity> {
  if (!isAddress(address)) return Promise.resolve(shape(address, null, "guest"));
  const lower = address.toLowerCase() as Address;
  const cache = options.cache === undefined ? defaultCache() : options.cache;
  const now = options.now ?? Date.now;
  const cached = readIdentityCache(lower, cache);
  if (!options.force && cached && now() - cached.checkedAt < (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    return Promise.resolve(shape(lower, cached, cached.identity ? "cache" : "guest"));
  }
  const running = inflight.get(lower);
  if (running) return running;
  const work = (async (): Promise<ResolvedIdentity> => {
    try {
      const head = await options.head(lower, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID);
      const pieceCid = new TextDecoder().decode(head.pieceCid);
      const version = head.version.toString();
      if (!pieceCid) {
        writeIdentityCache(lower, { identity: null, pieceCid: "", version }, cache, now());
        return shape(lower, null, "guest");
      }
      const identity = cached?.pieceCid === pieceCid && cached.identity ? cached.identity : parseIdentity(await options.fetchPiece(pieceCid), lower);
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

/**
 * `head` via plain JSON-RPC `eth_call` (no viem): FolderRegistry.head(address,bytes32,bytes32) selector + ABI decode.
 */
export function registryHeadReader(rpcUrl: string, registry: string, fetchImpl: typeof fetch = fetch): IdentityResolverOptions["head"] {
  const read = singleHeadReader(rpcUrl, registry, fetchImpl);
  if (registry.toLowerCase() !== CALIBRATION_REGISTRY.toLowerCase()) return read;
  // v1 address: read the v2 successor first (same `head` ABI), fall back to v1 until the pointer moves.
  const next = singleHeadReader(rpcUrl, CALIBRATION_REGISTRY_V2, fetchImpl);
  return async (owner, ns, key) => {
    const head = await next(owner, ns, key).catch(() => null);
    if (head && head.version > 0n) return head;
    return read(owner, ns, key);
  };
}

function singleHeadReader(rpcUrl: string, registry: string, fetchImpl: typeof fetch): IdentityResolverOptions["head"] {
  return async (owner, ns, key) => {
    const data = "0x" + HEAD_SELECTOR + owner.slice(2).toLowerCase().padStart(64, "0") + ns.slice(2) + key.slice(2);
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: registry, data }, "latest"] }) });
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!body.result) throw new Error(body.error?.message || "eth_call failed");
    return decodeHead(body.result);
  };
}

/** keccak256("head(address,bytes32,bytes32)")[0..4]. */
export const HEAD_SELECTOR = "5a533e9f";

export function decodeHead(result: string): { pieceCid: Uint8Array; version: bigint } {
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  if (hex.length < 128) return { pieceCid: new Uint8Array(), version: 0n };
  const word = (i: number) => hex.slice(i * 64, i * 64 + 64);
  const offset = Number(BigInt("0x" + word(0))) / 32;
  const version = BigInt("0x" + word(1));
  const length = Number(BigInt("0x" + word(offset)));
  const start = (offset + 1) * 64;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(start + i * 2, start + i * 2 + 2), 16);
  return { pieceCid: bytes, version };
}

/** GET `{base}/piece/{cid}` on each provider in parallel; first accepted answer wins. */
export async function fetchPieceFromProviders(pieceCid: string, baseUrls: readonly string[], accept: (bytes: Uint8Array) => boolean = () => true, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
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
