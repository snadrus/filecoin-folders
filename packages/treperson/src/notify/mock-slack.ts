/**
 * Mock Slack for tests and the VITE_E2E build: a `fetch` that answers oauth.v2.user.access, auth.test,
 * conversations.open and chat.postMessage, and an authorize URL handler. Nothing leaves the browser.
 * Workspaces: T0MOCKACME (acme) with U0MOCKANDY (the sender) and U0MOCKBEA; T0MOCKOTHER (other) with U0MOCKCARL.
 */
export interface MockSlackMessage {
  team: string;
  from: string;
  to: string;
  channel: string;
  text: string;
}
export interface MockSlack {
  fetch: typeof fetch;
  /** Given the authorize URL, the callback URL Slack would redirect to (code + state), or null if invalid. */
  authorize(url: string): string;
  sent: MockSlackMessage[];
  calls: { method: string; params: Record<string, string> }[];
}

export const MOCK_WORKSPACES: Record<string, { name: string; domain: string; users: string[] }> = {
  T0MOCKACME: { name: "Acme", domain: "acme", users: ["U0MOCKANDY", "U0MOCKBEA"] },
  T0MOCKOTHER: { name: "Other Co", domain: "otherco", users: ["U0MOCKCARL"] },
};

export function createMockSlack(opts: { clientId?: string; signInAs?: { team: string; user: string } } = {}): MockSlack {
  const codes = new Map<string, { challenge: string; team: string; user: string; redirect: string }>();
  const tokens = new Map<string, { team: string; user: string }>();
  const sent: MockSlackMessage[] = [];
  const calls: MockSlack["calls"] = [];
  let n = 0;
  const sha = async (v: string) => {
    const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.split("/").pop() || "";
    const headers = new Headers(init?.headers);
    // Real Slack rejects a preflighted request from the browser; insist on the simple form-encoded POST.
    if (init?.method !== "POST" || headers.get("content-type") !== "application/x-www-form-urlencoded" || headers.has("authorization")) return json({ ok: false, error: "mock_not_simple_request" });
    const params = Object.fromEntries((new URLSearchParams(String(init.body ?? "")) as unknown as { entries(): Iterable<[string, string]> }).entries()) as Record<string, string>;
    calls.push({ method, params });
    if (method === "oauth.v2.user.access") {
      const c = codes.get(params.code ?? "");
      if (!c) return json({ ok: false, error: "invalid_code" });
      if (opts.clientId && params.client_id !== opts.clientId) return json({ ok: false, error: "invalid_client_id" });
      if (params.redirect_uri !== c.redirect) return json({ ok: false, error: "bad_redirect_uri" });
      if ((await sha(params.code_verifier ?? "")) !== c.challenge) return json({ ok: false, error: "invalid_code_verifier" });
      if ("client_secret" in params) return json({ ok: false, error: "mock_unexpected_secret" });
      codes.delete(params.code!);
      const token = `xoxp-mock-${++n}`;
      tokens.set(token, { team: c.team, user: c.user });
      return json({ ok: true, access_token: token, token_type: "user", scope: "chat:write,im:write", authed_user: { id: c.user }, team: { id: c.team, name: MOCK_WORKSPACES[c.team]?.name } });
    }
    const who = tokens.get(params.token ?? "");
    if (!who) return json({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return json({ ok: true, team_id: who.team, user_id: who.user, team: MOCK_WORKSPACES[who.team]?.name, url: `https://${MOCK_WORKSPACES[who.team]?.domain}.slack.com/` });
    if (method === "conversations.open") {
      if (!MOCK_WORKSPACES[who.team]?.users.includes(params.users ?? "")) return json({ ok: false, error: "user_not_found" });
      return json({ ok: true, channel: { id: `D${who.user.slice(1)}${params.users}` } });
    }
    if (method === "chat.postMessage") {
      const to = (params.channel ?? "").slice(`D${who.user.slice(1)}`.length);
      sent.push({ team: who.team, from: who.user, to, channel: params.channel!, text: params.text ?? "" });
      return json({ ok: true, channel: params.channel, ts: `${Date.now() / 1000}` });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return {
    fetch: mockFetch,
    sent,
    calls,
    authorize(raw) {
      const u = new URL(raw);
      const redirect = u.searchParams.get("redirect_uri") || "";
      const back = new URL(redirect);
      back.searchParams.set("state", u.searchParams.get("state") || "");
      if (u.searchParams.get("code_challenge_method") !== "S256" || !u.searchParams.get("code_challenge") || u.searchParams.get("scope")) {
        back.searchParams.set("error", "invalid_request");
        return back.href;
      }
      const asked = u.searchParams.get("team");
      const as = opts.signInAs ?? (asked && MOCK_WORKSPACES[asked] ? { team: asked, user: MOCK_WORKSPACES[asked]!.users[0]! } : { team: "T0MOCKACME", user: "U0MOCKANDY" });
      const code = `mockcode-${++n}`;
      codes.set(code, { challenge: u.searchParams.get("code_challenge")!, team: as.team, user: as.user, redirect });
      back.searchParams.set("code", code);
      return back.href;
    },
  };
}
