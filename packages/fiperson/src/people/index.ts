/**
 * fiperson/people — FiPerson owns who you can mention. Apps (FiPen) only render:
 * `suggest(query)` → `{ id, name, iconUrl }[]` from your cached club-mates (see fiperson/clubs) plus people
 * the app passes in (doc participants); `details(id)` → the extra card data once one is chosen.
 * Ids are lowercase wallet addresses. Names/avatars come from the identity cache (`cachedIdentity`).
 */
import { cachedClubs, cachedCoworkers } from "../clubs/index.js";
import { avatarColors, initials, shortAddress } from "../view/display.js";
import { pixelAvatarSvg } from "../view/pixel-avatar.js";
import { cachedIdentity, type KV } from "../view/resolve.js";
import { cleanAvatarImage, isAddress, preferredContact, type Address, type NotifyContact } from "../view/schema.js";
import { WALLET_KEY } from "../view/display.js";

export interface PersonSuggestion {
  /** Lowercase wallet address. */
  id: string;
  name: string;
  /** data: URL (uploaded picture, emoji or the wallet's pixel avatar). */
  iconUrl: string;
  /** Why they are suggested: "Acme · Ops" (shared clubs) or "In this document". */
  hint: string;
}

export interface PersonDetails extends PersonSuggestion {
  address: Address;
  shortAddress: string;
  bio: string;
  /** Club names you share. */
  sharedClubs: string[];
  /** Preferred notification contact, if they set one. */
  contact: NotifyContact | null;
  /** "Slack · acme.slack.com" etc., or "" when none. */
  contactLabel: string;
  /** Has a saved on-chain identity (else a guest name). */
  hasIdentity: boolean;
  /** Link to the view-person page. */
  url: string;
}

function cache(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Your wallet (as remembered by FiFolders/FiPen), or null. */
export function selfAddress(kv: KV | null = cache()): string | null {
  const w = kv?.getItem(WALLET_KEY) ?? null;
  return isAddress(w) ? w.toLowerCase() : null;
}

/** Icon as a data URL, for <img> or canvas. */
export function personIconUrl(address: string, kv: KV | null = cache()): string {
  const p = cachedIdentity(address, kv);
  const image = cleanAvatarImage(p.avatar?.image);
  if (image) return image;
  if (p.avatar?.emoji) {
    const c = avatarColors(p);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${c.background}"/><text x="32" y="44" font-size="34" text-anchor="middle">${p.avatar.emoji.replace(/[<&>]/g, "")}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(pixelAvatarSvg(address, 64));
}

/** View-person page URL (`/person/?id=<address>`), relative to `here`. */
export function personUrl(id: string, here: string = (globalThis as { location?: Location }).location?.href ?? "https://fifolders.scionbase.ai/", page = "/person/"): string {
  const u = new URL(page, here);
  u.searchParams.set("id", id.toLowerCase());
  return u.href;
}

/** URL of the FiPerson page section that runs "Find all my Clubs". */
export function findClubsUrl(here: string = (globalThis as { location?: Location }).location?.href ?? "https://fifolders.scionbase.ai/"): string {
  const u = new URL("/identity/", here);
  u.searchParams.set("return", here);
  u.hash = "clubs";
  return u.href;
}

export interface SuggestOptions {
  /** Extra people, e.g. document participants with a wallet. */
  participants?: { address: string; name?: string }[];
  /** Include yourself (default false). */
  includeSelf?: boolean;
  limit?: number;
  kv?: KV | null;
}

/** People matching `query` (prefix of any word in the name, or of the address). Empty query = everyone. */
export function suggest(query: string, opts: SuggestOptions = {}): PersonSuggestion[] {
  const kv = opts.kv === undefined ? cache() : opts.kv;
  const me = selfAddress(kv);
  const hints = new Map<string, string>();
  for (const c of cachedCoworkers(me, kv)) hints.set(c.address, c.clubs.join(" · "));
  for (const p of opts.participants ?? []) if (isAddress(p.address) && !hints.has(p.address.toLowerCase())) hints.set(p.address.toLowerCase(), "In this document");
  if (opts.includeSelf && me) hints.set(me, "You");
  else if (me) hints.delete(me);
  const q = query.trim().toLowerCase();
  const out: (PersonSuggestion & { rank: number })[] = [];
  for (const [id, hint] of hints) {
    const name = cachedIdentity(id, kv).displayName;
    const words = name.toLowerCase().split(/\s+/);
    const rank = !q ? 1 : name.toLowerCase().startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : id.startsWith(q) || id.slice(2).startsWith(q) ? 2 : -1;
    if (rank >= 0) out.push({ id, name, iconUrl: personIconUrl(id, kv), hint, rank });
  }
  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return out.slice(0, opts.limit ?? 8).map(({ rank: _r, ...s }) => s);
}

/** True when there is nobody to suggest because "Find all my Clubs" has not run for this wallet. */
export function needsClubScan(kv: KV | null = cache()): boolean {
  return !cachedClubs(selfAddress(kv), kv);
}

export function contactLabel(c: NotifyContact | null): string {
  if (!c) return "";
  return c.channel === "slack" ? `Slack${c.domain ? ` · ${c.domain}.slack.com` : ""}` : c.channel;
}

/** Card data for one person. */
export function details(id: string, kv: KV | null = cache()): PersonDetails | null {
  if (!isAddress(id)) return null;
  const address = id.toLowerCase() as Address;
  const p = cachedIdentity(address, kv);
  const mine = cachedClubs(selfAddress(kv), kv);
  const sharedClubs = mine ? mine.clubs.filter((c) => c.members.includes(address) || c.admins.includes(address)).map((c) => c.name) : [];
  const contact = preferredContact(p.identity?.notify);
  return {
    id: address,
    address,
    name: p.displayName,
    iconUrl: personIconUrl(address, kv),
    hint: sharedClubs.join(" · "),
    shortAddress: shortAddress(address),
    bio: p.bio ?? "",
    sharedClubs,
    contact,
    contactLabel: contactLabel(contact),
    hasIdentity: !!p.identity,
    url: personUrl(address),
  };
}
export { initials };
