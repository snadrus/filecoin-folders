import { FilFoldersError } from "./errors.js";

/** Absolute volume path. `/` is the root. `.` and empty segments are dropped. `..` is rejected. */
export function normalizePath(input: string): string {
  if (typeof input !== "string") throw new TypeError("path must be a string");
  if (input.includes("\0")) throw new FilFoldersError("path contains NUL");
  if (input === "" || input === "/") return "/";
  const out: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new FilFoldersError("path must not contain ..");
    out.push(part);
  }
  return out.length === 0 ? "/" : `/${out.join("/")}`;
}

export function splitPath(path: string): string[] {
  const norm = path.startsWith("/") ? path : normalizePath(path);
  if (norm === "/") return [];
  return norm.slice(1).split("/");
}

export function baseName(path: string): string {
  const norm = normalizePath(path);
  if (norm === "/") return "";
  return norm.slice(norm.lastIndexOf("/") + 1);
}

export function parentPath(path: string): string {
  const norm = normalizePath(path);
  if (norm === "/") return "/";
  const index = norm.lastIndexOf("/");
  return index <= 0 ? "/" : norm.slice(0, index);
}

export function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}
