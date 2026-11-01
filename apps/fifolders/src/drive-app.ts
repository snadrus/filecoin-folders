import {
  CasConflictError,
  NotFoundError,
  type HistoryEntry,
  type Stat,
  type Volume,
} from "fil-folders";
import {
  TRASH_PATH,
  applySelection,
  appLink,
  baseName,
  breadcrumbs,
  copyName,
  defaultSortDir,
  felKind,
  guessMime,
  isTrashPath,
  joinPath,
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
import type { CasObserver, ChainChoice } from "./session.js";
import { renderApp, type DialogState, type UploadRow, type ViewModel } from "./view.js";

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
  onConnect?: (input: { chain: ChainChoice; volumeName: string; encrypt: boolean }) => Promise<void>;
  onDisconnect?: () => void;
}

interface DialogModel {
  mode: "new-folder" | "rename" | "move";
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
  onDisconnect?: DriveAppOptions["onDisconnect"];

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
  details: { stat: Stat; history: HistoryEntry[]; version: bigint; pieceCid: string } | null = null;
  preview: PreviewModel | null = null;
  uploads: UploadRow[] = [];
  toasts: { id: string; text: string }[] = [];
  connectError = "";
  mainnetBlocked = false;
  dropPath: string | null = null;
  dragging = false;

  root: HTMLElement | null = null;
  #tail: Promise<void> = Promise.resolve();
  #toastSeq = 0;

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
    this.onDisconnect = options.onDisconnect;
    this.view = localStorage.getItem("fifolders:view") === "grid" ? "grid" : "list";
    this.mainnetBlocked = options.chain === "mainnet";
    if (options.volume) this.loadPrefs();
  }

  get settled(): Promise<void> {
    return this.#tail;
  }

  attach(options: DriveAppOptions): void {
    this.volume = options.volume;
    this.owner = options.owner;
    this.chain = options.chain;
    this.encrypted = options.encrypted;
    this.volumeName = options.volumeName;
    this.cas = options.cas;
    this.mainnetBlocked = options.chain === "mainnet";
    this.connectError = "";
    this.loadPrefs();
    if (this.root) void this.enqueue(() => this.refresh());
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
      void this.enqueue(() => this.onSubmit(event));
    });
    void this.enqueue(() => this.refresh());
  }

  async uploadFiles(files: File[], destDir?: string): Promise<void> {
    const list = [...files];
    await this.enqueue(() => this.uploadList(list, destDir ?? this.destDir()));
  }

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

  private async refresh(): Promise<void> {
    if (!this.volume) {
      this.entries = [];
      this.render();
      return;
    }
    try {
      const [entries, tree] = await Promise.all([this.loadListing(), this.walk("/")]);
      this.entries = entries;
      this.storageUsed = sumSizes(tree);
      const visible = new Set(entries.map((entry) => entry.path));
      this.selected = this.selected.filter((path) => visible.has(path));
    } catch (error) {
      this.toast(errorText(error));
    }
    this.render();
  }

  private async loadListing(): Promise<Stat[]> {
    const volume = this.volume;
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
    let items = await volume.ls(this.cwd || "/");
    if ((this.cwd || "/") === "/") items = items.filter((entry) => entry.name !== ".trash");
    return sortStats(items, this.sortKey, this.sortDir, true);
  }

  private filterQuery(entries: Stat[]): Stat[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(query));
  }

  private async walk(dir: string): Promise<Stat[]> {
    const volume = this.volume;
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
      this.toast("Mainnet has no FolderRegistry yet.");
      this.render();
      return false;
    }
    this.busy = true;
    this.cas.takeMerged();
    this.render();
    try {
      await task();
      const merged = this.cas.takeMerged();
      this.busy = false;
      if (merged) this.toast("Changes merged with a newer version of this volume.");
      await this.refresh();
      return true;
    } catch (error) {
      this.cas.takeMerged();
      this.busy = false;
      this.toast(errorText(error));
      try {
        await this.refresh();
      } catch {
        this.render();
      }
      return false;
    }
  }

  private toast(text: string): void {
    const id = `t${++this.#toastSeq}`;
    this.toasts = [...this.toasts, { id, text }].slice(-4);
  }

  private async uploadList(files: File[], dest: string): Promise<void> {
    if (!files.length) return;
    const payloads = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        rel: file.webkitRelativePath || file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const rows: UploadRow[] = payloads.map((file) => ({
      id: `${Date.now()}-${file.rel}`,
      name: file.rel,
      progress: 8,
      status: "uploading",
    }));
    this.uploads = [...this.uploads, ...rows];
    this.render();
    const ok = await this.run(async () => {
      await this.volume!.tx(async (draft) => {
        for (let index = 0; index < payloads.length; index += 1) {
          const file = payloads[index]!;
          const path = joinPath(dest, file.rel);
          const parent = parentPath(path);
          if (parent !== "/") await draft.mkdir(parent);
          const siblings = await draft.ls(parent);
          const name = uniqueName(baseName(path), new Set(siblings.map((item) => item.name)));
          rows[index]!.progress = 55;
          this.render();
          await draft.put(joinPath(parent, name), file.bytes, { mime: guessMime(file.name, file.type) });
          rows[index]!.progress = 100;
          rows[index]!.status = "done";
          this.render();
        }
      });
    });
    if (!ok) {
      for (const row of rows) row.status = "error";
      this.render();
    }
  }

  private async createFolder(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await this.run(() => this.volume!.mkdir(joinPath(this.destDir(), trimmed)));
  }

  private async rename(path: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = joinPath(parentPath(path), trimmed);
    if (next === path) return;
    await this.run(async () => {
      await this.volume!.mv(path, next);
      this.moveStarPrefix(path, next);
      this.mapOrigins(path, next);
      this.selected = this.selected.map((item) => remap(item, path, next));
    });
  }

  private async makeCopies(paths: string[]): Promise<void> {
    await this.run(async () => {
      await this.volume!.tx(async (draft) => {
        for (const path of paths) {
          const parent = parentPath(path);
          const siblings = await draft.ls(parent);
          const name = uniqueName(copyName(baseName(path)), new Set(siblings.map((item) => item.name)));
          await draft.cp(path, joinPath(parent, name));
        }
      });
    });
  }

  private async movePaths(paths: string[], dest: string): Promise<void> {
    await this.run(async () => {
      await this.volume!.tx(async (draft) => {
        if (dest !== "/") await draft.mkdir(dest);
        for (const path of paths) {
          if (path === dest || dest.startsWith(`${path}/`)) throw new Error("Can't move a folder into itself.");
          const siblings = await draft.ls(dest);
          const name = uniqueName(baseName(path), new Set(siblings.map((item) => item.name)));
          const next = joinPath(dest, name);
          if (next === path) continue;
          await draft.mv(path, next);
          this.moveStarPrefix(path, next);
          this.mapOrigins(path, next);
          this.selected = this.selected.map((item) => remap(item, path, next));
        }
      });
    });
  }

  private async trashPaths(paths: string[]): Promise<void> {
    await this.run(async () => {
      await this.volume!.tx(async (draft) => {
        await draft.mkdir(TRASH_PATH);
        const taken = new Set((await draft.ls(TRASH_PATH)).map((item) => item.name));
        for (const path of paths) {
          if (isTrashPath(path)) continue;
          const name = uniqueName(baseName(path), taken);
          taken.add(name);
          const dest = `${TRASH_PATH}/${name}`;
          await draft.mv(path, dest);
          this.origins[dest] = path;
          this.moveStarPrefix(path, dest);
          this.selected = this.selected.map((item) => (item === path ? dest : item));
        }
        this.writeOrigins();
      });
    });
  }

  private async restorePaths(paths: string[]): Promise<void> {
    await this.run(async () => {
      await this.volume!.tx(async (draft) => {
        for (const path of paths) {
          const origin = this.origins[path] ?? joinPath("/", baseName(path));
          const parent = parentPath(origin);
          if (parent !== "/") await draft.mkdir(parent);
          let dest = origin;
          try {
            await draft.stat(dest);
            const siblings = await draft.ls(parent);
            dest = joinPath(parent, uniqueName(baseName(origin), new Set(siblings.map((item) => item.name))));
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
          }
          await draft.mv(path, dest);
          delete this.origins[path];
          this.moveStarPrefix(path, dest);
        }
        this.writeOrigins();
      });
    });
  }

  private async deleteForever(paths: string[]): Promise<void> {
    await this.run(async () => {
      await this.volume!.tx(async (draft) => {
        for (const path of paths) await draft.rm(path, { recursive: true });
      });
      for (const path of paths) {
        delete this.origins[path];
        for (const star of [...this.stars]) {
          if (star === path || star.startsWith(`${path}/`)) this.stars.delete(star);
        }
      }
      this.writeOrigins();
      this.writeStars();
      this.selected = [];
    });
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
    const volume = this.volume;
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
    const kind = felKind(stat.name);
    if (kind) {
      const url = appLink(kind, stat.pieceCid ?? "", stat.name, {
        felarumi: this.felarumiUrl,
        felanumio: this.felanumioUrl,
      });
      window.open(url, "_blank", "noopener");
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
    const volume = this.volume;
    if (!volume) return;
    const stat = await volume.stat(path);
    if (stat.type === "dir") return;
    const bytes = await volume.get(path);
    const blob = toBlob(bytes, guessMime(stat.name, stat.mime));
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = stat.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private async showDetails(path: string): Promise<void> {
    const volume = this.volume;
    if (!volume) return;
    const stat = await volume.stat(path);
    const history = await volume.history(path);
    const head = await volume.registry.head(volume.owner, volume.ns, volume.key);
    let pieceCid = stat.pieceCid ?? "";
    if (!pieceCid) {
      const commits = await volume.history();
      pieceCid = commits.at(-1)?.pieceCid ?? "";
    }
    this.details = { stat, history, version: head.version, pieceCid };
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
    const inMenu = Boolean(target.closest("[data-menu]"));
    if (!inMenu) {
      this.newMenu = false;
      this.context = null;
      if (action !== "account") this.accountMenu = false;
    }
    if (action === "new-toggle") {
      this.newMenu = !this.newMenu;
      this.context = null;
      this.accountMenu = false;
      this.render();
      return;
    }
    if (action === "account") {
      this.accountMenu = !this.accountMenu;
      this.newMenu = false;
      this.render();
      return;
    }
    if (action === "chain") {
      const chain = actionEl?.dataset.chain === "mainnet" ? "mainnet" : "calibration";
      this.chain = chain;
      this.mainnetBlocked = chain === "mainnet" && Boolean(this.volume);
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
    if (action === "dismiss-toast") {
      const id = actionEl?.dataset.id;
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
      this.render();
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
      this.context = null;
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
      localStorage.setItem("fifolders:felarumi-url", target.value);
      return;
    }
    if (target.dataset.testid === "felanumio-url") {
      this.felanumioUrl = target.value;
      localStorage.setItem("fifolders:felanumio-url", target.value);
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
      this.volumeName = volumeName;
      this.encryptPref = encrypt;
      if (this.chain === "mainnet") {
        this.connectError = "Mainnet has no FolderRegistry yet. Use Calibration.";
        this.render();
        return;
      }
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
    this.root.innerHTML = renderApp(this.toModel());
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
    return {
      connected: Boolean(this.volume),
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
      busy: this.busy,
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
      preview: this.preview,
      uploads: this.uploads,
      toasts: this.toasts,
      dropPath: this.dropPath,
      dragging: this.dragging,
      felarumiUrl: this.felarumiUrl,
      felanumioUrl: this.felanumioUrl,
      connectError: this.connectError,
    };
  }
}

function remap(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

function errorText(error: unknown): string {
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
  return { testid, start: element.selectionStart ?? element.value.length, end: element.selectionEnd ?? element.value.length };
}

function restoreFocus(root: HTMLElement, saved: { testid: string; start: number; end: number } | null): void {
  if (!saved) return;
  const element = root.querySelector<HTMLInputElement>(`[data-testid="${saved.testid}"]`);
  if (!element) return;
  element.focus();
  element.setSelectionRange?.(saved.start, saved.end);
}
