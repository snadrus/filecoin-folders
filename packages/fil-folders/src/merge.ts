import { CasConflictError } from "./errors.js";
import { baseName, parentPath } from "./paths.js";
import { emptyDir } from "./tree.js";
import type { ContentEnc, DirNode, FileNode, Node } from "./types.js";

interface FlatDir {
  type: "dir";
  mtime: number;
}

interface FlatFile {
  type: "file";
  mtime: number;
  pieceCid: string;
  size: number;
  mime?: string;
  enc?: ContentEnc;
}

type Flat = FlatDir | FlatFile;

/**
 * Three-way merge of folder trees. Directory identity ignores mtime.
 * File identity ignores mtime and compares piece, size, mime, and content encryption.
 * Non-overlapping edits apply. The same resulting content on both sides applies.
 * Everything else, including a delete beside a new child, is a conflict.
 */
export function mergeTrees(base: DirNode, ours: DirNode, theirs: DirNode): DirNode {
  const baseMap = flatten(base);
  const oursMap = flatten(ours);
  const theirsMap = flatten(theirs);
  const paths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const out = new Map(baseMap);
  const conflicts: string[] = [];

  for (const path of [...paths].sort()) {
    const before = baseMap.get(path);
    const our = oursMap.get(path);
    const their = theirsMap.get(path);
    const ourChange = !sameContent(before, our);
    const theirChange = !sameContent(before, their);
    if (!ourChange && !theirChange) continue;
    if (ourChange && !theirChange) {
      setOrDelete(out, path, our);
      continue;
    }
    if (theirChange && !ourChange) {
      setOrDelete(out, path, their);
      continue;
    }
    if (sameContent(our, their)) {
      setOrDelete(out, path, later(our, their));
      continue;
    }
    conflicts.push(path);
  }

  if (conflicts.length === 0) conflicts.push(...brokenParents(out));
  if (conflicts.length > 0) throw new CasConflictError([...new Set(conflicts)].sort());
  return unflatten(out, Math.max(base.mtime, ours.mtime, theirs.mtime));
}

function setOrDelete(map: Map<string, Flat>, path: string, node: Flat | undefined): void {
  if (node) map.set(path, node);
  else map.delete(path);
}

function later(a: Flat | undefined, b: Flat | undefined): Flat | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.mtime >= b.mtime ? a : b;
}

function sameContent(a: Flat | undefined, b: Flat | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "dir" && b.type === "dir") return true;
  if (a.type !== "file" || b.type !== "file") return false;
  return a.pieceCid === b.pieceCid && a.size === b.size && (a.mime ?? "") === (b.mime ?? "") && sameEnc(a.enc, b.enc);
}

function sameEnc(a: ContentEnc | undefined, b: ContentEnc | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.alg === b.alg && a.iv === b.iv;
}

function brokenParents(map: Map<string, Flat>): string[] {
  const bad: string[] = [];
  for (const path of map.keys()) {
    const parent = parentPath(path);
    if (parent === "/") continue;
    const node = map.get(parent);
    if (!node || node.type !== "dir") bad.push(path);
  }
  return bad;
}

function flatten(root: DirNode): Map<string, Flat> {
  const map = new Map<string, Flat>();
  const walk = (dir: DirNode, prefix: string): void => {
    for (const entry of dir.entries) {
      const path = prefix === "/" ? `/${entry.name}` : `${prefix}/${entry.name}`;
      if (entry.type === "dir") {
        map.set(path, { type: "dir", mtime: entry.mtime });
        walk(entry, path);
      } else {
        const file: FlatFile = {
          type: "file",
          mtime: entry.mtime,
          pieceCid: entry.pieceCid,
          size: entry.size,
        };
        if (entry.mime !== undefined) file.mime = entry.mime;
        if (entry.enc !== undefined) file.enc = entry.enc;
        map.set(path, file);
      }
    }
  };
  walk(root, "/");
  return map;
}

function unflatten(map: Map<string, Flat>, rootMtime: number): DirNode {
  const root = emptyDir(rootMtime);
  const dirs = new Map<string, DirNode>([["/", root]]);
  const paths = [...map.keys()].sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) return depth;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const path of paths) {
    const node = map.get(path);
    if (!node) continue;
    const parent = dirs.get(parentPath(path));
    if (!parent) throw new Error(`merge produced a missing parent for ${path}`);
    const name = baseName(path);
    if (node.type === "dir") {
      const dir: DirNode = { type: "dir", name, mtime: node.mtime, entries: [] };
      parent.entries.push(dir);
      dirs.set(path, dir);
    } else {
      const file: FileNode = {
        type: "file",
        name,
        pieceCid: node.pieceCid,
        size: node.size,
        mtime: node.mtime,
      };
      if (node.mime !== undefined) file.mime = node.mime;
      if (node.enc !== undefined) file.enc = node.enc;
      parent.entries.push(file);
    }
  }
  for (const dir of dirs.values()) {
    dir.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return root;
}

export type { Node };
