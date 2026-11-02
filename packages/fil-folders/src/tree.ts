import { canonicalJson } from "./codec.js";
import {
  AlreadyExistsError,
  DirectoryNotEmptyError,
  FilFoldersError,
  IsADirectoryError,
  NotADirectoryError,
  NotFoundError,
} from "./errors.js";
import { baseName, joinPath, normalizePath, parentPath, splitPath } from "./paths.js";
import type { DirNode, FileNode, Node, Stat } from "./types.js";

export function emptyDir(mtime = 0): DirNode {
  return { type: "dir", name: "", mtime, entries: [] };
}

export function find(root: DirNode, path: string): Node | null {
  const norm = normalizePath(path);
  if (norm === "/") return root;
  let current: Node = root;
  for (const part of splitPath(norm)) {
    if (current.type !== "dir") return null;
    const next: Node | undefined = current.entries.find((entry) => entry.name === part);
    if (!next) return null;
    current = next;
  }
  return current;
}

export function directorySize(dir: DirNode): number {
  let total = 0;
  for (const entry of dir.entries) {
    total += entry.type === "file" ? entry.size : directorySize(entry);
  }
  return total;
}

export function toStat(node: Node, path: string, volumeName = ""): Stat {
  if (node.type === "file") {
    const stat: Stat = {
      name: node.name,
      path,
      type: "file",
      size: node.size,
      mtime: node.mtime,
      pieceCid: node.pieceCid,
    };
    if (node.mime !== undefined) stat.mime = node.mime;
    if (node.located !== undefined) stat.located = node.located;
    if (node.ipfs !== undefined) stat.ipfs = node.ipfs;
    if (node.importedCar) stat.importedCar = true;
    return stat;
  }
  return {
    name: path === "/" ? volumeName : node.name,
    path,
    type: "dir",
    size: directorySize(node),
    mtime: node.mtime,
  };
}

export function list(root: DirNode, path: string): Stat[] {
  const norm = normalizePath(path);
  const node = find(root, norm);
  if (!node) throw new NotFoundError(norm);
  if (node.type !== "dir") throw new NotADirectoryError(norm);
  return node.entries.map((entry) => toStat(entry, joinPath(norm, entry.name)));
}

export function mkdir(root: DirNode, path: string, now: number): DirNode {
  const norm = normalizePath(path);
  if (norm === "/") return root;
  return ensureDir(root, splitPath(norm), now, "/");
}

export function putFile(root: DirNode, path: string, file: Omit<FileNode, "type" | "name">, now: number): DirNode {
  const norm = normalizePath(path);
  if (norm === "/") throw new IsADirectoryError("/");
  const node: FileNode = { type: "file", name: baseName(norm), ...file };
  return place(root, splitPath(norm), node, true, true, now, "/");
}

export function remove(root: DirNode, path: string, recursive: boolean, now: number): DirNode {
  const norm = normalizePath(path);
  if (norm === "/") throw new FilFoldersError("cannot remove the volume root");
  return removeAt(root, splitPath(norm), recursive, now, "/");
}

export function move(root: DirNode, from: string, to: string, now: number): DirNode {
  return relocate(root, from, to, now, "mv");
}

export function copy(root: DirNode, from: string, to: string, now: number): DirNode {
  return relocate(root, from, to, now, "cp");
}

export function sameTree(a: DirNode, b: DirNode): boolean {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

/** Content fingerprint of `path`, or `null` when it is absent. */
export function fingerprint(root: DirNode, path: string): string | null {
  const node = find(root, path);
  if (!node) return null;
  return canonicalJson(shape(node));
}

function shape(node: Node): unknown {
  if (node.type === "file") {
    return {
      type: "file",
      size: node.size,
      mtime: node.mtime,
      mime: node.mime ?? null,
      pieceCid: node.pieceCid,
      ipfs: node.ipfs ?? null,
      importedCar: node.importedCar ?? false,
      enc: node.enc ?? null,
    };
  }
  return {
    type: "dir",
    mtime: node.mtime,
    entries: [...node.entries]
      .map((entry) => [entry.name, shape(entry)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
}

function relocate(root: DirNode, from: string, to: string, now: number, mode: "mv" | "cp"): DirNode {
  const src = normalizePath(from);
  const dst = normalizePath(to);
  if (src === "/") throw new FilFoldersError(`cannot ${mode} the volume root`);
  if (dst === "/") throw new FilFoldersError("cannot replace the volume root");
  const node = find(root, src);
  if (!node) throw new NotFoundError(src);
  if (src === dst) {
    if (mode === "mv") return root;
    throw new AlreadyExistsError(dst);
  }
  if (dst.startsWith(`${src}/`)) throw new FilFoldersError(`cannot ${mode} a directory into itself`);
  if (find(root, dst)) throw new AlreadyExistsError(dst);
  const parent = parentPath(dst);
  const parentNode = find(root, parent);
  if (!parentNode) throw new NotFoundError(parent);
  if (parentNode.type !== "dir") throw new NotADirectoryError(parent);

  const cloned = structuredClone(node) as Node;
  cloned.name = baseName(dst);
  if (mode === "cp") cloned.mtime = now;
  const base = mode === "mv" ? remove(root, src, true, now) : root;
  return place(base, splitPath(dst), cloned, false, false, now, "/");
}

function ensureDir(dir: DirNode, parts: readonly string[], now: number, prefix: string): DirNode {
  const head = parts[0];
  if (head === undefined) return dir;
  const here = joinPath(prefix, head);
  const rest = parts.slice(1);
  const existing = dir.entries.find((entry) => entry.name === head);
  if (!existing) {
    let created: DirNode = { type: "dir", name: head, mtime: now, entries: [] };
    if (rest.length > 0) created = ensureDir(created, rest, now, here);
    return replaceChild(dir, created, dir.mtime);
  }
  if (existing.type !== "dir") throw new NotADirectoryError(here);
  if (rest.length === 0) return dir;
  const next = ensureDir(existing, rest, now, here);
  if (next === existing) return dir;
  return replaceChild(dir, next, dir.mtime);
}

function place(
  dir: DirNode,
  parts: readonly string[],
  node: Node,
  mkdirp: boolean,
  overwrite: boolean,
  now: number,
  prefix: string,
): DirNode {
  const head = parts[0];
  if (head === undefined) throw new FilFoldersError("empty path");
  const here = joinPath(prefix, head);
  const rest = parts.slice(1);
  if (rest.length === 0) {
    const existing = dir.entries.find((entry) => entry.name === head);
    if (existing) {
      if (!overwrite || existing.type === "dir" || node.type === "dir") {
        if (existing.type === "dir") throw new IsADirectoryError(here);
        throw new AlreadyExistsError(here);
      }
    }
    const named = { ...node, name: head } as Node;
    return replaceChild(dir, named, now);
  }

  const existing = dir.entries.find((entry) => entry.name === head);
  let child: DirNode;
  if (!existing) {
    if (!mkdirp) throw new NotFoundError(here);
    child = { type: "dir", name: head, mtime: now, entries: [] };
  } else if (existing.type !== "dir") {
    throw new NotADirectoryError(here);
  } else {
    child = existing;
  }
  const next = place(child, rest, node, mkdirp, overwrite, now, here);
  return replaceChild(dir, next, dir.mtime);
}

function removeAt(dir: DirNode, parts: readonly string[], recursive: boolean, now: number, prefix: string): DirNode {
  const head = parts[0];
  if (head === undefined) throw new NotFoundError(prefix);
  const here = joinPath(prefix, head);
  const rest = parts.slice(1);
  const existing = dir.entries.find((entry) => entry.name === head);
  if (!existing) throw new NotFoundError(here);
  if (rest.length === 0) {
    if (existing.type === "dir" && existing.entries.length > 0 && !recursive) throw new DirectoryNotEmptyError(here);
    return withoutChild(dir, head, now);
  }
  if (existing.type !== "dir") throw new NotADirectoryError(here);
  const next = removeAt(existing, rest, recursive, now, here);
  return replaceChild(dir, next, dir.mtime);
}

function replaceChild(dir: DirNode, child: Node, mtime: number): DirNode {
  const entries = dir.entries.filter((entry) => entry.name !== child.name);
  entries.push(child);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { type: "dir", name: dir.name, mtime, entries };
}

function withoutChild(dir: DirNode, name: string, mtime: number): DirNode {
  return {
    type: "dir",
    name: dir.name,
    mtime,
    entries: dir.entries.filter((entry) => entry.name !== name),
  };
}
