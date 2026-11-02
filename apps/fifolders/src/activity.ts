/** Completed activity rows show a 10 s progress bar, then go away; dismissals survive refresh. */
export const ACTIVITY_DISMISS_MS = 10_000;
const KEY = "fifolders:activity-dismissed";

export function loadDismissed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function dismissActivity(id: string): void {
  const next = [...loadDismissed()].filter((item) => item !== id);
  next.push(id);
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(-300)));
  } catch {
    // Storage full or blocked: the row still leaves this session.
  }
}
