import { MemoryRegistry, MemoryStorage, NotFoundError, openVolume, type Volume } from "fil-folders";

/** One local edit. A Save replays the list in a single volume transaction. */
export type StagedOp =
  | { op: "mkdir"; path: string }
  | { op: "put"; path: string; bytes: string; mime?: string; ipfs?: string; importedCar?: boolean }
  | { op: "mv"; from: string; to: string }
  | { op: "cp"; from: string; to: string }
  | { op: "rm"; path: string };

export interface StagedFile {
  ops: StagedOp[];
  origins: Record<string, string>;
  stars: string[];
}

export const AUTOSAVE_UPLOADS_KEY = "fifolders:autosave-uploads";

export function stagedKey(owner: string, volumeName: string): string {
  return `fifolders:staged:${owner.toLowerCase()}:${volumeName}`;
}

export function loadStaged(owner: string, volumeName: string): StagedFile {
  const raw = localStorage.getItem(stagedKey(owner, volumeName));
  if (!raw) return { ops: [], origins: {}, stars: [] };
  try {
    const parsed = JSON.parse(raw) as { ops?: unknown; origins?: unknown; stars?: unknown };
    const ops = Array.isArray(parsed.ops) ? parsed.ops.map(parseOp).filter((op): op is StagedOp => op !== null) : [];
    const origins = parsed.origins && typeof parsed.origins === "object" ? (parsed.origins as Record<string, string>) : {};
    const stars = Array.isArray(parsed.stars) ? parsed.stars.filter((item): item is string => typeof item === "string") : [];
    return { ops, origins, stars };
  } catch {
    return { ops: [], origins: {}, stars: [] };
  }
}

export function saveStaged(owner: string, volumeName: string, file: StagedFile): void {
  if (!file.ops.length) {
    localStorage.removeItem(stagedKey(owner, volumeName));
    return;
  }
  localStorage.setItem(stagedKey(owner, volumeName), JSON.stringify({ v: 1, ...file }));
}

/** Absent or any value other than "0" means uploads commit immediately. */
export function autoSaveUploads(): boolean {
  return localStorage.getItem(AUTOSAVE_UPLOADS_KEY) !== "0";
}

export function saveLabel(count: number): string {
  return count === 1 ? "Save 1 change" : `Save ${count} changes`;
}

export function restoreLabel(count: number): string {
  return count === 1 ? "Restored 1 unsaved change" : `Restored ${count} unsaved changes`;
}

/** Plaintext copy so the drive can show edits before they are committed. */
export async function forkVolume(source: Volume): Promise<Volume> {
  const draft = await openVolume({
    storage: new MemoryStorage(),
    registry: new MemoryRegistry(source.owner),
    owner: source.owner,
    name: source.name,
    now: () => Date.now(),
  });
  await draft.tx(async (tx) => {
    await copyTree(source, tx, "/");
  });
  return draft;
}

export async function replayStaged(volume: Volume, ops: readonly StagedOp[]): Promise<void> {
  if (!ops.length) return;
  await volume.tx(async (draft) => {
    for (const op of ops) await applyOne(draft, op);
  });
}

async function applyOne(volume: Volume, op: StagedOp): Promise<void> {
  if (op.op === "mkdir") {
    await volume.mkdir(op.path);
    return;
  }
  if (op.op === "put") {
    await volume.put(op.path, b64ToBytes(op.bytes), {
      ...(op.mime ? { mime: op.mime } : {}),
      ...(op.ipfs ? { ipfs: op.ipfs } : {}),
      ...(op.importedCar ? { importedCar: true } : {}),
    });
    return;
  }
  if (op.op === "mv") {
    await volume.mv(op.from, op.to);
    return;
  }
  if (op.op === "cp") {
    await volume.cp(op.from, op.to);
    return;
  }
  await volume.rm(op.path, { recursive: true });
}

async function copyTree(source: Volume, dest: Volume, dir: string): Promise<void> {
  let entries;
  try {
    entries = await source.ls(dir);
  } catch (error) {
    if (error instanceof NotFoundError) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.type === "dir") {
      await dest.mkdir(entry.path);
      await copyTree(source, dest, entry.path);
    } else {
      const bytes = await source.get(entry.path);
      await dest.put(entry.path, bytes, {
        ...(entry.mime ? { mime: entry.mime } : {}),
        ...(entry.ipfs ? { ipfs: entry.ipfs } : {}),
        ...(entry.importedCar ? { importedCar: true } : {}),
      });
    }
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function parseOp(value: unknown): StagedOp | null {
  if (!value || typeof value !== "object") return null;
  const op = value as Record<string, unknown>;
  if (op.op === "mkdir" && typeof op.path === "string") return { op: "mkdir", path: op.path };
  if (op.op === "put" && typeof op.path === "string" && typeof op.bytes === "string") {
    const next: StagedOp = { op: "put", path: op.path, bytes: op.bytes };
    if (typeof op.mime === "string") next.mime = op.mime;
    if (typeof op.ipfs === "string") next.ipfs = op.ipfs;
    if (op.importedCar === true) next.importedCar = true;
    return next;
  }
  if ((op.op === "mv" || op.op === "cp") && typeof op.from === "string" && typeof op.to === "string") {
    return { op: op.op, from: op.from, to: op.to };
  }
  if (op.op === "rm" && typeof op.path === "string") return { op: "rm", path: op.path };
  return null;
}
