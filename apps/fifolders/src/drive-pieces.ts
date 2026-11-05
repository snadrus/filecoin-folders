/**
 * Filecoin Pin "Filecoin Drive" pieces: one file (or directory/CAR) per piece, described by
 * per-piece metadata {label, path | carPath, ipfsRootCID}. Filecoin Drive creates (and lists) only
 * data sets whose metadata has source="filecoin-pin" (filecoin-pin APPLICATION_SOURCE).
 * FiFolders commit pieces add `version`; those are versions of a folder, not loose uploads.
 */
import { readDriveMetadata } from "fil-folders";

export const FILECOIN_DRIVE_SOURCE = "filecoin-pin";
/** Earlier FiFolders builds and mocks used this label; still treated as Filecoin Drive. */
const LEGACY_DRIVE_SOURCE = "filecoin-drive";

export function isDriveSource(source: string | undefined | null): boolean {
  return source === FILECOIN_DRIVE_SOURCE || source === LEGACY_DRIVE_SOURCE;
}

export interface PieceDetail {
  pieceCid: string;
  pieceId: string;
  metadata: Record<string, string>;
  /** Unix ms the piece was added, when the index knows it. */
  addedAt?: number;
}

export interface DriveInfo {
  fileName: string;
  /** Normalized folder path, "" for the root. */
  folderPath: string;
  ipfsRootCid: string;
  importedCar: boolean;
  /** Set on pieces FiFolders, FiPen or FiGrid wrote as one version of a folder. */
  version?: bigint;
}

/** Reads per-piece metadata for the open dataset; set by the live/mock IO layer. */
let source: (() => Promise<PieceDetail[]>) | null = null;
export function setPieceDetailSource(fn: (() => Promise<PieceDetail[]>) | null): void {
  source = fn;
}
export async function readPieceDetails(): Promise<PieceDetail[]> {
  return source ? source() : [];
}

export function normalizeFolder(path: string): string {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== ".")
    .join("/");
}

/** Null when the piece carries no Filecoin Drive metadata. */
export function driveInfo(metadata: Record<string, string> | undefined): DriveInfo | null {
  const info = readDriveMetadata(metadata);
  if (!info) return null;
  const out: DriveInfo = {
    fileName: info.fileName,
    folderPath: normalizeFolder(info.folderPath),
    ipfsRootCid: info.ipfsRootCID,
    importedCar: info.importedCar,
  };
  if (info.version !== undefined) out.version = info.version;
  return out;
}

export function gatewayUrl(cid: string, path = ""): string {
  return `https://dweb.link/ipfs/${encodeURIComponent(cid)}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`;
}

/** Group rows by folder path for a tree view; root first, then folders alphabetically. */
export function groupByFolder<T extends { folder?: string }>(rows: T[]): { folder: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.folder ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, items]) => ({ folder, rows: items }));
}

import { FILECOIN_API as INDEX_API } from "./filecoin-api.js";

/**
 * Per-piece metadata for one dataset. Filecoin index API first (metadata + added block in one
 * paginated call, as filecoin-pin-website does), then the warm-storage view on chain.
 */
export async function loadPieceDetails(input: {
  network: "mainnet" | "calibration";
  dataSetId: string;
  genesisTimestamp: number;
  chainFallback?: () => Promise<PieceDetail[]>;
  fetchImpl?: typeof fetch;
}): Promise<PieceDetail[]> {
  const get = input.fetchImpl ?? fetch;
  try {
    const out: PieceDetail[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const response = await get(`${INDEX_API}/${input.network}/data-sets/${encodeURIComponent(input.dataSetId)}/pieces?${query}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`index ${response.status}`);
      const page = (await response.json()) as {
        data?: { cid?: string; pieceId?: string; removed?: boolean; metadata?: Record<string, unknown> | null; addedAtBlock?: string | null }[];
        nextCursor?: string | null;
      };
      if (!Array.isArray(page.data)) throw new Error("bad index page");
      for (const piece of page.data) {
        if (!piece.cid || piece.removed) continue;
        const metadata: Record<string, string> = {};
        for (const [key, value] of Object.entries(piece.metadata ?? {})) if (typeof value === "string") metadata[key] = value;
        const block = piece.addedAtBlock && /^\d+$/.test(piece.addedAtBlock) ? Number(piece.addedAtBlock) : 0;
        out.push({
          pieceCid: piece.cid,
          pieceId: piece.pieceId ?? "",
          metadata,
          ...(block ? { addedAt: (input.genesisTimestamp + block * 30) * 1000 } : {}),
        });
      }
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return out;
  } catch (error) {
    if (!input.chainFallback) throw error;
    return input.chainFallback();
  }
}
