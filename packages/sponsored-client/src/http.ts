import { sponsorUrl, type ChainChoice, readNetworkPreference } from "./config.js";

export class SponsorRateLimitError extends Error {
  readonly status = 429;
  constructor(
    message: string,
    readonly retryAfter: number,
    readonly limit?: string,
  ) {
    super(message);
    this.name = "SponsorRateLimitError";
  }
}

export async function sponsorCall<T>(path: string, body?: unknown, chain?: ChainChoice): Promise<T> {
  const base = sponsorUrl(chain ?? readNetworkPreference());
  if (!base) throw new Error("Sponsor is not configured for this network.");
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body, (_, value) => (typeof value === "bigint" ? value.toString() : value)) }),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string; limit?: string; retryAfter?: number };
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") || json.retryAfter || 60);
    throw new SponsorRateLimitError(json.error || "rate limited", Number.isFinite(retryAfter) ? retryAfter : 60, json.limit);
  }
  if (!response.ok) throw new Error(json.error || `Sponsor ${path} failed (${response.status})`);
  return json;
}

/** Retry a sponsor call that 429s, waiting Retry-After (capped). Used so queued ops stay pending and commits can fold. */
export async function sponsorCallRetry<T>(path: string, body?: unknown, chain?: ChainChoice, opts: { attempts?: number; maxWaitMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sponsorCall<T>(path, body, chain);
    } catch (error) {
      last = error;
      if (!(error instanceof SponsorRateLimitError) || i === attempts - 1) throw error;
      const wait = Math.min(maxWaitMs, Math.max(500, error.retryAfter * 1000));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}
