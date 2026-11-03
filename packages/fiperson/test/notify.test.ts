// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeIdentity } from "../src/view/index.js";
import { configureNotify, forgetSlackToken, handleSlackCallback, notify, slackConnections, slackTeams, SLACK_TOKENS_KEY } from "../src/notify/index.js";
import { createMockSlack } from "../src/notify/mock-slack.js";

const A = "0x" + "a".repeat(40);
const bea = normalizeIdentity(A, { displayName: "Bea", notify: { preferred: "slack", contacts: [{ channel: "slack", team: "T0MOCKACME", user: "U0MOCKBEA", domain: "acme" }] } });
const carl = normalizeIdentity(A, { displayName: "Carl", notify: { contacts: [{ channel: "slack", team: "T0MOCKOTHER", user: "U0MOCKCARL", domain: "otherco.slack.com" }] } });

/** Wire notify to the mock: the "popup" runs the callback page in-process (start → Slack authorize → callback). */
function setup(signInAs?: { team: string; user: string }, opts: { cancel?: boolean } = {}) {
  const slack = createMockSlack({ clientId: "123.456", signInAs });
  let popups = 0;
  configureNotify({
    slackClientId: "123.456",
    slackRedirectUri: "https://fifolders.test/slack/callback/",
    fetch: slack.fetch,
    open: (url) => {
      popups++;
      const win = { closed: false } as Window;
      void (async () => {
        let authorizeUrl = "";
        await handleSlackCallback(url, (u) => (authorizeUrl = u));
        const back = opts.cancel ? `https://fifolders.test/slack/callback/?error=access_denied&state=${new URL(authorizeUrl).searchParams.get("state")}` : slack.authorize(authorizeUrl);
        await handleSlackCallback(back);
        (win as { closed: boolean }).closed = true;
      })();
      return win;
    },
  });
  return { slack, popups: () => popups };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetSlackToken();
});

describe("schema notify", () => {
  it("keeps valid Slack contacts, drops junk, strips .slack.com", () => {
    expect(bea.notify).toEqual({ preferred: "slack", contacts: [{ channel: "slack", team: "T0MOCKACME", user: "U0MOCKBEA", domain: "acme" }] });
    expect(carl.notify?.contacts[0]?.domain).toBe("otherco");
    const junk = normalizeIdentity(A, { displayName: "X", notify: { contacts: [{ channel: "slack", team: "nope", user: "U1" } as never, { channel: "email" } as never] } });
    expect(junk.notify).toBeUndefined();
  });
});

describe("notify via mock Slack", () => {
  it("first send connects Slack with PKCE (no secret), then DMs as the user; second send reuses the token", async () => {
    const { slack, popups } = setup();
    const r = await notify({ displayName: "Bea", identity: bea }, "Take a look", "https://fifolders.test/fipen/#doc1");
    expect(r).toMatchObject({ ok: true, channel: "slack", team: "T0MOCKACME" });
    expect(slack.sent).toEqual([expect.objectContaining({ from: "U0MOCKANDY", to: "U0MOCKBEA", text: "Take a look\nhttps://fifolders.test/fipen/#doc1" })]);
    const ex = slack.calls.find((c) => c.method === "oauth.v2.user.access")!;
    expect(ex.params.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(ex.params).not.toHaveProperty("client_secret");
    expect(popups()).toBe(1);
    expect(slackTeams()).toEqual(["T0MOCKACME"]);
    expect(slackConnections()[0]).toMatchObject({ domain: "acme", encrypted: false }); // happy-dom has no IndexedDB
    await notify(bea, "again", "https://x/");
    expect(popups()).toBe(1);
    expect(slack.sent).toHaveLength(2);
  });

  it("recipient in another workspace: explains, copy-the-link fallback, nothing sent", async () => {
    const { slack } = setup({ team: "T0MOCKACME", user: "U0MOCKANDY" });
    const r = await notify({ displayName: "Carl", identity: carl }, "hi", "https://x/doc");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("other-workspace");
    expect(r.message).toContain("otherco.slack.com");
    expect(r.fallback).toBe("hi\nhttps://x/doc");
    expect(slack.sent).toHaveLength(0);
  });

  it("no contact / not configured / cancelled", async () => {
    setup(undefined, { cancel: true });
    expect(await notify({ displayName: "Zed" }, "m", "u")).toMatchObject({ ok: false, reason: "no-contact" });
    const r = await notify(bea, "m", "u");
    expect(r).toMatchObject({ ok: false, reason: "cancelled" });
    configureNotify({ slackClientId: "" });
    expect(await notify(bea, "m", "u")).toMatchObject({ ok: false, reason: "not-configured" });
  });

  it("expired token is dropped so the next Notify reconnects", async () => {
    const { slack } = setup();
    await notify(bea, "m", "u");
    const all = JSON.parse(localStorage.getItem(SLACK_TOKENS_KEY)!);
    all.T0MOCKACME.plain = "xoxp-revoked";
    localStorage.setItem(SLACK_TOKENS_KEY, JSON.stringify(all));
    expect(await notify(bea, "m", "u")).toMatchObject({ ok: false, reason: "error" });
    expect(slackTeams()).toEqual([]);
    expect(slack.sent).toHaveLength(1);
  });
});
