/**
 * Guest view of a private share link (`/share/#v=pf1&…`). The key, the throwaway signer and the delivery are
 * in the URL fragment, which the browser never sends to any server. The page fetches the encrypted piece from
 * the storage provider's gated `/download/` with a signed request, decrypts it here, and offers Open/Download.
 */
import { openFileShare, parseShareFragment, type FileShare } from "fil-folders/private";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function size(bytes?: number): string {
  if (!bytes) return "";
  const units = ["bytes", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} bytes` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export async function mountPrivateShare(root: HTMLElement, hash = location.hash, fetchImpl?: typeof fetch): Promise<void> {
  const share = parseShareFragment(hash);
  if (!share || share.kind !== "file") {
    root.innerHTML = `<div class="wrap"><header><h1>Shared file</h1></header><section class="card"><p data-testid="share-missing">This private link is incomplete. Ask the sender for a new link.</p></section></div>`;
    return;
  }
  document.title = `${share.name} · TreFolders`;
  root.innerHTML = `<div class="wrap"><header><h1>Shared file</h1></header><section class="card" data-testid="private-share">
    <p class="name" data-testid="share-name">🔒 ${esc(share.name)}</p>
    <p class="note">${esc(size(share.size))}${share.size ? " · " : ""}Private file. It is decrypted in this browser; the key in this link never leaves it.</p>
    <p class="note">Shared by <code>${esc(share.owner)}</code></p>
    <p data-testid="share-status" role="status">Fetching and decrypting…</p>
    <div class="actions"></div>
  </section></div>`;
  const status = root.querySelector<HTMLElement>("[data-testid=share-status]")!;
  const actions = root.querySelector<HTMLElement>(".actions")!;
  try {
    const bytes = await openFileShare(share as FileShare, fetchImpl ? { fetchImpl } : {});
    const blob = new Blob([bytes as BlobPart], { type: share.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    status.textContent = "Ready.";
    actions.innerHTML = `<a class="button primary" data-testid="share-open" href="${url}" target="_blank" rel="noreferrer">Open</a>
      <a class="button" data-testid="share-download" href="${url}" download="${esc(share.name)}">Download</a>`;
    if (share.mime?.startsWith("text/") && bytes.byteLength < 200_000) {
      const pre = document.createElement("pre");
      pre.dataset.testid = "share-preview";
      pre.textContent = new TextDecoder().decode(bytes);
      actions.after(pre);
    }
  } catch (error) {
    status.dataset.testid = "share-error";
    status.textContent = error instanceof Error ? error.message : "This private file could not be opened.";
  }
}
