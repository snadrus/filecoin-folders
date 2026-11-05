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
 * FiFolders adds `version` (registry commit number, decimal) so a commit piece is recognisable as one
 * version of a file and not a loose upload. Synapse allows 5 piece keys, 32-byte keys, 128-byte values.
 */
import type { DirNode, Node } from "./types.js";

export const DRIVE_METADATA_BYTES = 96;
export const DRIVE_SOURCE = "filecoin-pin";
export const FIFOLDERS_SOURCE = "fifolders";
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
  version?: bigint | number;
  /** Extra keys (e.g. `source`); dropped first when over the 5-key limit. */
  extra?: Record<string, string>;
}

/** Piece metadata Filecoin Drive understands, within Synapse limits. */
export function driveMetadata(input: DriveMetadataInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.name?.trim()) out.label = fitBytes(input.name.trim());
  if (input.folder !== undefined && out.label) {
    // Over-long folders go to the root rather than failing the save.
    out.path = utf8(input.folder).byteLength <= DRIVE_METADATA_BYTES ? input.folder : "";
  }
  if (input.ipfsRootCID) out.ipfsRootCID = input.ipfsRootCID;
  if (input.version !== undefined) out[VERSION_KEY] = String(input.version);
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (Object.keys(out).length >= 5) break;
    if (key.length <= 32 && utf8(value).byteLength <= 128 && !(key in out)) out[key] = value;
  }
  return out;
}

export interface DrivePieceInfo {
  fileName: string;
  folderPath: string;
  ipfsRootCID: string;
  importedCar: boolean;
  /** Set when a FiFolders writer stored this piece as a version of a file. */
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
 * get a system name under `.fifolders`. Encrypted volumes publish only the version: names stay private.
 */
export function commitMetadata(opts: {
  tree: DirNode;
  newBlocks: ReadonlySet<string>;
  manifestRoot: string;
  volumeName: string;
  version: bigint;
  encrypted: boolean;
}): Record<string, string> {
  if (opts.encrypted) return driveMetadata({ version: opts.version });
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
    return driveMetadata({ name, folder, ipfsRootCID: unique[0]!.cid, version: opts.version });
  }
  return driveMetadata({
    name: `${opts.volumeName || "default"}.manifest.json`,
    folder: SYSTEM_FOLDER,
    ipfsRootCID: opts.manifestRoot,
    version: opts.version,
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
