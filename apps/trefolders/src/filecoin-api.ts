/**
 * api.filecoin.io: key-free, CORS-open (Access-Control-Allow-Origin: *) read-only index for
 * mainnet and calibration. Preferred for chain questions Synapse does not already answer;
 * callers keep a public-RPC fallback for errors, missing endpoints or networks.
 */
export const FILECOIN_API = "https://api.filecoin.io";
export type FilecoinApiNetwork = "mainnet" | "calibration";

export function apiNetwork(network: string): FilecoinApiNetwork | null {
  return network === "mainnet" || network === "calibration" ? network : null;
}

/** Every page of a cursor-paginated list endpoint. Throws on any HTTP/shape error. */
export async function apiList<T>(path: string, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "200", ...params, ...(cursor ? { cursor } : {}) });
    const response = await fetchImpl(`${FILECOIN_API}${path}?${query}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`api.filecoin.io ${response.status}`);
    const page = (await response.json()) as { data?: T[]; nextCursor?: string | null };
    if (!Array.isArray(page.data)) throw new Error("bad api.filecoin.io page");
    out.push(...page.data);
    cursor = page.nextCursor ?? null;
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}

/**
 * Service URLs of active PDP providers. api.filecoin.io first; `chainFallback` (the on-chain
 * SP registry over public RPC) when the API fails or returns nothing.
 */
export async function activeProviderUrls(input: {
  network: string;
  chainFallback: () => Promise<string[]>;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const network = apiNetwork(input.network);
  if (network) {
    try {
      const rows = await apiList<{ serviceUrl?: string | null; active?: boolean | null; pdpProductActive?: boolean | null }>(
        `/${network}/providers`,
        { active: "true" },
        input.fetchImpl,
      );
      const urls = [...new Set(rows.filter((p) => p.active !== false && p.pdpProductActive !== false).map((p) => p.serviceUrl ?? "").filter(Boolean))];
      if (urls.length) return urls;
    } catch {
      // fall through to chain
    }
  }
  return input.chainFallback();
}
