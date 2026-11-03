import { expect, test } from "@playwright/test";
import { routeMockSlack } from "./mock-slack-route";

const ME = "0x2222222222222222222222222222222222222222";
const BEA = "0x3333333333333333333333333333333333333333";
const CARL = "0x4444444444444444444444444444444444444444";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ me, bea, carl }) => {
    const w = window as unknown as Record<string, unknown>;
    w.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return w.__connected ? [me] : [];
        if (method === "eth_requestAccounts") return ((w.__connected = true), [me]);
        if (method === "eth_signTypedData_v4") return "0x" + "11".repeat(65);
        if (method === "eth_sendTransaction") return "0x" + "22".repeat(32);
        return null;
      },
    };
    if (!localStorage.getItem("ficlub:mock:v1"))
      localStorage.setItem("ficlub:mock:v1", JSON.stringify({ clubs: [
        { id: "1", name: "Filecoin Builders", creator: bea, nonce: "0", members: [me, bea, carl], admins: [bea] },
        { id: "2", name: "Docs Crew", creator: me, nonce: "0", members: [me, bea], admins: [me] },
        { id: "3", name: "Not mine", creator: carl, nonce: "0", members: [carl], admins: [carl] },
      ] }));
  }, { me: ME, bea: BEA, carl: CARL });
});

test("identity: connect Slack (mock, PKCE popup) fills the contact, save, Find all my Clubs, view a person", async ({ page, context }) => {
  const slack = await routeMockSlack(context);
  await page.goto("/identity/");
  await page.getByTestId("identity-connect").click();
  await expect(page.getByTestId("identity-notify")).toBeVisible();
  const popupP = page.waitForEvent("popup");
  await page.getByTestId("identity-slack-fill").click();
  const popup = await popupP;
  await popup.waitForEvent("close", { timeout: 15_000 }).catch(() => {});
  await expect(page.getByTestId("identity-slack-team")).toHaveValue("T0MOCKACME");
  await expect(page.getByTestId("identity-slack-user")).toHaveValue("U0MOCKANDY");
  await expect(page.getByTestId("identity-slack-domain")).toHaveValue("acme");
  const ex = slack.calls.find((c) => c.method === "oauth.v2.user.access")!;
  expect(ex.params.code_verifier.length).toBeGreaterThanOrEqual(43);
  expect(ex.params.client_secret).toBeUndefined();
  const stored = await page.evaluate(() => localStorage.getItem("fiperson:slack-tokens:v1") || "");
  expect(stored).not.toContain("xoxp-"); // encrypted at rest
  await page.getByTestId("identity-name").fill("");
  await page.getByTestId("identity-name").pressSequentially("Andy Jackson", { delay: 40 });
  await page.getByTestId("identity-save").click();
  await expect(page.getByTestId("identity-saved")).toBeVisible();
  const saved = await page.evaluate((a) => JSON.parse(localStorage.getItem("fil-identity:v1:" + a) || "null"), ME);
  expect(saved.identity.notify.contacts[0]).toMatchObject({ channel: "slack", team: "T0MOCKACME", user: "U0MOCKANDY", domain: "acme" });
  await page.screenshot({ path: "/workspace/mention-identity-notify.png", fullPage: true });

  await page.getByTestId("identity-find-clubs").click();
  await expect(page.getByTestId("identity-clubs-list")).toContainText("Filecoin Builders");
  await expect(page.getByTestId("identity-clubs-list")).toContainText("Docs Crew");
  await expect(page.getByTestId("identity-clubs-list")).not.toContainText("Not mine");
  await expect(page.getByTestId("identity-coworkers")).toContainText("2 club-mates");
  await page.locator("#clubs").screenshot({ path: "/workspace/mention-identity-clubs.png" });
  const cache = await page.evaluate((a) => JSON.parse(localStorage.getItem("fiperson:clubs:v1:" + a) || "null"), ME);
  expect(cache.coworkers).toEqual([BEA, CARL]);

  await page.goto(`/person/?id=${ME}`);
  await expect(page.getByTestId("person-name")).toHaveText("Andy Jackson");
  await expect(page.getByTestId("person-contact")).toContainText("acme.slack.com");
  await page.goto(`/person/?id=${BEA}`);
  await expect(page.getByTestId("person-clubs")).toContainText("Filecoin Builders · Docs Crew");
  await page.screenshot({ path: "/workspace/mention-person-page.png" });
});
