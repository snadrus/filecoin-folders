/** Public / Private (read-restricted) data sets: detection from metadata, a small cache, and the badge. */
import "./private.css";
import { datasetVisibility } from "fil-folders/private";

export type Visibility = "public" | "private" | "encrypted";

const KEY = (chainId: number, id: string) => `fifolders:visibility:${chainId}:${id}`;

export function visibilityOf(metadata: Record<string, string> | undefined): Visibility {
  return datasetVisibility(metadata ?? {});
}

export function rememberVisibility(chainId: number, id: string, visibility: Visibility): void {
  try {
    localStorage.setItem(KEY(chainId, id), visibility);
  } catch {
    /* storage blocked */
  }
}

export function knownVisibility(chainId: number, id: string): Visibility | null {
  try {
    const v = localStorage.getItem(KEY(chainId, id));
    return v === "private" || v === "public" || v === "encrypted" ? v : null;
  } catch {
    return null;
  }
}

/** Badge for dataset rows and settings. "encrypted" data sets are still publicly readable, so they show Public. */
export function visibilityBadge(visibility: Visibility | undefined): string {
  if (!visibility) return "";
  const priv = visibility === "private";
  const title = priv
    ? "Private: the storage provider only serves these pieces to people you share a key or link with"
    : "Public: anyone with a piece or file CID can download it";
  return `<span class="badge visibility-badge ${priv ? "is-private" : "is-public"}" data-testid="dataset-visibility" data-visibility="${priv ? "private" : "public"}" title="${title}"><span class="material-symbols-outlined" aria-hidden="true">${priv ? "lock" : "public"}</span> ${priv ? "Private" : "Public"}</span>`;
}
