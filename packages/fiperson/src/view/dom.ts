import { avatarColors, initials, shortAddress } from "./display.js";
import { pixelAvatarSvg } from "./pixel-avatar.js";
import type { ResolvedIdentity } from "./resolve.js";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Where to configure the identity, returning here after Save. Pages live one level under the site root (/fipen/, /figrid/), the drive at the root. */
export function identityUrl(here: string = location.href, page = "../identity/"): string {
  const url = new URL(page, here);
  url.searchParams.set("return", here);
  return url.href;
}

export interface AvatarPerson {
  address?: string;
  displayName: string;
  avatar?: { emoji?: string; color?: string };
}

/** Inner avatar content: identity emoji, else the wallet's pixel avatar, else the initial. */
export function avatarInnerHtml(person: AvatarPerson, size = 28): string {
  if (person.avatar?.emoji) return escapeHtml(person.avatar.emoji);
  if (person.address) return pixelAvatarSvg(person.address, size);
  return escapeHtml(initials(person.displayName));
}

/** Round avatar HTML at `size` px. */
export function avatarHtml(person: AvatarPerson, size = 28): string {
  const c = avatarColors(person);
  const pixel = !person.avatar?.emoji && !!person.address;
  return `<span class="fiperson-avatar" data-kind="${person.avatar?.emoji ? "emoji" : pixel ? "pixel" : "initial"}" style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;flex:none;display:inline-grid;place-items:center;font-size:${Math.round(size / 2)}px;background:${escapeHtml(c.background)};color:${c.color}">${avatarInnerHtml(person, size)}</span>`;
}

/** Set an existing element's content to the avatar (for editors that build their own avatar nodes). */
export function paintAvatar(el: HTMLElement, person: AvatarPerson): void {
  const size = el.getBoundingClientRect().width || 28;
  el.innerHTML = avatarInnerHtml(person, Math.round(size));
  el.dataset.kind = person.avatar?.emoji ? "emoji" : person.address ? "pixel" : "initial";
  if (person.address && !person.avatar?.emoji) el.style.overflow = "hidden";
}

/** Small inline person chip HTML (avatar + name). */
export function personChipHtml(person: AvatarPerson, size = 28): string {
  return `<span class="fiperson-chip" style="display:inline-flex;align-items:center;gap:8px">${avatarHtml(person, size)}<span class="fiperson-name">${escapeHtml(person.displayName)}</span></span>`;
}

export interface IdentityPopupOptions {
  /** Resolved self (identity null = not set up). */
  person: ResolvedIdentity;
  /** Link to the edit page; defaults to {@link identityUrl}(). */
  href?: string;
  /** Offer "Just use a different name here". */
  onLocalRename?: () => void;
}

/** Popup body HTML: "Configure your identity" when none, else the identity with Edit. */
export function identityPopupHtml(opts: IdentityPopupOptions): string {
  const href = escapeHtml(opts.href ?? identityUrl());
  const link = "background:none;border:0;padding:0;color:#1a73e8;font:inherit;cursor:pointer;text-decoration:none";
  const p = opts.person;
  if (p.identity) {
    return `<div style="display:flex;gap:12px;align-items:center">${personChipHtml(p, 40).replace('class="fiperson-name"', 'class="fiperson-name" data-testid="identity-pop-name" style="font-weight:500"')}</div>
      <small style="color:#5f6368">${escapeHtml(shortAddress(p.address))}</small>
      ${p.bio ? `<p style="margin:10px 0 0;color:#3c4043">${escapeHtml(p.bio)}</p>` : ""}
      <p style="margin:12px 0 0"><a data-testid="identity-pop-edit" href="${href}" style="${link}">Edit</a></p>`;
  }
  return `<h3 style="margin:0 0 6px;font-size:16px;font-weight:500">Configure your identity</h3>
      <p style="margin:0 0 12px;color:#3c4043">Pick one name and avatar for your wallet. It is saved on Filecoin and linked to your wallet, so FiPen, FiGrid, FiFolders — and everyone you share with — see the same name. Right now you show as <strong>${escapeHtml(p.displayName)}</strong>.</p>
      <a data-testid="identity-pop-configure" href="${href}" style="display:inline-block;background:#1a73e8;color:#fff;border-radius:18px;padding:8px 18px;font-weight:500;text-decoration:none">Configure your identity</a>
      ${opts.onLocalRename ? `<p style="margin:10px 0 0"><button type="button" data-testid="identity-pop-local" style="${link};font-size:13px">Just use a different name here</button></p>` : ""}`;
}

/** Open the popup under `anchor` (light theme). Escape / outside click closes. */
export function openIdentityPopup(anchor: HTMLElement, opts: IdentityPopupOptions): HTMLElement {
  document.querySelector("#identity-pop")?.remove();
  const pop = document.createElement("div");
  pop.id = "identity-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", opts.person.identity ? "Your identity" : "Configure your identity");
  pop.style.cssText = "position:fixed;z-index:1000;width:300px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:12px;box-shadow:0 4px 16px rgba(60,64,67,.25);padding:16px;font:14px/1.45 Roboto,system-ui,sans-serif";
  pop.innerHTML = identityPopupHtml(opts);
  const close = () => {
    pop.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey);
  };
  const onDoc = (event: Event) => {
    if (!pop.contains(event.target as Node) && event.target !== anchor) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  pop.querySelector("[data-testid=identity-pop-local]")?.addEventListener("click", () => {
    close();
    opts.onLocalRename?.();
  });
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 308, Math.round(rect.right - 300)))}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
  });
  return pop;
}
