/** /share/?cid=…&name=…&by=…: friendly guest page for a shared file. */
import "../stale-chunks.js";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "../identity/identity.css";
import { avatarHtml, cachedIdentity } from "fiperson/view";
import { details } from "fiperson/people";
import { fileUrl, parseShare, sharePageHtml } from "./share-page.js";

const root = document.querySelector<HTMLElement>("#share-app")!;
const params = parseShare(location.search);

function ownerInfo() {
  if (!params?.owner) return null;
  const d = details(params.owner.toLowerCase());
  return { name: d?.name ?? "", avatar: avatarHtml(cachedIdentity(params.owner.toLowerCase()), 40), hasIdentity: Boolean(d?.hasIdentity) };
}

function paint(): void {
  root.innerHTML = `<div class="wrap"><header><h1>Shared file</h1></header>${sharePageHtml(params, ownerInfo())}</div>`;
  if (params) document.title = `${params.name} · FiFolders`;
  root.querySelector<HTMLButtonElement>("[data-testid=share-download]")?.addEventListener("click", () => void download());
}

async function download(): Promise<void> {
  if (!params) return;
  const status = root.querySelector<HTMLElement>("[data-testid=share-status]");
  if (status) status.textContent = "Downloading…";
  try {
    const res = await fetch(fileUrl(params));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = params.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    if (status) status.textContent = `Downloaded ${params.name}.`;
  } catch {
    // Gateway blocked the fetch (CORS/offline): fall back to the gateway's own download with the real name.
    const url = new URL(fileUrl(params));
    if (!params.direct) url.searchParams.set("download", "true");
    location.href = url.href;
    if (status) status.textContent = "Opening the download…";
  }
}

paint();
if (params?.owner && import.meta.env.VITE_E2E !== "1") {
  void import("../person.js")
    .then(({ resolvePerson }) => resolvePerson(params.owner, params.chain))
    .then(() => paint())
    .catch(() => undefined);
}
