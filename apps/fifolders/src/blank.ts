import type { FelKind } from "./model.js";

/**
 * Empty snapshots the Felarumi and Felanumio editors open.
 * `v` is the file schema. A document is one empty paragraph. A spreadsheet is one sheet with no cells.
 */
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
  const ext = kind === "felarumi" ? ".felarumi" : ".felanumio";
  const trimmed = raw.trim();
  if (!trimmed || /[\\/]/.test(trimmed)) return "";
  return trimmed.toLowerCase().endsWith(ext) ? trimmed : `${trimmed}${ext}`;
}

export function felTitle(fileName: string, kind: FelKind): string {
  const ext = kind === "felarumi" ? ".felarumi" : ".felanumio";
  return fileName.toLowerCase().endsWith(ext) ? fileName.slice(0, -ext.length) : fileName;
}
