import { decodeUtf8, utf8 } from "./bytes.js";
import type { Manifest, ManifestEntry } from "./types.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) out[key] = normalize(child);
    }
    return out;
  }
  return value;
}

export function manifestBytes(manifest: Manifest): Uint8Array {
  return utf8(canonicalJson(manifest));
}

export function parseManifest(bytes: Uint8Array): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new Error("manifest piece is not JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("manifest piece is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw new Error(`unsupported manifest version: ${String(record.v)}`);
  const mtime = record.mtime === undefined ? 0 : record.mtime;
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) throw new Error("manifest mtime is invalid");
  if (!Array.isArray(record.entries)) throw new Error("manifest entries are missing");
  return { v: 1, mtime, entries: record.entries.map((entry) => parseEntry(entry)) };
}

function parseEntry(value: unknown): ManifestEntry {
  if (!value || typeof value !== "object") throw new Error("manifest entry is not an object");
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || entry.name.length === 0) throw new Error("manifest entry name is invalid");
  if (entry.type !== "file" && entry.type !== "dir") throw new Error(`manifest entry type is invalid: ${String(entry.type)}`);
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error("manifest entry size is invalid");
  }
  if (typeof entry.mtime !== "number" || !Number.isFinite(entry.mtime)) throw new Error("manifest entry mtime is invalid");
  const parsed: ManifestEntry = {
    name: entry.name,
    type: entry.type,
    size: entry.size,
    mtime: entry.mtime,
  };
  if (entry.pieceCid !== undefined) {
    if (typeof entry.pieceCid !== "string" || entry.pieceCid.length === 0) throw new Error("manifest pieceCid is invalid");
    parsed.pieceCid = entry.pieceCid;
  }
  if (entry.mime !== undefined) {
    if (typeof entry.mime !== "string") throw new Error("manifest mime is invalid");
    parsed.mime = entry.mime;
  }
  if (entry.enc !== undefined) parsed.enc = parseEnc(entry.enc);
  if (entry.entries !== undefined) {
    if (!Array.isArray(entry.entries)) throw new Error("manifest directory entries are invalid");
    parsed.entries = entry.entries.map((child) => parseEntry(child));
  }
  if (parsed.type === "file") {
    if (!parsed.pieceCid) throw new Error("file entry is missing pieceCid");
    if (parsed.entries) throw new Error("file entry cannot contain entries");
  } else if (parsed.pieceCid && parsed.entries) {
    throw new Error("directory entry has both pieceCid and entries");
  }
  return parsed;
}

function parseEnc(value: unknown): ManifestEntry["enc"] {
  if (!value || typeof value !== "object") throw new Error("manifest enc is invalid");
  const enc = value as Record<string, unknown>;
  if (enc.alg !== "A256GCM") throw new Error("unsupported encryption alg");
  const parsed: NonNullable<ManifestEntry["enc"]> = { alg: "A256GCM" };
  if (enc.iv !== undefined) {
    if (typeof enc.iv !== "string") throw new Error("manifest enc.iv is invalid");
    parsed.iv = enc.iv;
  }
  if (enc.nameIv !== undefined) {
    if (typeof enc.nameIv !== "string") throw new Error("manifest enc.nameIv is invalid");
    parsed.nameIv = enc.nameIv;
  }
  return parsed;
}
