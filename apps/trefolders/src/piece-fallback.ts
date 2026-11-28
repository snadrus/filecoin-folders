import { reportLoadStep } from "./load-steps.js";

export interface PieceFallbackOptions {
  /** Provider service URLs to ask directly when the SDK cannot retrieve a piece. */
  providerUrls: () => Promise<string[]>;
  /** Accept only bytes that hash to the piece. */
  verify: (bytes: Uint8Array, pieceCid: string) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
  missTtlMs?: number;
  /** How long the SDK gets alone before the other providers are asked in parallel. */
  sdkHeadStartMs?: number;
  /** IPFS gateways for bafkrei… CIDs (Filecoin Pin), verified by sha-256. */
  gateways?: string[];
  now?: () => number;
  /** Per-request cap for a provider that does not answer (a 404 is a definite miss and fails at once). */
  timeoutMs?: number;
}

export const IPFS_GATEWAYS = ["https://ipfs.io", "https://dweb.link", "https://trustless-gateway.link"];

/** Raised when no source has the piece: the UI shows "file unavailable right now" with Retry. */
export class PieceUnavailableError extends Error {
  constructor(readonly pieceCid: string, readonly cause?: unknown) {
    super("This file is unavailable right now. Its storage providers did not answer; your file is still recorded on chain.");
    this.name = "PieceUnavailableError";
  }
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Decode(text: string): Uint8Array | null {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** sha-256 digest of a raw-block IPFS CIDv1 (bafkrei…, how Filecoin Pin stores small files), else null. */
export function ipfsSha256(cid: string): Uint8Array | null {
  if (!cid.startsWith("bafkrei")) return null;
  const bytes = base32Decode(cid.slice(1));
  if (!bytes || bytes[0] !== 0x01 || bytes[1] !== 0x55) return null;
  // CIDv1, raw codec, multihash sha2-256 (0x12, 32 bytes)
  if (bytes[2] !== 0x12 || bytes[3] !== 0x20 || bytes.length !== 36) return null;
  return bytes.slice(4);
}

/**
 * Hosts a public page must never fetch: private, loopback, link-local or unroutable addresses. Fetching
 * them makes Chrome show its Local Network Access permission prompt, then fail.
 */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !host.includes(":")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  return false;
}

/** An http:// provider from an https:// page is blocked by the browser as mixed content: don't bother. */
function isMixedContent(url: string): boolean {
  return typeof location !== "undefined" && location.protocol === "https:" && url.startsWith("http:");
}

export interface PieceFallback {
  get(pieceCid: string): Promise<Uint8Array>;
  /** For tests/diagnostics: requests sent so far. */
  readonly requests: string[];
}

/**
 * Wrap the SDK's piece read. A provider 404 is a definite miss: move to the next source at once and
 * never ask that provider for that piece again this session. A piece found via a fallback provider goes
 * straight there next time. A piece nobody has fails fast on repeat reads instead of re-requesting.
 */
export function withPieceFallback(sdkGet: (pieceCid: string) => Promise<Uint8Array>, options: PieceFallbackOptions): PieceFallback {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const missing = new Map<string, Set<string>>(); // pieceCid -> sources that answered 404
  const foundAt = new Map<string, string>();
  // Misses expire so a piece that was still replicating can be found on a later Retry.
  const missTtlMs = options.missTtlMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const sdkMissed = new Map<string, number>();
  const nobody = new Map<string, { error: Error; at: number }>();
  const requests: string[] = [];
  /** Providers that failed hard (5xx, CORS, unreachable, timeout): skipped for every piece this session. */
  const down = new Map<string, number>();
  const downTtlMs = 5 * 60_000;
  const isDown = (base: string) => now() - (down.get(base) ?? -Infinity) < downTtlMs;
  const gateways = options.gateways ?? IPFS_GATEWAYS;
  const sdkHeadStartMs = options.sdkHeadStartMs ?? 2_500;

  const missedBy = (pieceCid: string) => {
    let set = missing.get(pieceCid);
    if (!set) missing.set(pieceCid, (set = new Set()));
    return set;
  };

  const tryProvider = async (base: string, pieceCid: string): Promise<Uint8Array> => {
    const url = new URL(`/piece/${encodeURIComponent(pieceCid)}`, base).toString();
    requests.push(url);
    let response: Response;
    try {
      // targetAddressSpace "public": if the host resolves to a private address, Chrome fails the request
      // instead of showing a Local Network Access permission prompt.
      response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), targetAddressSpace: "public" } as RequestInit);
    } catch (error) {
      down.set(base, now());
      throw error;
    }
    if (response.status >= 500) down.set(base, now());
    if (response.status === 404 || response.status === 410) {
      missedBy(pieceCid).add(base);
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!(await options.verify(bytes, pieceCid))) {
      missedBy(pieceCid).add(base);
      throw new Error("piece mismatch");
    }
    foundAt.set(pieceCid, base);
    return bytes;
  };

  const tryGateway = async (base: string, cid: string, digest: Uint8Array): Promise<Uint8Array> => {
    const url = `${base}/ipfs/${cid}?format=raw`;
    requests.push(url);
    let response: Response;
    try {
      response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/vnd.ipld.raw" }, targetAddressSpace: "public" } as RequestInit);
    } catch (error) {
      down.set(base, now());
      throw error;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const got = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    if (got.length !== digest.length || got.some((v, i) => v !== digest[i])) throw new Error("block mismatch");
    return bytes;
  };

  async function get(pieceCid: string): Promise<Uint8Array> {
    const known = nobody.get(pieceCid);
    if (known && now() - known.at < missTtlMs) throw known.error;
    if (known) {
      nobody.delete(pieceCid);
      missing.delete(pieceCid);
    }
    const at = foundAt.get(pieceCid);
    if (at) {
      try {
        return await tryProvider(at, pieceCid);
      } catch {
        foundAt.delete(pieceCid);
      }
    }
    let sdkError: unknown;
    const skip = missedBy(pieceCid);
    const viaProviders = async (): Promise<Uint8Array> => {
      const urls = (await options.providerUrls().catch(() => [] as string[])).filter((u) => !skip.has(u) && !isDown(u) && !isPrivateHost(u) && !isMixedContent(u));
      if (!urls.length) throw new Error("no other providers");
      reportLoadStep("Trying other storage providers…");
      return Promise.any(urls.map((u) => tryProvider(u, pieceCid)));
    };
    if (!(now() - (sdkMissed.get(pieceCid) ?? -Infinity) < missTtlMs)) {
      reportLoadStep("Fetching from storage provider…");
      // The SDK can spend a long time on one provider: after a short head start, ask the others in parallel.
      const sdk = sdkGet(pieceCid).catch((error) => {
        sdkError = error;
        sdkMissed.set(pieceCid, now());
        throw error;
      });
      const others = Promise.race([new Promise<void>((r) => setTimeout(r, sdkHeadStartMs)), sdk.then(() => undefined, () => undefined)]).then(viaProviders);
      try {
        return await Promise.any([sdk, others]);
      } catch {
        // both missed
      }
    } else {
      try {
        return await viaProviders();
      } catch {
        // every provider missed or failed
      }
    }
    const digest = ipfsSha256(pieceCid);
    if (digest && gateways.length) {
      reportLoadStep("Trying public IPFS gateways…");
      try {
        return await Promise.any(gateways.filter((g) => !isDown(g)).map((g) => tryGateway(g, pieceCid, digest)));
      } catch {
        // no gateway had it
      }
    }
    const error = new PieceUnavailableError(pieceCid, sdkError);
    // Remember only definite misses (every provider said 404); timeouts may succeed on Retry.
    const all = await options.providerUrls().catch(() => [] as string[]);
    if (all.length && all.every((u) => skip.has(u))) nobody.set(pieceCid, { error, at: now() });
    throw error;
  }

  return { get, requests };
}
