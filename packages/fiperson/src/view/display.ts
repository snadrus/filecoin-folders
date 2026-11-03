import { guestName } from "./guest-name.js";
import { cachedIdentity, type KV } from "./resolve.js";
import { isAddress } from "./schema.js";

/** Wallet the editors learned (FiPen/FiGrid `learnWallet`). */
export const WALLET_KEY = "fipen:wallet";
export const BROWSER_ID_KEY = "fipen:browser-id";
/** Pre-identity FiFolders display name (still read as a fallback). */
export const LEGACY_NAME_KEY = "fifolders:display-name";
/** Per-tab override typed in an editor. */
export const SESSION_NAME_KEYS = ["felarumi-name", "folio-name"] as const;

export interface NameSources {
  identityName?: string | null;
  sessionName?: string | null;
  legacyName?: string | null;
  wallet?: string | null;
  browserId?: string | null;
}

/** Name precedence everywhere: wallet identity → name typed this session → legacy FiFolders name → guest(wallet) → guest(browser id). */
export function pickDisplayName(s: NameSources): string {
  for (const v of [s.identityName, s.sessionName, s.legacyName]) {
    const t = v?.trim();
    if (t) return t.slice(0, 60);
  }
  if (isAddress(s.wallet)) return guestName(s.wallet);
  return guestName(s.browserId || "");
}

function get(store: KV | null | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** {@link pickDisplayName} wired to localStorage/sessionStorage. Creates a browser id when there is no wallet. */
export function resolveDisplayName(local: KV | null = safe(() => localStorage), session: KV | null = safe(() => sessionStorage)): string {
  const wallet = get(local, WALLET_KEY);
  const identity = isAddress(wallet) ? cachedIdentity(wallet, local).identity?.displayName : null;
  let browserId = get(local, BROWSER_ID_KEY);
  const sessionName = SESSION_NAME_KEYS.map((k) => get(session, k)).find(Boolean) ?? null;
  const legacyName = get(local, LEGACY_NAME_KEY);
  if (!identity && !sessionName && !legacyName?.trim() && !isAddress(wallet) && !browserId) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    browserId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      local?.setItem(BROWSER_ID_KEY, browserId);
    } catch {
      // ignore
    }
  }
  return pickDisplayName({ identityName: identity, sessionName, legacyName, wallet, browserId });
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** First letter, uppercased ("?" when empty). */
export function initials(name: string): string {
  return ([...name.trim()][0] || "?").toUpperCase();
}

/** Avatar glyph: identity emoji, else initial. */
export function avatarGlyph(person: { displayName: string; avatar?: { emoji?: string } }): string {
  return person.avatar?.emoji || initials(person.displayName);
}

export const AVATAR_COLORS = ["#1a73e8", "#188038", "#d93025", "#e37400", "#9334e6", "#007b83", "#c5221f", "#5f6368"] as const;

/** Background + text color for an avatar; neutral grey when no color is set. */
export function avatarColors(person: { avatar?: { color?: string } }): { background: string; color: string } {
  return person.avatar?.color ? { background: person.avatar.color, color: "#fff" } : { background: "#e8eaed", color: "#202124" };
}

export function shortAddress(address: string): string {
  return isAddress(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
