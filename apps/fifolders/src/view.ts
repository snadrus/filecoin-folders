import { LEGACY_NAME_KEY, SESSION_NAME_KEYS, avatarHtml, cachedIdentity, pickDisplayName, type ResolvedIdentity } from "fiperson/view";
import { friendlyError } from "./friendly-error.js";
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
import { gatewayUrl, groupByFolder } from "./drive-pieces.js";
import type { UnixfsEntry } from "./unixfs.js";
import { DOCS_COSTS_URL, type Runway } from "./pricing.js";

export interface UploadRow {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "waiting" | "done" | "error";
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
  note?: string;
  label?: string;
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
  /** Secondary detail: cost, error, stage. Never in the title. */
  detail?: string;
  /** Done rows: ms already elapsed of the 10 s auto-dismiss. */
  elapsedMs?: number;
}

export interface LooseRow {
  pieceCid: string;
  name: string;
  size: number;
  uploaded: number;
  mime: string;
  folder?: string;
  ipfsRoot?: string;
  origin?: "drive";
  unixfs?: "file" | "directory" | "car";
  children?: UnixfsEntry[];
  expanded?: boolean;
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
  /** Loose view still resolving pieces, e.g. "Reading pieces 3 of 12…". */
  looseProgress?: string;
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
    directUrl?: string;
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
  /** null = automatic (open while uploading or on errors, collapsed once all are done, like Drive). */
  uploadsOpen?: boolean | null;
  offline?: boolean;
  toasts: ToastRow[];
  walletPrompts: WalletPromptView[];
  /** Copies participants saved while the owner was away; the owner can bring each into their drive. */
  participantCopies?: { id: string; title: string; from: string; mode: "version" | "side" }[];
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
    ${renderUploads(model.uploads, model.uploadsOpen ?? null)}
    ${model.offline ? `<div class="offline-chip" data-testid="offline-chip" role="status">You're offline. You can browse what's loaded; reconnect to upload or save changes.</div>` : ""}
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
      ${model.connectError ? `<p class="error" data-testid="connect-error">${escapeHtml(friendlyError(model.connectError))}</p>` : ""}
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
  // A lapsed session on a set-up wallet is a Transaction log entry ("Reconnect wallet session"), not a setup pop-up.
  const reconnectOnly = Boolean(panel.selectedDatasetId && panel.paymentsReady && !panel.sessionReady && model.sessionPrompt);
  const needsUser = (!ready && !reconnectOnly) || Boolean(model.setupError);
  return `<div class="shell">
    ${renderTop(model)}
    ${renderNav(model)}
    <main class="workspace">
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
      ${payment}
      ${session}
      <div class="datasets" data-testid="datasets">
        <p class="note">Dataset for this wallet. Every volume stores its pieces here.</p>
        ${datasets || `<p class="note">No datasets yet.</p>`}
        ${create}
      </div>
      ${open}
      <p class="note" data-testid="wallet-signatures">Wallet signatures ${panel.signatures}. Connect prompts ${panel.connectPrompts}.</p>
      ${model.setupError ? `<p class="error" data-testid="setup-error">${escapeHtml(friendlyError(model.setupError))}</p>` : ""}
    </div>
  </div>`;
}

function renderSessionEntry(model: ViewModel): string {
  if (!model.sessionPrompt) return "";
  const expired = model.sessionPrompt === "expired";
  return `<div class="activity-item session-entry" data-testid="session-renew" data-prompt="${model.sessionPrompt}" data-status="pending" role="status">
    <span class="spinner small" aria-hidden="true"></span>
    <span class="activity-text"><span class="activity-title">Reconnect wallet session</span>
      <span class="note">${expired ? "Your save session ended. One wallet signature reconnects it." : "Your save session ends soon. One wallet signature keeps it going."}</span></span>
    <button type="button" data-testid="session-renew-button" data-action="renew-session">Reconnect</button>
  </div>`;
}

function renderActivityItem(item: ActivityRow): string {
  const mark = item.status === "pending" ? `<span class="spinner small" aria-hidden="true"></span>` : `<span class="activity-mark" aria-hidden="true"></span>`;
  return `<div class="activity-item" data-testid="activity-item" data-status="${item.status}">
    ${mark}
    <span class="activity-text"><span class="activity-title">${escapeHtml(item.label)}</span>${item.detail ? `<span class="note">${escapeHtml(item.detail)}</span>` : ""}</span>
    ${item.status === "error" ? `<button type="button" data-action="retry-activity" data-id="${escapeHtml(item.id)}" data-testid="retry-activity">Retry</button><button type="button" class="activity-dismiss" data-action="dismiss-activity" data-id="${escapeHtml(item.id)}" data-testid="dismiss-activity" aria-label="Dismiss">×</button>` : ""}
    ${item.status === "done" ? `<span class="activity-progress" data-testid="activity-progress" style="animation-delay:-${Math.max(0, Math.round(item.elapsedMs ?? 0))}ms"></span>` : ""}
  </div>`;
}

/** Pending work behind the single Transaction log entry (ops, wallet prompts, session renewal). */
export function txlogPending(model: ViewModel): number {
  return model.activity.filter((item) => item.status === "pending").length + (model.sessionPrompt ? 1 : 0);
}

function chainButton(chain: "calibration" | "mainnet", label: string, current: string): string {
  const pressed = chain === current ? "true" : "false";
  return `<button type="button" class="chip ${chain === current ? "on" : ""}" data-action="chain" data-chain="${chain}" data-testid="chain-${chain}" aria-pressed="${pressed}">${label}</button>`;
}

function readKey(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

/** The wallet as a person (fiperson/view), same precedence as FiPen/FiGrid: identity → session name → legacy name → guest name. */
export function personOf(owner: string): ResolvedIdentity {
  const who = cachedIdentity(owner);
  if (who.identity) return who;
  const sessionName = SESSION_NAME_KEYS.map((k) => readKey(() => sessionStorage, k)).find(Boolean) ?? null;
  return { ...who, displayName: pickDisplayName({ sessionName, legacyName: readKey(() => localStorage, LEGACY_NAME_KEY), wallet: owner }) };
}

function renderTop(model: ViewModel): string {
  const isWallet = /^0x[0-9a-fA-F]{40}$/.test(model.owner);
  const who = isWallet ? personOf(model.owner) : null;
  const label = who?.displayName || model.panel?.ens || shortAddress(model.owner);
  const secondary = isWallet ? model.panel?.ens || shortAddress(model.owner) : "";
  return `<header class="topbar">
    <div class="brand">${logoSvg(28)} <span>FiFolders</span></div>
    <label class="search">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
      <input data-testid="search" type="search" placeholder="Search in FiFolders" value="${escapeHtml(model.query)}" />
    </label>
    ${model.activityPending ? `<span class="activity-dot" data-testid="activity-indicator" title="Saving"></span>` : ""}
    ${renderStaged(model)}
    <button class="account" data-action="account" data-testid="account" type="button" title="${escapeHtml(model.owner)}">${who ? avatarHtml(who, 28) : identiconSvg(model.owner)}<span class="account-text"><span data-testid="account-label">${escapeHtml(label)}</span>${secondary ? `<small data-testid="account-address">${escapeHtml(secondary)}</small>` : ""}</span></button>
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
  const pending = txlogPending(model);
  const errors = model.activity.some((item) => item.status === "error");
  const txlog = `<button type="button" class="place txlog-toggle ${model.txlogOpen ? "on" : ""}" data-action="toggle-txlog" data-testid="txlog-toggle" data-pending="${pending}">
      ${pending ? `<span class="spinner small" data-testid="txlog-spinner" aria-hidden="true"></span>` : `<span class="material-symbols-outlined" aria-hidden="true">receipt_long</span>`} Transaction log
      ${pending ? `<span class="badge" data-testid="txlog-count">${pending}</span>` : errors ? `<span class="badge error" data-testid="txlog-count">!</span>` : ""}
    </button>`;
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
    <nav class="places suite" aria-label="More apps">
    </nav>
    <div class="storage storage-open ${runway.low ? "low" : ""}" data-testid="storage-runway" data-action="show-costs" role="button" tabindex="0" title="What it costs">
      <p class="runway-headline" data-testid="runway-headline">${runwayHtml(runway.headline, runway.datasetLabel)}</p>
      ${runway.detail ? `<p class="runway-detail" data-testid="runway-detail">${runwayHtml(runway.detail, runway.datasetLabel)}</p>` : ""}
      ${runway.showAdd ? `<button type="button" class="primary slim" data-action="add-funds" data-testid="add-funds">Add funds</button>` : ""}
    </div>
    <input data-testid="file-input" class="sr-only" type="file" multiple aria-label="Upload files" tabindex="-1" />
    <input data-testid="folder-input" class="sr-only" type="file" multiple webkitdirectory aria-label="Upload folder" tabindex="-1" />
  </aside>`;
}

/** Wallet-menu dataset picker: every dataset the wallet owns, current one checked, newest marked. */
function renderDatasetSection(model: ViewModel): string {
  const panel = model.panel;
  if (!panel || !panel.datasets.length) return "";
  const current = panel.selectedDatasetId;
  const latest = latestDatasetId(panel.datasets);
  const ordered = [...panel.datasets].sort((a, b) => {
    const rank = (d: typeof a) => (d.drive ? 0 : d.source === "filecoin-drive" ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
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
      return `<button type="button" role="menuitemradio" aria-checked="${on}" class="dataset-item ${on ? "on" : ""} ${dataset.drive || dataset.source === "filecoin-drive" ? "is-drive" : "not-drive"}" data-drive="${dataset.drive ? "1" : "0"}" data-action="switch-dataset" data-id="${escapeHtml(dataset.id)}" data-testid="dataset-item">
        <span class="material-symbols-outlined dataset-check" aria-hidden="true">${on ? "check" : ""}</span>
        <span class="dataset-text"><span class="dataset-id">Dataset ${escapeHtml(label)}${dataset.id === latest ? ` <span class="dataset-tag" data-testid="dataset-latest">latest</span>` : ""}</span>
        ${dataset.drive ? `<span class="dataset-drive" data-testid="dataset-drive"><span class="material-symbols-outlined" aria-hidden="true">folder</span> FiFolders drive${dataset.driveName ? ` · ${escapeHtml(dataset.driveName)}` : ""}</span>` : ""}
        ${dataset.source === "filecoin-drive" ? `<span class="dataset-drive fcdrive" data-testid="dataset-filecoin-drive"><span class="material-symbols-outlined" aria-hidden="true">cloud</span> Filecoin Drive</span>` : ""}
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
  const rows = model.nav === "loose" ? renderLooseList(model.loose) : model.entries.map((entry, index) => renderEntry(entry, model, index)).join("");
  const filled = model.nav === "loose" ? model.loose.length : model.entries.length;
  const empty =
    model.loadState === "error"
      ? `<div class="empty" data-testid="load-error" role="alert">Could not load your drive from Filecoin. Your files are safe on chain.${model.loadError ? ` <small>${escapeHtml(model.loadError)}</small>` : ""} <button type="button" data-action="retry-load" data-testid="retry-load">Retry</button></div>`
      : model.loadState === "loading" && !filled && model.nav === "loose"
        ? `<div class="empty loose-skeleton" data-testid="drive-loading" role="status"><p data-testid="loose-loading"><span class="spinner" aria-hidden="true"></span> ${escapeHtml(model.looseProgress || "Finding loose pieces…")}</p>${'<span class="skeleton-bar"></span>'.repeat(4)}</div>`
      : model.loadState === "loading" && !filled
        ? `<div class="empty" data-testid="drive-loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading your drive from Filecoin…</div>`
        : filled
          ? ""
          : renderEmpty(model);
  const blocked = model.mainnetBlocked
    ? `<p class="banner" data-testid="mainnet-banner">Registry not deployed</p>`
    : "";
  const restored = model.restoreNote ? `<p class="restore-banner" data-testid="staged-restore">${escapeHtml(model.restoreNote)}</p>` : "";
  // The setup note sits at the top of the file list (a sibling in the flex row squeezed the list into a column).
  return `<section class="browser ${model.dragging ? "dragover" : ""}" data-testid="browser" data-view="${model.view}">
      ${model.setupNote ? `<div class="setup-note" data-testid="setup-note" role="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(model.setupNote)}${
        model.setupStep
          ? ` <button type="button" class="text-button" data-action="account" data-testid="setup-open-wallet">Wallet &amp; setup</button>`
          : ""
      }</div>` : ""}
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
        <button type="button" data-testid="view-list" data-action="view-list" aria-pressed="${model.view === "list"}" title="List" aria-label="List view"><span class="material-symbols-outlined" aria-hidden="true">view_list</span></button>
        <button type="button" data-testid="view-grid" data-action="view-grid" aria-pressed="${model.view === "grid"}" title="Grid" aria-label="Grid view"><span class="material-symbols-outlined" aria-hidden="true">grid_view</span></button>
      </div>
    </div>
    ${blocked}
    ${renderParticipantCopies(model)}
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
    ${model.nav === "loose" && filled && model.loadState === "loading" ? `<p class="note loose-pending" data-testid="loose-loading"><span class="spinner small" aria-hidden="true"></span> ${escapeHtml(model.looseProgress || "Loading more pieces…")}</p>` : ""}
    ${model.nav === "loose" && model.looseSummary && filled && model.loadState !== "loading" ? `<p class="note" data-testid="loose-summary">${escapeHtml(model.looseSummary)}</p>` : ""}
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

function renderEntry(entry: Stat, model: ViewModel, index = 0): string {
  const selected = model.selected.includes(entry.path);
  // Roving tabindex: Tab reaches the file list once (the last-selected row, else the first row); ↑/↓ move within it.
  const focusTarget = model.selected.length ? model.selected.at(-1) === entry.path : index === 0;
  const kind = felKind(entry.name) ?? "";
  const drop = model.dropPath === entry.path ? "true" : "false";
  const icon = entryIcon(entry, kind as FelKind | "");
  const star = model.stars.has(entry.path) ? `<span class="material-symbols-outlined filled star" aria-label="Starred">star</span>` : "";
  const badge = model.badges[entry.path] ? `<span class="badge" data-testid="save-badge">${escapeHtml(model.badges[entry.path] ?? "")}</span>` : "";
  const adopted = entry.type === "file" && entry.format === "unixfs"
    ? `<span class="badge fcdrive-badge" data-testid="adopted-badge" title="Referenced from a Filecoin Drive piece; stored unencrypted">Filecoin Drive · plaintext</span>`
    : "";
  const name = `${icon}<span class="name">${escapeHtml(entry.name)}</span>${adopted}${badge}${star}`;
  const body =
    model.view === "grid"
      ? name
      : `<span class="cell name-cell">${name}</span><span class="cell owner" title="${escapeHtml(model.owner)}">${/^0x[0-9a-fA-F]{40}$/.test(model.owner) ? `${avatarHtml(personOf(model.owner), 20)} ${escapeHtml(personOf(model.owner).displayName)}` : escapeHtml(shortAddress(model.owner))}</span><span class="cell mtime">${escapeHtml(formatWhen(entry.mtime))}</span><span class="cell size">${entry.type === "dir" ? "—" : escapeHtml(formatBytes(entry.size))}</span>`;
  return `<div class="entry ${model.view}" role="row" data-testid="entry" tabindex="${focusTarget ? 0 : -1}" aria-selected="${selected ? "true" : "false"}" aria-label="${escapeHtml(entry.name)}" data-path="${encodeURIComponent(entry.path)}" data-type="${entry.type}" data-kind="${kind}" data-selected="${selected ? "true" : "false"}" data-drop="${drop}" data-saving="${badge ? "true" : "false"}" draggable="true">${body}</div>`;
}

/** Filecoin Drive pieces group under their folder path; other loose pieces list flat after them. */
function renderLooseList(rows: LooseRow[]): string {
  const drive = rows.filter((row) => row.origin === "drive");
  const other = rows.filter((row) => row.origin !== "drive");
  if (!drive.length) return other.map((piece) => renderLoose(piece)).join("");
  const groups = groupByFolder(drive)
    .map(
      (group) => `<div class="loose-group" data-testid="loose-folder" data-folder="${escapeHtml(group.folder)}">
        <div class="loose-folder"><span class="material-symbols-outlined" aria-hidden="true">folder</span> ${escapeHtml(group.folder ? `/${group.folder}` : "/ (root)")} <span class="badge">Filecoin Drive</span>
          <button type="button" class="text-button" data-action="loose-adopt-folder" data-folder="${escapeHtml(group.folder)}" data-testid="loose-adopt-folder">Add folder to drive</button></div>
        ${group.rows.map((piece) => renderLoose(piece)).join("")}
      </div>`,
    )
    .join("");
  const rest = other.length ? `<div class="loose-group"><div class="loose-folder"><span class="material-symbols-outlined" aria-hidden="true">inventory_2</span> Other pieces</div>${other.map((piece) => renderLoose(piece)).join("")}</div>` : "";
  const all = `<div class="loose-adopt-all"><button type="button" class="primary slim" data-action="loose-adopt-all" data-testid="loose-adopt-all">Add all Filecoin Drive files to drive</button></div>`;
  return all + groups + rest;
}

function renderUnixfsEntries(piece: LooseRow, entries: UnixfsEntry[], prefix: string, depth: number): string {
  return entries
    .map((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isDir = entry.kind === "directory";
      return `<div class="entry list unixfs-entry" role="row" data-testid="unixfs-entry" style="padding-left:${24 + depth * 20}px">
        <span class="cell name-cell"><span class="material-symbols-outlined file-icon" aria-hidden="true">${isDir ? "folder" : "draft"}</span><span class="name">${escapeHtml(entry.name)}</span></span>
        <span class="cell owner"><code class="cid">${escapeHtml(shortCid(entry.cid))}</code></span>
        <span class="cell mtime"></span>
        <span class="cell size">${isDir ? "—" : escapeHtml(formatBytes(entry.size))}</span>
        <span class="cell loose-actions">
          ${isDir ? "" : `<button type="button" data-action="loose-entry-download" data-cid="${escapeHtml(piece.pieceCid)}" data-path="${escapeHtml(path)}" data-testid="unixfs-download">Download</button>`}
          ${piece.ipfsRoot ? `<a href="${escapeHtml(gatewayUrl(piece.ipfsRoot, path))}" target="_blank" rel="noreferrer" data-testid="unixfs-gateway">Gateway</a>` : ""}
        </span>
      </div>${isDir && entry.children ? renderUnixfsEntries(piece, entry.children, path, depth + 1) : ""}`;
    })
    .join("");
}

function shortCid(cid: string): string {
  return cid.length > 16 ? `${cid.slice(0, 8)}…${cid.slice(-6)}` : cid;
}

function renderLoose(piece: LooseRow): string {
  const when = piece.uploaded ? formatWhen(piece.uploaded) : "—";
  if (piece.origin === "drive") {
    const dir = piece.unixfs === "directory";
    const kind = dir ? "Folder (UnixFS)" : piece.unixfs === "car" ? "Imported CAR" : piece.mime;
    return `<div class="entry list loose-drive" role="row" data-testid="loose-row" data-origin="drive" data-cid="${escapeHtml(piece.pieceCid)}">
      <span class="cell name-cell">
        ${dir ? `<button type="button" class="expander" data-action="loose-expand" data-cid="${escapeHtml(piece.pieceCid)}" data-testid="loose-expand" aria-expanded="${Boolean(piece.expanded)}"><span class="material-symbols-outlined" aria-hidden="true">${piece.expanded ? "expand_more" : "chevron_right"}</span></button>` : ""}
        <span class="material-symbols-outlined file-icon" aria-hidden="true">${dir ? "folder_zip" : piece.unixfs === "car" ? "deployed_code" : "draft"}</span>
        <span class="name-stack"><span class="name">${escapeHtml(piece.name)}</span>
        ${piece.ipfsRoot ? `<small class="cid" data-testid="loose-ipfs" title="${escapeHtml(piece.ipfsRoot)}">IPFS ${escapeHtml(shortCid(piece.ipfsRoot))}</small>` : ""}</span>
      </span>
      <span class="cell owner">${escapeHtml(kind)}</span>
      <span class="cell mtime">${escapeHtml(when)}</span>
      <span class="cell size">${escapeHtml(formatBytes(piece.size))}</span>
      <span class="cell loose-actions">
        <button type="button" data-action="loose-download" data-cid="${escapeHtml(piece.pieceCid)}" data-testid="loose-download">${dir ? "Download CAR" : "Download"}</button>
        <button type="button" data-action="loose-adopt" data-cid="${escapeHtml(piece.pieceCid)}" data-testid="loose-adopt">Add to drive</button>
        ${dir ? "" : `<button type="button" data-action="loose-open" data-cid="${escapeHtml(piece.pieceCid)}" data-testid="loose-open">Open</button>`}
        ${piece.ipfsRoot ? `<a href="${escapeHtml(gatewayUrl(piece.ipfsRoot))}" target="_blank" rel="noreferrer" data-testid="loose-gateway">Gateway</a>` : ""}
      </span>
    </div>${dir && piece.expanded && piece.children ? renderUnixfsEntries(piece, piece.children, "", 1) : ""}`;
  }
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

/** Drive-style empty state: icon, headline, one line of what to do next. */
function renderEmpty(model: ViewModel): string {
  const hint: Record<string, [string, string]> = {
    loose: ["inventory_2", "Pieces in this dataset that no folder points to show up here — for example files saved with Filecoin Drive. Select them and use “Add to drive” to file them without re-uploading."],
    trash: ["delete", "Items you remove stay here until you delete them forever."],
    starred: ["star", "Star files to find them here quickly."],
    recent: ["schedule", "Files you open or change show up here."],
  };
  const [icon, line] = model.query.trim() ? ["search", "Try a different name."] : (hint[model.nav] ?? ["folder_open", "Drop files here or use New to add files and folders."]);
  return `<div class="empty-state"><span class="material-symbols-outlined empty-icon" aria-hidden="true">${icon}</span>
    <p class="empty" data-testid="empty">${model.nav === "loose" && !model.query.trim() ? `No loose pieces${model.looseSummary ? `<small class="empty-stats">${escapeHtml(model.looseSummary)}</small>` : ""}` : escapeHtml(emptyCopy(model))}</p><p class="empty-hint">${escapeHtml(line)}</p></div>`;
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
  if (context.trash) {
    // Like Drive's Trash: only restore, delete forever, or look at it.
    return `<div class="menu floating" data-menu="context" data-testid="context-menu" style="left:${context.x}px;top:${context.y}px">
    ${trashItems}
    ${item("details", "info", "Details")}
  </div>`;
  }
  return `<div class="menu floating" data-menu="context" data-testid="context-menu" style="left:${context.x}px;top:${context.y}px">
    ${item("open", "open_in_new", "Open")}
    ${item("download", "download", "Download", context.directory)}
    ${item("rename", "edit", "Rename")}
    ${item("move", "drive_file_move", "Move to")}
    ${item("copy", "content_copy", "Make a copy")}
    ${item("star", "star", context.starred ? "Unstar" : "Star")}
    ${trashItems}
    ${context.directory ? "" : item("versions", "history", "Manage versions")}
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
    <header><h2>${escapeHtml(details.stat.name)}</h2><button type="button" data-action="close-details" aria-label="Close details"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></header>
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
      ${details.previewable && !details.stat.importedCar ? `<a data-testid="gateway-preview" href="${escapeHtml(details.directUrl ?? details.shareUrl)}" target="_blank" rel="noreferrer">Gateway preview</a>` : ""}
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
    : `<label class="field">${escapeHtml(dialog.label ?? "Name")}
        <input data-testid="dialog-input" name="name" value="${escapeHtml(dialog.value)}" autocomplete="off" />
      </label>`;
  return `<div class="backdrop" data-testid="dialog">
    <form class="dialog" role="dialog" aria-label="${escapeHtml(dialog.title)}">
      <h2>${escapeHtml(dialog.title)}</h2>
      ${folders}
      ${dialog.note ? `<p class="note" data-testid="dialog-note">${escapeHtml(dialog.note)}</p>` : ""}
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
  else if (preview.kind === "video" && preview.url) body = `<video controls preload="metadata" data-testid="preview-video" src="${preview.url}"></video>`;
  else if (preview.kind === "audio" && preview.url) body = `<div class="audio-preview"><span class="material-symbols-outlined audio-art" aria-hidden="true">music_note</span><audio controls preload="metadata" data-testid="preview-audio" aria-label="${escapeHtml(preview.name)}" src="${preview.url}"></audio></div>`;
  else if (preview.kind === "text") body = `<pre data-testid="preview-text">${escapeHtml(preview.text ?? "")}</pre>`;
  return `<div class="backdrop" data-testid="preview">
    <div class="preview" role="dialog" aria-label="${escapeHtml(preview.name)}">
      <header><h2>${escapeHtml(preview.name)}</h2><span class="preview-actions">${preview.url && (preview.kind === "audio" || preview.kind === "video") ? `<a class="icon-link" data-testid="preview-download" href="${preview.url}" download="${escapeHtml(preview.name)}" aria-label="Download" title="Download"><span class="material-symbols-outlined" aria-hidden="true">download</span></a>` : ""}<button type="button" data-action="close-preview" aria-label="Close preview"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span></header>
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
        ? `<button type="button" data-action="refresh-session" data-testid="session-refresh">Refresh session key</button>
           <button type="button" data-action="refund-session" data-testid="refund-session" title="Send the session key's leftover tFIL/FIL back to your wallet and forget the key in this browser">Disconnect session and refund</button>`
        : `<button type="button" class="primary slim" data-action="authorize" data-testid="authorize-session">${escapeHtml(step?.action === "authorize" ? step.label : "Authorize session key")}</button>
           <p class="note" data-testid="session-lazy-note">Not needed to browse. Your first save asks for it (1 signature).</p>`}
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
  const who = personOf(owner);
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
    <div class="activity" data-testid="activity">${renderSessionEntry(model)}${model.activity.map(renderActivityItem).join("")}</div>
    ${model.chainSteps.length ? `<details class="txlog-details"${model.activity.length || model.sessionPrompt ? "" : " open"}><summary>On-chain details</summary>${renderChainSteps(model.chainSteps)}</details>` : ""}
    ${!model.activity.length && !model.sessionPrompt && !model.chainSteps.length ? `<p class="note">Nothing yet. Saves and wallet requests show up here.</p>` : ""}
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

function renderUploads(uploads: UploadRow[], open: boolean | null): string {
  if (!uploads.length) return "";
  const active = uploads.some((item) => item.status === "uploading");
  const failed = uploads.filter((item) => item.status === "error").length;
  const done = uploads.filter((item) => item.status === "done").length;
  const waiting = uploads.filter((item) => item.status === "waiting").length;
  const title = active
    ? `Uploading ${uploads.filter((item) => item.status === "uploading").length}`
    : waiting
      ? `${waiting} upload${waiting === 1 ? "" : "s"} waiting for wallet setup`
      : failed
      ? `${failed} upload${failed === 1 ? "" : "s"} failed`
      : `${done} upload${done === 1 ? "" : "s"} complete`;
  const expanded = open ?? (active || waiting > 0 || failed > 0);
  const toggle = `<button type="button" data-action="toggle-uploads" data-testid="toggle-uploads" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} uploads"><span class="material-symbols-outlined" aria-hidden="true">${expanded ? "expand_more" : "expand_less"}</span></button>`;
  return `<section class="uploads" data-testid="upload-panel" data-collapsed="${expanded ? "false" : "true"}">
    <header><span data-testid="upload-title">${title}</span><span class="upload-actions">${toggle}<button type="button" data-action="dismiss-uploads" aria-label="Close uploads">×</button></span></header>
    ${!expanded ? "" : uploads
      .map(
        (item) => `<div class="upload-row" data-status="${item.status}">
          <span>${escapeHtml(item.name)}</span>${item.status === "waiting" ? `<span class="note" data-testid="upload-waiting">Waiting for wallet setup</span>` : ""}
          <progress value="${item.progress}" max="100"></progress>
        </div>`,
      )
      .join("")}
  </section>`;
}

function renderParticipantCopies(model: ViewModel): string {
  const copies = model.participantCopies ?? [];
  if (!copies.length || model.nav !== "drive") return "";
  const rows = copies
    .map(
      (copy) => `<li class="copy-row" data-testid="participant-copy">
        <span class="material-symbols-outlined" aria-hidden="true">file_copy</span>
        <span class="copy-what"><strong>${escapeHtml(copy.title || "Untitled")}</strong> — ${escapeHtml(copy.from)} saved a copy while you were away${copy.mode === "version" ? "" : " (it changed since, so it goes beside the original)"}</span>
        <button type="button" class="text-btn" data-action="copy-take" data-copy-id="${escapeHtml(copy.id)}">${copy.mode === "version" ? "Save as new version" : "Copy to my drive"}</button>
        <button type="button" class="text-btn" data-action="copy-dismiss" data-copy-id="${escapeHtml(copy.id)}">Dismiss</button>
      </li>`,
    )
    .join("");
  return `<section class="participant-copies" data-testid="participant-copies" aria-label="Participant copies">
    <h3>Participant copies</h3>
    <ul>${rows}</ul>
  </section>`;
}
