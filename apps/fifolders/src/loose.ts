import { isCar, unpadPiece } from "fil-folders";
import { driveInfo, type PieceDetail } from "./drive-pieces.js";
import { entryKind, listDirectory, looksLikeCar, parseCar, readFile, type UnixfsEntry } from "./unixfs.js";

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
  /** Filecoin Drive folder path ("" = root). Set only for Filecoin Drive pieces. */
  folder?: string;
  /** IPFS root CID from piece metadata or the CAR header. */
  ipfsRoot?: string;
  /** "drive" = Filecoin Pin Filecoin Drive piece. */
  origin?: "drive";
  /** UnixFS shape of the piece's root. Imported CARs stay raw. */
  unixfs?: "file" | "directory" | "car";
  /** Directory listing (recursive) for UnixFS directory pieces. */
  children?: UnixfsEntry[];
  pieceId?: string;
  /** UnixFS CID of the file inside the piece (single-file pieces and imported CARs). */
  fileCid?: string;
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
export function loosePieces(pieces: readonly PieceBlob[], referenced: ReadonlySet<string>, details?: ReadonlyMap<string, PieceDetail>): LoosePiece[] {
  const catalog = new Map(loadCatalog().map((item) => [item.pieceCid, item]));
  const rows: LoosePiece[] = [];
  for (const piece of pieces) {
    if (referenced.has(piece.pieceCid)) continue;
    const detail = details?.get(piece.pieceCid);
    const drive = driveInfo(detail?.metadata);
    if (drive) {
      rows.push(driveRow({ ...piece, uploaded: piece.uploaded || detail?.addedAt || 0 }, drive, detail?.pieceId));
      continue;
    }
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

/** A Filecoin Drive piece: unwrap the UnixFS CAR for single files; list directories; keep imported CARs raw. */
function driveRow(piece: PieceBlob, drive: NonNullable<ReturnType<typeof driveInfo>>, pieceId?: string): LoosePiece {
  const raw = piece.bytes.byteLength && looksLikeCar(piece.bytes) ? piece.bytes : unpadPiece(piece.bytes);
  const base: LoosePiece = {
    pieceCid: piece.pieceCid,
    name: drive.fileName || drive.ipfsRootCid || piece.pieceCid,
    size: raw.byteLength,
    uploaded: piece.uploaded || 0,
    mime: "application/octet-stream",
    bytes: raw,
    folder: drive.folderPath,
    ipfsRoot: drive.ipfsRootCid,
    origin: "drive",
    ...(pieceId ? { pieceId } : {}),
  };
  if (drive.importedCar) {
    let root = drive.ipfsRootCid;
    try {
      if (!root && looksLikeCar(raw)) root = parseCar(raw).roots[0] ?? "";
    } catch {
      // keep the metadata root
    }
    return { ...base, unixfs: "car", mime: "application/vnd.ipld.car", ...(root ? { fileCid: root, ipfsRoot: root } : {}) };
  }
  if (!raw.byteLength || !looksLikeCar(raw)) return base;
  try {
    const car = parseCar(raw);
    const root = drive.ipfsRootCid && car.blocks.has(drive.ipfsRootCid) ? drive.ipfsRootCid : car.roots[0] ?? "";
    if (!root) return base;
    const withRoot = { ...base, ipfsRoot: drive.ipfsRootCid || root };
    const kind = entryKind(car, root);
    if (kind === "directory") {
      const children = listDirectory(car, root);
      // filecoin-pin may wrap a single file in a directory: unwrap when the only entry is that file.
      const only = children.length === 1 ? children[0] : undefined;
      if (only && only.kind !== "directory" && (!drive.fileName || only.name === drive.fileName)) {
        const bytes = readFile(car, only.cid);
        return { ...withRoot, unixfs: "file", fileCid: only.cid, bytes, size: bytes.byteLength, mime: sniffMime(withRoot.name, bytes) };
      }
      return { ...withRoot, unixfs: "directory", children, size: children.reduce((sum, child) => sum + sizeOf(child), 0), mime: "inode/directory" };
    }
    const bytes = readFile(car, root);
    return { ...withRoot, unixfs: "file", fileCid: root, bytes, size: bytes.byteLength, mime: sniffMime(withRoot.name, bytes) };
  } catch {
    return base;
  }
}

function sizeOf(entry: UnixfsEntry): number {
  return entry.children ? entry.children.reduce((sum, child) => sum + sizeOf(child), 0) : entry.size;
}

/** Bytes of one file inside a directory piece. */
export function directoryFile(piece: LoosePiece, path: string): Uint8Array {
  const car = parseCar(piece.bytes);
  const root = piece.ipfsRoot && car.blocks.has(piece.ipfsRoot) ? piece.ipfsRoot : car.roots[0]!;
  let cid = root;
  for (const part of path.split("/").filter(Boolean)) {
    const next = listDirectory(car, cid, 0).find((entry) => entry.name === part);
    if (!next) throw new Error(`${path} is not in this piece`);
    cid = next.cid;
  }
  return readFile(car, cid);
}

export interface AdoptItem {
  path: string;
  ref: { cid: string; piece: string; size: number; mime?: string; ipfs?: string; importedCar?: boolean; mtime?: number };
}

function joinPath(...parts: string[]): string {
  const joined = parts.flatMap((part) => part.split("/")).filter(Boolean).join("/");
  return `/${joined}`;
}

/**
 * Manifest entries for Filecoin Drive pieces placed under `base`, keeping each piece's
 * Filecoin Drive folder path. Directory pieces adopt every file inside them.
 */
export function adoptItems(rows: readonly LoosePiece[], base: string): AdoptItem[] {
  const out: AdoptItem[] = [];
  for (const row of rows) {
    if (row.origin !== "drive") continue;
    const folder = row.folder ?? "";
    const common = { piece: row.pieceCid, ...(row.ipfsRoot ? { ipfs: row.ipfsRoot } : {}), ...(row.uploaded ? { mtime: row.uploaded } : {}) };
    if (row.unixfs === "directory" && row.children) {
      const walk = (entries: UnixfsEntry[], prefix: string): void => {
        for (const entry of entries) {
          const path = joinPath(base, folder, row.name, prefix, entry.name);
          if (entry.kind === "directory") walk(entry.children ?? [], `${prefix}/${entry.name}`);
          else out.push({ path, ref: { ...common, cid: entry.cid, size: entry.size } });
        }
      };
      walk(row.children, "");
    } else if (row.fileCid) {
      out.push({
        path: joinPath(base, folder, row.name),
        ref: { ...common, cid: row.fileCid, size: row.size, mime: row.mime, ...(row.unixfs === "car" ? { importedCar: true } : {}) },
      });
    }
  }
  return out;
}
