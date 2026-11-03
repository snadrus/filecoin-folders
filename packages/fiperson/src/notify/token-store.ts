/**
 * Slack user tokens, one per workspace, kept only in this browser. Ciphertext (AES-GCM) in localStorage;
 * the key is a non-extractable CryptoKey in IndexedDB, so the raw token is never in storage in the clear.
 * Without IndexedDB/WebCrypto (rare) the token is stored as-is and `encrypted` is false.
 */
export interface SlackToken {
  team: string;
  user: string;
  token: string;
  teamName: string;
  domain: string;
  scope: string;
}
interface Stored extends Omit<SlackToken, "token"> {
  iv?: string;
  ct?: string;
  plain?: string;
  at: number;
}

export const SLACK_TOKENS_KEY = "fiperson:slack-tokens:v1";
const DB = "fiperson";
const STORE = "keys";

function read(): Record<string, Stored> {
  try {
    return JSON.parse(localStorage.getItem(SLACK_TOKENS_KEY) || "{}") as Record<string, Stored>;
  } catch {
    return {};
  }
}
function write(v: Record<string, Stored>): void {
  localStorage.setItem(SLACK_TOKENS_KEY, JSON.stringify(v));
}

/** Workspace IDs with a stored token (sync; no secrets). */
export function slackTeams(): string[] {
  return Object.keys(read());
}
/** Stored workspaces with names (for "Connected to …" UI). */
export function slackConnections(): { team: string; user: string; teamName: string; domain: string; encrypted: boolean }[] {
  return Object.values(read()).map((s) => ({ team: s.team, user: s.user, teamName: s.teamName, domain: s.domain, encrypted: !!s.ct }));
}
export function forgetSlackToken(team?: string): void {
  if (!team) return void localStorage.removeItem(SLACK_TOKENS_KEY);
  const all = read();
  delete all[team];
  write(all);
}

let keyPromise: Promise<CryptoKey | null> | null = null;
function key(): Promise<CryptoKey | null> {
  keyPromise ??= (async () => {
    if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) return null;
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = () => new Promise<CryptoKey | undefined>((res, rej) => {
      const t = db.transaction(STORE).objectStore(STORE).get("slack");
      t.onsuccess = () => res(t.result as CryptoKey | undefined);
      t.onerror = () => rej(t.error);
    });
    let k = await get();
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await new Promise<void>((res, rej) => {
        const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(k, "slack");
        t.onsuccess = () => res();
        t.onerror = () => rej(t.error);
      });
    }
    return k;
  })().catch(() => null);
  return keyPromise;
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function saveSlackToken(t: SlackToken): Promise<void> {
  const k = await key();
  const { token, ...meta } = t;
  let entry: Stored;
  if (k) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(token)));
    entry = { ...meta, iv: b64(iv), ct: b64(ct), at: Date.now() };
  } else entry = { ...meta, plain: token, at: Date.now() };
  const all = read();
  all[t.team] = entry;
  write(all);
}

export async function slackTokenFor(team: string): Promise<SlackToken | null> {
  const s = read()[team];
  if (!s) return null;
  let token = s.plain ?? "";
  if (s.ct && s.iv) {
    const k = await key();
    if (!k) return null;
    try {
      token = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, k, unb64(s.ct)));
    } catch {
      return null;
    }
  }
  return token ? { team: s.team, user: s.user, token, teamName: s.teamName, domain: s.domain, scope: s.scope } : null;
}
