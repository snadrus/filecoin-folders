import { isCar, unpadPiece } from "fil-folders";

export interface PieceBlob {
  pieceCid: string;
  bytes: Uint8Array;
  uploaded?: number;
  name?: string;
  mime?: string;
}

export interface LoosePiece {
  pieceCid: string;
  name: string;
  size: number;
  uploaded: number;
  mime: string;
  bytes: Uint8Array;
}

const CATALOG_KEY = "fifolders:piece-catalog";

export interface CatalogRecord {
  pieceCid: string;
  name?: string;
  mime?: string;
  size?: number;
  uploaded?: number;
  path?: string;
}

export function loadCatalog(): CatalogRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CATALOG_KEY) || "[]") as CatalogRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberPiece(record: CatalogRecord): void {
  const next = loadCatalog().filter((item) => item.pieceCid !== record.pieceCid);
  next.push(record);
  localStorage.setItem(CATALOG_KEY, JSON.stringify(next.slice(-400)));
}

export function sniffMime(name: string, bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length && !sample.includes(0)) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".md")) return "text/markdown";
    return "text/plain";
  }
  return "application/octet-stream";
}

/** Pieces present in the dataset that no folder manifest entry points at. */
export function loosePieces(pieces: readonly PieceBlob[], referenced: ReadonlySet<string>): LoosePiece[] {
  const catalog = new Map(loadCatalog().map((item) => [item.pieceCid, item]));
  const rows: LoosePiece[] = [];
  for (const piece of pieces) {
    if (referenced.has(piece.pieceCid)) continue;
    const bytes = unpadPiece(piece.bytes);
    if (looksLikeManifest(bytes)) continue;
    const known = catalog.get(piece.pieceCid);
    const name = piece.name || known?.name || piece.pieceCid;
    rows.push({
      pieceCid: piece.pieceCid,
      name,
      size: bytes.byteLength,
      uploaded: piece.uploaded || known?.uploaded || 0,
      mime: piece.mime || known?.mime || sniffMime(name, bytes),
      bytes,
    });
  }
  rows.sort((a, b) => b.uploaded - a.uploaded || a.name.localeCompare(b.name));
  return rows;
}

function looksLikeManifest(bytes: Uint8Array): boolean {
  if (isCar(bytes)) return true;
  if (bytes.byteLength > 2_000_000 || bytes.includes(0)) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { entries?: unknown; v?: unknown };
    return Boolean(parsed && typeof parsed === "object" && parsed.entries && parsed.v);
  } catch {
    return false;
  }
}
