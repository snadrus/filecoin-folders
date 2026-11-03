import { AVATAR_COLORS, BIO_MAX, DISPLAY_NAME_MAX, IdentityError, LEGACY_NAME_KEY, avatarHtml, buildIdentity, escapeHtml as esc, guestName, writeIdentityCache, type ResolvedIdentity } from "fiperson/edit";
import { onWalletPrompts, isUserRejection, type WalletPrompt } from "../wallet-prompts.js";
import { IdentityBlocked, type IdentityIO } from "./io.js";

export { LEGACY_NAME_KEY };
export const COLORS = AVATAR_COLORS;

/** Only same-origin return targets (FiPen/FiGrid/FiFolders pages). */
export function safeReturn(value: string | null, origin = location.origin): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

interface State {
  address: string | null;
  loading: boolean;
  resolved: ResolvedIdentity | null;
  draft: { displayName: string; emoji: string; color: string; bio: string };
  busy: string;
  error: string;
  blocked: { message: string; url: string } | null;
  saved: boolean;
  prompts: WalletPrompt[];
}

export class IdentityPage {
  state: State = {
    address: null,
    loading: false,
    resolved: null,
    draft: { displayName: "", emoji: "", color: "", bio: "" },
    busy: "",
    error: "",
    blocked: null,
    saved: false,
    prompts: [],
  };
  readonly returnTo: string | null;

  constructor(private root: HTMLElement, private io: IdentityIO, search = location.search, private navigate = (url: string) => location.assign(url)) {
    this.returnTo = safeReturn(new URLSearchParams(search).get("return"));
    onWalletPrompts((prompts) => {
      this.state.prompts = prompts;
      this.renderToasts();
    });
    root.addEventListener("click", (event) => void this.onClick(event));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save();
    });
  }

  async start(): Promise<void> {
    this.render();
    const address = await this.io.peek().catch(() => null);
    if (address) await this.useAddress(address);
  }

  private async useAddress(address: string): Promise<void> {
    this.state.address = address;
    this.state.loading = true;
    this.render();
    const resolved = await this.io.load(address).catch(() => null);
    this.state.loading = false;
    this.state.resolved = resolved;
    const id = resolved?.identity;
    let legacy = "";
    try {
      legacy = localStorage.getItem(LEGACY_NAME_KEY)?.trim() || "";
    } catch {
      // ignore
    }
    this.state.draft = id
      ? { displayName: id.displayName, emoji: id.avatar?.emoji ?? "", color: id.avatar?.color ?? "", bio: id.bio ?? "" }
      : { displayName: legacy || guestName(address), emoji: "", color: "", bio: "" };
    this.render();
  }

  private async onClick(event: Event): Promise<void> {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "connect") {
      this.state.error = "";
      try {
        await this.useAddress(await this.io.connect());
      } catch (error) {
        this.state.error = isUserRejection(error) ? "Connection was cancelled." : (error as Error).message;
        this.render();
      }
    } else if (action === "color") {
      this.state.draft.color = el.dataset.color === this.state.draft.color ? "" : el.dataset.color || "";
      this.render();
    } else if (action === "return" && this.returnTo) {
      this.navigate(this.returnTo);
    }
  }

  private onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const field = input.dataset.field as keyof State["draft"] | undefined;
    if (!field) return;
    this.state.draft[field] = input.value;
    this.paintPreview();
  }

  async save(): Promise<void> {
    const address = this.state.address;
    if (!address || this.state.busy) return;
    this.state.error = "";
    this.state.blocked = null;
    let doc;
    try {
      const d = this.state.draft;
      doc = buildIdentity(address, { displayName: d.displayName, avatar: { emoji: d.emoji, color: d.color }, bio: d.bio });
    } catch (error) {
      this.state.error = error instanceof IdentityError ? error.message : String(error);
      this.render();
      return;
    }
    this.state.busy = "Saving…";
    this.render();
    try {
      const saved = await this.io.save(address, doc, (step) => {
        this.state.busy = step;
        this.render();
      });
      writeIdentityCache(address, { identity: doc, pieceCid: saved.pieceCid, version: saved.version });
      try {
        // Older FiPen/FiGrid builds read this key.
        localStorage.setItem(LEGACY_NAME_KEY, doc.displayName);
      } catch {
        // ignore
      }
      this.state.resolved = { address: doc.address, displayName: doc.displayName, avatar: doc.avatar, bio: doc.bio, source: "chain", identity: doc, pieceCid: saved.pieceCid, version: saved.version };
      this.state.saved = true;
      this.state.busy = "";
      this.render();
      if (this.returnTo) setTimeout(() => this.navigate(this.returnTo!), 1500);
    } catch (error) {
      this.state.busy = "";
      if (error instanceof IdentityBlocked) this.state.blocked = { message: error.message, url: error.setupUrl };
      else this.state.error = isUserRejection(error) ? "Signature rejected — nothing was saved." : (error as Error).message || "Save failed.";
      this.render();
    }
  }

  private paintPreview(): void {
    const preview = this.root.querySelector<HTMLElement>("[data-testid=identity-preview]");
    if (preview) preview.outerHTML = this.preview();
  }

  private preview(): string {
    const d = this.state.draft;
    const name = d.displayName.trim() || "Your name";
    const person = { address: this.state.address ?? undefined, displayName: name, avatar: { emoji: d.emoji.trim(), color: d.color } };
    return `<div class="preview" data-testid="identity-preview">${avatarHtml(person, 44)}<span><strong>${esc(name)}</strong><small>${esc(this.state.address ?? "")}</small></span></div>`;
  }

  private renderToasts(): void {
    let host = this.root.querySelector<HTMLElement>(".toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "toasts";
      host.setAttribute("aria-live", "polite");
      this.root.appendChild(host);
    }
    host.innerHTML = this.state.prompts
      .map((p) =>
        p.state === "waiting"
          ? `<div class="toast" data-testid="wallet-prompt"><span class="spinner"></span>Check your wallet — <strong>${esc(p.intent.title)}</strong> <small>${esc([p.intent.purpose, p.intent.cost].filter(Boolean).join(" · "))}</small></div>`
          : `<div class="toast" data-testid="wallet-prompt" data-state="rejected">Signature rejected — ${esc(p.intent.title)} <button type="button" data-retry="${p.id}">Retry</button><button type="button" data-cancel="${p.id}">Cancel</button></div>`,
      )
      .join("");
    for (const p of this.state.prompts) {
      host.querySelector(`[data-retry="${p.id}"]`)?.addEventListener("click", () => p.retry());
      host.querySelector(`[data-cancel="${p.id}"]`)?.addEventListener("click", () => p.cancel());
    }
  }

  render(): void {
    const s = this.state;
    const d = s.draft;
    const header = `<header><h1>Your identity</h1><p class="lede">One name and avatar for your wallet, shown in FiFolders, FiPen and FiGrid. It is saved as a small public piece on Filecoin and linked to your wallet on chain, so anyone you work with sees the same name.</p></header>`;
    let body: string;
    if (!s.address) {
      body = `<section class="card"><p>Connect the wallet you use with FiFolders.</p><button type="button" class="primary" data-action="connect" data-testid="identity-connect">Connect wallet</button><p class="note">Connecting is free.</p></section>`;
    } else if (s.loading) {
      body = `<section class="card"><p data-testid="identity-loading">Looking up your identity…</p></section>`;
    } else {
      const status = s.resolved?.identity
        ? `<p class="note" data-testid="identity-status">Saved on chain${s.resolved.pieceCid ? ` · piece ${esc(s.resolved.pieceCid.slice(0, 14))}…` : ""}</p>`
        : `<p class="note" data-testid="identity-status">Not set up yet — others see “${esc(guestName(s.address))}”.</p>`;
      body = `<form class="card" data-testid="identity-form">
        ${this.preview()}
        ${status}
        <label class="field">Display name <span class="req">required</span>
          <input data-field="displayName" data-testid="identity-name" required maxlength="${DISPLAY_NAME_MAX}" value="${esc(d.displayName)}" /></label>
        <label class="field">Avatar emoji <span class="opt">optional</span>
          <input data-field="emoji" data-testid="identity-emoji" maxlength="16" placeholder="🦊" value="${esc(d.emoji)}" /></label>
        <div class="field">Color <span class="opt">optional</span><div class="colors">${COLORS.map((c) => `<button type="button" class="swatch${c === d.color ? " on" : ""}" data-action="color" data-color="${c}" style="background:${c}" aria-label="Color ${c}" aria-pressed="${c === d.color}"></button>`).join("")}</div></div>
        <label class="field">Short bio <span class="opt">optional</span>
          <textarea data-field="bio" data-testid="identity-bio" maxlength="${BIO_MAX}" rows="3">${esc(d.bio)}</textarea></label>
        ${s.error ? `<p class="error" role="alert" data-testid="identity-error">${esc(s.error)}</p>` : ""}
        ${s.blocked ? `<p class="blocked" role="alert" data-testid="identity-blocked">${esc(s.blocked.message)} <a href="${esc(s.blocked.url)}">Open FiFolders</a></p>` : ""}
        ${s.saved ? `<p class="ok" role="status" data-testid="identity-saved">Saved.${this.returnTo ? ` <button type="button" data-action="return" data-testid="identity-return">Back to your document</button>` : ""}</p>` : ""}
        <button type="submit" class="primary" data-testid="identity-save" ${s.busy ? "disabled" : ""}>${esc(s.busy || "Save identity")}</button>
        <p class="note">Saving asks your wallet twice: a free signature to store the piece (billed from your existing FiFolders storage deposit — a few bytes, well under $0.01/month) and one transaction to link it (gas ~0.01 FIL). Everything here is public.</p>
      </form>`;
    }
    const back = this.returnTo ? `<a class="back" href="${esc(this.returnTo)}" data-testid="identity-back">← Back</a>` : `<a class="back" href="../">← FiFolders</a>`;
    this.root.innerHTML = `<div class="wrap">${back}${header}${body}</div>`;
    this.renderToasts();
  }
}
