import type { Stat } from "fil-folders";

export type NavId = "drive" | "recent" | "starred" | "trash" | "loose";
export type ViewMode = "list" | "grid";
export type SortKey = "name" | "owner" | "mtime" | "size";
export type FelKind = "felarumi" | "felanumio";

export const TRASH_PATH = "/.trash";
export const METER_CAP = 5 * 1024 * 1024 * 1024;

export function parentPath(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function baseName(path: string): string {
  if (path === "/" || path === "") return "";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return trimmed.slice(index + 1);
}

export function matchesQuery(entry: { name: string; path: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle);
}

export function joinPath(dir: string, name: string): string {
  const clean = name.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return dir || "/";
  if (dir === "/" || dir === "") return `/${clean}`;
  return `${dir.replace(/\/+$/, "")}/${clean}`;
}

export function isTrashPath(path: string): boolean {
  return path === TRASH_PATH || path.startsWith(`${TRASH_PATH}/`);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatBytes(raw: number): string {
  const size = typeof raw === "bigint" || typeof raw === "string" ? toNumber(raw) : raw;
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 || Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function meterPercent(used: number): number {
  if (used <= 0) return 0;
  return Math.max(2, Math.min(100, (used / METER_CAP) * 100));
}

export function formatWhen(ms: number, now = Date.now()): string {
  const date = new Date(toNumber(ms));
  if (Number.isNaN(date.getTime())) return "—";
  if (new Date(now).toDateString() === date.toDateString()) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function felKind(name: string): FelKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".fipen") || lower.endsWith(".felarumi")) return "felarumi";
  if (lower.endsWith(".figrid") || lower.endsWith(".felanumio")) return "felanumio";
  return null;
}

export function splitStem(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const { stem, ext } = splitStem(name);
  for (let i = 1; i < 1000; i += 1) {
    const next = `${stem} (${i})${ext}`;
    if (!taken.has(next)) return next;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export function copyName(name: string): string {
  const { stem, ext } = splitStem(name);
  return `${stem} (copy)${ext}`;
}

export function breadcrumbs(nav: NavId, cwd: string): { label: string; path: string }[] {
  if (nav === "recent") return [{ label: "Recent", path: "" }];
  if (nav === "starred") return [{ label: "Starred", path: "" }];
  if (nav === "loose") return [{ label: "Loose pieces", path: "" }];
  if (nav === "trash") {
    const crumbs = [{ label: "Trash", path: TRASH_PATH }];
    if (cwd === TRASH_PATH || !cwd.startsWith(`${TRASH_PATH}/`)) return crumbs;
    let acc = TRASH_PATH;
    for (const part of cwd.slice(TRASH_PATH.length + 1).split("/").filter(Boolean)) {
      acc = `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  const crumbs = [{ label: "My Drive", path: "/" }];
  if (cwd !== "/") {
    let acc = "";
    for (const part of cwd.split("/").filter(Boolean)) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }
  return crumbs;
}

export function applySelection(options: {
  ordered: readonly string[];
  selected: readonly string[];
  anchor: string | null;
  path: string;
  shift: boolean;
  toggle: boolean;
}): { selected: string[]; anchor: string | null } {
  const { ordered, path, anchor } = options;
  if (options.shift && anchor && ordered.includes(anchor) && ordered.includes(path)) {
    const start = ordered.indexOf(anchor);
    const end = ordered.indexOf(path);
    const [lo, hi] = start < end ? [start, end] : [end, start];
    return { selected: ordered.slice(lo, hi + 1), anchor };
  }
  if (options.toggle) {
    const selected = options.selected.includes(path)
      ? options.selected.filter((item) => item !== path)
      : [...options.selected, path];
    return { selected, anchor: path };
  }
  return { selected: [path], anchor: path };
}

export function sortStats(entries: readonly Stat[], key: SortKey, dir: 1 | -1, foldersFirst: boolean): Stat[] {
  return [...entries].sort((a, b) => {
    if (foldersFirst && a.type !== b.type) return a.type === "dir" ? -1 : 1;
    let cmp = 0;
    if (key === "name") cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    else if (key === "size") cmp = toNumber(a.size) - toNumber(b.size);
    else if (key === "mtime") cmp = toNumber(a.mtime) - toNumber(b.mtime);
    if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return cmp * dir;
  });
}

export function defaultSortDir(key: SortKey): 1 | -1 {
  return key === "name" || key === "owner" ? 1 : -1;
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};

export function guessMime(name: string, mime?: string): string {
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? mime ?? "application/octet-stream";
}

export type PreviewKind = "image" | "text" | "pdf" | "video" | "none";

export function previewKind(mime: string, bytes: Uint8Array): PreviewKind {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime.endsWith("+xml")) {
    return "text";
  }
  if (bytes.byteLength <= 256 * 1024 && !bytes.includes(0)) return "text";
  return "none";
}

export function materialIcon(entry: Pick<Stat, "type" | "name" | "mime">): string {
  if (entry.type === "dir") return "folder";
  const mime = guessMime(entry.name, entry.mime);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "movie";
  if (mime === "application/pdf") return "picture_as_pdf";
  if (mime.startsWith("text/") || mime === "application/json") return "description";
  return "draft";
}

export interface AppLinkExtra {
  path?: string;
  volume?: string;
  owner?: string;
  /** Base URL used to resolve a relative editor path such as `./fipen/`. */
  href?: string;
}

export function appLink(
  kind: FelKind,
  pieceCid: string,
  name: string,
  bases: Record<FelKind, string>,
  extra: AppLinkExtra = {},
): string {
  const raw = bases[kind].trim();
  const href = extra.href || (typeof location !== "undefined" ? location.href : "https://fifolder.scionbase.ai/");
  const url = new URL(raw, href);
  url.searchParams.set("fifolders", "1");
  url.searchParams.set("name", name);
  if (pieceCid) url.searchParams.set("pieceCid", pieceCid);
  if (extra.path) url.searchParams.set("path", extra.path);
  if (extra.volume) url.searchParams.set("volume", extra.volume);
  if (extra.owner) url.searchParams.set("owner", extra.owner);
  return url.toString();
}

export function sumSizes(entries: readonly Stat[]): number {
  let total = 0;
  for (const entry of entries) {
    // Live manifests can decode sizes as bigint; never mix them with numbers.
    if (entry.type === "file") total += toNumber(entry.size);
  }
  return total;
}

/** Chain and CBOR values arrive as number, bigint, or string; turn them into a finite number. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Same for bigint math (atto-USDFC, epochs, expiries). */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return 0n;
}
