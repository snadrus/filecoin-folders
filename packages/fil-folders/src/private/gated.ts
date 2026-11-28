/**
 * Gated retrieval from Curio: `GET {serviceURL}/download/{cid}` with
 * `Authorization: FOC-Grant <base64url presentation>` (a claim chain plus a fresh request signed by its
 * final bearer for that CID, valid for at most 300 s). Curio verifies the chain against the piece's own
 * FEE labels (`foc/own`, `foc/gkid`, `foc/group`, `foc/salt`) without chain lookups
 * (curio `market/retrieval/piecehandler.go` `handleDownload`, `lib/keysmith`).
 * Curio answers 401 (`WWW-Authenticate: FOC-Grant`) with no grant and 403 for one that does not verify.
 */
import * as Keysmith from "@filoz/keysmith";
import { cidBytes } from "./unixfs-pack.js";

export interface GatedFetchInput {
  providers: readonly string[];
  cid: string;
  signer: Keysmith.ClaimSigner;
  chain: Keysmith.ClaimChain;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GatedFetchError extends Error {
  constructor(
    message: string,
    readonly statuses: { provider: string; status: number | string }[],
  ) {
    super(message);
    this.name = "GatedFetchError";
  }
}

export function downloadUrl(provider: string, cid: string): string {
  return `${provider.replace(/\/+$/, "")}/download/${cid}`;
}

export async function fetchGated(input: GatedFetchInput): Promise<Uint8Array> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const statuses: { provider: string; status: number | string }[] = [];
  const binary = cidBytes(input.cid);
  for (const provider of [...new Set(input.providers.filter(Boolean))]) {
    try {
      const header = await Keysmith.authorizationHeader(input.signer, input.chain, { pieceCid: binary });
      const response = await fetchImpl(downloadUrl(provider, input.cid), {
        headers: { Authorization: header },
        signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
      });
      if (!response.ok) {
        statuses.push({ provider, status: response.status });
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      statuses.push({ provider, status: error instanceof Error ? error.message : "failed" });
    }
  }
  const refused = statuses.some((s) => s.status === 401 || s.status === 403);
  throw new GatedFetchError(
    refused
      ? "The storage provider refused this private file: the link or grant may have expired."
      : statuses.length
        ? "No storage provider could serve this private file right now."
        : "No storage provider is known for this private file.",
    statuses,
  );
}

/** Statuses as text, for logs. */
export function describeStatuses(error: unknown): string {
  return error instanceof GatedFetchError ? error.statuses.map((s) => `${s.provider}: ${s.status}`).join("; ") : "";
}
