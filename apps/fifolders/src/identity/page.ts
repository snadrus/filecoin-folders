import { AVATAR_COLORS, AVATAR_IMAGE_MAX, AVATAR_IMAGE_SIZE, BIO_MAX, DISPLAY_NAME_MAX, IdentityError, LEGACY_NAME_KEY, WALLET_KEY, avatarHtml, buildIdentity, escapeHtml as esc, guestName, writeIdentityCache, type ResolvedIdentity } from "fiperson/edit";
import { cachedClubs, type MyClubs } from "fiperson/clubs";
import { connectSlack, notifyConfig, slackConnections } from "fiperson/notify";
import { personUrl } from "fiperson/people";
import { onWalletPrompts, isUserRejection, type WalletPrompt } from "../wallet-prompts.js";
import { IdentityBlocked, type IdentityIO } from "./io.js";

export { LEGACY_NAME_KEY };

/** Center-crop `file` to a square and scale it to {@link AVATAR_IMAGE_SIZE}px; WebP (PNG fallback) data URL within {@link AVATAR_IMAGE_MAX}. */
export async function avatarImageFromFile(file: Blob, size = AVATAR_IMAGE_SIZE): Promise<string> {
  if (!file.type.startsWith("image/")) throw new IdentityError("Pick an image file (PNG, JPEG, WebP, GIF…).");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new IdentityError("That image could not be read. Try a PNG or JPEG.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  for (const px of [size, 96, 64]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
    for (const q of [0.85, 0.7, 0.5]) {
      const webp = canvas.toDataURL("image/webp", q);
      if (webp.startsWith("data:image/webp") && webp.length <= AVATAR_IMAGE_MAX) return webp;
    }
    const jpeg = canvas.toDataURL("image/jpeg", 0.8);
    const png = canvas.toDataURL("image/png");
    const best = png.length <= AVATAR_IMAGE_MAX ? png : jpeg;
    if (best.length <= AVATAR_IMAGE_MAX) return best;
  }
  throw new IdentityError("That image is too detailed to store. Try a simpler picture.");
}
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
  draft: { displayName: string; emoji: string; color: string; bio: string; image: string; slackTeam: string; slackUser: string; slackDomain: string };
  clubs: MyClubs | null;
  clubsBusy: boolean;
  clubsError: string;
  slackMsg: string;
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
    draft: { displayName: "", emoji: "", color: "", bio: "", image: "", slackTeam: "", slackUser: "", slackDomain: "" },
    clubs: null,
    clubsBusy: false,
    clubsError: "",
    slackMsg: "",
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
    root.addEventListener("change", (event) => void this.onFile(event));
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
    try {
      localStorage.setItem(WALLET_KEY, address.toLowerCase()); // FiPen/FiGrid and fiperson/people read "you" from here
    } catch {
      /* ignore */
    }
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
    const slack = id?.notify?.contacts.find((c) => c.channel === "slack");
    const sl = { slackTeam: slack?.team ?? "", slackUser: slack?.user ?? "", slackDomain: slack?.domain ?? "" };
    this.state.draft = id
      ? { displayName: id.displayName, emoji: id.avatar?.emoji ?? "", color: id.avatar?.color ?? "", bio: id.bio ?? "", image: id.avatar?.image ?? "", ...sl }
      : { displayName: legacy || guestName(address), emoji: "", color: "", bio: "", image: "", ...sl };
    this.state.clubs = cachedClubs(address);
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
    } else if (action === "pick-image") {
      this.root.querySelector<HTMLInputElement>("[data-testid=identity-image-file]")?.click();
    } else if (action === "remove-image") {
      this.state.draft.image = "";
      this.render();
    } else if (action === "find-clubs" && this.state.address) {
      this.state.clubsBusy = true;
      this.state.clubsError = "";
      this.render();
      try {
        this.state.clubs = await this.io.findClubs(this.state.address);
      } catch (error) {
        this.state.clubsError = (error as Error).message || "Could not read FiClub.";
      }
      this.state.clubsBusy = false;
      this.render();
    } else if (action === "slack-fill") {
      // connectSlack opens its popup synchronously (inside this click), then waits.
      const pending = connectSlack({ team: this.state.draft.slackTeam || undefined });
      this.state.slackMsg = "Waiting for Slack…";
      this.render();
      try {
        const t = await pending;
        Object.assign(this.state.draft, { slackTeam: t.team, slackUser: t.user, slackDomain: t.domain });
        this.state.slackMsg = `Filled from Slack${t.domain ? ` (${t.domain}.slack.com)` : ""}. Save identity to publish it.`;
      } catch (error) {
        this.state.slackMsg = (error as Error).name === "PopupBlocked" ? "Your browser blocked the Slack window. Allow pop-ups and try again." : "Slack was not connected.";
      }
      this.render();
    } else if (action === "slack-clear") {
      Object.assign(this.state.draft, { slackTeam: "", slackUser: "", slackDomain: "" });
      this.render();
    } else if (action === "return" && this.returnTo) {
      this.navigate(this.returnTo);
    }
  }

  private async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.dataset.testid !== "identity-image-file") return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this.state.error = "";
    try {
      this.state.draft.image = await avatarImageFromFile(file);
    } catch (error) {
      this.state.error = error instanceof IdentityError ? error.message : "That image could not be used.";
    }
    this.render();
  }

  private onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const field = input.dataset.field as keyof State["draft"] | undefined;
    if (!field || input.type === "file") return;
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
      const team = d.slackTeam.trim().toUpperCase();
      const user = d.slackUser.trim().toUpperCase();
      if ((team || user) && !(/^[TE][A-Z0-9]{2,20}$/.test(team) && /^[UW][A-Z0-9]{2,20}$/.test(user))) throw new IdentityError("Slack needs both a workspace ID (starts with T) and a member ID (starts with U), or leave both empty.");
      const notify = team && user ? { preferred: "slack" as const, contacts: [{ channel: "slack" as const, team, user, domain: d.slackDomain }] } : undefined;
      doc = buildIdentity(address, { displayName: d.displayName, avatar: { emoji: d.emoji, color: d.color, image: d.image }, bio: d.bio, notify });
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
    const person = { address: this.state.address ?? undefined, displayName: name, avatar: { emoji: d.emoji.trim(), color: d.color, image: d.image } };
    return `<div class="preview" data-testid="identity-preview">${avatarHtml(person, 44)}<span><strong>${esc(name)}</strong><small>${esc(this.state.address ?? "")}</small></span></div>`;
  }

  private notifySection(): string {
    const d = this.state.draft;
    const configured = !!notifyConfig().slackClientId;
    const conn = slackConnections();
    return `<fieldset class="field notify" data-testid="identity-notify"><legend>Notifications <span class="opt">optional · how people reach you when they @-mention you</span></legend>
      <div class="channel"><span class="chan-name">Slack</span><span class="opt">preferred</span></div>
      <div class="row3">
        <label>Workspace ID<input data-field="slackTeam" data-testid="identity-slack-team" placeholder="T0123ABCD" value="${esc(d.slackTeam)}" /></label>
        <label>Member ID<input data-field="slackUser" data-testid="identity-slack-user" placeholder="U0123ABCD" value="${esc(d.slackUser)}" /></label>
        <label>Workspace<input data-field="slackDomain" data-testid="identity-slack-domain" placeholder="acme (.slack.com)" value="${esc(d.slackDomain)}" /></label>
      </div>
      <div class="photo">
        ${configured ? `<button type="button" data-action="slack-fill" data-testid="identity-slack-fill">Connect Slack to fill these</button>` : ""}
        ${d.slackTeam || d.slackUser ? `<button type="button" data-action="slack-clear" data-testid="identity-slack-clear">Remove Slack</button>` : ""}
      </div>
      ${this.state.slackMsg ? `<p class="note" role="status" data-testid="identity-slack-msg">${esc(this.state.slackMsg)}</p>` : ""}
      <p class="note">Public, like the rest of your identity. In Slack: your profile → ⋮ → <em>Copy member ID</em>; the workspace ID is in the browser URL (app.slack.com/client/<strong>T…</strong>).${conn.length ? ` This browser can send from Slack: ${esc(conn.map((c) => c.domain || c.teamName || c.team).join(", "))}.` : ""}</p>
    </fieldset>`;
  }

  private clubsSection(): string {
    const s = this.state;
    const c = s.clubs;
    const list = c
      ? c.clubs.length
        ? `<ul class="clubs" data-testid="identity-clubs-list">${c.clubs.map((club) => `<li><strong>${esc(club.name || `Club #${club.id}`)}</strong> <span class="opt">${club.role} · ${new Set([...club.members, ...club.admins]).size} people</span></li>`).join("")}</ul>
           <p class="note" data-testid="identity-coworkers">${c.coworkers.length} club-mate${c.coworkers.length === 1 ? "" : "s"} will be suggested when you type @ in FiPen.${c.coworkers.length ? " " + c.coworkers.slice(0, 12).map((a) => `<a href="${esc(personUrl(a))}">${esc(a.slice(0, 8))}…</a>`).join(" ") : ""}</p>`
        : `<p class="note" data-testid="identity-coworkers">This wallet is not in any FiClub yet. <a href="../ficlub/">Create or join a club</a>.</p>`
      : "";
    return `<section class="card" id="clubs" data-testid="identity-clubs"><h2>Your clubs</h2>
      <p class="note">Find the FiClubs this wallet is a member or admin of. Their members become your @-mention suggestions in FiPen. Reading is free (no wallet prompt).</p>
      <button type="button" class="primary" data-action="find-clubs" data-testid="identity-find-clubs" ${s.clubsBusy ? "disabled" : ""}>${s.clubsBusy ? "Searching FiClub…" : c ? "Find all my Clubs again" : "Find all my Clubs"}</button>
      ${s.clubsError ? `<p class="error" role="alert">${esc(s.clubsError)}</p>` : ""}
      ${c ? `<p class="note">Checked ${esc(new Date(c.checkedAt).toLocaleString())}.</p>` : ""}${list}</section>`;
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
    const header = `<header><h1>Your identity</h1><nav class="identity-links"><a href="../ficlub/" data-testid="identity-ficlub-link">FiClub — your groups</a></nav><p class="lede">One name and avatar for your wallet, shown in FiFolders, FiPen and FiGrid. It is saved as a small public piece on Filecoin and linked to your wallet on chain, so anyone you work with sees the same name.</p></header>`;
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
        <div class="field">Picture <span class="opt">optional · cropped to a ${AVATAR_IMAGE_SIZE}px square, shown instead of the emoji</span>
          <div class="photo">
            <input type="file" accept="image/*" data-testid="identity-image-file" hidden />
            <button type="button" data-action="pick-image" data-testid="identity-image-pick">${d.image ? "Change picture" : "Upload picture"}</button>
            ${d.image ? `<button type="button" data-action="remove-image" data-testid="identity-image-remove">Remove picture</button>` : ""}
          </div></div>
        <label class="field">Avatar emoji <span class="opt">optional</span>
          <input data-field="emoji" data-testid="identity-emoji" maxlength="16" placeholder="🦊" value="${esc(d.emoji)}" /></label>
        <div class="field">Color <span class="opt">optional</span><div class="colors">${COLORS.map((c) => `<button type="button" class="swatch${c === d.color ? " on" : ""}" data-action="color" data-color="${c}" style="background:${c}" aria-label="Color ${c}" aria-pressed="${c === d.color}"></button>`).join("")}</div></div>
        <label class="field">Short bio <span class="opt">optional</span>
          <textarea data-field="bio" data-testid="identity-bio" maxlength="${BIO_MAX}" rows="3">${esc(d.bio)}</textarea></label>
        ${this.notifySection()}
        ${s.error ? `<p class="error" role="alert" data-testid="identity-error">${esc(s.error)}</p>` : ""}
        ${s.blocked ? `<p class="blocked" role="alert" data-testid="identity-blocked">${esc(s.blocked.message)} <a href="${esc(s.blocked.url)}">Open FiFolders</a></p>` : ""}
        ${s.saved ? `<p class="ok" role="status" data-testid="identity-saved">Saved.${this.returnTo ? ` <button type="button" data-action="return" data-testid="identity-return">Back to your document</button>` : ""}</p>` : ""}
        <button type="submit" class="primary" data-testid="identity-save" ${s.busy ? "disabled" : ""}>${esc(s.busy || "Save identity")}</button>
        <p class="note">Saving asks your wallet twice: a free signature to store the piece (billed from your existing FiFolders storage deposit — a few bytes, well under $0.01/month) and one transaction to link it (gas ~0.01 FIL). Everything here is public.</p>
      </form>${this.clubsSection()}`;
    }
    const back = this.returnTo ? `<a class="back" href="${esc(this.returnTo)}" data-testid="identity-back">← Back</a>` : `<a class="back" href="../">← FiFolders</a>`;
    this.root.innerHTML = `<div class="wrap">${back}${header}${body}</div>`;
    this.renderToasts();
  }
}
