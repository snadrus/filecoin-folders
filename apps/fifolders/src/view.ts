import { avatarHtml, cachedIdentity } from "fiperson/view";
import type { HistoryEntry, Stat } from "fil-folders";
import type { ChainStepView } from "./chain-step.js";
import { felanumioSvg, felarumiSvg, logoSvg } from "./icons.js";
import { identiconSvg } from "./identicon.js";
import { datasetLabel, latestDatasetId, type SessionGate, type WalletPanel } from "./onboarding-logic.js";
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
  shortAddress,
} from "./model.js";
import { DOCS_COSTS_URL, type Runway } from "./pricing.js";

export interface UploadRow {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
}

export interface ToastRow {
  id: string;
  text: string;
  action?: string;
  actionLabel?: string;
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

export interface ActivityRow {
  id: string;
  label: string;
  status: "pending" | "done" | "error";
  /** Done rows: ms already elapsed of the 10 s auto-dismiss. */
  elapsedMs?: number;
}

export interface LooseRow {
  pieceCid: string;
  name: string;
  size: number;
  uploaded: number;
  mime: string;
}

export interface CostView {
  perTiB: string;
  fourGiB: string;
  proving: string;
  reserve: string;
  cdnReserve: string;
  createFee: string;
  addPieces: string;
  datasetNote: string;
  depositNote: string;
}

export interface ViewModel {
  connected: boolean;
  costsOpen: boolean;
  costs: CostView;
  chainSteps: ChainStepView[];
  activity: ActivityRow[];
  activityPending: boolean;
  runway: Runway;
  loose: LooseRow[];
  /** "N pieces: X in folders, Y manifests, Z loose" so the dataset count reconciles. */
  looseSummary: string;
  txlogOpen: boolean;
  badges: Record<string, string>;
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
  newMenu: boolean;
  accountMenu: boolean;
  context: ContextState | null;
  dialog: DialogState | null;
  details: {
    stat: Stat;
    history: HistoryEntry[];
    version: bigint;
    pieceCid: string;
    shareUrl?: string;
    qr?: string;
    copies: number;
    providers: string[];
    indexing?: string;
    previewable: boolean;
  } | null;
  downloads: {
    active: { id: string; name: string; stage: string } | null;
    pending: { id: string; name: string }[];
    error: string | null;
    finished: string[];
  };
  preview: PreviewState | null;
  uploads: UploadRow[];
  toasts: ToastRow[];
  walletPrompts: WalletPromptView[];
  /** Shown while the drive is browsable but wallet setup still runs. */
  setupNote: string;
  loadState?: "idle" | "loading" | "ok" | "error";
  loadError?: string;
  setupStep: { action: string; label: string } | null;
  dropPath: string | null;
  dragging: boolean;
  felarumiUrl: string;
  felanumioUrl: string;
  connectError: string;
  wallets: { rdns: string; name: string }[];
  walletRdns: string;
  panel: WalletPanel | null;
  setupError: string;
  stagedCount: number;
  restoreNote: string;
  autoSaveUploads: boolean;
  /** Non-blocking session renewal. `expired` waits for Renew before the action retries. */
  sessionPrompt: Exclude<SessionGate, "ok"> | null;
}

export function renderApp(model: ViewModel): string {
  return renderScreen(model) + renderWalletPrompts(model.walletPrompts);
}

/** Wallet-waiting toasts on every screen, so a hidden MetaMask pop-up is never a mystery. */
function renderWalletPrompts(prompts: WalletPromptView[]): string {
  if (!prompts.length) return "";
  return `<div class="wallet-prompts" data-testid="wallet-prompts" aria-live="assertive">${prompts
    .map((prompt) =>
      prompt.state === "waiting"
        ? `<div class="toast wallet-toast" data-testid="wallet-prompt" data-state="waiting"><span class="spinner" aria-hidden="true"></span><span>Check your wallet — <strong data-testid="wallet-prompt-title">${escapeHtml(prompt.title)}</strong>${prompt.detail ? `<small data-testid="wallet-prompt-detail"> ${escapeHtml(prompt.detail)}</small>` : ""}</span></div>`
        : `<div class="toast wallet-toast" data-testid="wallet-prompt" data-state="rejected">Signature rejected — ${escapeHtml(prompt.title)}
            <button type="button" data-action="wallet-retry" data-id="${prompt.id}" data-testid="wallet-retry">Retry</button>
            <button type="button" data-action="wallet-cancel" data-id="${prompt.id}" data-testid="wallet-cancel" aria-label="Cancel">×</button></div>`,
    )
    .join("")}</div>`;
}

export interface WalletPromptView {
  id: number;
  what: string;
  title: string;
  detail: string;
  state: "waiting" | "rejected";
}

function renderScreen(model: ViewModel): string {
  if (!model.connected) return model.panel ? renderSetupShell(model) : renderConnect(model);
  return `<div class="shell">
    ${renderTop(model)}
    ${renderNav(model)}
    <main class="workspace">
      ${model.setupNote ? `<div class="setup-note" data-testid="setup-note" role="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(model.setupNote)}${
        model.setupStep
          ? ` <button type="button" class="text-button" data-action="account" data-testid="setup-open-wallet">Wallet &amp; setup</button>`
          : ""
      }</div>` : ""}
      ${renderSessionBanner(model)}
      ${renderBrowser(model)}
      ${model.details ? renderDetails(model.details) : ""}
    </main>
    ${model.newMenu ? renderNewMenu() : ""}
    ${model.costsOpen ? renderCosts() : ""}
    ${model.txlogOpen ? renderTxlog(model) : ""}
    ${model.accountMenu ? renderAccount(model) : ""}
    ${model.context ? renderContext(model.context) : ""}
    ${model.dialog ? renderDialog(model.dialog) : ""}
    ${model.preview ? renderPreview(model.preview) : ""}
    ${renderToasts(model.toasts)}
    ${renderUploads(model.uploads)}
    ${renderDownloads(model)}
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
      <p class="note" data-testid="mainnet-note" ${model.mainnetBlocked ? "" : "hidden"}>Registry not deployed</p>
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

/** Connected wallet, drive not open yet: the drive frame with setup as a pop-up only when it needs the user. */
function renderSetupShell(model: ViewModel): string {
  const panel = model.panel;
  if (!panel) return "";
  const picked = panel.datasets.find((dataset) => dataset.id === panel.selectedDatasetId);
  const ready = Boolean(panel.selectedDatasetId && panel.paymentsReady && panel.sessionReady);
  const needsUser = !ready || Boolean(model.setupError);
  return `<div class="shell">
    ${renderTop(model)}
    ${renderNav(model)}
    <main class="workspace">
      ${renderSessionBanner(model)}
      <div class="empty" data-testid="drive-pending">${picked ? `Opening ${escapeHtml(datasetLabel(picked))}…` : "Pick a dataset to open your drive."}</div>
    </main>
    ${needsUser ? `<div class="costs-backdrop setup-backdrop">${renderSetup(model)}</div>` : ""}
    ${model.costsOpen ? renderCosts() : ""}
    ${model.txlogOpen ? renderTxlog(model) : ""}
    ${model.accountMenu ? renderAccount(model) : ""}
    ${renderToasts(model.toasts)}
  </div>`;
}

function renderSetup(model: ViewModel): string {
  const panel = model.panel;
  if (!panel) return "";
  const payment = panel.paymentsReady
    ? `<p class="status ok" data-testid="payment-status">Storage payment ready</p>`
    : `<button class="primary" type="button" data-testid="fix-payments" data-action="fix-payments">Enable storage payment</button>
       <p class="note">${escapeHtml(model.costs.depositNote)}</p>`;
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
  const create = `<button class="${panel.createPrimary ? "primary" : ""}" type="button" data-testid="create-dataset" data-action="create-dataset">Create new dataset</button>
        <p class="note">${escapeHtml(model.costs.datasetNote)}</p>`;
  const open =
    panel.selectedDatasetId && panel.paymentsReady && panel.sessionReady
      ? `<button class="primary" type="button" data-testid="open-drive" data-action="open-drive">Open drive</button>`
      : "";
  const legacy = panel.legacyRegistry
    ? `<p class="note" data-testid="legacy-registry">This FolderRegistry has no session-key entry. Commits still ask the wallet until you deploy the new contract and set VITE_FOLDER_REGISTRY.</p>`
    : "";
  const failed = Boolean(model.setupError);
  return `<div class="costs-modal setup-modal" role="dialog" aria-modal="true">
    <div class="setup-card" data-testid="setup">
      ${logoSvg(56)}
      <h1>FiFolders</h1>
      <p class="account-line" data-testid="setup-address">${escapeHtml(panel.address)}</p>
      <p class="balances" data-testid="balances"><span>${escapeHtml(panel.fil)} FIL</span><span>${escapeHtml(panel.usdfc)} USDFC</span></p>
      ${legacy}
      ${failed ? renderChainSteps(model.chainSteps) : ""}
      ${renderSessionBanner(model)}
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

function renderSessionBanner(model: ViewModel): string {
  if (!model.sessionPrompt) return "";
  const expired = model.sessionPrompt === "expired";
  const text = expired ? "Session expired — Renew (1 signature)" : "Session expires soon — Renew (1 signature)";
  return `<div class="banner session-banner ${expired ? "expired" : "soon"}" data-testid="session-renew" data-prompt="${model.sessionPrompt}" role="status">
    <span>${text}</span>
    <button type="button" data-testid="session-renew-button" data-action="renew-session">Renew</button>
  </div>`;
}

function chainButton(chain: "calibration" | "mainnet", label: string, current: string): string {
  const pressed = chain === current ? "true" : "false";
  return `<button type="button" class="chip ${chain === current ? "on" : ""}" data-action="chain" data-chain="${chain}" data-testid="chain-${chain}" aria-pressed="${pressed}">${label}</button>`;
}

function renderTop(model: ViewModel): string {
  const label = model.panel?.ens || shortAddress(model.owner);
  return `<header class="topbar">
    <div class="brand">${logoSvg(28)} <span>FiFolders</span></div>
    <label class="search">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
      <input data-testid="search" type="search" placeholder="Search in FiFolders" value="${escapeHtml(model.query)}" />
    </label>
    ${model.activityPending ? `<span class="activity-dot" data-testid="activity-indicator" title="Saving"></span>` : ""}
    ${renderStaged(model)}
    <button class="account" data-action="account" data-testid="account" type="button">${identiconSvg(model.owner)}<span data-testid="account-label">${escapeHtml(label)}</span></button>
    ${model.connected ? `<span class="sr-only" data-testid="wallet-signatures">${model.panel?.signatures ?? 0}</span>` : ""}
  </header>`;
}

function renderStaged(model: ViewModel): string {
  if (!model.stagedCount) return "";
  const label = model.stagedCount === 1 ? "Save 1 change" : `Save ${model.stagedCount} changes`;
  return `<div class="staged-changes" data-testid="staged-changes">
    <button class="primary" type="button" data-testid="save-changes" data-action="save-changes">${label}</button>
    <button class="ghost" type="button" data-testid="discard-changes" data-action="discard-changes">Discard</button>
  </div>`;
}

function renderChainSteps(steps: ChainStepView[]): string {
  if (!steps.length) return "";
  return `<ol class="chain-steps" data-testid="chain-steps">${steps
    .map(
      (step) => `<li data-phase="${step.phase}" data-testid="chain-step">
        <span>${escapeHtml(step.title)}</span>
        ${step.detail ? `<span class="note">${escapeHtml(step.detail)}</span>` : ""}
        ${step.href ? `<a data-testid="tx-link" href="${escapeHtml(step.href)}" target="_blank" rel="noreferrer">${escapeHtml(step.id)}</a>` : ""}
      </li>`,
    )
    .join("")}</ol>`;
}

function renderNav(model: ViewModel): string {
  const runway = model.runway;
  const txlog = model.chainSteps.length
    ? `<button type="button" class="place txlog-toggle ${model.txlogOpen ? "on" : ""}" data-action="toggle-txlog" data-testid="txlog-toggle">
        <span class="material-symbols-outlined" aria-hidden="true">receipt_long</span> Transaction log (${model.chainSteps.length})
      </button>`
    : "";
  const activity = model.activity.length
    ? `<section class="activity" data-testid="activity">${model.activity
        .map(
          (item) => `<div class="activity-item" data-testid="activity-item" data-status="${item.status}">
            <span class="activity-mark" aria-hidden="true"></span>
            <span>${escapeHtml(item.label)}</span>
            ${item.status === "error" ? `<button type="button" data-action="retry-activity" data-id="${escapeHtml(item.id)}" data-testid="retry-activity">Retry</button><button type="button" class="activity-dismiss" data-action="dismiss-activity" data-id="${escapeHtml(item.id)}" data-testid="dismiss-activity" aria-label="Dismiss">×</button>` : ""}
            ${item.status === "done" ? `<span class="activity-progress" data-testid="activity-progress" style="animation-delay:-${Math.max(0, Math.round(item.elapsedMs ?? 0))}ms"></span>` : ""}
          </div>`,
        )
        .join("")}</section>`
    : "";
  return `<aside class="nav">
    <button class="new" data-testid="new-button" data-action="new-toggle" type="button" ${model.mainnetBlocked ? "disabled" : ""}>
      <span class="material-symbols-outlined" aria-hidden="true">add</span> New
    </button>
    <nav class="places">
      ${navItem("drive", "folder", "My Drive", model.nav)}
      ${navItem("recent", "schedule", "Recent", model.nav)}
      ${navItem("starred", "star", "Starred", model.nav)}
      ${navItem("loose", "inventory_2", "Loose pieces", model.nav)}
      ${navItem("trash", "delete", "Trash", model.nav)}
    </nav>
    ${txlog}
    ${activity}
    <div class="storage storage-open ${runway.low ? "low" : ""}" data-testid="storage-runway" data-action="show-costs" role="button" tabindex="0" title="What it costs">
      <p class="runway-headline" data-testid="runway-headline">${runwayHtml(runway.headline, runway.datasetLabel)}</p>
      ${runway.detail ? `<p class="runway-detail" data-testid="runway-detail">${runwayHtml(runway.detail, runway.datasetLabel)}</p>` : ""}
      ${runway.showAdd ? `<button type="button" class="primary slim" data-action="add-funds" data-testid="add-funds">Add funds</button>` : ""}
    </div>
    <input data-testid="file-input" class="sr-only" type="file" multiple />
    <input data-testid="folder-input" class="sr-only" type="file" multiple webkitdirectory />
  </aside>`;
}

/** Wallet-menu dataset picker: every dataset the wallet owns, current one checked, newest marked. */
function renderDatasetSection(model: ViewModel): string {
  const panel = model.panel;
  if (!panel || !panel.datasets.length) return "";
  const current = panel.selectedDatasetId;
  const latest = latestDatasetId(panel.datasets);
  const ordered = [...panel.datasets].sort((a, b) => {
    if (Boolean(a.drive) !== Boolean(b.drive)) return a.drive ? -1 : 1;
    const na = /^\d+$/.test(a.id), nb = /^\d+$/.test(b.id);
    if (na && nb) return BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0;
    return na ? 1 : nb ? -1 : 0;
  });
  const items = ordered
    .map((dataset) => {
      const on = dataset.id === current;
      const label = /^\d+$/.test(dataset.id) ? `#${dataset.id}` : "Pending";
      const bits = [`${dataset.pieceCount} pieces`];
      if (dataset.size && dataset.size !== "—") bits.push(dataset.size);
      if (dataset.created && dataset.created !== "—") bits.push(dataset.created);
      return `<button type="button" role="menuitemradio" aria-checked="${on}" class="dataset-item ${on ? "on" : ""} ${dataset.drive ? "is-drive" : "not-drive"}" data-drive="${dataset.drive ? "1" : "0"}" data-action="switch-dataset" data-id="${escapeHtml(dataset.id)}" data-testid="dataset-item">
        <span class="material-symbols-outlined dataset-check" aria-hidden="true">${on ? "check" : ""}</span>
        <span class="dataset-text"><span class="dataset-id">Dataset ${escapeHtml(label)}${dataset.id === latest ? ` <span class="dataset-tag" data-testid="dataset-latest">latest</span>` : ""}</span>
        ${dataset.drive ? `<span class="dataset-drive" data-testid="dataset-drive"><span class="material-symbols-outlined" aria-hidden="true">folder</span> FiFolders drive${dataset.driveName ? ` · ${escapeHtml(dataset.driveName)}` : ""}</span>` : ""}
        <span class="dataset-meta">${escapeHtml(bits.join(" · "))}</span></span>
      </button>`;
    })
    .join("");
  return `<section class="account-section dataset-section" id="wallet-datasets" data-testid="dataset-menu" role="menu" aria-label="Datasets">
    <p class="section-title">Datasets (${panel.datasets.length})</p>
    ${items}
  </section>`;
}

function runwayHtml(text: string, datasetLabel: string): string {
  const phrase = `Dataset total ${datasetLabel}`;
  if (!text.includes(phrase) || datasetLabel === "0 B") return escapeHtml(text);
  const [before, after] = text.split(phrase);
  return `${escapeHtml(before ?? "")}<span data-testid="dataset-total">${escapeHtml(phrase)}</span>${escapeHtml(after ?? "")}`;
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
    <button type="button" data-action="new-felarumi">${felarumiSvg()} FiPen document</button>
    <button type="button" data-action="new-felanumio">${felanumioSvg()} FiGrid spreadsheet</button>
  </div>`;
}

function renderBrowser(model: ViewModel): string {
  const crumbs = model.crumbs
    .map(
      (crumb, index) =>
        `${index ? `<span class="crumb-sep">/</span>` : ""}<button type="button" data-testid="breadcrumb" data-action="crumb" data-path="${encodeURIComponent(crumb.path)}">${escapeHtml(crumb.label)}</button>`,
    )
    .join("");
  const rows = model.nav === "loose" ? model.loose.map((piece) => renderLoose(piece)).join("") : model.entries.map((entry) => renderEntry(entry, model)).join("");
  const filled = model.nav === "loose" ? model.loose.length : model.entries.length;
  const empty =
    model.loadState === "error"
      ? `<div class="empty" data-testid="load-error" role="alert">Could not load your drive from Filecoin. Your files are safe on chain.${model.loadError ? ` <small>${escapeHtml(model.loadError)}</small>` : ""} <button type="button" data-action="retry-load" data-testid="retry-load">Retry</button></div>`
      : model.loadState === "loading" && !filled
        ? `<div class="empty" data-testid="drive-loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading your drive from Filecoin…</div>`
        : filled
          ? ""
          : `<p class="empty" data-testid="empty">${escapeHtml(emptyCopy(model))}</p>`;
  const blocked = model.mainnetBlocked
    ? `<p class="banner" data-testid="mainnet-banner">Registry not deployed</p>`
    : "";
  const restored = model.restoreNote ? `<p class="restore-banner" data-testid="staged-restore">${escapeHtml(model.restoreNote)}</p>` : "";
  return `<section class="browser ${model.dragging ? "dragover" : ""}" data-testid="browser" data-view="${model.view}">
    ${restored}
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
    ${model.nav === "loose" && model.looseSummary && filled ? `<p class="note" data-testid="loose-summary">${escapeHtml(model.looseSummary)}</p>` : ""}
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
  const badge = model.badges[entry.path] ? `<span class="badge" data-testid="save-badge">${escapeHtml(model.badges[entry.path] ?? "")}</span>` : "";
  const name = `${icon}<span class="name">${escapeHtml(entry.name)}</span>${badge}${star}`;
  const body =
    model.view === "grid"
      ? name
      : `<span class="cell name-cell">${name}</span><span class="cell owner">${escapeHtml(shortAddress(model.owner))}</span><span class="cell mtime">${escapeHtml(formatWhen(entry.mtime))}</span><span class="cell size">${entry.type === "dir" ? "—" : escapeHtml(formatBytes(entry.size))}</span>`;
  return `<div class="entry ${model.view}" role="row" data-testid="entry" data-path="${encodeURIComponent(entry.path)}" data-type="${entry.type}" data-kind="${kind}" data-selected="${selected ? "true" : "false"}" data-drop="${drop}" data-saving="${badge ? "true" : "false"}" draggable="true">${body}</div>`;
}

function renderLoose(piece: LooseRow): string {
  const when = piece.uploaded ? formatWhen(piece.uploaded) : "—";
  return `<div class="entry list" role="row" data-testid="loose-row" data-cid="${escapeHtml(piece.pieceCid)}">
    <span class="cell name-cell"><span class="name">${escapeHtml(piece.name)}</span></span>
    <span class="cell owner">${escapeHtml(piece.mime)}</span>
    <span class="cell mtime">${escapeHtml(when)}</span>
    <span class="cell size">${escapeHtml(formatBytes(piece.size))}</span>
    <span class="cell loose-actions">
      <button type="button" data-action="loose-download" data-cid="${escapeHtml(piece.pieceCid)}" data-testid="loose-download">Download</button>
      <button type="button" data-action="loose-open" data-cid="${escapeHtml(piece.pieceCid)}" data-testid="loose-open">Open</button>
    </span>
  </div>`;
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
  if (model.nav === "loose") return model.looseSummary ? `No loose pieces (${model.looseSummary})` : "No loose pieces";
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
    ${details.stat.ipfs ? `<label>IPFS root</label><code data-testid="ipfs-cid">${escapeHtml(details.stat.ipfs)}</code>` : ""}
    ${details.stat.importedCar ? `<p data-testid="imported-car">Imported CAR · stored unchanged</p>` : ""}
    <label>Copies</label>
    <p data-testid="copy-count">${details.copies}</p>
    ${details.providers.length ? `<p data-testid="copy-providers">${escapeHtml(details.providers.join(", "))}</p>` : ""}
    ${details.indexing ? `<label>Indexing</label><p data-testid="indexing-status">${escapeHtml(details.indexing)}</p>${details.stat.ipfs ? `<button type="button" data-testid="check-indexing" data-action="check-indexing" data-cid="${escapeHtml(details.stat.ipfs)}">Check indexing</button>` : ""}` : ""}
    ${
      details.shareUrl
        ? `<label>${details.previewable && !details.stat.importedCar ? "Share" : "Piece link"}</label>
      <a data-testid="share-link" href="${escapeHtml(details.shareUrl)}">${escapeHtml(details.shareUrl)}</a>
      ${details.previewable && !details.stat.importedCar ? `<a data-testid="gateway-preview" href="${escapeHtml(details.shareUrl)}" target="_blank" rel="noreferrer">Gateway preview</a>` : ""}
      <div class="qr" data-testid="share-qr">${details.qr ?? ""}</div>`
        : ""
    }
    <label>History</label>
    <ul class="history" data-testid="history">${rows}</ul>
  </aside>`;
}

function renderDownloads(model: ViewModel): string {
  const queue = model.downloads;
  if (!queue.active && !queue.pending.length && !queue.error && !queue.finished.length) return "";
  const active = queue.active
    ? `<p data-testid="download-active">${escapeHtml(queue.active.name)} · ${escapeHtml(queue.active.stage)}</p>`
    : "";
  const finished = queue.finished.map((name) => `<p data-testid="download-finished">${escapeHtml(name)}</p>`).join("");
  const pending = queue.pending
    .map(
      (item) =>
        `<li data-testid="download-queued">${escapeHtml(item.name)} <button type="button" data-testid="cancel-download" data-action="cancel-download" data-id="${encodeURIComponent(item.id)}">Cancel</button></li>`,
    )
    .join("");
  const error = queue.error ? `<p class="error" data-testid="download-error">${escapeHtml(queue.error)}</p>` : "";
  return `<section class="download-queue" data-testid="download-queue">${active}${finished}${error}<ul>${pending}</ul></section>`;
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
  const step = model.setupStep;
  const setup = panel
    ? `<section class="account-section" data-testid="wallet-setup">
      <p class="section-title">Wallet &amp; setup</p>
      <p class="account-line">${escapeHtml(panel.fil)} FIL · ${escapeHtml(panel.usdfc)} USDFC</p>
      ${panel.paymentsReady
        ? `<p class="account-line status ok" data-testid="payment-status">Storage payment approved</p>`
        : `<button type="button" class="primary slim" data-action="fix-payments" data-testid="fix-payments">${escapeHtml(step?.action === "fix-payments" ? step.label : "Enable storage payment")}</button>
           <p class="note">${escapeHtml(model.costs.depositNote)}</p>`}
      <p class="account-line" data-testid="session-status">${panel.sessionReady ? `Session key until ${escapeHtml(panel.sessionExpiry || "soon")}` : "Session key missing"}</p>
      ${panel.sessionReady
        ? `<button type="button" data-action="refresh-session" data-testid="session-refresh">Refresh session key</button>`
        : `<button type="button" class="primary slim" data-action="authorize" data-testid="authorize-session">${escapeHtml(step?.action === "authorize" ? step.label : "Authorize session key")}</button>`}
      ${step && step.action !== "fix-payments" && step.action !== "authorize" ? `<button type="button" class="primary slim" data-action="${step.action}" data-testid="setup-step">${escapeHtml(step.label)}</button>` : ""}
      <button type="button" data-action="create-dataset" data-testid="create-dataset">Create new dataset</button>
      <p class="note">${escapeHtml(model.costs.datasetNote)}</p>
      <div class="chain-toggle" role="group" aria-label="Network">
        ${chainButton("calibration", "Calibration", model.chain)}
        ${chainButton("mainnet", "Mainnet", model.chain)}
      </div>
      <p class="account-line">Volume ${escapeHtml(model.volumeName)} · encryption ${model.encrypted ? "on" : "off"}</p>
    </section>`
    : `<div class="chain-toggle" role="group" aria-label="Network">
        ${chainButton("calibration", "Calibration", model.chain)}
        ${chainButton("mainnet", "Mainnet", model.chain)}
      </div>`;
  return `<div class="menu account-menu" data-menu="account" data-testid="account-menu">
    <p class="account-line">${escapeHtml(panel?.ens || model.owner)}</p>
    ${renderIdentity(model.owner)}
    ${renderDatasetSection(model)}
    ${setup}
    <label class="check"><input data-testid="autosave-uploads" type="checkbox" ${model.autoSaveUploads ? "checked" : ""}/> Auto-save uploads</label>
    <button type="button" data-action="show-costs" data-testid="show-costs">What it costs</button>
    <details class="advanced" data-testid="advanced-editors">
      <summary>Advanced</summary>
      <label class="field">FiPen URL
        <input data-testid="felarumi-url" value="${escapeHtml(model.felarumiUrl)}" />
      </label>
      <label class="field">FiGrid URL
        <input data-testid="felanumio-url" value="${escapeHtml(model.felanumioUrl)}" />
      </label>
    </details>
    <button type="button" data-action="disconnect" data-testid="disconnect">Disconnect</button>
  </div>`;
}

/** Identity lives on its own page (/identity/); the drive shows it and links there. */
function renderIdentity(owner: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return "";
  const who = cachedIdentity(owner);
  const back = typeof location === "undefined" ? "" : `?return=${encodeURIComponent(location.href)}`;
  return `<div class="identity-line" data-testid="identity-summary">
      ${avatarHtml(who, 28)}
      <span><strong data-testid="identity-name">${escapeHtml(who.displayName)}</strong>${who.identity ? "" : `<small> · guest name</small>`}</span>
      <a href="./identity/${back}" data-testid="identity-edit">${who.identity ? "Edit identity" : "Set up identity"}</a>
    </div>
    <p class="note">Your name in FiPen and FiGrid.</p>`;
}

function renderTxlog(model: ViewModel): string {
  return `<section class="txlog" data-testid="txlog" aria-label="Transaction log">
    <header>Transaction log<button type="button" class="close" data-action="toggle-txlog" aria-label="Close">×</button></header>
    ${renderChainSteps(model.chainSteps) || `<p class="note">No transactions yet.</p>`}
  </section>`;
}

function renderCosts(): string {
  return `<div class="costs-backdrop" data-action="costs-close" data-testid="costs-backdrop">
    <div class="costs-modal" role="dialog" aria-modal="true" aria-labelledby="costs-title" data-testid="costs">
      <button type="button" class="close" data-action="costs-close" data-testid="costs-close" aria-label="Close">×</button>
      <h2 id="costs-title">What it costs</h2>
      <p class="lede">FiPen documents and FiGrid spreadsheets are included — you only pay Filecoin storage.</p>
      <p><strong>Per month:</strong></p>
      <ul class="cost-list">
        <li>$2.50/TiB = a penny for 4 GB</li>
        <li>$0.12 per dataset ($0.50 at start)</li>
        <li>A penny per piece added</li>
      </ul>
      <p class="note"><a href="${DOCS_COSTS_URL}" target="_blank" rel="noreferrer">How Filecoin storage is priced</a></p>
    </div>
  </div>`;
}

function renderToasts(toasts: ToastRow[]): string {
  if (!toasts.length) return "";
  return `<div class="toasts" data-testid="toasts" aria-live="polite">${toasts
    .map((toast) => `<div class="toast" data-testid="toast">${escapeHtml(toast.text)}${toast.action ? `<button type="button" class="toast-action" data-action="${escapeHtml(toast.action)}" data-testid="toast-action">${escapeHtml(toast.actionLabel ?? "Open")}</button>` : ""}<button type="button" data-action="dismiss-toast" data-id="${toast.id}" aria-label="Dismiss">×</button></div>`)
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
