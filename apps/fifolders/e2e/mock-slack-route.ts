/** Route slack.com to fiperson's mock Slack (no real Slack traffic). Returns the mock so tests can read sent DMs. */
import type { BrowserContext } from "@playwright/test";
import { createMockSlack, type MockSlack } from "fiperson/notify/mock";

export const MOCK_CLIENT_ID = "1111.2222";

export async function routeMockSlack(context: BrowserContext, opts: Parameters<typeof createMockSlack>[0] = {}): Promise<MockSlack> {
  const slack = createMockSlack({ clientId: MOCK_CLIENT_ID, ...opts });
  await context.addInitScript((id) => localStorage.setItem("fiperson:slack-client-id", id), MOCK_CLIENT_ID);
  await context.route("https://slack.com/**", async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes("/oauth/v2_user/authorize")) return route.fulfill({ status: 302, headers: { location: slack.authorize(url) } });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" } });
    const res = await slack.fetch(url, { method: req.method(), headers: { "content-type": req.headers()["content-type"] ?? "" }, body: req.postData() ?? "" });
    return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  return slack;
}
