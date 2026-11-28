/** Identity v1 schema, constants and validation. Dependency-free (safe for every app bundle). */

export const IDENTITY_NAMESPACE = "fil-identity";
export const IDENTITY_PROFILE_KEY = "profile";
export const IDENTITY_CONTACTS_KEY = "contacts";
/** keccak256(utf8("fil-identity")) — FolderRegistry `ns`. */
export const IDENTITY_NS = "0x4ba7e36ce925bbe5d8a219757e1186149701b3ee9649e24538dccda15e7c59e5" as const;
/** keccak256(utf8("profile")) — FolderRegistry `key` for the profile. */
export const IDENTITY_PROFILE_KEY_ID = "0xe3dd854eb9d23c94680b3ec632b9072842365d9a702ab0df7da8bc398ee52c7d" as const;
/** keccak256(utf8("contacts")) — reserved for the address book. */
export const IDENTITY_CONTACTS_KEY_ID = "0x8417ef2e3e7bb6630d90a4cdcc188db4bcc27d6b2d8891b376ef771499bb4299" as const;
export const IDENTITY_SCHEMA = "fil-identity/profile";
export const IDENTITY_VERSION = 1;
export const DISPLAY_NAME_MAX = 60;
export const BIO_MAX = 280;
/** FolderRegistry on Filecoin Calibration (deployments/calibration.json). */
export const CALIBRATION_REGISTRY = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331" as const;
/** FolderRegistry v2 on Calibration (deployments/calibration-v2.json). Read first; v1 is the fallback until the next save moves the pointer. */
export const CALIBRATION_REGISTRY_V2 = "0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443" as const;
export const CALIBRATION_RPC = "https://api.calibration.node.glif.io/rpc/v1";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface IdentityAvatar {
  /** One emoji (grapheme cluster). */
  emoji?: string;
  /** `#rrggbb`. */
  color?: string;
  /** Small square picture as a `data:image/(webp|png|jpeg);base64,…` URL (≤ {@link AVATAR_IMAGE_MAX} chars). Shown instead of the emoji. */
  image?: string;
}

/** Max length of `avatar.image` (data URL chars, ~18 KB of image). A 128px WebP is usually 3–10 KB. */
export const AVATAR_IMAGE_MAX = 24_000;
/** Side of the stored square avatar picture, px. */
export const AVATAR_IMAGE_SIZE = 128;
const IMAGE_RE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A safe inline avatar picture (data URL of webp/png/jpeg within the size limit), else "". */
export function cleanAvatarImage(value: unknown): string {
  return typeof value === "string" && value.length <= AVATAR_IMAGE_MAX && IMAGE_RE.test(value) ? value : "";
}

/** Version 1 profile document. Unknown fields are kept on read. */
export interface IdentityV1 {
  v: 1;
  schema: typeof IDENTITY_SCHEMA;
  address: Address;
  displayName: string;
  avatar?: IdentityAvatar;
  bio?: string;
  updatedAt: string;
  /** Previous profile piece CID (history link; "" = first). Optional. */
  prev?: string;
  /** How others can notify this person (public). Optional. */
  notify?: IdentityNotify;
  [extra: string]: unknown;
}
export type Identity = IdentityV1;

export interface IdentityDraft {
  displayName: string;
  avatar?: IdentityAvatar;
  bio?: string;
  notify?: IdentityNotify;
}

/** Notification channels. Only Slack today; the contact list is keyed by `channel` so email etc. can be added. */
export type NotifyChannel = "slack";
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ["slack"];
/** A Slack DM target: workspace (team) ID + member ID, plus the workspace subdomain for links/explanations. */
export interface SlackContact {
  channel: "slack";
  /** Workspace ID, e.g. `T0123ABCD` (Enterprise Grid org IDs start with E). */
  team: string;
  /** Member ID, e.g. `U0123ABCD` (or W… on Grid). */
  user: string;
  /** Workspace subdomain (`acme` for acme.slack.com). Optional. */
  domain?: string;
}
export type NotifyContact = SlackContact;
export interface IdentityNotify {
  /** Channel to use first; defaults to the first contact. */
  preferred?: NotifyChannel;
  contacts: NotifyContact[];
}
export const NOTIFY_CONTACTS_MAX = 4;
const SLACK_TEAM_RE = /^[TE][A-Z0-9]{2,20}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,20}$/;
const SLACK_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Clean a notify block: drops invalid contacts; undefined when nothing valid is left. */
export function normalizeNotify(value: unknown): IdentityNotify | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { preferred?: unknown; contacts?: unknown };
  const contacts: NotifyContact[] = [];
  for (const c of Array.isArray(raw.contacts) ? raw.contacts : []) {
    if (!c || typeof c !== "object" || contacts.length >= NOTIFY_CONTACTS_MAX) continue;
    const r = c as Record<string, unknown>;
    if (r.channel !== "slack") continue;
    const team = typeof r.team === "string" ? r.team.trim().toUpperCase() : "";
    const user = typeof r.user === "string" ? r.user.trim().toUpperCase() : "";
    if (!SLACK_TEAM_RE.test(team) || !SLACK_USER_RE.test(user)) continue;
    const domain = typeof r.domain === "string" ? r.domain.trim().toLowerCase().replace(/\.slack\.com$/, "") : "";
    contacts.push({ channel: "slack", team, user, ...(SLACK_DOMAIN_RE.test(domain) ? { domain } : {}) });
  }
  if (!contacts.length) return undefined;
  const preferred = NOTIFY_CHANNELS.includes(raw.preferred as NotifyChannel) && contacts.some((c) => c.channel === raw.preferred) ? (raw.preferred as NotifyChannel) : contacts[0]!.channel;
  return { preferred, contacts };
}

/** The contact to use: the preferred channel's first entry, else the first contact. */
export function preferredContact(notify: IdentityNotify | undefined | null): NotifyContact | null {
  if (!notify?.contacts?.length) return null;
  return notify.contacts.find((c) => c.channel === notify.preferred) ?? notify.contacts[0] ?? null;
}

export class IdentityError extends Error {
  override name = "IdentityError";
}

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanEmoji(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const first = Seg ? ([...new Seg(undefined, { granularity: "grapheme" }).segment(trimmed)][0]?.segment ?? "") : [...trimmed].slice(0, 2).join("");
  return first.slice(0, 16);
}

/** Validate + normalize into a v1 document. Throws {@link IdentityError}. */
export function normalizeIdentity(address: string, draft: IdentityDraft, now: Date = new Date()): IdentityV1 {
  if (!isAddress(address)) throw new IdentityError("Connect a wallet first.");
  const displayName = cleanText(draft.displayName, DISPLAY_NAME_MAX);
  if (!displayName) throw new IdentityError("Display name is required.");
  const doc: IdentityV1 = { v: 1, schema: IDENTITY_SCHEMA, address: address.toLowerCase() as Address, displayName, updatedAt: now.toISOString() };
  const emoji = cleanEmoji(draft.avatar?.emoji);
  const color = typeof draft.avatar?.color === "string" && COLOR_RE.test(draft.avatar.color) ? draft.avatar.color.toLowerCase() : "";
  const image = cleanAvatarImage(draft.avatar?.image);
  if (emoji || color || image) doc.avatar = { ...(emoji ? { emoji } : {}), ...(color ? { color } : {}), ...(image ? { image } : {}) };
  const bio = cleanText(draft.bio, BIO_MAX);
  if (bio) doc.bio = bio;
  const notify = normalizeNotify(draft.notify);
  if (notify) doc.notify = notify;
  return doc;
}

/** Parse bytes / JSON text / object. Null unless it is a valid v1 doc (for `expected`, when given). */
export function parseIdentity(input: unknown, expected?: string): IdentityV1 | null {
  let value = input;
  try {
    if (input instanceof Uint8Array) value = JSON.parse(new TextDecoder().decode(input));
    else if (typeof input === "string") value = JSON.parse(input);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !isAddress(raw.address)) return null;
  if (expected && raw.address.toLowerCase() !== expected.toLowerCase()) return null;
  try {
    const when = typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : 0;
    const built = normalizeIdentity(raw.address, { displayName: raw.displayName as string, avatar: raw.avatar as IdentityAvatar, bio: raw.bio as string, notify: raw.notify as IdentityNotify }, new Date(when));
    const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !(k in built) && k !== "avatar" && k !== "bio" && k !== "notify"));
    return { ...extra, ...built };
  } catch {
    return null;
  }
}
