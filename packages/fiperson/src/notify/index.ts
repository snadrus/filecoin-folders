/**
 * fiperson/notify — `notify(identity, message, url)`: tell a person about a document over their preferred channel.
 * Slack today: the sender connects Slack once (browser-only OAuth v2 user flow with PKCE, no client secret,
 * popup → /slack/callback/), the user token stays in this browser (AES-GCM, key non-extractable in IndexedDB),
 * and the message is sent as the sender with conversations.open + chat.postMessage.
 *
 * Slack's Web API answers CORS with `Access-Control-Allow-Origin: *` but its preflight does not allow an
 * `Authorization` header, so every call is a simple form-encoded POST with the token in the body (no preflight).
 */
import { preferredContact, type IdentityNotify, type IdentityV1, type NotifyContact, type SlackContact } from "../view/schema.js";

export * from "./config.js";
export * from "./token-store.js";
import { notifyConfig } from "./config.js";
import { slackTokenFor, slackTeams, saveSlackToken, forgetSlackToken, type SlackToken } from "./token-store.js";

/** Who to notify: a resolved identity (fiperson/view `ResolvedIdentity`) or a raw profile. */
export type NotifyTarget = { displayName?: string; identity?: IdentityV1 | null; notify?: IdentityNotify } | IdentityV1;

export type NotifyFailure = "no-contact" | "not-configured" | "cancelled" | "popup-blocked" | "other-workspace" | "error";
export type NotifyResult =
  | { ok: true; channel: "slack"; team: string; channelId: string; ts: string }
  | { ok: false; reason: NotifyFailure; message: string; /** Text to copy and send by hand. */ fallback: string };

export function notifyContact(target: NotifyTarget | null | undefined): NotifyContact | null {
  if (!target) return null;
  const n = (target as { notify?: IdentityNotify }).notify ?? (target as { identity?: IdentityV1 | null }).identity?.notify;
  return preferredContact(n);
}

/** Human label for the channel a target would be notified on, e.g. "Slack (acme)". Null when none. */
export function notifyChannelLabel(target: NotifyTarget | null | undefined): string | null {
  const c = notifyContact(target);
  if (!c) return null;
  return c.channel === "slack" ? `Slack${c.domain ? ` (${c.domain})` : ""}` : c.channel;
}

export function composeMessage(message: string, url: string): string {
  const m = message.trim();
  return m.includes(url) ? m : `${m}${m ? "\n" : ""}${url}`;
}

/** POST a Slack Web API method form-encoded (a CORS "simple request": no preflight). */
export async function slackCall<T = Record<string, unknown>>(method: string, params: Record<string, string>): Promise<T & { ok: boolean; error?: string }> {
  const cfg = notifyConfig();
  const res = await cfg.fetch(`${cfg.slackApi}/${method}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return (await res.json()) as T & { ok: boolean; error?: string };
}

const nameOf = (t: NotifyTarget) => (t as { displayName?: string }).displayName || "them";

function fail(reason: NotifyFailure, message: string, text: string): NotifyResult {
  return { ok: false, reason, message, fallback: text };
}

/**
 * Notify `target` about `url`. Call it from a click handler: when Slack is not connected yet for the
 * recipient's workspace it opens the Connect Slack popup synchronously (before any await) so it isn't blocked.
 * Never called automatically by FiPen; the user approves each send.
 */
export function notify(target: NotifyTarget, message: string, url: string): Promise<NotifyResult> {
  const text = composeMessage(message, url);
  const contact = notifyContact(target);
  if (!contact) return Promise.resolve(fail("no-contact", `${nameOf(target)} has not added a notification contact to their FiPerson identity. Copy the link and send it yourself.`, text));
  if (contact.channel === "slack") return notifySlack(target, contact, text);
  return Promise.resolve(fail("no-contact", "Unsupported notification channel.", text));
}

function notifySlack(target: NotifyTarget, contact: SlackContact, text: string): Promise<NotifyResult> {
  const cfg = notifyConfig();
  if (!cfg.slackClientId) return Promise.resolve(fail("not-configured", "Slack notifications are not set up on this site yet (no Slack app client ID). Copy the link and send it yourself.", text));
  const connected = slackTeams();
  const connecting = connected.includes(contact.team) ? null : connectSlack({ team: contact.team });
  return (async () => {
    if (connecting) {
      let got: SlackToken;
      try {
        got = await connecting;
      } catch (e) {
        const reason = (e as Error).name === "PopupBlocked" ? "popup-blocked" : "cancelled";
        return fail(reason, reason === "popup-blocked" ? "Your browser blocked the Connect Slack window. Allow pop-ups for this site and try again." : "Slack was not connected, so nothing was sent.", text);
      }
      if (got.team !== contact.team) return otherWorkspace(target, contact, got, text);
    }
    return sendSlack(target, contact, text);
  })();
}

function otherWorkspace(target: NotifyTarget, contact: SlackContact, got: Pick<SlackToken, "teamName" | "domain">, text: string): NotifyResult {
  const theirs = contact.domain ? `${contact.domain}.slack.com` : `workspace ${contact.team}`;
  const yours = got.domain ? `${got.domain}.slack.com` : got.teamName || "a different workspace";
  return fail("other-workspace", `${nameOf(target)} is on Slack in ${theirs}, but you connected ${yours}. Slack only lets you message people in a workspace you belong to. Connect Slack again and choose ${theirs}, or copy the link and send it another way.`, text);
}

async function sendSlack(target: NotifyTarget, contact: SlackContact, text: string): Promise<NotifyResult> {
  const tok = await slackTokenFor(contact.team);
  if (!tok) return fail("error", "Slack token is missing. Connect Slack again.", text);
  // im:write → conversations.open gives the DM channel between the sender and the recipient (documented path for user tokens).
  const open = await slackCall<{ channel?: { id: string } }>("conversations.open", { token: tok.token, users: contact.user, return_im: "false" });
  if (!open.ok || !open.channel?.id) return slackError(target, contact, tok, open.error || "unknown_error", text);
  const post = await slackCall<{ ts?: string; channel?: string }>("chat.postMessage", { token: tok.token, channel: open.channel.id, text, unfurl_links: "true" });
  if (!post.ok) return slackError(target, contact, tok, post.error || "unknown_error", text);
  return { ok: true, channel: "slack", team: contact.team, channelId: post.channel || open.channel.id, ts: post.ts || "" };
}

function slackError(target: NotifyTarget, contact: SlackContact, tok: SlackToken, error: string, text: string): NotifyResult {
  if (error === "invalid_auth" || error === "token_revoked" || error === "token_expired" || error === "account_inactive" || error === "not_authed") {
    forgetSlackToken(tok.team);
    return fail("error", "Your Slack connection expired. Press Notify again to reconnect.", text);
  }
  if (error === "user_not_found" || error === "channel_not_found" || error === "user_not_visible" || error === "cannot_dm_bot") return otherWorkspace(target, contact, tok, text);
  if (error === "missing_scope") return fail("error", "The Slack connection is missing a permission. Disconnect Slack and connect again.", text);
  return fail("error", `Slack said “${error}”. Nothing was sent.`, text);
}

/** PopupBlocked / cancelled errors from {@link connectSlack}. */
export class SlackConnectError extends Error {
  constructor(message: string, override readonly name: "PopupBlocked" | "Cancelled" | "SlackError" = "SlackError") {
    super(message);
  }
}

/**
 * Open the Connect Slack popup (must run inside a click). The popup is our /slack/callback/ page: it generates
 * the PKCE verifier, sends the user to Slack, exchanges the code and stores the token, then reports back.
 */
export function connectSlack(opts: { team?: string } = {}): Promise<SlackToken> {
  const cfg = notifyConfig();
  const state = randomId();
  const start = new URL(cfg.slackRedirectUri);
  start.searchParams.set("start", "1");
  start.searchParams.set("state", state);
  if (opts.team) start.searchParams.set("team", opts.team);
  const popup = cfg.open(start.href, "fiperson-slack", "popup,width=600,height=760");
  if (!popup) return Promise.reject(new SlackConnectError("Pop-up blocked", "PopupBlocked"));
  return new Promise((resolve, reject) => {
    let done = false;
    let seen = false;
    let closing = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      chan?.close();
      removeEventListener("storage", onStorage);
      fn();
    };
    const check = (raw: string | null) => {
      if (!raw) return;
      try {
        const msg = JSON.parse(raw) as { state: string; ok: boolean; team?: string; error?: string };
        if (msg.state !== state || seen) return;
        seen = true;
        if (!msg.ok) return finish(() => reject(new SlackConnectError(msg.error || "Slack connect failed", msg.error === "access_denied" ? "Cancelled" : "SlackError")));
        void slackTokenFor(msg.team!).then((t) => finish(() => (t ? resolve(t) : reject(new SlackConnectError("Token missing after connect")))));
      } catch {
        /* ignore */
      }
    };
    const key = RESULT_PREFIX + state;
    const onStorage = (e: StorageEvent) => e.key === key && check(e.newValue);
    addEventListener("storage", onStorage);
    const chan = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    if (chan) chan.onmessage = (e) => check(typeof e.data === "string" ? e.data : JSON.stringify(e.data));
    const poll = setInterval(() => {
      check(safeGet(key));
      if (popup.closed && !done && !closing) {
        closing = true;
        setTimeout(() => {
          check(safeGet(key));
          if (!seen) finish(() => reject(new SlackConnectError("Slack window closed", "Cancelled")));
        }, 300);
      }
    }, 400);
  });
}

const RESULT_PREFIX = "fiperson:slack-result:";
const CHANNEL = "fiperson-slack";
const VERIFIER_KEY = "fiperson:slack-pkce";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export const SLACK_USER_SCOPES = ["chat:write", "im:write"] as const;

/**
 * The /slack/callback/ page. `?start=1&state=…[&team=…]`: make a code_verifier (kept in this popup's
 * sessionStorage), redirect to Slack. `?code=…&state=…`: exchange at oauth.v2.user.access with the verifier,
 * store the token, report to the opener, close. Returns a status line for the page.
 */
export async function handleSlackCallback(href: string = location.href, nav: (url: string) => void = (u) => location.replace(u)): Promise<{ ok: boolean; message: string }> {
  const cfg = notifyConfig();
  const url = new URL(href);
  const q = url.searchParams;
  const report = (msg: Record<string, unknown>) => {
    const raw = JSON.stringify(msg);
    try {
      localStorage.setItem(RESULT_PREFIX + msg.state, raw);
    } catch {
      /* ignore */
    }
    try {
      const c = new BroadcastChannel(CHANNEL);
      c.postMessage(raw);
      c.close();
    } catch {
      /* ignore */
    }
  };
  if (q.get("start") === "1") {
    const state = q.get("state") || randomId();
    const verifier = randomId(48);
    sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ state, verifier }));
    const auth = new URL(cfg.slackAuthorize);
    auth.searchParams.set("client_id", cfg.slackClientId);
    auth.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
    auth.searchParams.set("redirect_uri", cfg.slackRedirectUri);
    auth.searchParams.set("state", state);
    auth.searchParams.set("code_challenge", await pkceChallenge(verifier));
    auth.searchParams.set("code_challenge_method", "S256");
    const team = q.get("team");
    if (team) auth.searchParams.set("team", team);
    nav(auth.href);
    return { ok: true, message: "Opening Slack…" };
  }
  const state = q.get("state") || "";
  let saved: { state: string; verifier: string } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(VERIFIER_KEY) || "null");
  } catch {
    saved = null;
  }
  sessionStorage.removeItem(VERIFIER_KEY);
  if (q.get("error")) {
    report({ state, ok: false, error: q.get("error") });
    return { ok: false, message: q.get("error") === "access_denied" ? "Slack was not connected (you cancelled)." : `Slack said “${q.get("error")}”.` };
  }
  const code = q.get("code");
  if (!code || !saved || saved.state !== state) {
    report({ state, ok: false, error: "bad_state" });
    return { ok: false, message: "This Slack sign-in link is stale or was not started here. Close this window and try again." };
  }
  const tok = await slackCall<{ access_token?: string; authed_user?: { id?: string; access_token?: string }; team?: { id?: string; name?: string }; team_id?: string; user_id?: string; scope?: string; refresh_token?: string; expires_in?: number }>(
    "oauth.v2.user.access",
    { client_id: cfg.slackClientId, code, code_verifier: saved.verifier, redirect_uri: cfg.slackRedirectUri },
  ).catch((e) => ({ ok: false, error: String((e as Error).message) }) as { ok: false; error: string });
  const token = ("access_token" in tok && tok.access_token) || ("authed_user" in tok && tok.authed_user?.access_token) || "";
  if (!tok.ok || !token) {
    report({ state, ok: false, error: tok.error || "no_token" });
    return { ok: false, message: `Slack sign-in failed (${tok.error || "no token"}).` };
  }
  // auth.test needs no scope and gives the workspace URL (domain) and canonical team/user IDs.
  const who = await slackCall<{ team_id?: string; user_id?: string; team?: string; url?: string }>("auth.test", { token }).catch(() => ({ ok: false }) as { ok: false });
  const t = tok as { team?: { id?: string; name?: string }; team_id?: string; authed_user?: { id?: string }; user_id?: string; scope?: string };
  const team = ("team_id" in who && who.team_id) || t.team?.id || t.team_id || "";
  const user = ("user_id" in who && who.user_id) || t.authed_user?.id || t.user_id || "";
  const domain = "url" in who && who.url ? (new URL(who.url).hostname.split(".")[0] ?? "") : "";
  await saveSlackToken({ team, user, token, teamName: ("team" in who && typeof who.team === "string" ? who.team : t.team?.name) || "", domain, scope: t.scope || "" });
  report({ state, ok: true, team });
  return { ok: true, message: `Slack connected${domain ? ` (${domain}.slack.com)` : ""}. You can close this window.` };
}

/** Your own Slack IDs (for filling your identity's notification contact). Opens Connect Slack when needed. */
export async function mySlackContact(token?: SlackToken): Promise<SlackContact> {
  const t = token ?? (await connectSlack());
  return { channel: "slack", team: t.team, user: t.user, ...(t.domain ? { domain: t.domain } : {}) };
}
