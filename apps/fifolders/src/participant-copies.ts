/**
 * Copies a participant saved while the owner was away (FiPen/FiGrid "Save a copy to your drive?").
 * The owner's editor tab stores them here when the participant hands them over; the owner brings one into their own
 * drive as the next version of the original (nothing changed since the participant's base) or side by side.
 */

export const COPIES_KEY = "fifolders:copies";

export interface ParticipantCopy {
  id: string;
  kind: "doc" | "book";
  title: string;
  from: string;
  content: string;
  origin: { doc: string; owner: string; baseRev: number; by: string; at: number };
  fit: "version" | "diverged";
  /** The original's path in the owner's drive, when known. */
  path: string;
  received: number;
}

export function loadCopies(): ParticipantCopy[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(COPIES_KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as ParticipantCopy[]).filter((c) => c && typeof c.id === "string" && typeof c.content === "string") : [];
  } catch {
    return [];
  }
}

export function dropCopy(id: string): void {
  localStorage.setItem(COPIES_KEY, JSON.stringify(loadCopies().filter((c) => c.id !== id)));
}

function clean(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Where taking a copy writes: over the original (a new version) when it still fits, else beside it. */
export function copyTarget(copy: ParticipantCopy): { path: string; mode: "version" | "side" } {
  if (copy.fit === "version" && copy.path) return { path: copy.path, mode: "version" };
  const ext = copy.kind === "doc" ? ".fipen" : ".figrid";
  const dir = copy.path ? copy.path.slice(0, copy.path.lastIndexOf("/")) || "" : copy.kind === "doc" ? "/FiPen" : "/FiGrid";
  const base = clean(copy.title || "Untitled") || "Untitled";
  return { path: `${dir}/${base} (copy from ${clean(copy.from) || "participant"})${ext}`, mode: "side" };
}
