import type { FelKind } from "./model.js";

/**
 * Empty snapshots the FiPen and FiGrid editors open.
 * `v` is the file schema. A document is one empty paragraph. A spreadsheet is one sheet with no cells.
 */

const NEW_EXT: Record<FelKind, string> = { felarumi: ".fipen", felanumio: ".figrid" };
const KNOWN_EXT = [".fipen", ".felarumi", ".figrid", ".felanumio"];

export interface FelarumiDoc {
  v: 1;
  type: "doc";
  title: string;
  content: [{ type: "paragraph"; text: "" }];
}

export interface FelanumioSheet {
  v: 1;
  type: "sheet";
  title: string;
  sheets: [{ name: "Sheet1"; cells: Record<string, never> }];
}

export function blankFelarumi(title: string): FelarumiDoc {
  return { v: 1, type: "doc", title, content: [{ type: "paragraph", text: "" }] };
}

export function blankFelanumio(title: string): FelanumioSheet {
  return { v: 1, type: "sheet", title, sheets: [{ name: "Sheet1", cells: {} }] };
}

export function blankBytes(kind: FelKind, title: string): Uint8Array {
  const doc = kind === "felarumi" ? blankFelarumi(title) : blankFelanumio(title);
  return new TextEncoder().encode(JSON.stringify(doc));
}

export function felFileName(raw: string, kind: FelKind): string {
  let trimmed = raw.trim();
  if (!trimmed || /[\\/]/.test(trimmed)) return "";
  const lower = trimmed.toLowerCase();
  for (const ext of KNOWN_EXT) {
    if (lower.endsWith(ext)) {
      trimmed = trimmed.slice(0, -ext.length).trim();
      break;
    }
  }
  if (!trimmed) return "";
  return `${trimmed}${NEW_EXT[kind]}`;
}

export function felTitle(fileName: string, kind: FelKind): string {
  const lower = fileName.toLowerCase();
  for (const ext of [NEW_EXT[kind], kind === "felarumi" ? ".felarumi" : ".felanumio"]) {
    if (lower.endsWith(ext)) return fileName.slice(0, -ext.length);
  }
  return fileName;
}
