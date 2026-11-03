/** Shared pending-op log. Editors on the same origin write `fel-save` rows here. */

export const OPS_KEY = "fifolders:ops";
export const OPS_CHANNEL = "fifolders-ops";
export const OPS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type OpKind = "upload" | "dataset" | "session" | "deposit" | "commit" | "fel-save" | "wallet";
export type OpStatus = "pending" | "done" | "error";

export interface FifoldersOp {
  id: string;
  v: 1;
  kind: OpKind;
  label: string;
  status: OpStatus;
  stage: string;
  path?: string;
  name?: string;
  size?: number;
  mime?: string;
  pieceCid?: string;
  txHash?: string;
  prevHead?: string;
  newHead?: string;
  content?: string;
  /** Editor title at save time; names the file. */
  title?: string;
  /** Secondary detail (cost, tx stage) shown under the purpose in the Transaction log. */
  detail?: string;
  volume?: string;
  owner?: string;
  error?: string;
  created: number;
  updated: number;
}

interface OpsFile {
  v: 1;
  ops: FifoldersOp[];
}

export function loadOps(now = Date.now()): FifoldersOp[] {
  const file = readFile();
  const fresh = file.ops.filter((op) => now - op.updated <= OPS_MAX_AGE_MS && op.status !== "done");
  if (fresh.length !== file.ops.length) writeFile({ v: 1, ops: fresh }, false);
  return fresh;
}

export function upsertOp(op: FifoldersOp): void {
  const ops = readFile().ops.filter((item) => item.id !== op.id && item.status !== "done");
  ops.push({ ...op, v: 1, updated: op.updated || Date.now() });
  writeFile({ v: 1, ops }, true);
}

export function patchOp(id: string, patch: Partial<FifoldersOp>): FifoldersOp | null {
  const ops = readFile().ops;
  const current = ops.find((op) => op.id === id);
  if (!current) return null;
  const next = { ...current, ...patch, id, v: 1 as const, updated: Date.now() };
  writeFile({ v: 1, ops: ops.map((op) => (op.id === id ? next : op)) }, true);
  return next;
}

export function dropOp(id: string): void {
  const ops = readFile().ops.filter((op) => op.id !== id);
  writeFile({ v: 1, ops }, true);
}

/** The "Save pending" row FiFolders adds when it opens a new editor; the editor's first real save replaces it. */
export function dropFelPlaceholders(path: string, keepId: string): void {
  const file = readFile();
  const ops = file.ops.filter((op) => op.id === keepId || !(op.kind === "fel-save" && op.path === path && !op.content));
  if (ops.length !== file.ops.length) writeFile({ v: 1, ops }, true);
}

export function newOp(partial: Omit<FifoldersOp, "v" | "created" | "updated" | "status" | "stage"> & { status?: OpStatus; stage?: string }): FifoldersOp {
  const now = Date.now();
  return {
    ...partial,
    v: 1,
    status: partial.status ?? "pending",
    stage: partial.stage ?? "pending",
    created: now,
    updated: now,
  };
}

/** True when the editor snapshot is still the empty template and must not be uploaded. */
export function isBlankFelContent(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      content?: { type?: string; text?: string }[];
      sheets?: { cells?: Record<string, unknown> }[];
    };
    if (parsed.type === "doc") {
      const blocks = parsed.content ?? [];
      return blocks.length === 0 || blocks.every((block) => !block.text);
    }
    if (parsed.type === "sheet") {
      const sheets = parsed.sheets ?? [];
      return sheets.every((sheet) => !sheet.cells || Object.keys(sheet.cells).length === 0);
    }
  } catch {
    return false;
  }
  return false;
}

function readFile(): OpsFile {
  const raw = localStorage.getItem(OPS_KEY);
  if (!raw) return { v: 1, ops: [] };
  try {
    const parsed = JSON.parse(raw) as OpsFile;
    if (!parsed || !Array.isArray(parsed.ops)) return { v: 1, ops: [] };
    return { v: 1, ops: parsed.ops.filter((op) => op && op.v === 1 && typeof op.id === "string") };
  } catch {
    return { v: 1, ops: [] };
  }
}

function writeFile(file: OpsFile, notify: boolean): void {
  localStorage.setItem(OPS_KEY, JSON.stringify(file));
  if (!notify) return;
  try {
    const channel = new BroadcastChannel(OPS_CHANNEL);
    channel.postMessage({ v: 1 });
    channel.close();
  } catch {
    // BroadcastChannel is missing in a few test realms; the storage event still covers other tabs.
  }
}
