/**
 * Filecoin Drive (filecoin-pin-website) piece metadata conventions, shared by every FiFolders writer.
 *
 * Drive names a piece by its Synapse *piece metadata*:
 * - `label` (or `name`): the file name, at most 96 UTF-8 bytes,
 * - `path`: the folder ("" = root, "a/b" nested), at most 96 UTF-8 bytes (`carPath` for imported CARs),
 * - `ipfsRootCID`: the UnixFS root of the file inside the CAR piece.
 * Drive only lists data sets whose data-set metadata has `source: "filecoin-pin"`.
 * Drive has no versions: each upload is its own piece, and Delete schedules piece removal.
 *
 * FiFolders writes exactly Drive's keys, on every network: FWSS (filecoin-services ≥ v1.3.0, live on Calibration
 * and mainnet) caps piece metadata at MAX_KEYS_PER_PIECE = 3 keys, 32-byte keys and 96-byte values, and Drive itself
 * spends all three (`label`, `path`|`carPath`, `ipfsRootCID`; a directory is a trailing "/" on `label`, not a 4th key).
 * The commit version is not piece metadata: the FolderRegistry is the source of truth for versions, and a commit
 * piece is recognised by its bytes (a FiFolders CAR whose root block is a folder manifest, {@link isCommitPiece}).
 * Pieces written by earlier builds may still carry a `version` key; readers accept it.
 */
import { decodeCar } from "./car.js";
import { parseManifest } from "./codec.js";
import type { DirNode, Node } from "./types.js";

export const DRIVE_METADATA_BYTES = 96;
export const DRIVE_SOURCE = "filecoin-pin";
export const FIFOLDERS_SOURCE = "fifolders";
/** Legacy (pre-v1.3 FWSS) FiFolders key; read for old pieces, never written. */
export const VERSION_KEY = "version";
/** Folder Drive shows FiFolders commits that change several files at once. */
export const SYSTEM_FOLDER = ".fifolders";

const utf8 = (value: string) => new TextEncoder().encode(value);

/** Trim to `max` UTF-8 bytes, keeping the extension and never splitting a character. */
export function fitBytes(value: string, max = DRIVE_METADATA_BYTES): string {
  if (utf8(value).byteLength <= max) return value;
  const dot = value.lastIndexOf(".");
  const ext = dot > 0 && value.length - dot <= 16 ? value.slice(dot) : "";
  const chars = [...value.slice(0, value.length - ext.length)];
  while (chars.length && utf8(chars.join("") + "…" + ext).byteLength > max) chars.pop();
  return chars.join("") + "…" + ext;
}

/** "/Docs/a/b.txt" -> { name: "b.txt", folder: "Docs/a" } in Drive's normalised form. */
export function splitDrivePath(path: string): { name: string; folder: string } {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  return { name, folder: parts.join("/") };
}

export interface DriveMetadataInput {
  name?: string;
  folder?: string;
  ipfsRootCID?: string;
}

/** FWSS piece-metadata limits (filecoin-services FWSSConstants, v1.3.0+ on every network). */
export const MAX_PIECE_KEYS = 3;
export const MAX_PIECE_KEY_BYTES = 32;
export const MAX_PIECE_VALUE_BYTES = 96;

/** Piece metadata exactly as Filecoin Drive writes it: `label`, `path`, `ipfsRootCID` (at most 3 keys, 96-byte values). */
export function driveMetadata(input: DriveMetadataInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.name?.trim()) out.label = fitBytes(input.name.trim());
  if (input.folder !== undefined && out.label) {
    // Over-long folders go to the root rather than failing the save (Drive rejects them at upload).
    out.path = utf8(input.folder).byteLength <= DRIVE_METADATA_BYTES ? input.folder : "";
  }
  if (input.ipfsRootCID && utf8(input.ipfsRootCID).byteLength <= MAX_PIECE_VALUE_BYTES) out.ipfsRootCID = input.ipfsRootCID;
  return out;
}

/** True for a FiFolders commit piece: a FiFolders CAR whose root block is a folder manifest. */
export function isCommitPiece(bytes: Uint8Array): boolean {
  try {
    const car = decodeCar(bytes);
    const root = car.blocks.get(car.root);
    if (!root) return false;
    parseManifest(root);
    return true;
  } catch {
    return false;
  }
}

export interface DrivePieceInfo {
  fileName: string;
  folderPath: string;
  ipfsRootCID: string;
  importedCar: boolean;
  /** Legacy pieces only (pre-v1.3 FWSS builds wrote a `version` key). New commits are found with {@link isCommitPiece}. */
  version?: bigint;
}

/** Read Drive (and FiFolders) piece metadata. Null when the piece carries none. */
export function readDriveMetadata(metadata: Record<string, string> | undefined | null): DrivePieceInfo | null {
  if (!metadata) return null;
  const fileName = (metadata.name || metadata.label || "").trim();
  const path = metadata.path ?? metadata.carPath;
  const ipfsRootCID = metadata.ipfsRootCID || metadata.ipfsRootCid || "";
  const rawVersion = metadata[VERSION_KEY];
  if (!fileName && path === undefined && !ipfsRootCID && rawVersion === undefined) return null;
  const info: DrivePieceInfo = {
    fileName,
    folderPath: typeof path === "string" ? path.replaceAll("\\", "/").split("/").filter(Boolean).join("/") : "",
    ipfsRootCID,
    importedCar: typeof metadata.carPath === "string",
  };
  if (rawVersion !== undefined && /^\d{1,20}$/.test(rawVersion)) info.version = BigInt(rawVersion);
  return info;
}

/**
 * Piece metadata for one volume commit. A commit that adds exactly one plaintext file's bytes is
 * named after that file, so Filecoin Drive lists (and downloads) it as that file. Other commits
 * get a system name under `.fifolders`. Encrypted volumes publish no piece metadata: names stay private.
 */
export function commitMetadata(opts: {
  tree: DirNode;
  newBlocks: ReadonlySet<string>;
  manifestRoot: string;
  volumeName: string;
  version: bigint;
  encrypted: boolean;
}): Record<string, string> {
  if (opts.encrypted) return {};
  const changed: { path: string; cid: string }[] = [];
  const walk = (node: Node, prefix: string): void => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === "dir") {
      for (const child of node.entries) walk(child, path);
      return;
    }
    if (!node.enc && !node.format && opts.newBlocks.has(node.pieceCid)) changed.push({ path, cid: node.pieceCid });
  };
  for (const child of opts.tree.entries) walk(child, "");
  const unique = [...new Map(changed.map((item) => [item.cid, item])).values()];
  if (unique.length === 1 && changed.length === 1) {
    const { name, folder } = splitDrivePath(unique[0]!.path);
    return driveMetadata({ name, folder, ipfsRootCID: unique[0]!.cid });
  }
  return driveMetadata({
    name: `${opts.volumeName || "default"}.manifest.json`,
    folder: SYSTEM_FOLDER,
    ipfsRootCID: opts.manifestRoot,
  });
}

export interface RetentionPolicy {
  /** Every version newer than this is kept. Default 30 days (Google Drive keeps revisions 30 days). */
  keepDays: number;
  /** The newest N versions are always kept. Default 100 (Google Drive's revision cap). */
  keepVersions: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepDays: 30, keepVersions: 100 };

/**
 * Old version pieces that may be removed: older than `keepDays`, outside the newest `keepVersions`,
 * not used by the live tree and not pinned ("keep forever"). History must be oldest first.
 * Only a contiguous oldest run is returned, so the `prev` chain stays walkable down to the oldest kept version.
 */
export function versionsToPrune(
  history: readonly { pieceCid: string; timestamp: number }[],
  live: ReadonlySet<string>,
  opts: { now?: number; policy?: Partial<RetentionPolicy>; pinned?: ReadonlySet<string> } = {},
): string[] {
  const policy = { ...DEFAULT_RETENTION, ...opts.policy };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const cutoff = nowSec - policy.keepDays * 86_400;
  const candidates = history.slice(0, Math.max(0, history.length - policy.keepVersions));
  const out: string[] = [];
  for (const entry of candidates) {
    if (!entry.pieceCid) continue;
    if (!entry.timestamp || entry.timestamp > cutoff) break;
    if (opts.pinned?.has(entry.pieceCid)) break;
    if (live.has(entry.pieceCid)) continue;
    out.push(entry.pieceCid);
  }
  return [...new Set(out)];
}
