import { NotFoundError, type Stat, type Volume } from "fil-folders";

interface SavedFile {
  path: string;
  mime?: string;
  b64?: string;
  dir?: boolean;
}

function key(owner: string, volumeName: string): string {
  return `fifolders:mem-volume:${owner.toLowerCase()}:${volumeName}`;
}

export function viewKey(owner: string, volumeName: string): string {
  return `fifolders:last-view:${owner.toLowerCase()}:${volumeName}`;
}

export interface SavedView {
  nav: string;
  cwd: string;
  volume: string;
}

export function loadSavedView(owner: string, volumeName: string): SavedView | null {
  const raw = localStorage.getItem(viewKey(owner, volumeName));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedView;
    if (!parsed?.cwd || !parsed.nav) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveView(owner: string, volumeName: string, view: SavedView): void {
  localStorage.setItem(viewKey(owner, volumeName), JSON.stringify(view));
}

export async function persistMemoryVolume(volume: Volume, owner: string, volumeName: string): Promise<void> {
  const saved: SavedFile[] = [];
  for (const entry of await walkAll(volume, "/")) {
    if (entry.type === "dir") {
      saved.push({ path: entry.path, dir: true });
      continue;
    }
    const bytes = await volume.get(entry.path);
    saved.push({ path: entry.path, mime: entry.mime || "application/octet-stream", b64: bytesToB64(bytes) });
  }
  localStorage.setItem(key(owner, volumeName), JSON.stringify(saved));
}

export async function restoreMemoryVolume(volume: Volume, owner: string, volumeName: string): Promise<void> {
  const raw = localStorage.getItem(key(owner, volumeName));
  if (!raw) return;
  let saved: SavedFile[];
  try {
    saved = JSON.parse(raw) as SavedFile[];
  } catch {
    return;
  }
  if (!Array.isArray(saved) || !saved.length) return;
  await volume.tx(async (draft) => {
    for (const file of saved) {
      if (!file?.path) continue;
      const parent = file.path.split("/").slice(0, -1).join("/") || "/";
      if (parent !== "/") await draft.mkdir(parent);
      if (file.dir) {
        await draft.mkdir(file.path);
        continue;
      }
      if (!file.b64) continue;
      await draft.put(file.path, b64ToBytes(file.b64), { mime: file.mime });
    }
  });
}

async function walkAll(volume: Volume, dir: string): Promise<Stat[]> {
  let entries: Stat[];
  try {
    entries = await volume.ls(dir);
  } catch (error) {
    if (error instanceof NotFoundError) return [];
    throw error;
  }
  const out: Stat[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (entry.type === "dir") out.push(...(await walkAll(volume, entry.path)));
  }
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function b64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
