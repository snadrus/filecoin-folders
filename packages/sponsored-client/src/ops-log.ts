/** Write unconfirmed sponsored work into the FiFolders Transaction log (`fifolders:ops`). */
export const SPONSORED_OPS_KEY = "fifolders:ops";
export const SPONSORED_OPS_CHANNEL = "fifolders-ops";

export type SponsoredOpState = "sent" | "retrying" | "confirmed" | "failed";

export interface SponsoredOp {
  id: string;
  v: 1;
  kind: "upload" | "dataset" | "session" | "deposit" | "commit" | "handover" | "fel-save" | "wallet";
  label: string;
  status: "pending" | "sent" | "retrying" | "done" | "error";
  stage: string;
  detail?: string;
  error?: string;
  created: number;
  updated: number;
}

function readOps(): SponsoredOp[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SPONSORED_OPS_KEY) ?? "") as { ops?: SponsoredOp[] };
    return Array.isArray(parsed?.ops) ? parsed.ops : [];
  } catch {
    return [];
  }
}

function writeOps(ops: SponsoredOp[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SPONSORED_OPS_KEY, JSON.stringify({ v: 1, ops }));
    if (typeof BroadcastChannel !== "undefined") new BroadcastChannel(SPONSORED_OPS_CHANNEL).postMessage({ type: "ops" });
  } catch { /* private mode */ }
}

export function trackSponsoredOp(input: { id: string; kind: SponsoredOp["kind"]; label: string; state: SponsoredOpState; detail?: string }): void {
  const now = Date.now();
  const status: SponsoredOp["status"] = input.state === "confirmed" ? "done" : input.state === "failed" ? "error" : input.state;
  const ops = readOps().filter((op) => op.id !== input.id && op.status !== "done");
  const prev = readOps().find((op) => op.id === input.id);
  ops.push({
    id: input.id,
    v: 1,
    kind: input.kind,
    label: input.label,
    status,
    stage: input.state,
    detail: input.detail,
    error: input.state === "failed" ? input.detail : undefined,
    created: prev?.created ?? now,
    updated: now,
  });
  writeOps(ops);
}
