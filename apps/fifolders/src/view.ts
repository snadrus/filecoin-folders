import type { HistoryEntry, Stat } from "fil-folders";
import { felanumioSvg, felarumiSvg, logoSvg } from "./icons.js";
import { datasetLabel, type WalletPanel } from "./onboarding-logic.js";
import {
  type FelKind,
  type NavId,
  type PreviewKind,
  type SortKey,
  type ViewMode,
  escapeHtml,
  felKind,
  formatBytes,
  formatWhen,
  materialIcon,
  meterPercent,
  shortAddress,
} from "./model.js";

export interface UploadRow {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
}

export interface ToastRow {
  id: string;
  text: string;
}

export interface PreviewState {
  name: string;
  kind: PreviewKind;
  url?: string;
  text?: string;
}

export interface DialogState {
  title: string;
  submit: string;
  value: string;
  testid: string;
  folders?: { path: string; label: string }[];
  dest?: string;
}

export interface ContextState {
  x: number;
  y: number;
  trash: boolean;
  directory: boolean;
  starred: boolean;
}

export interface ViewModel {
  connected: boolean;
  chain: "calibration" | "mainnet";
  mainnetBlocked: boolean;
  volumeName: string;
  encrypt: boolean;
  encrypted: boolean;
  owner: string;
  nav: NavId;
  cwdLabel: string;
  crumbs: { label: string; path: string }[];
  query: string;
  view: ViewMode;
  sortKey: SortKey;
  sortDir: 1 | -1;
  entries: Stat[];
  selected: string[];
  stars: Set<string>;
  storageUsed: number;
  busy: boolean;
  newMenu: boolean;
  accountMenu: boolean;
  context: ContextState | null;
  dialog: DialogState | null;
  details: { stat: Stat; history: HistoryEntry[]; version: bigint; pieceCid: string } | null;
  preview: PreviewState | null;
  uploads: UploadRow[];
  toasts: ToastRow[];
  dropPath: string | null;
  dragging: boolean;
  felarumiUrl: string;
  felanumioUrl: string;
  connectError: string;
  wallets: { rdns: string; name: string }[];
  walletRdns: string;
  panel: WalletPanel | null;
  setupError: string;
}

export function renderApp(model: ViewModel): string {
  if (!model.connected) return model.panel ? renderSetup(model) : renderConnect(model);
  return `<div class="shell ${model.busy ? "is-busy" : ""}">
    ${renderTop(model)}
    ${renderNav(model)}
    <main class="workspace">
      ${renderBrowser(model)}
      ${model.details ? renderDetails(model.details) : ""}
    </main>
    ${model.newMenu ? renderNewMenu() : ""}
    ${model.accountMenu ? renderAccount(model) : ""}
    ${model.context ? renderContext(model.context) : ""}
    ${model.dialog ? renderDialog(model.dialog) : ""}
    ${model.preview ? renderPreview(model.preview) : ""}
    ${renderToasts(model.toasts)}
    ${renderUploads(model.uploads)}
  </div>`;
}

function renderConnect(model: ViewModel): string {
  return `<div class="connect">
    <form class="connect-card" data-testid="connect">
      ${logoSvg(56)}
      <h1>FiFolders</h1>
      <p class="lede">A folder volume on Filecoin. Files live in pieces. The registry head is the current snapshot.</p>
      <div class="chain-toggle" role="group" aria-label="Network">
        ${chainButton("calibration", "Calibration", model.chain)}
        ${chainButton("mainnet", "Mainnet", model.chain)}
      </div>
      <label class="field">Volume name
        <input data-testid="volume-name" name="volume" value="${escapeHtml(model.volumeName)}" autocomplete="off" />
      </label>
      ${walletPicker(model)}
      <label class="check"><input data-testid="encrypt" name="encrypt" type="checkbox" ${model.encrypt ? "checked" : ""}/> Encrypt this volume</label>
      <button class="primary" data-testid="connect-wallet" type="submit">Connect wallet</button>
      <p class="note" data-testid="mainnet-note" ${model.chain === "mainnet" ? "" : "hidden"}>Mainnet has no FolderRegistry yet. Calibration is the network with a deployed registry.</p>
      ${model.connectError ? `<p class="error" data-testid="connect-error">${escapeHtml(model.connectError)}</p>` : ""}
    </form>
  </div>`;
}

function walletPicker(model: ViewModel): string {
  if (model.wallets.length < 2) return "";
  const options = model.wallets
    .map(
      (wallet) =>
        `<option value="${escapeHtml(wallet.rdns)}" ${wallet.rdns === model.walletRdns ? "selected" : ""}>${escapeHtml(wallet.name)}</option>`,
    )
    .join("");
  return `<label class="field">Wallet
    <select name="wallet" data-testid="wallet-pick">${options}</select>
  </label>`;
}

function renderSetup(model: ViewModel): string {
  const panel = model.panel;
  if (!panel) return "";
  const payment = panel.paymentsReady
    ? `<p class="status ok" data-testid="payment-status">Storage payment ready</p>`
    : `<button class="primary" type="button" data-testid="fix-payments" data-action="fix-payments">Enable storage payment</button>
       <p class="note">One step deposits 5 USDFC and approves the storage operator.</p>`;
  const session = panel.sessionReady
    ? `<p class="status ok" data-testid="session-status">Session key ready${panel.sessionExpiry ? ` until ${escapeHtml(panel.sessionExpiry)}` : ""}</p>
       <button type="button" data-testid="session-refresh" data-action="refresh-session">Refresh session key</button>`
    : `<button class="primary" type="button" data-testid="authorize-session" data-action="authorize">Authorize session key</button>
       <p class="note">One wallet confirmation. Uploads and registry commits then stay in the browser.</p>`;
  const datasets = panel.datasets
    .map(
      (dataset) =>
        `<label class="dataset"><input type="radio" name="dataset" data-testid="dataset-choice" value="${escapeHtml(dataset.id)}" ${dataset.id === panel.selectedDatasetId ? "checked" : ""}/> <span>${escapeHtml(datasetLabel(dataset))}</span></label>`,
    )
    .join("");
  const create = `<button class="${panel.createPrimary ? "primary" : ""}" type="button" data-testid="create-dataset" data-action="create-dataset">Create new dataset</button>`;
  const open =
    panel.selectedDatasetId && panel.paymentsReady && (panel.sessionReady || panel.legacyRegistry)
      ? `<button class="primary" type="button" data-testid="open-drive" data-action="open-drive">Open drive</button>`
      : "";
  const legacy = panel.legacyRegistry
    ? `<p class="note" data-testid="legacy-registry">This FolderRegistry has no session-key entry. Commits still ask the wallet until you deploy the new contract and set VITE_FOLDER_REGISTRY.</p>`
    : "";
  return `<div class="connect">
    <div class="connect-card setup-card" data-testid="setup">
      ${logoSvg(56)}
      <h1>FiFolders</h1>
      <p class="account-line" data-testid="setup-address">${escapeHtml(panel.address)}</p>
      <p class="balances" data-testid="balances"><span>${escapeHtml(panel.fil)} FIL</span><span>${escapeHtml(panel.usdfc)} USDFC</span></p>
      ${legacy}
      ${payment}
      ${session}
      <div class="datasets" data-testid="datasets">
        <p class="note">Dataset for this wallet. Every volume stores its pieces here.</p>
        ${datasets || `<p class="note">No datasets yet.</p>`}
        ${create}
      </div>
      ${open}
      <p class="note" data-testid="wallet-signatures">Wallet signatures ${panel.signatures}. Connect prompts ${panel.connectPrompts}.</p>
      ${model.setupError ? `<p class="error" data-testid="setup-error">${escapeHtml(model.setupError)}</p>` : ""}
    </div>
  </div>`;
}

function chainButton(chain: "calibration" | "mainnet", label: string, current: string): string {
  const pressed = chain === current ? "true" : "false";
  return `<button type="button" class="chip ${chain === current ? "on" : ""}" data-action="chain" data-chain="${chain}" data-testid="chain-${chain}" aria-pressed="${pressed}">${label}</button>`;
}

function renderTop(model: ViewModel): string {
  return `<header class="topbar">
    <div class="brand">${logoSvg(28)} <span>FiFolders</span></div>
    <label class="search">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
      <input data-testid="search" type="search" placeholder="Search in FiFolders" value="${escapeHtml(model.query)}" />
    </label>
    <div class="chain-toggle compact" role="group" aria-label="Network">
      ${chainButton("calibration", "Calibration", model.chain)}
      ${chainButton("mainnet", "Mainnet", model.chain)}
    </div>
    <button class="account" data-action="account" data-testid="account" type="button">${escapeHtml(shortAddress(model.owner))}</button>
    <span class="sr-only" data-testid="wallet-signatures">${model.panel?.signatures ?? 0}</span>
    ${model.busy ? `<div class="busy" data-testid="busy"></div>` : ""}
  </header>`;
}

function renderNav(model: ViewModel): string {
  const percent = meterPercent(model.storageUsed);
  return `<aside class="nav">
    <button class="new" data-testid="new-button" data-action="new-toggle" type="button" ${model.mainnetBlocked ? "disabled" : ""}>
      <span class="material-symbols-outlined" aria-hidden="true">add</span> New
    </button>
    <nav class="places">
      ${navItem("drive", "folder", "My Drive", model.nav)}
      ${navItem("recent", "schedule", "Recent", model.nav)}
      ${navItem("starred", "star", "Starred", model.nav)}
      ${navItem("trash", "delete", "Trash", model.nav)}
    </nav>
    <div class="storage" data-testid="storage-meter">
      <div class="meter"><span style="width:${percent.toFixed(2)}%"></span></div>
      <span data-testid="storage-label">${escapeHtml(formatBytes(model.storageUsed))} used</span>
    </div>
    <input data-testid="file-input" class="sr-only" type="file" multiple />
    <input data-testid="folder-input" class="sr-only" type="file" multiple webkitdirectory />
  </aside>`;
}

function navItem(id: NavId, icon: string, label: string, current: NavId): string {
  return `<button type="button" class="place ${id === current ? "on" : ""}" data-testid="nav-${id}" data-action="nav" data-nav="${id}">
    <span class="material-symbols-outlined" aria-hidden="true">${icon}</span> ${label}
  </button>`;
}

function renderNewMenu(): string {
  return `<div class="menu anchored" data-menu="new" data-testid="new-menu">
    <button type="button" data-action="new-folder"><span class="material-symbols-outlined" aria-hidden="true">create_new_folder</span> New folder</button>
    <button type="button" data-action="upload-file"><span class="material-symbols-outlined" aria-hidden="true">upload_file</span> File upload</button>
    <button type="button" data-action="upload-folder"><span class="material-symbols-outlined" aria-hidden="true">drive_folder_upload</span> Folder upload</button>
    <button type="button" data-action="new-felarumi">${felarumiSvg()} Felarumi document</button>
    <button type="button" data-action="new-felanumio">${felanumioSvg()} Felanumio spreadsheet</button>
  </div>`;
}

function renderBrowser(model: ViewModel): string {
  const crumbs = model.crumbs
    .map(
      (crumb, index) =>
        `${index ? `<span class="crumb-sep">/</span>` : ""}<button type="button" data-testid="breadcrumb" data-action="crumb" data-path="${encodeURIComponent(crumb.path)}">${escapeHtml(crumb.label)}</button>`,
    )
    .join("");
  const rows = model.entries
    .map((entry) => renderEntry(entry, model))
    .join("");
  const empty = model.entries.length
    ? ""
    : `<p class="empty" data-testid="empty">${escapeHtml(emptyCopy(model))}</p>`;
  const blocked = model.mainnetBlocked
    ? `<p class="banner" data-testid="mainnet-banner">Mainnet has no FolderRegistry yet. Switch back to Calibration to keep working in this volume.</p>`
    : "";
  return `<section class="browser ${model.dragging ? "dragover" : ""}" data-testid="browser" data-view="${model.view}">
    <div class="toolbar">
      <nav class="crumbs" data-testid="breadcrumbs">${crumbs}</nav>
      <div class="tools">
        <label class="sort-label">Sort
          <select data-testid="sort-select" data-action="sort-select">
            ${sortOption("name", "Name", model.sortKey)}
            ${sortOption("owner", "Owner", model.sortKey)}
            ${sortOption("mtime", "Last modified", model.sortKey)}
            ${sortOption("size", "File size", model.sortKey)}
          </select>
        </label>
        <button type="button" data-testid="view-list" data-action="view-list" aria-pressed="${model.view === "list"}" title="List"><span class="material-symbols-outlined">view_list</span></button>
        <button type="button" data-testid="view-grid" data-action="view-grid" aria-pressed="${model.view === "grid"}" title="Grid"><span class="material-symbols-outlined">grid_view</span></button>
      </div>
    </div>
    ${blocked}
    ${
      model.view === "list"
        ? `<div class="list" role="table">
            <div class="row head" role="row">
              ${sortHead("name", "Name", model)}
              ${sortHead("owner", "Owner", model)}
              ${sortHead("mtime", "Last modified", model)}
              ${sortHead("size", "File size", model)}
            </div>
            ${rows}
          </div>`
        : `<div class="grid">${rows}</div>`
    }
    ${empty}
  </section>`;
}

function sortOption(key: SortKey, label: string, current: SortKey): string {
  return `<option value="${key}" ${key === current ? "selected" : ""}>${label}</option>`;
}

function sortHead(key: SortKey, label: string, model: ViewModel): string {
  const arrow =
    model.sortKey === key
      ? `<span class="material-symbols-outlined sort-arrow" aria-hidden="true">${model.sortDir < 0 ? "arrow_downward" : "arrow_upward"}</span>`
      : "";
  return `<button type="button" class="cell head-cell" role="columnheader" data-testid="sort-${key}" data-action="sort" data-sort="${key}" aria-sort="${model.sortKey === key ? (model.sortDir < 0 ? "descending" : "ascending") : "none"}">${label}${arrow}</button>`;
}

function renderEntry(entry: Stat, model: ViewModel): string {
  const selected = model.selected.includes(entry.path);
  const kind = felKind(entry.name) ?? "";
  const drop = model.dropPath === entry.path ? "true" : "false";
  const icon = entryIcon(entry, kind as FelKind | "");
  const star = model.stars.has(entry.path) ? `<span class="material-symbols-outlined filled star" aria-label="Starred">star</span>` : "";
  const name = `${icon}<span class="name">${escapeHtml(entry.name)}</span>${star}`;
  const body =
    model.view === "grid"
      ? name
      : `<span class="cell name-cell">${name}</span><span class="cell owner">${escapeHtml(shortAddress(model.owner))}</span><span class="cell mtime">${escapeHtml(formatWhen(entry.mtime))}</span><span class="cell size">${entry.type === "dir" ? "—" : escapeHtml(formatBytes(entry.size))}</span>`;
  return `<div class="entry ${model.view}" role="row" data-testid="entry" data-path="${encodeURIComponent(entry.path)}" data-type="${entry.type}" data-kind="${kind}" data-selected="${selected ? "true" : "false"}" data-drop="${drop}" draggable="true">${body}</div>`;
}

function entryIcon(entry: Stat, kind: FelKind | ""): string {
  if (kind === "felarumi") return felarumiSvg();
  if (kind === "felanumio") return felanumioSvg();
  return `<span class="material-symbols-outlined file-icon" aria-hidden="true">${materialIcon(entry)}</span>`;
}

function emptyCopy(model: ViewModel): string {
  if (model.query.trim()) return "No matching files";
  if (model.nav === "trash") return "Trash is empty";
  if (model.nav === "starred") return "No starred items";
  if (model.nav === "recent") return "Nothing recent";
  return "This folder is empty";
}

function renderContext(context: ContextState): string {
  const item = (action: string, icon: string, label: string, disabled = false) =>
    `<button type="button" data-action="${action}" ${disabled ? "disabled" : ""}><span class="material-symbols-outlined" aria-hidden="true">${icon}</span> ${label}</button>`;
  const trashItems = context.trash
    ? `${item("restore", "restore_from_trash", "Restore")}${item("delete-forever", "delete_forever", "Delete forever")}`
    : `${item("trash", "delete", "Move to trash")}`;
  return `<div class="menu floating" data-menu="context" data-testid="context-menu" style="left:${context.x}px;top:${context.y}px">
    ${item("open", "open_in_new", "Open")}
    ${item("download", "download", "Download", context.directory)}
    ${item("rename", "edit", "Rename")}
    ${item("move", "drive_file_move", "Move to")}
    ${item("copy", "content_copy", "Make a copy")}
    ${item("star", "star", context.starred ? "Unstar" : "Star")}
    ${trashItems}
    ${item("details", "info", "Details")}
  </div>`;
}

function renderDetails(details: ViewModel["details"] & object): string {
  const history = [...details.history].reverse();
  const rows = history.length
    ? history
        .map(
          (entry) =>
            `<li><span>v${entry.version.toString()}</span> ${escapeHtml(entry.change ?? "commit")} <time>${escapeHtml(formatWhen(entry.timestamp * (entry.timestamp < 10_000_000_000 ? 1000 : 1)))}</time></li>`,
        )
        .join("")
    : `<li>No commits for this item yet</li>`;
  return `<aside class="details" data-testid="details">
    <header><h2>${escapeHtml(details.stat.name)}</h2><button type="button" data-action="close-details" aria-label="Close details"><span class="material-symbols-outlined">close</span></button></header>
    <p class="meta">${details.stat.type === "dir" ? "Folder" : escapeHtml(details.stat.mime || "File")} · ${details.stat.type === "dir" ? "—" : escapeHtml(formatBytes(details.stat.size))}</p>
    <label>Piece CID</label>
    <div class="cid-row">
      <code data-testid="piece-cid">${escapeHtml(details.pieceCid || "—")}</code>
      <button type="button" data-testid="copy-cid" data-action="copy-cid" ${details.pieceCid ? "" : "disabled"}>Copy</button>
    </div>
    <label>Version</label>
    <p data-testid="volume-version">${details.version.toString()}</p>
    <label>History</label>
    <ul class="history" data-testid="history">${rows}</ul>
  </aside>`;
}

function renderDialog(dialog: DialogState): string {
  const folders = dialog.folders
    ? `<label class="field">Folder
        <select data-testid="move-dest" name="dest">${dialog.folders
          .map(
            (folder) =>
              `<option value="${encodeURIComponent(folder.path)}" ${folder.path === dialog.dest ? "selected" : ""}>${escapeHtml(folder.label)}</option>`,
          )
          .join("")}</select>
      </label>`
    : `<label class="field">Name
        <input data-testid="dialog-input" name="name" value="${escapeHtml(dialog.value)}" autocomplete="off" />
      </label>`;
  return `<div class="backdrop" data-testid="dialog">
    <form class="dialog" role="dialog" aria-label="${escapeHtml(dialog.title)}">
      <h2>${escapeHtml(dialog.title)}</h2>
      ${folders}
      <div class="dialog-actions">
        <button type="button" data-action="close-dialog">Cancel</button>
        <button class="primary" type="submit" data-testid="${dialog.testid}">${escapeHtml(dialog.submit)}</button>
      </div>
    </form>
  </div>`;
}

function renderPreview(preview: PreviewState): string {
  let body = `<p>No preview for this file.</p>`;
  if (preview.kind === "image" && preview.url) body = `<img alt="${escapeHtml(preview.name)}" src="${preview.url}" />`;
  else if (preview.kind === "pdf" && preview.url) body = `<iframe title="${escapeHtml(preview.name)}" src="${preview.url}"></iframe>`;
  else if (preview.kind === "video" && preview.url) body = `<video controls src="${preview.url}"></video>`;
  else if (preview.kind === "text") body = `<pre data-testid="preview-text">${escapeHtml(preview.text ?? "")}</pre>`;
  return `<div class="backdrop" data-testid="preview">
    <div class="preview" role="dialog" aria-label="${escapeHtml(preview.name)}">
      <header><h2>${escapeHtml(preview.name)}</h2><button type="button" data-action="close-preview" aria-label="Close preview"><span class="material-symbols-outlined">close</span></button></header>
      <div class="preview-body">${body}</div>
    </div>
  </div>`;
}

function renderAccount(model: ViewModel): string {
  const panel = model.panel;
  const datasets = panel
    ? `<label class="field">Dataset
        <select data-testid="dataset-select">${panel.datasets
          .map(
            (dataset) =>
              `<option value="${escapeHtml(dataset.id)}" ${dataset.id === panel.selectedDatasetId ? "selected" : ""}>${escapeHtml(datasetLabel(dataset))}</option>`,
          )
          .join("")}</select>
      </label>
      <button type="button" data-action="create-dataset" data-testid="create-dataset">Create new dataset</button>
      <p class="account-line" data-testid="session-status">${panel.sessionReady ? `Session key until ${escapeHtml(panel.sessionExpiry || "soon")}` : "Session key missing"}</p>
      <p class="account-line">${escapeHtml(panel.fil)} FIL · ${escapeHtml(panel.usdfc)} USDFC${panel.paymentsReady ? "" : " · payment needed"}</p>
      <button type="button" data-action="refresh-session" data-testid="session-refresh">Refresh session key</button>`
    : "";
  return `<div class="menu account-menu" data-menu="account" data-testid="account-menu">
    <p class="account-line">${escapeHtml(model.owner)}</p>
    <p class="account-line">Volume ${escapeHtml(model.volumeName)} · encryption ${model.encrypted ? "on" : "off"}</p>
    ${datasets}
    <label class="field">Felarumi URL
      <input data-testid="felarumi-url" value="${escapeHtml(model.felarumiUrl)}" />
    </label>
    <label class="field">Felanumio URL
      <input data-testid="felanumio-url" value="${escapeHtml(model.felanumioUrl)}" />
    </label>
    <button type="button" data-action="disconnect" data-testid="disconnect">Disconnect</button>
  </div>`;
}

function renderToasts(toasts: ToastRow[]): string {
  if (!toasts.length) return "";
  return `<div class="toasts" data-testid="toasts" aria-live="polite">${toasts
    .map((toast) => `<div class="toast" data-testid="toast">${escapeHtml(toast.text)}<button type="button" data-action="dismiss-toast" data-id="${toast.id}" aria-label="Dismiss">×</button></div>`)
    .join("")}</div>`;
}

function renderUploads(uploads: UploadRow[]): string {
  if (!uploads.length) return "";
  const active = uploads.some((item) => item.status === "uploading");
  const title = active ? `Uploading ${uploads.filter((item) => item.status === "uploading").length}` : "Uploads";
  return `<section class="uploads" data-testid="upload-panel">
    <header>${title}<button type="button" data-action="dismiss-uploads" aria-label="Close uploads">×</button></header>
    ${uploads
      .map(
        (item) => `<div class="upload-row" data-status="${item.status}">
          <span>${escapeHtml(item.name)}</span>
          <progress value="${item.progress}" max="100"></progress>
        </div>`,
      )
      .join("")}
  </section>`;
}
