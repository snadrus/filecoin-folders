import { felFileName } from "./blank.js";
import type { FelKind } from "./model.js";

/**
 * New FiPen/FiGrid files open without a name prompt. The editor's title names the file:
 * each editor session keeps its first path as a key, and this maps it to the current file.
 */
export interface FelAlias {
  path: string;
  title: string;
}

const KEY = "fifolders:fel-alias";

function load(): Record<string, FelAlias> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, FelAlias>) : {};
  } catch {
    return {};
  }
}

function save(book: Record<string, FelAlias>): void {
  localStorage.setItem(KEY, JSON.stringify(book));
}

export function defaultFelTitle(kind: FelKind): string {
  return kind === "felarumi" ? "Untitled document" : "Untitled spreadsheet";
}

export function felKindOfPath(path: string): FelKind {
  return /\.(figrid|felanumio)$/i.test(path) ? "felanumio" : "felarumi";
}

/**
 * Where an editor save for `origin` should land. A changed title renames the file;
 * an unchanged title keeps any rename done in FiFolders.
 */
export function felTarget(origin: string, title: string | undefined): { from: string; to: string } {
  const book = load();
  const known = book[origin];
  const current = known?.path ?? origin;
  const clean = (title ?? "").trim();
  if (!clean || clean === known?.title) return { from: current, to: current };
  const name = felFileName(clean, felKindOfPath(origin));
  if (!name) return { from: current, to: current };
  const dir = current.slice(0, current.lastIndexOf("/")) || "/";
  return { from: current, to: dir === "/" ? `/${name}` : `${dir}/${name}` };
}

export function rememberFelTarget(origin: string, path: string, title: string | undefined): void {
  const book = load();
  book[origin] = { path, title: (title ?? "").trim() || book[origin]?.title || "" };
  save(book);
}

/** FiFolders rename or move: keep editor sessions pointing at the file. */
export function remapFelTargets(from: string, to: string): void {
  const book = load();
  let changed = false;
  for (const alias of Object.values(book)) {
    if (alias.path === from || alias.path.startsWith(`${from}/`)) {
      alias.path = to + alias.path.slice(from.length);
      changed = true;
    }
  }
  if (changed) save(book);
}
