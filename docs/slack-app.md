# Slack notifications (FiPerson `notify`)

`fiperson/notify` sends a Slack DM **as the sender** when they approve "Notify <name>?" after an @-mention in FiPen.
Everything runs in the browser: there is no server and no client secret.

## Flow

1. The recipient publishes a contact in their identity (`/identity/` → Notifications): Slack workspace ID (`T…`),
   member ID (`U…`), optional workspace subdomain. "Connect Slack to fill these" reads them via `auth.test`.
   Stored in the public profile piece as `notify: { preferred: "slack", contacts: [{ channel, team, user, domain? }] }`.
   `channel` keys the list so email etc. can be added later.
2. The sender clicks Notify. If this browser has no token for the recipient's workspace, `notify()` opens a popup
   (synchronously inside the click, so it is not blocked) at `/slack/callback/?start=1&team=T…`. That page makes a
   random `code_verifier` (kept in the popup's sessionStorage), sends the S256 `code_challenge` to
   `https://slack.com/oauth/v2_user/authorize` with `user_scope=chat:write,im:write` and `team=` preselected.
3. Slack redirects back to `/slack/callback/?code&state`; the page checks `state` and exchanges the code at
   `oauth.v2.user.access` with `client_id`, `code`, `code_verifier`, `redirect_uri` (no secret), calls `auth.test`
   for the canonical team/user IDs and domain, stores the token, signals the opener (BroadcastChannel + storage event) and closes.
4. `conversations.open(users=U…)` → DM channel, then `chat.postMessage(channel, text = message + "\n" + url)`.

**Scopes.** `chat:write` posts the message. `im:write` is for `conversations.open`, the documented way for a user token
to get the DM channel ID with a member; posting to a bare user ID with a user token is not a documented contract.

**Token storage.** One user token per workspace in `localStorage["fiperson:slack-tokens:v1"]`, AES-GCM encrypted with a
non-extractable key kept in IndexedDB (`fiperson`/`keys`). That stops casual disclosure (copying storage, backups) but
not script running on this origin. Without IndexedDB it falls back to plaintext and reports `encrypted: false`.
`invalid_auth`/`token_revoked`/`token_expired` drop the token; the next Notify reconnects.

**CORS (verified 2026-11-02).** `slack.com/api/*` returns `Access-Control-Allow-Origin: *`, and its preflight allows only
Slack's own headers (not `Authorization`). So every call is a form-encoded POST with `token` in the body: a CORS
simple request, no preflight.

**Another workspace.** A user token can only DM people in its own workspace. If the recipient's `team` differs from
the one the sender connected (or Slack answers `user_not_found`/`channel_not_found`), `notify()` returns
`reason: "other-workspace"` with an explanation naming both workspaces and `fallback` text (message + link) that FiPen
offers to copy. The sender can press Notify again and pick the right workspace (the popup preselects it).

## Register the app (Andy, one time, ~3 minutes)

1. Open https://api.slack.com/apps → **Create New App** → **From a manifest**.
2. Pick the workspace to own the app (any of yours; others can still connect, see step 6) → **Next**.
3. Choose **YAML**, paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) → **Next** → **Create**.
4. **Basic Information** → App Credentials → copy the **Client ID** (e.g. `1234567890.1234567890`). Ignore the Client Secret; it is never used.
5. **OAuth & Permissions**: check that the Redirect URLs list `https://fifolders.scionbase.ai/slack/callback/` and that
   **PKCE** shows enabled (the manifest sets `pkce_enabled: true`; turning it on is one-way).
6. To let people outside the owner workspace connect: **Manage Distribution** → tick the checklist (no hard-coded
   secrets: true) → **Activate Public Distribution**. (Not needed if only the owner workspace will use it.)
7. Put the Client ID in `packages/fiperson/src/notify/config.ts` (`SLACK_CLIENT_ID = "…"`) and merge; Pages redeploys.
   Until then the Notify sidebar says Slack is not set up and offers Copy link.

## Tests

`fiperson/notify/mock` (`createMockSlack`) implements authorize, `oauth.v2.user.access` (verifies the S256 challenge,
rejects a client secret or a preflighted request), `auth.test`, `conversations.open`, `chat.postMessage`. Unit tests use
it as `fetch`; Playwright routes `https://slack.com/**` to it (`apps/fifolders/e2e/mock-slack-route.ts`). No real Slack traffic.
