import { felFileName } from "./blank.js";
import {
  CarArchiveError,
  CasConflictError,
  NotFoundError,
  contentCid,
  fundingShortfall,
  readCarRoots,
  type HistoryEntry,
  type Stat,
  type Volume,
} from "fil-folders";
import { DEFAULT_STORAGE_COPIES, defaultLocalCopies, loadCheckpoint, loadCopyCatalog, recoverReplication, saveCheckpoint, saveCopyCatalog } from "./copies.js";
import { DownloadQueue } from "./downloads.js";
import { indexingLabel, localIndexStore, runIndexingCheck } from "./indexing.js";
import { canPreviewName, fileShareLink } from "./links.js";
import { REGISTRY_NOT_DEPLOYED, registryReady, saveNetworkPreference } from "./network.js";
import { qrSvg } from "./qr.js";
import { loadRemovals, piecesEligibleForRemoval, saveRemovals, schedulePieceRemovals, type RemovalAdapters } from "./removal.js";
import { chainStepTitle, explorerHref, stepDetail, type ChainReport, type ChainStepView } from "./chain-step.js";
import { INTENTS, intentText, onWalletPrompts, sessionIntent, withWalletIntent, type WalletPrompt, walletPrompts } from "./wallet-prompts.js";
import { ACTIVITY_DISMISS_MS, dismissActivity, loadDismissed } from "./activity.js";
import { defaultFelTitle, felTarget, rememberFelTarget, remapFelTargets } from "./fel-names.js";
import { directoryFile, loosePieces, rememberPiece, sniffMime, type LoosePiece } from "./loose.js";
import { readPieceDetails, type PieceDetail } from "./drive-pieces.js";
import {
  TRASH_PATH,
  applySelection,
  appLink,
  baseName,
  breadcrumbs,
  copyName,
  defaultSortDir,
  felKind,
  type FelKind,
  guessMime,
  isTrashPath,
  joinPath,
  matchesQuery,
  parentPath,
  previewKind,
  sortStats,
  sumSizes,
  uniqueName,
  type NavId,
  type PreviewKind,
  type SortKey,
  type ViewMode,
} from "./model.js";
import { isSessionPermissionError, type SessionGate, type WalletPanel } from "./onboarding-logic.js";
import { dropFelPlaceholders, dropOp, isBlankFelContent, loadOps, newOp, OPS_CHANNEL, OPS_KEY, patchOp, upsertOp, type FifoldersOp, type OpKind } from "./ops.js";
import {
  datasetBlurb,
  depositBlurb,
  describeRunway,
  fallbackQuote,
  formatUsd,
  fourGiBLine,
  skipLivePricing,
  type CostQuote,
} from "./pricing.js";
import type { CasObserver, ChainChoice } from "./session.js";
import {
  autoSaveUploads,
  bytesToB64,
  forkVolume,
  loadStaged,
  replayStaged,
  restoreLabel,
  saveLabel,
  saveStaged,
  type StagedOp,
} from "./staged.js";
import { loadSavedView, persistMemoryVolume, saveView } from "./volume-persist.js";
import { renderApp, type ActivityRow, type DialogState, type UploadRow, type ViewModel } from "./view.js";

export interface DriveAppOptions {
  volume: Volume | null;
  owner: string;
  chain: ChainChoice;
  encrypted: boolean;
  volumeName: string;
  cas: CasObserver;
  felarumiUrl: string;
  felanumioUrl: string;
  encryptPref?: boolean;
  panel?: WalletPanel | null;
  onConnect?: (input: { chain: ChainChoice; volumeName: string; encrypt: boolean }) => Promise<void>;
  onSetupAction?: (action: string, value?: string) => Promise<void>;
  onDisconnect?: () => void;
  /** Read-only funding quote for the real piece size and copy count. A shortfall skips the upload. */
  quoteUpload?: (input: { pieceBytes: number; copies: number }) => Promise<{ ready: boolean; depositNeeded?: bigint; needsApproval?: boolean }>;
  /** IPFS indexer probe. A miss does not fail the file. */
  indexProbe?: (cid: string) => Promise<boolean>;
  removalAdapters?: RemovalAdapters;
}

interface DialogModel {
  mode: "new-folder" | "rename" | "move" | "new-felarumi" | "new-felanumio";
  title: string;
  submit: string;
  value: string;
  path?: string;
  paths?: string[];
  dest?: string;
  folders?: { path: string; label: string }[];
}

interface PreviewModel {
  name: string;
  kind: PreviewKind;
  url?: string;
  text?: string;
}

interface ContextModel {
  x: number;
  y: number;
  paths: string[];
  target: string;
}

export class DriveApp {
  volume: Volume | null;
  owner: string;
  chain: ChainChoice;
  encrypted: boolean;
  volumeName: string;
  cas: CasObserver;
  felarumiUrl: string;
  felanumioUrl: string;
  encryptPref: boolean;
  onConnect?: DriveAppOptions["onConnect"];
  onSetupAction?: DriveAppOptions["onSetupAction"];
  onDisconnect?: DriveAppOptions["onDisconnect"];
  /** Read on-chain session-key expirations before a session-key action. */
  onEnsureSession?: () => Promise<SessionGate>;
  /** `loginAndFund` on the stored key, then rebind live clients. Not queued. */
  onRenewSession?: () => Promise<void>;
  sessionPrompt: Exclude<SessionGate, "ok"> | null = null;
  wallets: { rdns: string; name: string }[] = [];
  walletRdns = "";
  panel: WalletPanel | null = null;
  setupError = "";

  nav: NavId = "drive";
  cwd = "/";
  view: ViewMode = "list";
  sortKey: SortKey = "name";
  sortDir: 1 | -1 = 1;
  query = "";
  entries: Stat[] = [];
  selected: string[] = [];
  anchor: string | null = null;
  stars = new Set<string>();
  origins: Record<string, string> = {};
  storageUsed = 0;
  busy = false;
  newMenu = false;
  accountMenu = false;
  context: ContextModel | null = null;
  dialog: DialogModel | null = null;
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
  } | null = null;
  preview: PreviewModel | null = null;
  uploads: UploadRow[] = [];
  toasts: { id: string; text: string; action?: string; actionLabel?: string }[] = [];
  /** Addresses already told which dataset was auto-picked this page load. */
  #autoPickToasted = new Set<string>();
  /** Switch the open drive to another dataset (reload tree from chain). */
  onSwitchDataset: ((id: string) => Promise<void>) | null = null;
  connectError = "";
  mainnetBlocked = false;
  dropPath: string | null = null;
  dragging = false;
  costsOpen = false;
  chainSteps: ChainStepView[] = [];
  recentDone: ActivityRow[] = [];
  looseRows: LoosePiece[] = [];
  quote: CostQuote = fallbackQuote();
  staged: StagedOp[] = [];
  restoreNote = "";
  autoSaveUploads = true;
  quoteUpload?: DriveAppOptions["quoteUpload"];
  indexProbe?: DriveAppOptions["indexProbe"];
  removalAdapters?: RemovalAdapters;
  readonly downloads = new DownloadQueue();

  root: HTMLElement | null = null;
  #tail: Promise<void> = Promise.resolve();
  #toastSeq = 0;
  #opSeq = 0;
  #opsAdopted = false;
  #opsListening = false;
  #draft: Volume | null = null;
  #draftReady = false;
  #restoredFromDisk = false;
  #baseline: { origins: Record<string, string>; stars: string[] } | null = null;
  #renewing = false;
  #renewWaiters: Array<() => void> = [];

  constructor(options: DriveAppOptions) {
    this.volume = options.volume;
    this.owner = options.owner;
    this.chain = options.chain;
    this.encrypted = options.encrypted;
    this.volumeName = options.volumeName;
    this.cas = options.cas;
    this.felarumiUrl = options.felarumiUrl;
    this.felanumioUrl = options.felanumioUrl;
    this.encryptPref = options.encryptPref ?? false;
    this.onConnect = options.onConnect;
    this.onSetupAction = options.onSetupAction;
    this.onDisconnect = options.onDisconnect;
    this.quoteUpload = options.quoteUpload;
    this.indexProbe = options.indexProbe;
    this.removalAdapters = options.removalAdapters;
    this.panel = options.panel ?? null;
    this.view = localStorage.getItem("fifolders:view") === "grid" ? "grid" : "list";
    this.autoSaveUploads = autoSaveUploads();
    this.mainnetBlocked = options.chain === "mainnet" && !registryReady("mainnet");
    this.downloads.onChange = () => this.render();
    this.downloads.setScope(options.volume ? `${options.owner}:${options.volumeName}` : undefined);
    if (options.volume) {
      this.loadPrefs();
      this.#restoredFromDisk = loadStaged(this.owner, this.volumeName).ops.length > 0;
    }
    if (!skipLivePricing()) void this.loadQuote();
  }

  get settled(): Promise<void> {
    return this.#tail;
  }

  /** Drive is showing a public, signature-free read while wallet setup runs. */
  readOnly = false;
  /** Tree load state: never show an empty drive while the load is running or after it failed. */
  loadState: "idle" | "loading" | "ok" | "error" = "idle";
  loadError = "";
  /** Re-runs the public chain read when no volume is open yet. */
  onRetryLoad: (() => Promise<void>) | null = null;

  /** Public tree read failed before any volume opened: show an error with Retry, never an empty drive. */
  notePublicReadError(message: string): void {
    if (this.volume) return;
    this.loadState = "error";
    this.loadError = message;
    this.render();
  }
  #saveWanted = false;

  /** Show the drive from a public read; edits stage locally until {@link attach} brings the writable volume. */
  attachReadOnly(options: DriveAppOptions): void {
    if (this.volume && !this.readOnly) return;
    this.attach(options);
    this.readOnly = true;
    this.render();
    // Read now, not behind the queue: a pending wallet prompt (session key) holds the queue and
    // would leave the drive looking empty until the user answered it.
    void this.refresh();
  }

  /** Re-read the owner's identity from chain (cached); the account menu repaints when it changes. */
  private refreshIdentity(): void {
    const owner = this.owner;
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || import.meta.env.VITE_E2E === "1" || import.meta.env.MODE === "test") return;
    void import("./person.js")
      .then(({ resolvePerson }) => resolvePerson(owner, this.chain))
      .then(() => this.render())
      .catch(() => undefined);
  }

  attach(options: DriveAppOptions): void {
    if (
      this.readOnly &&
      options.volume &&
      this.volume &&
      options.owner.toLowerCase() === this.owner.toLowerCase() &&
      options.volumeName === this.volumeName
    ) {
      this.upgrade(options);
      return;
    }
    this.readOnly = false;
    this.volume = options.volume;
    this.owner = options.owner;
    this.chain = options.chain;
    this.encrypted = options.encrypted;
    this.volumeName = options.volumeName;
    this.cas = options.cas;
    this.mainnetBlocked = options.chain === "mainnet" && !registryReady("mainnet");
    this.quoteUpload = options.quoteUpload ?? this.quoteUpload;
    this.indexProbe = options.indexProbe ?? this.indexProbe;
    this.removalAdapters = options.removalAdapters ?? this.removalAdapters;
    this.downloads.setScope(`${options.owner}:${options.volumeName}`);
    this.connectError = "";
    this.setupError = "";
    if (options.panel) this.panel = options.panel;
    if (options.onConnect) this.onConnect = options.onConnect;
    this.refreshIdentity();
    if (options.onSetupAction) this.onSetupAction = options.onSetupAction;
    if (options.onDisconnect) this.onDisconnect = options.onDisconnect;
    this.costsOpen = false;
    this.#draft = null;
    this.#draftReady = false;
    this.staged = [];
    this.#baseline = null;
    this.restoreNote = "";
    this.loadState = "idle";
    this.loadError = "";
    this.loadPrefs();
    this.#restoredFromDisk = loadStaged(this.owner, this.volumeName).ops.length > 0;
    if (this.root) void this.enqueue(() => this.refresh());
    if (options.volume) void this.recoverPendingUpload();
  }

  /** Swap the public read for the writable volume, keep staged edits, then run any save that waited. */
  private upgrade(options: DriveAppOptions): void {
    this.volume = options.volume;
    this.cas = options.cas;
    this.chain = options.chain;
    this.encrypted = options.encrypted;
    this.readOnly = false;
    if (options.panel) this.panel = options.panel;
    if (options.onConnect) this.onConnect = options.onConnect;
    if (options.onSetupAction) this.onSetupAction = options.onSetupAction;
    if (options.onDisconnect) this.onDisconnect = options.onDisconnect;
    this.quoteUpload = options.quoteUpload ?? this.quoteUpload;
    this.render();
    void this.enqueue(async () => {
      await this.rebuildDraft();
      if (this.#saveWanted && this.staged.length) {
        this.#saveWanted = false;
        await this.saveStaged();
      } else await this.refresh();
    });
    if (options.volume) void this.recoverPendingUpload();
  }

  setWallets(wallets: { rdns: string; name: string }[]): void {
    this.wallets = wallets;
    if (!this.walletRdns && wallets[0]) this.walletRdns = wallets[0].rdns;
    if (this.root && !this.volume) this.render();
  }

  /** Keep the clicked dataset through any re-render while the snapshot reloads (polls used to reset it). */
  private pickDataset(id: string): void {
    this.pickedDataset = id;
    this.onPickDataset?.(id);
    if (this.panel) this.panel = { ...this.panel, selectedDatasetId: id };
    if (this.root) this.render();
  }

  /** Last dataset the user clicked; wins over a snapshot that was read before the click. */
  pickedDataset = "";
  /** Saves the pick as the preferred dataset right away, not after queued wallet work. */
  onPickDataset?: (id: string) => void;

  /** Uncaught error from anywhere: log the stack, show a dismissible toast, keep the UI usable. */
  reportBackgroundError(error: unknown): void {
    console.error("FiFolders background error", error);
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (!message) return;
    const where = error instanceof Error ? (error.stack?.split("\n").find((line) => line.includes(location.origin)) ?? "").trim() : "";
    this.toast(where ? `${message} (${where.replace(location.origin, "")})` : message);
    if (this.root) this.render();
  }

  /** Boot or uncaught failure: keep the UI on screen and say what went wrong. */
  showBootError(message: string): void {
    if (this.volume) this.toast(message);
    else if (this.panel) this.setupError = message;
    else this.connectError = message;
    if (this.root) this.render();
  }

  showPanel(panel: WalletPanel, error = ""): void {
    const picked = this.pickedDataset;
    if (picked && picked !== panel.selectedDatasetId && panel.datasets.some((dataset) => dataset.id === picked)) {
      panel = { ...panel, selectedDatasetId: picked };
    }
    this.panel = panel;
    this.owner = panel.address;
    const autoKey = `${panel.address.toLowerCase()}:${panel.selectedDatasetId}`;
    if (panel.autoPicked && panel.datasets.length > 1 && panel.selectedDatasetId && !this.pickedDataset && !this.#autoPickToasted.has(autoKey)) {
      this.#autoPickToasted.add(autoKey);
      this.toastAction(
        `Using your latest dataset (#${panel.selectedDatasetId}). You can switch datasets from the wallet menu.`,
        "open-datasets",
        "Change",
      );
    }
    this.setupError = error;
    this.connectError = "";
    this.render();
    void this.readSessionPrompt().then(() => {
      if (this.root) this.render();
    });
  }

  /** Swap the open volume after a live session renewal. Mock storage stays put. */
  replaceVolume(volume: Volume, cas: CasObserver): void {
    this.volume = volume;
    this.cas = cas;
  }

  detachToConnect(): void {
    this.pickedDataset = "";
    this.volume = null;
    this.panel = null;
    this.owner = "";
    this.setupError = "";
    this.connectError = "";
    this.entries = [];
    this.selected = [];
    this.accountMenu = false;
    this.render();
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.addEventListener("click", (event) => this.onClick(event));
    root.addEventListener("dblclick", (event) => this.onDblClick(event));
    root.addEventListener("contextmenu", (event) => this.onContextMenu(event));
    root.addEventListener("change", (event) => this.onChange(event));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("keydown", (event) => this.onKey(event));
    root.addEventListener("dragstart", (event) => this.onDragStart(event));
    root.addEventListener("dragover", (event) => this.onDragOver(event));
    root.addEventListener("dragleave", (event) => this.onDragLeave(event));
    root.addEventListener("drop", (event) => this.onDrop(event));
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement | null;
      if (form && (this.dialog?.mode === "new-felarumi" || this.dialog?.mode === "new-felanumio")) {
        const name = form.querySelector<HTMLInputElement>("[data-testid=dialog-input]")?.value ?? this.dialog.value;
        const kind: FelKind = this.dialog.mode === "new-felarumi" ? "felarumi" : "felanumio";
        this.openNewFel(kind, name);
        return;
      }
      if (form?.matches("[data-testid=connect]")) {
        // One wallet request per Connect: repeat clicks while it is open (or after it succeeded) must not stack prompts.
        if (this.#connecting) return;
        this.#connecting = true;
        void this.enqueue(() => this.onSubmit(event)).finally(() => {
          this.#connecting = false;
        });
        return;
      }
      void this.enqueue(() => this.onSubmit(event));
    });
    this.listenForOps();
    onWalletPrompts((prompts) => {
      this.logWalletPrompts(prompts);
      if (this.root) this.render();
    });
    void this.enqueue(() => this.refresh());
  }

  async uploadFiles(files: File[], destDir?: string): Promise<void> {
    const list = [...files];
    await this.enqueue(() => this.uploadList(list, destDir ?? this.destDir()));
  }

  #connecting = false;

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private loadPrefs(): void {
    this.stars = new Set(readJson<string[]>(this.starKey()) ?? []);
    this.origins = readJson<Record<string, string>>(this.originKey()) ?? {};
    if (!this.owner) return;
    const saved = loadSavedView(this.owner, this.volumeName);
    if (!saved) return;
    if (saved.nav === "drive" || saved.nav === "recent" || saved.nav === "starred" || saved.nav === "trash" || saved.nav === "loose") {
      this.nav = saved.nav;
    }
    if (saved.cwd) this.cwd = saved.cwd;
  }

  private starKey(): string {
    return `fifolders:stars:${this.owner.toLowerCase()}:${this.volumeName}`;
  }

  private originKey(): string {
    return `fifolders:trash-origins:${this.owner.toLowerCase()}:${this.volumeName}`;
  }

  private writeStars(): void {
    localStorage.setItem(this.starKey(), JSON.stringify([...this.stars]));
  }

  private writeOrigins(): void {
    localStorage.setItem(this.originKey(), JSON.stringify(this.origins));
  }

  private destDir(): string {
    if (this.nav === "trash") return this.cwd.startsWith(TRASH_PATH) ? this.cwd : TRASH_PATH;
    if (this.nav === "drive") return this.cwd || "/";
    return "/";
  }

  private viewVolume(): Volume | null {
    return this.#draft ?? this.volume;
  }

  private async refresh(): Promise<void> {
    if (!this.volume) {
      this.entries = [];
      if (this.loadState !== "error") this.loadState = this.panel ? "loading" : "idle";
      this.render();
      return;
    }
    if (this.loadState !== "ok") {
      this.loadState = "loading";
      this.render();
    }
    try {
      await this.reconcileOps();
      await this.ensureDraft();
      const tree = await this.walk("/");
      this.storageUsed = sumSizes(tree);
      if (this.nav === "loose") {
        this.looseRows = await this.collectLoose(tree);
        this.entries = [];
      } else {
        this.entries = await this.loadListing();
        const visible = new Set(this.entries.map((entry) => entry.path));
        this.selected = this.selected.filter((path) => visible.has(path));
      }
      this.loadState = "ok";
      this.loadError = "";
      this.saveCurrentView();
      if (import.meta.env.VITE_E2E === "1") await persistMemoryVolume(this.volume, this.owner, this.volumeName);
    } catch (error) {
      if (isSessionPermissionError(error)) {
        this.sessionPrompt = "expired";
      } else if (error instanceof NotFoundError && this.cwd !== "/") {
        this.cwd = "/";
        await this.refresh();
        return;
      } else {
        this.toast(errorText(error));
      }
      if (this.loadState !== "ok") {
        this.loadState = "error";
        this.loadError = errorText(error);
      }
    }
    await this.readSessionPrompt();
    this.render();
  }

  private async loadListing(): Promise<Stat[]> {
    const volume = this.viewVolume();
    if (!volume) return [];
    if (this.nav === "recent") {
      const files = (await this.walk("/")).filter((entry) => entry.type === "file" && !isTrashPath(entry.path));
      files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
      return this.filterQuery(files).slice(0, 40);
    }
    if (this.nav === "starred") {
      const items = (await this.walk("/")).filter((entry) => this.stars.has(entry.path) && !isTrashPath(entry.path));
      return this.filterQuery(sortStats(items, this.sortKey, this.sortDir, true));
    }
    if (this.nav === "trash") {
      const dir = this.cwd.startsWith(TRASH_PATH) ? this.cwd : TRASH_PATH;
      let items: Stat[] = [];
      try {
        items = await volume.ls(dir);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      return this.filterQuery(sortStats(items, this.sortKey, this.sortDir, true));
    }
    if (this.query.trim()) {
      const items = (await this.walk("/")).filter((entry) => !isTrashPath(entry.path));
      return this.filterQuery(sortStats(items, this.sortKey, this.sortDir, true));
    }
    let items: Stat[] = [];
    try {
      items = await volume.ls(this.cwd || "/");
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      if ((this.cwd || "/") !== "/") throw error;
    }
    if ((this.cwd || "/") === "/") items = items.filter((entry) => entry.name !== ".trash");
    return sortStats(this.mergePending(items), this.sortKey, this.sortDir, true);
  }

  private filterQuery(entries: Stat[]): Stat[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => matchesQuery(entry, query));
  }

  private async walk(dir: string): Promise<Stat[]> {
    const volume = this.viewVolume();
    if (!volume) return [];
    let entries: Stat[];
    try {
      entries = await volume.ls(dir);
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    const out: Stat[] = [];
    for (const entry of entries) {
      out.push(entry);
      if (entry.type === "dir") out.push(...(await this.walk(entry.path)));
    }
    return out;
  }

  private async run(task: () => Promise<void>): Promise<boolean> {
    if (!this.volume || this.mainnetBlocked) {
      this.toast(REGISTRY_NOT_DEPLOYED);
      this.render();
      return false;
    }
    this.busy = true;
    this.cas.takeMerged();
    this.render();
    try {
      await this.ensureSession();
      await task();
      return await this.finishRun();
    } catch (error) {
      if (!isSessionPermissionError(error)) {
        return this.failRun(error);
      }
      try {
        await this.waitForRenewal();
        await task();
        return await this.finishRun();
      } catch (retryError) {
        return this.failRun(retryError);
      }
    }
  }

  private async finishRun(): Promise<boolean> {
    const merged = this.cas.takeMerged();
    this.busy = false;
    if (merged) this.toast("Changes merged with a newer version of this volume.");
    await this.refresh();
    return true;
  }

  private async failRun(error: unknown): Promise<boolean> {
    this.cas.takeMerged();
    this.busy = false;
    this.toast(isSessionPermissionError(error) ? "Session expired — Renew (1 signature)" : errorText(error));
    try {
      await this.refresh();
    } catch {
      this.render();
    }
    return false;
  }

  /**
   * Before a session-key action: block inside the safety margin and wait for Renew.
   * Under one day, show the prompt and continue.
   */
  async ensureSession(): Promise<void> {
    if (!this.onEnsureSession) return;
    let gate: SessionGate;
    try {
      gate = await this.onEnsureSession();
    } catch {
      return;
    }
    this.applySessionGate(gate);
    if (gate !== "expired") return;
    await this.waitForRenewal();
  }

  /** Resolves when Renew finishes and the on-chain key is past the safety margin. */
  waitForRenewal(): Promise<void> {
    this.sessionPrompt = "expired";
    if (this.root) this.render();
    return new Promise((resolve) => {
      this.#renewWaiters.push(resolve);
    });
  }

  private applySessionGate(gate: SessionGate): void {
    const next = gate === "ok" ? null : gate;
    if (next === this.sessionPrompt) return;
    this.sessionPrompt = next;
    if (this.root) this.render();
  }

  private async readSessionPrompt(): Promise<void> {
    if (!this.onEnsureSession || this.#renewWaiters.length > 0) return;
    try {
      const gate = await this.onEnsureSession();
      this.sessionPrompt = gate === "ok" ? null : gate;
    } catch {
      // A failed expiry read must not hide a banner the action path already showed.
    }
  }

  private async renewFromBanner(): Promise<void> {
    if (this.#renewing) return;
    if (!this.onRenewSession) {
      this.toast("Connect a wallet first.");
      this.render();
      return;
    }
    this.#renewing = true;
    try {
      await this.onRenewSession();
      let gate: SessionGate = "ok";
      try {
        gate = this.onEnsureSession ? await this.onEnsureSession() : "ok";
      } catch {
        gate = "ok";
      }
      this.sessionPrompt = gate === "ok" ? null : gate;
      this.render();
      if (gate === "expired") return;
      const waiters = this.#renewWaiters.splice(0);
      for (const resolve of waiters) resolve();
    } catch (error) {
      this.toast(isSessionPermissionError(error) ? "Session expired — Renew (1 signature)" : errorText(error));
      this.render();
    } finally {
      this.#renewing = false;
    }
  }

  private toast(text: string): void {
    const id = `t${++this.#toastSeq}`;
    this.toasts = [...this.toasts, { id, text }].slice(-4);
  }

  private toastAction(text: string, action: string, actionLabel: string): void {
    const id = `t${++this.#toastSeq}`;
    this.toasts = [...this.toasts, { id, text, action, actionLabel }].slice(-4);
  }

  /** Drop the open volume so the next read loads another dataset; shows the loading state meanwhile. */
  resetForDataset(): void {
    this.volume = null;
    this.readOnly = false;
    this.#draft = null;
    this.#draftReady = false;
    this.#baseline = null;
    this.entries = [];
    this.selected = [];
    this.looseRows = [];
    this.cwd = "/";
    this.loadState = "loading";
    this.loadError = "";
    this.render();
  }

  private async switchDataset(id: string): Promise<void> {
    this.accountMenu = false;
    if (!id || id === this.panel?.selectedDatasetId) {
      this.render();
      return;
    }
    if (this.staged.length) {
      this.toast("Save or discard your unsaved changes before switching datasets.");
      this.render();
      return;
    }
    this.pickDataset(id);
    if (!this.onSwitchDataset) return;
    try {
      await this.onSwitchDataset(id);
    } catch (error) {
      console.error("FiFolders switch dataset", error);
      this.loadState = "error";
      this.loadError = errorText(error);
      this.render();
    }
  }

  private async uploadList(files: File[], dest: string): Promise<void> {
    if (!files.length || !this.volume) return;
    const payloads = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        rel: file.webkitRelativePath || file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const totalBytes = payloads.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (this.quoteUpload && totalBytes > 0) {
      const quote = await this.quoteUpload({ pieceBytes: totalBytes, copies: DEFAULT_STORAGE_COPIES });
      if (!quote.ready) {
        this.toast(fundingShortfall({ depositNeeded: quote.depositNeeded, needsFwssMaxApproval: quote.needsApproval }, DEFAULT_STORAGE_COPIES));
        this.render();
        return;
      }
    }
    const view = await this.editingVolume();
    const reserved = new Map<string, Set<string>>();
    const ops: StagedOp[] = [];
    const rows: UploadRow[] = [];
    for (const file of payloads) {
      const parent = parentPath(joinPath(dest, file.rel));
      let taken = reserved.get(parent);
      if (!taken) {
        taken = new Set<string>();
        try {
          for (const item of await view.ls(parent)) taken.add(item.name);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
        reserved.set(parent, taken);
      }
      const name = uniqueName(baseName(file.rel), taken);
      taken.add(name);
      const path = joinPath(parent, name);
      const mime = guessMime(file.name, file.type);
      const share = await describeShare(file.bytes);
      ops.push({ op: "put", path, bytes: bytesToB64(file.bytes), mime, ipfs: share.ipfs, importedCar: share.importedCar });
      rows.push({ id: path, name: file.rel, progress: 40, status: "uploading" });
    }
    this.uploads = [...this.uploads, ...rows];
    this.render();
    try {
      await this.stage(ops, { autosave: true });
      const failed = this.autoSaveUploads && ops.some((op) => op.op === "put" && this.staged.some((item) => item.op === "put" && item.path === op.path));
      for (const row of rows) {
        row.progress = 100;
        row.status = failed ? "error" : "done";
      }
    } catch (error) {
      for (const row of rows) row.status = "error";
      this.toast(errorText(error));
    }
    this.render();
  }

  /** Opens a blank editor tab immediately. The file is stored on the first real save. */
  private openNewFel(kind: FelKind, rawName: string): void {
    const requested = felFileName(rawName, kind);
    if (!requested) {
      this.toast("Enter a file name.");
      this.dialog = null;
      this.render();
      return;
    }
    const dir = kind === "felarumi" ? "/FiPen" : "/FiGrid";
    const taken = new Set(
      loadOps()
        .filter((op) => op.path && parentPath(op.path) === dir)
        .map((op) => op.name ?? ""),
    );
    const name = uniqueName(requested, taken);
    const path = joinPath(dir, name);
    const url = appLink(kind, "", name, { felarumi: this.felarumiUrl, felanumio: this.felanumioUrl }, {
      path,
      volume: this.volumeName,
      owner: this.owner,
    });
    window.open(url, "_blank", "noopener");
    this.dialog = null;
    this.beginOp({
      kind: "fel-save",
      label: name,
      path,
      name,
      volume: this.volumeName,
      owner: this.owner,
      stage: "pending",
      mime: "application/json",
      size: 0,
    });
    this.entries = this.mergePending(this.entries);
    this.render();
  }

  private async createFolder(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await this.stage([{ op: "mkdir", path: joinPath(this.destDir(), trimmed) }]);
  }

  private async rename(path: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = joinPath(parentPath(path), trimmed);
    if (next === path) return;
    await this.stage([{ op: "mv", from: path, to: next }]);
    remapFelTargets(path, next);
    this.moveStarPrefix(path, next);
    this.mapOrigins(path, next);
    this.selected = this.selected.map((item) => remap(item, path, next));
    this.render();
  }

  private async makeCopies(paths: string[]): Promise<void> {
    const view = await this.editingVolume();
    const reserved = new Map<string, Set<string>>();
    const ops: StagedOp[] = [];
    for (const path of paths) {
      const parent = parentPath(path);
      let taken = reserved.get(parent);
      if (!taken) {
        taken = new Set((await view.ls(parent)).map((item) => item.name));
        reserved.set(parent, taken);
      }
      const name = uniqueName(copyName(baseName(path)), taken);
      taken.add(name);
      ops.push({ op: "cp", from: path, to: joinPath(parent, name) });
    }
    await this.stage(ops);
  }

  private async movePaths(paths: string[], dest: string): Promise<void> {
    const view = await this.editingVolume();
    const ops: StagedOp[] = [];
    if (dest !== "/") ops.push({ op: "mkdir", path: dest });
    const taken = new Set<string>();
    try {
      for (const item of await view.ls(dest)) taken.add(item.name);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    const moves: { from: string; to: string }[] = [];
    for (const path of paths) {
      if (path === dest || dest.startsWith(`${path}/`)) throw new Error("Can't move a folder into itself.");
      const name = uniqueName(baseName(path), taken);
      taken.add(name);
      const next = joinPath(dest, name);
      if (next === path) continue;
      ops.push({ op: "mv", from: path, to: next });
      moves.push({ from: path, to: next });
    }
    await this.stage(ops);
    for (const move of moves) {
      this.moveStarPrefix(move.from, move.to);
      this.mapOrigins(move.from, move.to);
      this.selected = this.selected.map((item) => remap(item, move.from, move.to));
    }
    this.render();
  }

  private async trashPaths(paths: string[]): Promise<void> {
    const view = await this.editingVolume();
    const ops: StagedOp[] = [{ op: "mkdir", path: TRASH_PATH }];
    const taken = new Set<string>();
    try {
      for (const item of await view.ls(TRASH_PATH)) taken.add(item.name);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    const moves: { from: string; to: string }[] = [];
    for (const path of paths) {
      if (isTrashPath(path)) continue;
      const name = uniqueName(baseName(path), taken);
      taken.add(name);
      const dest = `${TRASH_PATH}/${name}`;
      ops.push({ op: "mv", from: path, to: dest });
      moves.push({ from: path, to: dest });
    }
    if (!moves.length) return;
    await this.stage(ops);
    for (const move of moves) {
      this.origins[move.to] = move.from;
      this.moveStarPrefix(move.from, move.to);
      this.selected = this.selected.map((item) => (item === move.from ? move.to : item));
    }
    this.writeOrigins();
    this.render();
  }

  private async restorePaths(paths: string[]): Promise<void> {
    const view = await this.editingVolume();
    const ops: StagedOp[] = [];
    const moves: { from: string; to: string }[] = [];
    for (const path of paths) {
      const origin = this.origins[path] ?? joinPath("/", baseName(path));
      const parent = parentPath(origin);
      if (parent !== "/") ops.push({ op: "mkdir", path: parent });
      let dest = origin;
      try {
        await view.stat(dest);
        const siblings = await view.ls(parent);
        dest = joinPath(parent, uniqueName(baseName(origin), new Set(siblings.map((item) => item.name))));
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      ops.push({ op: "mv", from: path, to: dest });
      moves.push({ from: path, to: dest });
    }
    await this.stage(ops);
    for (const move of moves) {
      delete this.origins[move.from];
      this.moveStarPrefix(move.from, move.to);
    }
    this.writeOrigins();
    this.render();
  }

  private async deleteForever(paths: string[]): Promise<void> {
    await this.stage(paths.map((path) => ({ op: "rm" as const, path })));
    for (const path of paths) {
      delete this.origins[path];
      for (const star of [...this.stars]) {
        if (star === path || star.startsWith(`${path}/`)) this.stars.delete(star);
      }
    }
    this.writeOrigins();
    this.writeStars();
    this.selected = [];
    this.render();
  }

  private moveStarPrefix(from: string, to: string): void {
    const next = new Set<string>();
    for (const star of this.stars) next.add(remap(star, from, to));
    this.stars = next;
    this.writeStars();
  }

  private mapOrigins(from: string, to: string): void {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.origins)) next[remap(key, from, to)] = remap(value, from, to);
    this.origins = next;
    this.writeOrigins();
  }

  private async openPath(path: string): Promise<void> {
    const volume = this.viewVolume();
    if (!volume) return;
    const stat = await volume.stat(path);
    if (stat.type === "dir") {
      this.nav = isTrashPath(stat.path) ? "trash" : "drive";
      this.cwd = stat.path;
      this.query = "";
      this.selected = [];
      this.anchor = null;
      await this.refresh();
      return;
    }
    if (felKind(stat.name)) {
      this.openFel(stat);
      return;
    }
    const bytes = await volume.get(path);
    const mime = guessMime(stat.name, stat.mime);
    const kindPreview = previewKind(mime, bytes);
    this.revokePreview();
    if (kindPreview === "text") this.preview = { name: stat.name, kind: "text", text: new TextDecoder().decode(bytes) };
    else if (kindPreview === "none") this.preview = { name: stat.name, kind: "none" };
    else this.preview = { name: stat.name, kind: kindPreview, url: URL.createObjectURL(toBlob(bytes, mime)) };
    this.render();
  }

  private async downloadPath(path: string): Promise<void> {
    const volume = this.viewVolume();
    if (!volume) return;
    const stat = await volume.stat(path);
    if (stat.type === "dir") return;
    this.downloads.scope = this.scopeKey();
    this.downloads.enqueue({
      id: path,
      name: stat.name,
      cid: stat.pieceCid || stat.ipfs,
      deletionScheduled: this.removalScheduled(stat),
      run: async (stage) => {
        stage("Downloading from storage provider");
        const bytes = await volume.get(path);
        stage("Preparing original file");
        const blob = toBlob(bytes, guessMime(stat.name, stat.mime));
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = stat.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
    });
    await this.downloads.idle;
  }

  private async showDetails(path: string): Promise<void> {
    const volume = this.viewVolume();
    const real = this.volume;
    if (!volume || !real) return;
    const stat = await volume.stat(path);
    const history = await real.history(path);
    const head = await real.registry.head(real.owner, real.ns, real.key);
    let pieceCid = stat.pieceCid ?? "";
    if (!pieceCid) {
      const commits = await real.history();
      pieceCid = commits.at(-1)?.pieceCid ?? "";
    }
    const catalog = loadCopyCatalog(this.scopeKey())[stat.located || ""] ?? [];
    const serviceURLs = catalog.map((copy) => copy.serviceURL).filter(Boolean);
    const shareUrl = fileShareLink({
      name: stat.name,
      cid: stat.ipfs,
      pieceCid: stat.located || stat.pieceCid,
      importedCar: stat.importedCar,
      serviceURLs,
      removalScheduled: this.removalScheduled(stat),
      uploadComplete: true,
      encrypted: this.encrypted,
    });
    const indexing = stat.ipfs ? indexingLabel(localIndexStore(this.scopeKey()).read()[stat.ipfs]) : undefined;
    this.details = {
      stat,
      history,
      version: head.version,
      pieceCid,
      ...(shareUrl ? { shareUrl, qr: qrSvg(shareUrl) } : {}),
      copies: catalog.length || (stat.type === "file" ? DEFAULT_STORAGE_COPIES : 0),
      providers: catalog.map((copy) => copy.providerId),
      ...(indexing ? { indexing } : {}),
      previewable: stat.type === "file" && canPreviewName(stat.name, stat.ipfs, stat.importedCar),
    };
    this.render();
  }

  private toggleStar(paths: string[]): void {
    const clear = paths.every((path) => this.stars.has(path));
    for (const path of paths) {
      if (clear) this.stars.delete(path);
      else this.stars.add(path);
    }
    this.writeStars();
    this.render();
  }

  private async openMove(paths: string[]): Promise<void> {
    const folders = [{ path: "/", label: "My Drive" }];
    for (const entry of await this.walk("/")) {
      if (entry.type === "dir" && !isTrashPath(entry.path)) folders.push({ path: entry.path, label: entry.path });
    }
    const usable = folders.filter((folder) =>
      paths.every((path) => path !== folder.path && !folder.path.startsWith(`${path}/`) && parentPath(path) !== folder.path),
    );
    const choices = usable.length ? usable : folders;
    this.dialog = {
      mode: "move",
      title: "Move to",
      submit: "Move",
      value: "",
      paths,
      dest: choices[0]?.path ?? "/",
      folders: choices,
    };
    this.render();
  }

  private revokePreview(): void {
    if (this.preview?.url) URL.revokeObjectURL(this.preview.url);
    this.preview = null;
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const actionEl = target.closest<HTMLElement>("[data-action]");
    const action = actionEl?.getAttribute("data-action") ?? "";
    if (action === "renew-session") {
      void this.renewFromBanner();
      return;
    }
    if (action === "readonly-connect") {
      const connect = this.onConnect;
      if (connect) {
        void connect({ chain: this.chain, volumeName: this.volumeName, encrypt: this.encryptPref }).catch((error: unknown) => {
          this.toast(errorText(error));
          this.render();
        });
      }
      return;
    }
    if (
      action === "authorize" ||
      action === "fix-payments" ||
      action === "add-funds" ||
      action === "create-dataset" ||
      action === "refresh-session" ||
      action === "open-drive"
    ) {
      void this.enqueue(async () => {
        try {
          await this.onSetupAction?.(action);
        } catch (error) {
          const message = isSessionPermissionError(error) ? "Session expired — Renew (1 signature)" : errorText(error);
          this.setupError = message;
          this.connectError = this.volume ? "" : message;
          if (isSessionPermissionError(error)) this.sessionPrompt = "expired";
          this.render();
        }
      });
      return;
    }
    const inMenu = Boolean(target.closest("[data-menu]"));
    if (!inMenu) {
      this.newMenu = false;
      this.context = null;
      if (action !== "account" && action !== "open-datasets") this.accountMenu = false;
    }
    if (action === "new-toggle") {
      this.newMenu = !this.newMenu;
      this.context = null;
      this.accountMenu = false;
      this.render();
      return;
    }
    if (action === "open-datasets") {
      this.accountMenu = true;
      this.newMenu = false;
      this.toasts = this.toasts.filter((toast) => toast.action !== "open-datasets");
      this.render();
      this.root?.querySelector("#wallet-datasets")?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (action === "switch-dataset") {
      void this.switchDataset(actionEl?.dataset.id ?? "");
      return;
    }
    if (action === "account") {
      this.accountMenu = !this.accountMenu;
      this.newMenu = false;
      this.render();
      return;
    }
    if (action === "costs-close") {
      if (actionEl !== target && actionEl?.classList.contains("costs-backdrop")) return;
      this.costsOpen = false;
      this.render();
      return;
    }
    if (action === "wallet-retry" || action === "wallet-cancel") {
      const prompt = walletPrompts().find((item) => String(item.id) === actionEl?.dataset.id);
      if (action === "wallet-retry") prompt?.retry();
      else prompt?.cancel();
      return;
    }
    if (action === "dismiss-activity") {
      const id = actionEl?.dataset.id ?? "";
      const op = loadOps().find((item) => item.id === id);
      if (op) dismissActivity(`${op.id}@${op.updated}`);
      dropOp(id);
      this.dismissRow(id);
      return;
    }
    if (action === "toggle-txlog") {
      this.txlogOpen = !this.txlogOpen;
      this.render();
      return;
    }
    if (action === "show-costs") {
      this.accountMenu = false;
      this.newMenu = false;
      this.costsOpen = true;
      this.render();
      return;
    }
    if (action === "retry-load") {
      this.loadState = "loading";
      this.loadError = "";
      this.render();
      if (!this.volume && this.onRetryLoad) void this.onRetryLoad();
      else void this.enqueue(() => this.refresh());
      return;
    }
    if (action === "retry-activity") {
      const id = actionEl?.dataset.id ?? "";
      void this.enqueue(() => this.retryOp(id));
      return;
    }
    if (action === "loose-download" || action === "loose-open") {
      const cid = actionEl?.dataset.cid ?? "";
      void this.enqueue(() => (action === "loose-download" ? this.downloadLoose(cid) : this.openLoose(cid)));
      return;
    }
    if (action === "cancel-download") {
      this.downloads.cancel(actionEl?.dataset.id ?? "");
      return;
    }
    if (action === "check-indexing") {
      const cid = actionEl?.dataset.cid ?? "";
      if (!cid) return;
      void this.enqueue(async () => {
        await runIndexingCheck(localIndexStore(this.scopeKey()), cid, this.indexProbe ?? (async () => false));
        if (this.details?.stat.ipfs === cid) await this.showDetails(this.details.stat.path);
      });
      return;
    }
    if (action === "chain") {
      const chain = actionEl?.dataset.chain === "mainnet" ? "mainnet" : "calibration";
      this.chain = chain;
      saveNetworkPreference(chain);
      this.mainnetBlocked = chain === "mainnet" && !registryReady("mainnet");
      this.render();
      return;
    }
    if (action === "nav") {
      const nav = (actionEl?.dataset.nav ?? "drive") as NavId;
      void this.enqueue(() => this.setNav(nav));
      return;
    }
    if (action === "crumb") {
      const path = decodeURIComponent(actionEl?.dataset.path ?? "");
      if (!path) return;
      void this.enqueue(async () => {
        if (path === TRASH_PATH || path.startsWith(`${TRASH_PATH}/`)) this.nav = "trash";
        else this.nav = "drive";
        this.cwd = path;
        this.selected = [];
        await this.refresh();
      });
      return;
    }
    if (action === "view-list" || action === "view-grid") {
      this.view = action === "view-grid" ? "grid" : "list";
      localStorage.setItem("fifolders:view", this.view);
      this.render();
      return;
    }
    if (action === "sort") {
      const key = (actionEl?.dataset.sort ?? "name") as SortKey;
      this.applySort(key);
      void this.enqueue(() => this.refresh());
      return;
    }
    if (action === "upload-file" || action === "upload-folder") {
      this.newMenu = false;
      this.render();
      const testid = action === "upload-file" ? "file-input" : "folder-input";
      this.root?.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)?.click();
      return;
    }
    if (action === "new-folder") {
      this.newMenu = false;
      this.dialog = { mode: "new-folder", title: "New folder", submit: "Create", value: "" };
      this.render();
      return;
    }
    if (action === "new-felarumi" || action === "new-felanumio") {
      this.newMenu = false;
      // No name prompt: the editor's title names the file once it saves.
      const kind: FelKind = action === "new-felanumio" ? "felanumio" : "felarumi";
      this.openNewFel(kind, defaultFelTitle(kind));
      return;
    }
    if (action === "close-dialog") {
      this.dialog = null;
      this.render();
      return;
    }
    if (action === "close-preview") {
      this.revokePreview();
      this.render();
      return;
    }
    if (action === "close-details") {
      this.details = null;
      this.render();
      return;
    }
    if (action === "dismiss-uploads") {
      this.uploads = [];
      this.render();
      return;
    }
    if (action === "loose-expand") {
      const cid = actionEl?.dataset.cid ?? "";
      if (this.looseExpanded.has(cid)) this.looseExpanded.delete(cid);
      else this.looseExpanded.add(cid);
      this.render();
      return;
    }
    if (action === "loose-entry-download") {
      const piece = this.looseRows.find((item) => item.pieceCid === actionEl?.dataset.cid);
      const path = actionEl?.dataset.path ?? "";
      if (!piece) return;
      try {
        const bytes = directoryFile(piece, path);
        const name = path.split("/").pop() || "file";
        this.downloadBytes(bytes, name, sniffMime(name, bytes));
      } catch (error) {
        this.toast(errorText(error));
        this.render();
      }
      return;
    }
    if (action === "dismiss-toast") {
      const id = actionEl?.dataset.id;
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
      this.render();
      return;
    }
    if (action === "save-changes") {
      void this.enqueue(() => this.saveStaged());
      return;
    }
    if (action === "discard-changes") {
      void this.enqueue(() => this.discardStaged());
      return;
    }
    if (action === "disconnect") {
      this.volume = null;
      this.owner = "";
      this.encrypted = false;
      this.accountMenu = false;
      this.details = null;
      this.onDisconnect?.();
      this.render();
      return;
    }
    if (action === "copy-cid" && this.details?.pieceCid) {
      void this.enqueue(() => this.copyText(this.details!.pieceCid));
      return;
    }
    if (this.context && action) {
      const paths = this.context.paths;
      const targetPath = this.context.target;
      const target = this.entries.find((entry) => entry.path === targetPath);
      this.context = null;
      if (action === "open" && target && felKind(target.name)) {
        this.openFel(target);
        this.render();
        return;
      }
      void this.enqueue(() => this.runContext(action, paths, targetPath));
      return;
    }
    const entry = target.closest<HTMLElement>("[data-testid=entry]");
    if (entry?.dataset.path) {
      const path = decodeURIComponent(entry.dataset.path);
      const next = applySelection({
        ordered: this.entries.map((item) => item.path),
        selected: this.selected,
        anchor: this.anchor,
        path,
        shift: event.shiftKey,
        toggle: event.ctrlKey || event.metaKey,
      });
      this.selected = next.selected;
      this.anchor = next.anchor;
      this.paintSelection();
    }
  }

  private paintSelection(): void {
    const selected = new Set(this.selected);
    for (const node of this.root?.querySelectorAll<HTMLElement>("[data-testid=entry]") ?? []) {
      const path = decodeURIComponent(node.dataset.path ?? "");
      node.dataset.selected = selected.has(path) ? "true" : "false";
    }
  }

  private async setNav(nav: NavId): Promise<void> {
    this.nav = nav;
    this.selected = [];
    this.anchor = null;
    this.query = "";
    if (nav === "drive" && isTrashPath(this.cwd)) this.cwd = "/";
    if (nav === "trash") this.cwd = TRASH_PATH;
    await this.refresh();
  }

  private applySort(key: SortKey): void {
    if (this.sortKey === key) this.sortDir = this.sortDir === 1 ? -1 : 1;
    else {
      this.sortKey = key;
      this.sortDir = defaultSortDir(key);
    }
  }

  private async runContext(action: string, paths: string[], target: string): Promise<void> {
    if (action === "open") return this.openPath(target);
    if (action === "download") return this.downloadPath(target);
    if (action === "rename") {
      this.dialog = { mode: "rename", title: "Rename", submit: "Rename", value: baseName(target), path: target };
      this.render();
      return;
    }
    if (action === "move") return this.openMove(paths);
    if (action === "copy") return this.makeCopies(paths);
    if (action === "star") {
      this.toggleStar(paths);
      return;
    }
    if (action === "trash") return this.trashPaths(paths);
    if (action === "restore") return this.restorePaths(paths);
    if (action === "delete-forever") return this.deleteForever(paths);
    if (action === "details") return this.showDetails(target);
  }

  private onDblClick(event: MouseEvent): void {
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-testid=entry]");
    if (!entry?.dataset.path) return;
    const path = decodeURIComponent(entry.dataset.path);
    const stat = this.entries.find((item) => item.path === path);
    if (stat && felKind(stat.name)) {
      this.openFel(stat);
      return;
    }
    void this.enqueue(() => this.openPath(path));
  }

  private onContextMenu(event: MouseEvent): void {
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-testid=entry]");
    if (!entry?.dataset.path) {
      if ((event.target as HTMLElement | null)?.closest("[data-testid=browser]")) event.preventDefault();
      return;
    }
    event.preventDefault();
    const path = decodeURIComponent(entry.dataset.path);
    if (!this.selected.includes(path)) {
      this.selected = [path];
      this.anchor = path;
    }
    this.newMenu = false;
    this.accountMenu = false;
    this.context = { x: event.clientX, y: event.clientY, paths: [...this.selected], target: path };
    this.render();
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    if (target instanceof HTMLInputElement && target.name === "dataset") {
      this.pickDataset(target.value);
      void this.enqueue(async () => {
        try {
          await this.onSetupAction?.("select-dataset", target.value);
        } catch (error) {
          this.setupError = errorText(error);
          this.render();
        }
      });
      return;
    }
    if (target instanceof HTMLSelectElement && target.dataset.testid === "dataset-select") {
      const id = target.value;
      this.pickDataset(id);
      void this.enqueue(async () => {
        try {
          await this.onSetupAction?.("select-dataset", id);
        } catch (error) {
          this.setupError = errorText(error);
          this.render();
        }
      });
      return;
    }
    if (target instanceof HTMLSelectElement && target.dataset.testid === "sort-select") {
      this.sortKey = target.value as SortKey;
      this.sortDir = defaultSortDir(this.sortKey);
      void this.enqueue(() => this.refresh());
      return;
    }
    if (target instanceof HTMLSelectElement && target.dataset.testid === "move-dest") {
      if (this.dialog?.mode === "move") this.dialog.dest = decodeURIComponent(target.value);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.testid === "autosave-uploads") {
      this.autoSaveUploads = target.checked;
      localStorage.setItem("fifolders:autosave-uploads", target.checked ? "1" : "0");
      return;
    }
    if (!(target instanceof HTMLInputElement) || target.type !== "file" || !target.files) return;
    const files = [...target.files];
    target.value = "";
    const dest = this.destDir();
    void this.enqueue(() => this.uploadList(files, dest));
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    if (target.dataset.testid === "search") {
      this.query = target.value;
      void this.enqueue(() => this.refresh());
      return;
    }
    if (target.dataset.testid === "felarumi-url") {
      this.felarumiUrl = target.value;
      localStorage.setItem("fifolders:fipen-url", target.value);
      return;
    }
    if (target.dataset.testid === "felanumio-url") {
      this.felanumioUrl = target.value;
      localStorage.setItem("fifolders:figrid-url", target.value);
      return;
    }
    if (target.dataset.testid === "dialog-input" && this.dialog && this.dialog.mode !== "move") {
      this.dialog.value = target.value;
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.newMenu = false;
      this.context = null;
      this.accountMenu = false;
      this.dialog = null;
      this.revokePreview();
      this.render();
      return;
    }
    const typing = (event.target as HTMLElement | null)?.closest("input, textarea, select");
    if (event.key === "Delete" && !typing && this.selected.length && this.volume && !this.mainnetBlocked) {
      const paths = [...this.selected];
      void this.enqueue(() => (this.nav === "trash" ? this.deleteForever(paths) : this.trashPaths(paths)));
    }
  }

  private async onSubmit(event: Event): Promise<void> {
    const form = event.target as HTMLFormElement | null;
    if (!form) return;
    if (form.dataset.testid === "connect") {
      const data = new FormData(form);
      const volumeName = String(data.get("volume") ?? "").trim() || "My Drive";
      const encrypt = form.querySelector<HTMLInputElement>("[data-testid=encrypt]")?.checked ?? false;
      const wallet = String(data.get("wallet") ?? "");
      if (wallet) this.walletRdns = wallet;
      this.volumeName = volumeName;
      this.encryptPref = encrypt;
      if (this.chain === "mainnet" && !registryReady("mainnet")) {
        this.connectError = REGISTRY_NOT_DEPLOYED;
        this.render();
        return;
      }
      // A click right after load can beat wallet discovery (EIP-6963 announce); wait briefly instead of failing.
      for (let i = 0; i < 50 && !this.onConnect; i++) await new Promise((resolve) => setTimeout(resolve, 200));
      if (!this.onConnect) {
        this.connectError = "No injected wallet found. Install a browser wallet such as MetaMask.";
        this.render();
        return;
      }
      try {
        await this.onConnect({ chain: this.chain, volumeName, encrypt });
      } catch (error) {
        this.connectError = errorText(error);
        this.render();
      }
      return;
    }
    if (!this.dialog) return;
    if (this.dialog.mode === "new-folder") {
      const name = form.querySelector<HTMLInputElement>("[data-testid=dialog-input]")?.value ?? this.dialog.value;
      this.dialog = null;
      await this.createFolder(name);
      return;
    }
    if (this.dialog.mode === "new-felarumi" || this.dialog.mode === "new-felanumio") {
      const name = form.querySelector<HTMLInputElement>("[data-testid=dialog-input]")?.value ?? this.dialog.value;
      const kind: FelKind = this.dialog.mode === "new-felarumi" ? "felarumi" : "felanumio";
      this.openNewFel(kind, name);
      return;
    }
    if (this.dialog.mode === "rename" && this.dialog.path) {
      const name = form.querySelector<HTMLInputElement>("[data-testid=dialog-input]")?.value ?? this.dialog.value;
      const path = this.dialog.path;
      this.dialog = null;
      await this.rename(path, name);
      return;
    }
    if (this.dialog.mode === "move" && this.dialog.paths) {
      const select = form.querySelector<HTMLSelectElement>("[data-testid=move-dest]");
      const dest = select ? decodeURIComponent(select.value) : (this.dialog.dest ?? "/");
      const paths = this.dialog.paths;
      this.dialog = null;
      await this.movePaths(paths, dest);
    }
  }

  private async copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    this.toast("Copied Piece CID");
    this.render();
  }

  private onDragStart(event: DragEvent): void {
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-testid=entry]");
    if (!entry?.dataset.path) return;
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const path = decodeURIComponent(entry.dataset.path);
    const paths = this.selected.includes(path) ? [...this.selected] : [path];
    transfer.setData("application/x-fifolders-paths", JSON.stringify(paths));
    transfer.setData("text/plain", paths.join("\n"));
    transfer.effectAllowed = "move";
    this.dragPaths = paths;
  }

  dragPaths: string[] = [];

  private onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes("Files") ? "copy" : "move";
    this.root?.querySelector("[data-testid=browser]")?.classList.add("dragover");
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-testid=entry]");
    this.root?.querySelectorAll("[data-drop=true]").forEach((node) => node.setAttribute("data-drop", "false"));
    if (entry?.dataset.type === "dir" && entry.dataset.path) entry.setAttribute("data-drop", "true");
  }

  private onDragLeave(event: DragEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && this.root?.contains(next)) return;
    this.root?.querySelector("[data-testid=browser]")?.classList.remove("dragover");
  }

  private onDrop(event: DragEvent): void {
    event.preventDefault();
    this.root?.querySelector("[data-testid=browser]")?.classList.remove("dragover");
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-testid=entry]");
    const droppedOnDir = entry?.dataset.type === "dir" && entry.dataset.path ? decodeURIComponent(entry.dataset.path) : null;
    this.root?.querySelectorAll("[data-drop=true]").forEach((node) => node.setAttribute("data-drop", "false"));
    const raw = event.dataTransfer?.getData("application/x-fifolders-paths");
    const internal = raw || this.dragPaths.length ? raw || JSON.stringify(this.dragPaths) : "";
    this.dragPaths = [];
    if (internal) {
      let paths: string[] = [];
      try {
        paths = JSON.parse(internal) as string[];
      } catch {
        paths = [];
      }
      const dest = droppedOnDir ?? this.destDir();
      if (paths.length) void this.enqueue(() => this.movePaths(paths, dest));
      return;
    }
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      const dest = droppedOnDir ?? this.destDir();
      const list = [...files];
      void this.enqueue(() => this.uploadList(list, dest));
    }
  }

  private captureTransient(): void {
    const root = this.root;
    if (!root) return;
    const volume = root.querySelector<HTMLInputElement>("[data-testid=volume-name]");
    if (volume) this.volumeName = volume.value;
    const encrypt = root.querySelector<HTMLInputElement>("[data-testid=encrypt]");
    if (encrypt) this.encryptPref = encrypt.checked;
    const search = root.querySelector<HTMLInputElement>("[data-testid=search]");
    if (search && document.activeElement === search) this.query = search.value;
    const felarumi = root.querySelector<HTMLInputElement>("[data-testid=felarumi-url]");
    if (felarumi) this.felarumiUrl = felarumi.value;
    const felanumio = root.querySelector<HTMLInputElement>("[data-testid=felanumio-url]");
    if (felanumio) this.felanumioUrl = felanumio.value;
    const dialogInput = root.querySelector<HTMLInputElement>("[data-testid=dialog-input]");
    if (dialogInput && this.dialog && this.dialog.mode !== "move") this.dialog.value = dialogInput.value;
  }

  private render(): void {
    if (!this.root) return;
    this.captureTransient();
    const focus = captureFocus(this.root);
    let html: string;
    try {
      html = renderApp(this.toModel());
    } catch (error) {
      // A bad value (e.g. a bigint mixed with a number) must not blank the screen.
      console.error("FiFolders render", error);
      if (this.#renderFailed) return;
      this.#renderFailed = true;
      this.toast(`Display error: ${errorText(error)}`);
      this.#renderFailed = false;
      return;
    }
    this.root.innerHTML = html;
    restoreFocus(this.root, focus);
    const menu = this.root.querySelector<HTMLElement>("[data-testid=context-menu]");
    if (menu) {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
      if (rect.bottom > window.innerHeight - 8) menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
    if (this.dialog?.mode !== "move") {
      const input = this.root.querySelector<HTMLInputElement>("[data-testid=dialog-input]");
      if (input && this.dialog && document.activeElement !== input) input.focus();
    }
  }

  #promptOps = new Map<number, string>();

  /** One Transaction-log row per wallet prompt, named with purpose and cost. */
  private logWalletPrompts(prompts: WalletPrompt[]): void {
    const live = new Set(prompts.map((prompt) => prompt.id));
    for (const prompt of prompts) {
      if (prompt.intent.logged || this.#promptOps.has(prompt.id)) continue;
      this.#promptOps.set(prompt.id, this.beginOp({ kind: "wallet", label: intentText(prompt.intent), stage: "signing" }));
    }
    for (const [id, op] of this.#promptOps) {
      if (live.has(id)) continue;
      this.#promptOps.delete(id);
      this.finishOp(op);
    }
  }

  noteChain(report: ChainReport): void {
    const title = chainStepTitle(report);
    const href = report.hash ? explorerHref(this.chain, report.hash) : "";
    const step: ChainStepView = { id: report.hash || `${report.flow}-${report.phase}`, title, detail: stepDetail(report), href, phase: report.phase };
    const index = this.chainSteps.findIndex((item) => item.title === title);
    this.chainSteps = index >= 0 ? this.chainSteps.map((item, i) => (i === index ? step : item)) : [...this.chainSteps, step];
    const id = `chain:${report.flow}`;
    if (report.phase === "signing") {
      this.beginOp({ id, kind: report.flow === "session" ? "session" : "deposit", label: report.label ?? (report.flow === "session" ? "Authorize session key" : "Approve storage payments"), stage: "signing" });
    } else if (report.phase === "done") this.finishOp(id);
    else patchOp(id, { stage: report.phase, txHash: report.hash });
    if (this.root && !this.volume) this.render();
  }

  beginOp(partial: { id?: string; kind: OpKind; label: string; stage?: string; path?: string; name?: string; size?: number; mime?: string; volume?: string; owner?: string }): string {
    const id = partial.id ?? `op-${Date.now()}-${++this.#opSeq}`;
    upsertOp(newOp({ ...partial, id }));
    return id;
  }

  finishOp(id: string): void {
    const op = loadOps().find((item) => item.id === id);
    if (op) this.rememberDone(op);
    dropOp(id);
    if (this.root) this.render();
  }

  failOp(id: string, error: string): void {
    patchOp(id, { status: "error", stage: "error", error });
    if (this.root) this.render();
  }

  private rememberDone(op: FifoldersOp): void {
    const label = op.kind === "fel-save" ? `${op.name ?? op.label} saved` : op.label;
    const row: ActivityRow = { id: op.id, label, status: "done" };
    this.recentDone = [row, ...this.recentDone.filter((item) => item.id !== op.id)].slice(0, 8);
    this.#doneAt.set(op.id, Date.now());
    setTimeout(() => this.dismissRow(op.id), ACTIVITY_DISMISS_MS);
  }

  #doneAt = new Map<string, number>();
  #renderFailed = false;

  private dismissRow(id: string): void {
    this.recentDone = this.recentDone.filter((item) => item.id !== id);
    this.#doneAt.delete(id);
    if (this.root) this.render();
  }

  private listenForOps(): void {
    if (this.#opsListening || typeof window === "undefined") return;
    this.#opsListening = true;
    window.addEventListener("beforeunload", (event) => {
      const pending = loadOps().some((op) => op.status === "pending") || this.busy || this.staged.length > 0;
      if (!pending) return;
      event.preventDefault();
      event.returnValue = "";
    });
    window.addEventListener("storage", (event) => {
      if (event.key === OPS_KEY) void this.enqueue(() => this.refresh());
    });
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-menu], [data-action=account], [data-action=new-toggle], [data-action=open-datasets]")) return;
      if (!this.newMenu && !this.accountMenu && !this.context) return;
      this.newMenu = false;
      this.accountMenu = false;
      this.context = null;
      this.root?.querySelectorAll("[data-menu]").forEach((node) => node.remove());
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!this.newMenu && !this.accountMenu && !this.context && !this.dialog && !this.preview && !this.costsOpen) return;
      this.costsOpen = false;
      this.newMenu = false;
      this.accountMenu = false;
      this.context = null;
      this.dialog = null;
      this.revokePreview();
      this.render();
    });
    try {
      const channel = new BroadcastChannel(OPS_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { want?: string; path?: string; nonce?: string } | null;
        if (data && typeof data.want === "string") {
          // An editor tab opened a file from this drive and asks for its bytes (same origin, decrypted).
          void this.answerOpen(channel, data.want, data.path ?? "", data.nonce ?? "");
          return;
        }
        void this.enqueue(() => this.refresh());
      };
    } catch {
      // BroadcastChannel is optional.
    }
  }

  private async loadQuote(): Promise<void> {
    try {
      const { CALIBRATION_RPC } = await import("./session.js");
      const { Synapse } = await import("@filoz/synapse-sdk");
      const { calibration } = await import("@filoz/synapse-core/chains");
      const { http } = await import("viem");
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      const account = privateKeyToAccount(generatePrivateKey());
      const synapse = Synapse.create({
        account: account.address,
        chain: calibration,
        transport: http(CALIBRATION_RPC),
        source: "fifolders",
      });
      const info = await synapse.storage.getStorageInfo();
      let ratePerMonth: bigint | undefined;
      try {
        const costs = await synapse.storage.getUploadCosts({ dataSize: 1024n * 1024n * 1024n, withCDN: false });
        ratePerMonth = costs.rate.perMonth;
      } catch {
        ratePerMonth = undefined;
      }
      const { quoteFromLive } = await import("./pricing.js");
      this.quote = quoteFromLive({
        perTiBNoCdn: info.pricing.noCDN.perTiBPerMonth,
        perTiBWithCdn: info.pricing.withCDN.perTiBPerMonth,
        ratePerMonth,
      });
      if (this.costsOpen) this.render();
    } catch {
      this.quote = fallbackQuote();
    }
  }

  private saveCurrentView(): void {
    if (!this.owner) return;
    saveView(this.owner, this.volumeName, { nav: this.nav, cwd: this.cwd, volume: this.volumeName });
  }

  private mergePending(entries: Stat[]): Stat[] {
    const ops = loadOps().filter((op) => (op.kind === "upload" || op.kind === "fel-save") && op.path && op.name && op.status !== "done");
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const cwd = this.cwd || "/";
    if (cwd === "/" && this.nav === "drive") {
      for (const name of ["FiPen", "FiGrid", "Felarumi", "Felanumio"]) {
        const path = `/${name}`;
        if (ops.some((op) => op.path?.startsWith(`${path}/`)) && !byPath.has(path)) {
          byPath.set(path, { name, path, type: "dir", size: 0, mtime: Date.now() });
        }
      }
    }
    for (const op of ops) {
      const parent = parentPath(op.path ?? "/");
      const showHere = parent === cwd || (cwd === "/" && this.nav === "drive" && op.kind === "fel-save");
      if (!showHere || byPath.has(op.path ?? "")) continue;
      byPath.set(op.path ?? "", {
        name: op.name ?? "",
        path: op.path ?? "",
        type: "file",
        size: op.size ?? 0,
        mtime: op.updated,
        mime: op.mime,
        pieceCid: op.pieceCid,
      });
    }
    return [...byPath.values()];
  }

  private async reconcileOps(): Promise<void> {
    if (!this.#opsAdopted) {
      this.#opsAdopted = true;
      for (const op of loadOps()) {
        if (op.kind === "upload" && op.status === "pending" && !op.pieceCid) {
          patchOp(op.id, { status: "error", stage: "interrupted", error: "Upload interrupted" });
        }
      }
    }
    const volume = this.volume;
    // A public read cannot commit; queued editor saves wait for the writable volume.
    if (!volume || this.readOnly) return;
    let edited = false;
    for (const op of loadOps()) {
      if ((op.kind === "upload" || op.kind === "commit") && op.path && op.pieceCid) {
        try {
          const stat = await volume.stat(op.path);
          if (!stat.pieceCid || stat.pieceCid === op.pieceCid) {
            this.rememberDone(op);
            dropOp(op.id);
          }
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      if (op.kind !== "fel-save" || !op.path || !op.content || isBlankFelContent(op.content)) continue;
      const target = felTarget(op.path, op.title);
      const path = target.to;
      const next = new TextEncoder().encode(op.content);
      try {
        const current = await volume.get(path);
        if (sameBytes(current, next)) {
          this.rememberDone(op);
          dropOp(op.id);
          dropFelPlaceholders(op.path, op.id);
          continue;
        }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      // Parent folder and file entry commit with the document bytes, one piece.
      let renameFrom = "";
      if (target.from !== path) {
        try {
          await volume.get(target.from);
          renameFrom = target.from;
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      const stat = await volume.tx(async (draft) => {
        const parent = parentPath(path);
        if (parent !== "/") await draft.mkdir(parent);
        if (renameFrom) await draft.mv(renameFrom, path);
        return draft.put(path, next, { mime: "application/json" });
      });
      rememberFelTarget(op.path, path, op.title);
      this.rememberDone({ ...op, pieceCid: stat.pieceCid, stage: "saved" });
      dropOp(op.id);
      dropFelPlaceholders(op.path, op.id);
      edited = true;
    }
    if (edited && this.#draft) await this.rebuildDraft();
  }

  private async answerOpen(channel: BroadcastChannel, pieceCid: string, path: string, nonce: string): Promise<void> {
    const volume = this.volume;
    if (!volume || !path) return;
    try {
      const stat = await volume.stat(path);
      if (stat.pieceCid && pieceCid && stat.pieceCid !== pieceCid) return;
      const bytes = await volume.get(path);
      channel.postMessage({ have: pieceCid, path, nonce, bytes });
    } catch {
      // Not in this volume; the editor falls back to public sources.
    }
  }

  private async retryOp(id: string): Promise<void> {
    const op = loadOps().find((item) => item.id === id);
    if (!op) return;
    if (op.kind === "fel-save" && op.content && !isBlankFelContent(op.content)) {
      patchOp(id, { status: "pending", stage: "saving", error: "" });
      await this.refresh();
      return;
    }
    this.toast(op.pieceCid ? "Still waiting for that piece to show up in the volume." : "Upload interrupted. Choose the file again.");
    this.render();
  }

  /**
   * Live datasets have no in-memory piece map, so this used to return nothing on Synapse.
   * List the dataset's piece CIDs, then read only the ones no folder entry points at.
   */
  private async collectLoose(tree: Stat[]): Promise<LoosePiece[]> {
    const referenced = new Set(tree.flatMap((entry) => (entry.pieceCid ? [entry.pieceCid] : [])));
    const storage = this.volume?.storage as
      | { inner?: { pieces?: Map<string, Uint8Array>; list?: () => Promise<string[]>; get?: (cid: string) => Promise<Uint8Array> } }
      | undefined;
    const inner = storage?.inner;
    let cids: string[] = [];
    try {
      cids = inner?.pieces ? [...inner.pieces.keys()] : inner?.list ? await inner.list() : [];
    } catch (error) {
      this.toast(`Could not list dataset pieces: ${errorText(error)}`);
    }
    const blobs: { pieceCid: string; bytes: Uint8Array }[] = [];
    for (const pieceCid of cids) {
      if (referenced.has(pieceCid) || !inner?.get) continue;
      try {
        blobs.push({ pieceCid, bytes: await inner.get(pieceCid) });
      } catch {
        // Unreachable piece: still list it so the count reconciles.
        blobs.push({ pieceCid, bytes: new Uint8Array() });
      }
    }
    let details = new Map<string, PieceDetail>();
    try {
      details = new Map((await readPieceDetails()).map((detail) => [detail.pieceCid, detail]));
    } catch (error) {
      console.warn("FiFolders piece metadata", error);
    }
    const rows = loosePieces(blobs, referenced, details);
    const fromDrive = rows.filter((row) => row.origin === "drive").length;
    const inFolders = cids.filter((cid) => referenced.has(cid)).length;
    this.looseSummary = `${cids.length} pieces: ${inFolders} in folders, ${blobs.length - rows.length} manifests, ${rows.length} loose${fromDrive ? ` (${fromDrive} from Filecoin Drive)` : ""}`;
    return rows;
  }

  looseSummary = "";
  /** Filecoin Drive directory pieces expanded in the Loose pieces view. */
  looseExpanded = new Set<string>();

  private downloadBytes(bytes: Uint8Array, name: string, mime: string): void {
    const url = URL.createObjectURL(toBlob(bytes, mime));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  txlogOpen = false;

  private openFel(stat: Pick<Stat, "name" | "path" | "pieceCid">): void {
    const kind = felKind(stat.name);
    if (!kind) return;
    const url = appLink(kind, stat.pieceCid ?? "", stat.name, { felarumi: this.felarumiUrl, felanumio: this.felanumioUrl }, {
      path: stat.path,
      volume: this.volumeName,
      owner: this.owner,
    });
    window.open(url, "_blank", "noopener");
  }

  private async downloadLoose(cid: string): Promise<void> {
    const piece = this.looseRows.find((item) => item.pieceCid === cid);
    if (!piece) return;
    if (piece.unixfs === "directory" || piece.unixfs === "car") {
      const base = piece.name.replace(/\.car$/i, "");
      this.downloadBytes(piece.bytes, `${base || cid}.car`, "application/vnd.ipld.car");
      return;
    }
    const blob = toBlob(piece.bytes, piece.mime);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = piece.name || cid;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private async openLoose(cid: string): Promise<void> {
    const piece = this.looseRows.find((item) => item.pieceCid === cid);
    if (!piece) return;
    const kindPreview = previewKind(piece.mime, piece.bytes);
    this.revokePreview();
    if (kindPreview === "text") this.preview = { name: piece.name, kind: "text", text: new TextDecoder().decode(piece.bytes) };
    else if (kindPreview === "none") this.preview = { name: piece.name, kind: "none" };
    else this.preview = { name: piece.name, kind: kindPreview, url: URL.createObjectURL(toBlob(piece.bytes, piece.mime)) };
    this.render();
  }

  private toModel(): ViewModel {
    const target = this.context ? this.entries.find((entry) => entry.path === this.context?.target) : undefined;
    const dialog: DialogState | null = this.dialog
      ? {
          title: this.dialog.title,
          submit: this.dialog.submit,
          value: this.dialog.value,
          testid: this.dialog.mode === "move" ? "move-confirm" : "dialog-submit",
          folders: this.dialog.folders,
          dest: this.dialog.dest,
        }
      : null;
    const pending = loadOps();
    const dismissed = loadDismissed();
    const activity: ActivityRow[] = [
      ...pending.filter((op) => !(op.status === "error" && dismissed.has(`${op.id}@${op.updated}`))).map((op): ActivityRow => ({
        id: op.id,
        label: op.error ? `${op.label}: ${op.error}` : op.label,
        status: op.status === "error" ? "error" : "pending",
      })),
      ...this.recentDone.map((row) => ({ ...row, elapsedMs: Date.now() - (this.#doneAt.get(row.id) ?? Date.now()) })),
    ].slice(0, 12);
    let available = 0n;
    let rate = 0n;
    if (this.panel?.availableFunds) {
      try {
        available = BigInt(this.panel.availableFunds);
      } catch {
        available = 0n;
      }
    }
    if (this.panel?.lockupRate) {
      try {
        rate = BigInt(this.panel.lockupRate);
      } catch {
        rate = 0n;
      }
    }
    const runway = describeRunway({
      availableFunds: available,
      lockupRatePerEpoch: rate,
      datasetBytes: this.storageUsed,
      known: Boolean(this.panel),
      hasDataset: Boolean(this.panel?.selectedDatasetId || this.panel?.datasets.length || this.volume),
      ...(this.quote ? { datasetFeePerMonth: this.quote.provingPerMonth } : {}),
    });
    const badges: Record<string, string> = {};
    for (const op of pending) {
      if (!op.path) continue;
      if (op.kind === "upload" && op.status === "pending") badges[op.path] = "Saving…";
      if (op.kind === "fel-save") {
        badges[op.path] = op.stage === "saving" ? "Saving…" : op.stage === "saved" ? "Saved" : "Save pending";
      }
    }
    return {
      connected: Boolean(this.volume),
      costsOpen: this.costsOpen,
      costs: {
        perTiB: formatUsd(this.quote.perTiBPerMonth),
        fourGiB: formatUsd(fourGiBLine(this.quote)),
        proving: formatUsd(this.quote.provingPerMonth),
        reserve: formatUsd(this.quote.reserve),
        cdnReserve: formatUsd(this.quote.cdnReserve),
        createFee: formatUsd(this.quote.createFee),
        addPieces: `${formatUsd(this.quote.addPiecesBase)} + ${formatUsd(this.quote.addPiecesEach)} per piece`,
        datasetNote: datasetBlurb(this.quote),
        depositNote: depositBlurb(this.quote, "5"),
      },
      chainSteps: this.chainSteps,
      activity,
      activityPending: pending.some((op) => op.status === "pending") || this.busy,
      runway,
      looseSummary: this.looseSummary,
      walletPrompts: walletPrompts().map(({ id, what, state, intent }) => ({
        id,
        what,
        state,
        title: intent.title,
        detail: [intent.purpose, `(${intent.cost})`].filter(Boolean).join(" "),
      })),
      setupNote: this.readOnly ? "Finishing wallet setup… you can browse meanwhile" : "",
      loadState: !this.volume && this.panel && this.loadState === "idle" ? "loading" : this.loadState,
      loadError: this.loadError,
      setupStep: this.readOnly ? this.readOnlyStep() : null,
      txlogOpen: this.txlogOpen,
      loose: this.looseRows.map((piece) => ({
        pieceCid: piece.pieceCid,
        name: piece.name,
        size: piece.size,
        uploaded: piece.uploaded,
        mime: piece.mime,
        ...(piece.origin ? { origin: piece.origin, folder: piece.folder ?? "", unixfs: piece.unixfs, expanded: this.looseExpanded.has(piece.pieceCid) } : {}),
        ...(piece.ipfsRoot ? { ipfsRoot: piece.ipfsRoot } : {}),
        ...(piece.children ? { children: piece.children } : {}),
      })),
      badges,
      chain: this.chain,
      mainnetBlocked: this.mainnetBlocked,
      volumeName: this.volumeName,
      encrypt: this.encryptPref,
      encrypted: this.encrypted,
      owner: this.owner,
      nav: this.nav,
      cwdLabel: this.cwd,
      crumbs: breadcrumbs(this.nav, this.nav === "trash" ? this.cwd : this.nav === "drive" ? this.cwd : "/"),
      query: this.query,
      view: this.view,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      entries: this.entries,
      selected: this.selected,
      stars: this.stars,
      storageUsed: this.storageUsed,
      newMenu: this.newMenu,
      accountMenu: this.accountMenu,
      context: this.context
        ? {
            x: this.context.x,
            y: this.context.y,
            trash: this.nav === "trash" || isTrashPath(this.context.target),
            directory: target?.type === "dir",
            starred: this.context.paths.every((path) => this.stars.has(path)),
          }
        : null,
      dialog,
      details: this.details,
      downloads: {
        active: this.downloads.active,
        pending: this.downloads.pending,
        error: this.downloads.error,
        finished: this.downloads.finished,
      },
      preview: this.preview,
      uploads: this.uploads,
      toasts: this.toasts,
      dropPath: this.dropPath,
      dragging: this.dragging,
      felarumiUrl: this.felarumiUrl,
      felanumioUrl: this.felanumioUrl,
      connectError: this.connectError,
      wallets: this.wallets,
      walletRdns: this.walletRdns,
      panel: this.panel,
      setupError: this.setupError,
      stagedCount: this.staged.length,
      restoreNote: this.restoreNote,
      autoSaveUploads: this.autoSaveUploads,
      sessionPrompt: this.readOnly ? null : this.sessionPrompt,
    };
  }

  /** Next wallet step while browsing read-only, named with its purpose and cost. */
  private readOnlyStep(): { action: string; label: string } | null {
    const panel = this.panel;
    if (!panel) return { action: "readonly-connect", label: intentText(INTENTS.connect) };
    if (!panel.paymentsReady) return { action: "fix-payments", label: intentText(INTENTS.approvePayments) };
    if (!panel.selectedDatasetId) return { action: "create-dataset", label: intentText(INTENTS.createDataset) };
    if (!panel.sessionReady) return { action: "authorize", label: intentText(sessionIntent()) };
    return null;
  }

  private async editingVolume(): Promise<Volume> {
    await this.ensureDraft();
    const volume = this.viewVolume();
    if (!volume) throw new Error("Open a volume first.");
    return volume;
  }

  private async ensureDraft(): Promise<void> {
    if (this.#draftReady || !this.volume) return;
    this.#draftReady = true;
    const saved = loadStaged(this.owner, this.volumeName);
    this.staged = saved.ops;
    if (!saved.ops.length) return;
    this.#baseline = { origins: saved.origins, stars: saved.stars };
    this.#draft = await forkVolume(this.volume);
    await replayStaged(this.#draft, saved.ops);
    if (this.#restoredFromDisk) {
      this.restoreNote = restoreLabel(saved.ops.length);
      this.#restoredFromDisk = false;
    }
  }

  private async rebuildDraft(): Promise<void> {
    if (!this.volume || !this.staged.length) {
      this.#draft = null;
      return;
    }
    this.#draft = await forkVolume(this.volume);
    await replayStaged(this.#draft, this.staged);
  }

  private persistStaged(): void {
    saveStaged(this.owner, this.volumeName, {
      ops: this.staged,
      origins: this.#baseline?.origins ?? this.origins,
      stars: this.#baseline?.stars ?? [...this.stars],
    });
  }

  private async stage(ops: StagedOp[], opts?: { autosave?: boolean }): Promise<void> {
    if (!this.volume || !ops.length) return;
    await this.ensureDraft();
    if (!this.#baseline) this.#baseline = { origins: { ...this.origins }, stars: [...this.stars] };
    if (!this.#draft) {
      this.#draft = await forkVolume(this.volume);
      if (this.staged.length) await replayStaged(this.#draft, this.staged);
    }
    await replayStaged(this.#draft, ops);
    this.staged = [...this.staged, ...ops];
    this.persistStaged();
    if (opts?.autosave && this.autoSaveUploads) await this.saveStaged();
    else await this.refresh();
  }

  private async saveStaged(): Promise<void> {
    if (!this.volume || !this.staged.length) return;
    if (this.readOnly) {
      this.#saveWanted = true;
      this.toast("Kept as unsaved changes — they save once wallet setup finishes.");
      await this.refresh();
      return;
    }
    const ops = this.staged.slice();
    const label = saveLabel(ops.length);
    const id = this.beginOp({ kind: "commit", label, stage: "saving" });
    const ok = await this.run(async () => {
      await withWalletIntent(INTENTS.save(ops.length), () =>
        this.volume!.tx(async (draft) => {
          await replayStaged(draft, ops);
        }),
      );
      for (const op of ops) {
        if (op.op !== "put") continue;
        try {
          const stat = await this.volume!.stat(op.path);
          if (stat.pieceCid) {
            rememberPiece({
              pieceCid: stat.pieceCid,
              name: baseName(op.path),
              mime: op.mime,
              size: stat.size,
              uploaded: Date.now(),
              path: op.path,
            });
          }
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      this.staged = [];
      this.#draft = null;
      this.#baseline = null;
      this.restoreNote = "";
      this.persistStaged();
      await this.rememberCopies();
      if (ops.some((op) => op.op === "rm")) await this.scheduleUnreferenced();
    });
    if (ok) this.finishOp(id);
    else this.failOp(id, "Couldn't save");
  }

  private scopeKey(): string {
    return `${this.owner.toLowerCase()}:${this.volumeName}`;
  }

  private removalScheduled(stat: Stat): boolean {
    const piece = stat.located || "";
    if (!piece) return false;
    const record = loadRemovals(this.scopeKey())[piece];
    return Boolean(record && Object.keys(record).length);
  }

  private async rememberCopies(): Promise<void> {
    if (!this.volume) return;
    const head = (await this.volume.history()).at(-1)?.pieceCid;
    if (!head) return;
    const scope = this.scopeKey();
    const catalog = loadCopyCatalog(scope);
    if (catalog[head]?.length) return;
    const notice = loadCheckpoint(scope);
    const confirmed = notice?.providers.filter((provider) => provider.confirmed && provider.providerId) ?? [];
    catalog[head] = confirmed.length
      ? confirmed.map((provider) => ({
          datasetId: provider.dataSetId || provider.providerId,
          providerId: provider.providerId,
          serviceURL: provider.serviceURL,
        }))
      : defaultLocalCopies();
    saveCopyCatalog(scope, catalog);
  }

  private async scheduleUnreferenced(): Promise<void> {
    if (!this.volume) return;
    const live = new Set(await this.volume.referencedPieces());
    const history = await this.volume.history();
    const eligible = piecesEligibleForRemoval(
      history.map((entry) => entry.pieceCid),
      live,
    );
    const scope = this.scopeKey();
    const catalog = loadCopyCatalog(scope);
    const records = loadRemovals(scope);
    const adapters = this.removalAdapters ?? localRemovalAdapters();
    for (const piece of eligible) {
      const copies = catalog[piece] ?? [];
      if (!copies.length) continue;
      const file = { pieceCid: piece, datasetIds: copies.map((copy) => copy.datasetId), checkpoints: { ...(records[piece] ?? {}) } };
      await schedulePieceRemovals(file, async (datasetId, next) => {
        const current = { ...(records[piece] ?? {}) };
        if (next) current[datasetId] = next;
        else delete current[datasetId];
        records[piece] = current;
        saveRemovals(scope, records);
      }, adapters);
    }
  }

  private async recoverPendingUpload(): Promise<void> {
    const saved = loadCheckpoint(this.scopeKey());
    if (!saved || saved.phase === "complete" || saved.phase === "failed") return;
    const next = await recoverReplication(saved, async () => "pending");
    saveCheckpoint(this.scopeKey(), next);
    if (next.error) this.toast(next.error);
    this.render();
  }

  private async discardStaged(): Promise<void> {
    if (this.#baseline) {
      this.origins = { ...this.#baseline.origins };
      this.stars = new Set(this.#baseline.stars);
      this.writeOrigins();
      this.writeStars();
    }
    this.staged = [];
    this.#draft = null;
    this.#baseline = null;
    this.restoreNote = "";
    this.persistStaged();
    await this.refresh();
  }
}

async function describeShare(bytes: Uint8Array): Promise<{ ipfs: string; importedCar: boolean }> {
  try {
    const roots = readCarRoots(bytes);
    const root = roots[0];
    if (!root) throw new CarArchiveError("The CAR archive needs at least one root CID for Drive to track and retrieve it.");
    return { ipfs: root, importedCar: true };
  } catch (error) {
    if (error instanceof CarArchiveError) throw error;
    return { ipfs: await contentCid(bytes), importedCar: false };
  }
}

function localRemovalAdapters(): RemovalAdapters {
  return {
    async listPieceIds() {
      return ["1"];
    },
    async scheduled() {
      return new Set();
    },
    async submit() {
      return { hash: "0xlocal" };
    },
    async resolve(_datasetId, checkpoint) {
      return { status: "success", hash: checkpoint.transactionHash ?? "0xlocal" };
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function remap(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

function errorText(error: unknown): string {
  console.error("FiFolders error", error);
  if (error instanceof CasConflictError) {
    return error.paths.length
      ? `Couldn't save. Conflicting changes at ${error.paths.join(", ")}.`
      : "Couldn't save because of a conflicting edit.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toBlob(bytes: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: mime });
}

function captureFocus(root: HTMLElement): { testid: string; start: number; end: number } | null {
  const element = document.activeElement as HTMLInputElement | null;
  if (!element || !root.contains(element)) return null;
  const testid = element.getAttribute("data-testid");
  if (!testid) return null;
  const length = typeof element.value === "string" ? element.value.length : 0;
  let start = length;
  let end = length;
  try {
    start = element.selectionStart ?? length;
    end = element.selectionEnd ?? length;
  } catch {
    // Elements without text selection (select, div[tabindex]) keep focus only.
  }
  return { testid, start, end };
}

function restoreFocus(root: HTMLElement, saved: { testid: string; start: number; end: number } | null): void {
  if (!saved) return;
  const element = root.querySelector<HTMLInputElement>(`[data-testid="${saved.testid}"]`);
  if (!element) return;
  element.focus();
  try {
    element.setSelectionRange?.(saved.start, saved.end);
  } catch {
    // Not a text field.
  }
}
