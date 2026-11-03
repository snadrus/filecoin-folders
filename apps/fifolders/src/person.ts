/** FiFolders' read-only identity wiring (fiperson/view only): public RPC head + provider piece fetch. */
import { withTransientRetry } from "fil-folders";
import { CALIBRATION_REGISTRY, CALIBRATION_RPC, fetchPieceFromProviders, parseIdentity, registryHeadReader, resolveIdentity, type ResolvedIdentity } from "fiperson/view";
import { createPublicClient, http } from "viem";
// synapse-core rejects viem's own chain objects ("Unsupported chain: 314159"); use its chain definition.
import { calibration } from "@filoz/synapse-core/chains";

let providers: Promise<string[]> | null = null;

/** PDP provider URLs from the on-chain SP registry (cached per page). */
function providerUrls(): Promise<string[]> {
  providers ??= import("@filoz/synapse-core/sp-registry")
    .then(({ getPDPProviders }) => getPDPProviders(createPublicClient({ chain: calibration as never, transport: withTransientRetry(http(CALIBRATION_RPC)) }) as never, { onlyActive: true, limit: 200n } as never))
    .then((out) => out.providers.map((p) => p.pdp?.serviceURL ?? (p as unknown as { serviceURL?: string }).serviceURL ?? "").filter(Boolean))
    .catch(() => [] as string[]);
  return providers;
}

export async function fetchIdentityPiece(pieceCid: string): Promise<Uint8Array> {
  return fetchPieceFromProviders(pieceCid, await providerUrls(), (bytes) => parseIdentity(bytes) !== null);
}

/** Resolve on Calibration (mainnet has no FolderRegistry yet: cached/guest only). */
export function resolvePerson(address: string, chain: "calibration" | "mainnet", force = false): Promise<ResolvedIdentity> {
  const head = chain === "mainnet" ? async () => ({ pieceCid: new Uint8Array(), version: 0n }) : registryHeadReader(CALIBRATION_RPC, CALIBRATION_REGISTRY);
  return resolveIdentity(address, { head, fetchPiece: fetchIdentityPiece, force, ...(chain === "mainnet" ? { maxAgeMs: Infinity } : {}) });
}
