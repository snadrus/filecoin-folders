/**
 * Site config for notifications. SLACK_CLIENT_ID is the public client ID of the "FiFolders" Slack app
 * (docs/slack-app.md). It is not a secret: the app is a PKCE public client with no client secret.
 * Empty = Slack not registered yet; notify() then returns a copy-the-link fallback.
 */
export const SLACK_CLIENT_ID = "";

export interface NotifyConfig {
  slackClientId: string;
  /** Must be listed in the Slack app's redirect URLs. Default: `<origin>/slack/callback/`. */
  slackRedirectUri: string;
  slackAuthorize: string;
  slackApi: string;
  fetch: typeof fetch;
  open: (url: string, name: string, features: string) => Window | null;
}

let overrides: Partial<NotifyConfig> = {};

/** Override config (tests, other hosts). `globalThis.FIPERSON_NOTIFY` is read too, so a page can set it before loading. */
export function configureNotify(next: Partial<NotifyConfig>): void {
  overrides = { ...overrides, ...next };
}

export function notifyConfig(): NotifyConfig {
  const g = (globalThis as { FIPERSON_NOTIFY?: Partial<NotifyConfig> }).FIPERSON_NOTIFY ?? {};
  let stored = "";
  try {
    // Dev/test only: lets a mock-Slack e2e set a client ID without a rebuild.
    stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem("fiperson:slack-client-id") ?? "";
  } catch {
    /* ignore */
  }
  const origin = (globalThis as { location?: Location }).location?.origin ?? "https://fifolders.scionbase.ai";
  return {
    slackClientId: overrides.slackClientId ?? g.slackClientId ?? (stored || SLACK_CLIENT_ID),
    slackRedirectUri: overrides.slackRedirectUri ?? g.slackRedirectUri ?? `${origin}/slack/callback/`,
    slackAuthorize: overrides.slackAuthorize ?? g.slackAuthorize ?? "https://slack.com/oauth/v2_user/authorize",
    slackApi: overrides.slackApi ?? g.slackApi ?? "https://slack.com/api",
    fetch: overrides.fetch ?? g.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    open: overrides.open ?? g.open ?? ((u, n, f) => window.open(u, n, f)),
  };
}
