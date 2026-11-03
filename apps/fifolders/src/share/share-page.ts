/** FiFolders share page for guests: file name, who shared it (FiPerson), Open and Download with the real name. */
import { gatewayPreviewLink } from "../links.js";

export interface ShareParams {
  cid: string;
  name: string;
  size: number | null;
  owner: string;
  chain: "calibration" | "mainnet";
  /** Imported CARs: the provider piece URL that keeps every original byte. */
  direct: string;
}

const CID = /^[a-z0-9]{20,120}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseShare(search: string): ShareParams | null {
  const q = new URLSearchParams(search);
  const cid = q.get("cid") ?? "";
  let direct = q.get("src") ?? "";
  try {
    if (direct && !/^https?:$/.test(new URL(direct).protocol)) direct = "";
  } catch {
    direct = "";
  }
  if (!CID.test(cid) && !direct) return null;
  const owner = q.get("by") ?? "";
  const size = Number(q.get("size"));
  return {
    cid: CID.test(cid) ? cid : "",
    name: (q.get("name") ?? "").slice(0, 255) || "Shared file",
    size: Number.isFinite(size) && size > 0 ? size : null,
    owner: ADDRESS.test(owner) ? owner : "",
    chain: q.get("chain") === "mainnet" ? "mainnet" : "calibration",
    direct,
  };
}

/** Link the drive hands out: points at this page, not a raw storage URL. */
export function sharePageUrl(base: string, file: { name: string; cid?: string; size?: number; owner?: string; chain?: string; direct?: string }): string {
  let url: URL;
  try {
    url = new URL("share/", base);
    if (!/^https?:$/.test(url.protocol)) throw new Error("not http");
  } catch {
    url = new URL("https://fifolders.scionbase.ai/share/");
  }
  if (file.cid) url.searchParams.set("cid", file.cid);
  if (file.direct) url.searchParams.set("src", file.direct);
  url.searchParams.set("name", file.name);
  if (file.size) url.searchParams.set("size", String(file.size));
  if (file.owner) url.searchParams.set("by", file.owner);
  if (file.chain === "mainnet") url.searchParams.set("chain", "mainnet");
  return url.href;
}

export function fileUrl(p: ShareParams): string {
  return p.direct || gatewayPreviewLink(p.cid, p.name);
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} bytes` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function sharePageHtml(p: ShareParams | null, owner: { name: string; avatar: string; hasIdentity: boolean } | null): string {
  if (!p) return `<section class="card"><p data-testid="share-missing">This share link is incomplete. Ask the sender for a new link.</p></section>`;
  const size = formatSize(p.size);
  const by = p.owner
    ? `<a class="preview" data-testid="share-owner" href="../person/?id=${esc(p.owner.toLowerCase())}">${owner?.avatar ?? ""}<span><small>Shared by</small><strong data-testid="share-owner-name">${esc(owner?.name || `${p.owner.slice(0, 6)}…${p.owner.slice(-4)}`)}</strong></span></a>`
    : "";
  return `<section class="card" data-testid="share-page">
    <h2 data-testid="share-name" style="margin:0;word-break:break-word">${esc(p.name)}</h2>
    ${size ? `<p class="note" data-testid="share-size" style="margin:0">${esc(size)}</p>` : ""}
    ${by}
    <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="primary button" data-testid="share-open" href="${esc(fileUrl(p))}" target="_blank" rel="noopener">Open</a>
      <button type="button" class="button" data-testid="share-download">Download</button>
    </div>
    <p class="note" data-testid="share-status" role="status"></p>
    <p class="note" style="margin:0">Stored on Filecoin${p.chain === "calibration" ? " (Calibration test network)" : ""} with <a href="../">FiFolders</a>. Anyone with this link can open the file.</p>
  </section>`;
}
