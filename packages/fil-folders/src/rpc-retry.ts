import type { Transport } from "viem";

/**
 * Load-balanced FEVM RPCs (glif) can briefly lag each other: a block number seen on one node is
 * "a future epoch" on another, or a header is not found yet, or the epoch was a null round.
 * These clear up within a few blocks, so callers should wait and retry instead of failing.
 */
const TRANSIENT = /future epoch|beyond "?latest"?|header not found|block not found|null round/i;

export function isTransientRpcError(error: unknown): boolean {
  for (let e: any = error, depth = 0; e && depth < 8; e = e.cause, depth++) {
    const text = `${e?.message ?? ""} ${e?.details ?? ""} ${e?.shortMessage ?? ""} ${e?.data?.message ?? ""} ${e?.data?.cause?.message ?? ""}`;
    if (TRANSIENT.test(text)) return true;
    if (typeof e !== "object") break;
  }
  return typeof error === "string" && TRANSIENT.test(error);
}

export interface TransientRetryOptions {
  /** Give up after this long (default 30 s, one Filecoin epoch). */
  maxWaitMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying with backoff while it fails with a transient RPC error. */
export async function retryTransient<T>(fn: () => Promise<T>, options: TransientRetryOptions = {}): Promise<T> {
  const { maxWaitMs = 30_000, baseDelayMs = 1_000, maxDelayMs = 10_000, sleep = defaultSleep } = options;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientRpcError(error) || waited >= maxWaitMs) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt, maxWaitMs - waited);
      waited += delay;
      await sleep(delay);
    }
  }
}

/** Wrap a viem transport so every request waits out transient "future epoch"/null-round errors. */
export function withTransientRetry<T extends Transport>(transport: T, options: TransientRetryOptions = {}): T {
  return ((params: Parameters<T>[0]) => {
    const inner = transport(params);
    return { ...inner, request: ((args: unknown, opts: unknown) => retryTransient(() => (inner.request as any)(args, opts), options)) as typeof inner.request };
  }) as unknown as T;
}
