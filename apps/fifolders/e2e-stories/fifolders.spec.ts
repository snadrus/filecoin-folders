import { expect, test, type Page } from "@playwright/test";
import { LIVE } from "./helpers";

// FiFolders drive stories on the mock-chain build (no spend). `?onboard=1` drives the mock wallet flow.
test.skip(LIVE, "mock-chain build only; live wallet stories are in live-wallet.spec.ts");

const ready = "/?onboard=1&pay=ready&datasets=1";

async function connect(page: Page, query = ready) {
  await page.goto(query);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
}

test("S01 first visit: no cost pop-up until asked; costs open from the bottom-left with the exact text", async ({ page }) => {
  await connect(page);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("costs")).toHaveCount(0);
  const runway = page.getByTestId("storage-runway");
  const box = (await runway.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeLessThan(vp.width / 3);
  expect(box.y).toBeGreaterThan(vp.height / 2);
  await runway.click();
  const costs = page.getByTestId("costs");
  await expect(costs).toContainText("Per month:");
  await expect(costs.locator(".cost-list li")).toHaveText([
    "$2.50/TiB = a penny for 4 GB",
    "$0.12 per dataset ($0.50 at start)",
    "A penny per piece added",
  ]);
  await page.keyboard.press("Escape");
  await expect(costs).toHaveCount(0);
});

test("S02 light theme even when the OS prefers dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(Math.min(r, g, b)).toBeGreaterThan(200);
});

test("S04 drive is browsable read-only while setup transactions are pending; edits are staged", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&authdelay=1500");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:session:")) localStorage.removeItem(key);
  });
  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("setup-note")).toContainText("you can browse meanwhile");
  await page.getByTestId("nav-recent").click();
  await page.getByTestId("nav-drive").click();
  await page.getByTestId("file-input").setInputFiles({ name: "early.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(page.getByText("early.txt").first()).toBeVisible();
});

test("S05/S06 wallet requests are labeled with purpose+cost; 'Check your wallet' shows while waiting and clears", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&authdelay=2500");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:session:")) localStorage.removeItem(key);
  });
  await page.reload();
  await page.getByTestId("setup-open-wallet").click();
  const step = page.getByTestId("account-menu").getByTestId("authorize-session");
  await expect(step).toHaveText(/^Authorize session key — .+ \(.+\)$/);
  await step.click();
  // The mock wallet has no prompt UI; the labeled request shows in the Transaction log (activity lives there since #32).
  await page.keyboard.press("Escape");
  if (!(await page.getByTestId("txlog").count())) await page.getByTestId("txlog-toggle").click();
  await expect(page.getByTestId("activity")).toContainText(/Authorize session key — .+\(.+\)/);
  await expect(page.getByTestId("setup-note")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
});

test("S07 transaction log sidebar lists chain steps; activity rows auto-dismiss ~10s with a blue progress bar", async ({ page }) => {
  await connect(page);
  await page.getByTestId("txlog-toggle").click();
  await expect(page.getByTestId("txlog").getByTestId("chain-steps")).toBeVisible();
  await page.getByTestId("txlog-toggle").click();
  await expect(page.getByTestId("txlog")).toHaveCount(0);
  await page.getByTestId("file-input").setInputFiles({ name: "act.txt", mimeType: "text/plain", buffer: Buffer.from("activity") });
  await page.getByTestId("txlog-toggle").click(); // activity rows live in the Transaction log (#32)
  const done = page.getByTestId("activity-item").filter({ has: page.getByTestId("activity-progress") }).first();
  await expect(done).toBeVisible({ timeout: 30_000 });
  const color = await done.getByTestId("activity-progress").evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = color.match(/\d+/g)!.map(Number);
  expect(b).toBeGreaterThan(r);
  expect(b).toBeGreaterThan(g - 1);
  const t0 = Date.now();
  await expect(done).toHaveCount(0, { timeout: 14_000 });
  expect(Date.now() - t0).toBeGreaterThan(5_000);
});

test("S08 dataset selection persists across reload", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=3&drives=2");
  await page.getByTestId("account").click();
  const menu = page.getByTestId("dataset-menu");
  await menu.getByTestId("dataset-item").filter({ hasText: "#1" }).click();
  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("account").click();
  await expect(page.getByTestId("dataset-menu").locator("[aria-checked=true]")).toContainText("#1");
});

test("S09 loose pieces summary reconciles with the piece count", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
  await expect(page.getByTestId("entry").filter({ hasText: "a.txt" })).toBeVisible();
  await page.getByTestId("nav-loose").click();
  const summary = page.getByTestId("loose-summary");
  await page.waitForTimeout(3000);
  if (!(await summary.count())) {
    // Nothing loose: the summary is hidden and the list is empty.
    await expect(page.getByTestId("loose-row")).toHaveCount(0);
    return;
  }
  const m = (await summary.innerText()).match(/(\d+) pieces: (\d+) in folders, (\d+) manifests, (\d+) loose/);
  expect(m).not.toBeNull();
  const [total, inFolders, manifests, loose] = m!.slice(1).map(Number);
  expect(inFolders + manifests + loose).toBe(total);
  await expect(page.getByTestId("loose-row")).toHaveCount(loose);
});

test("S10 refresh restores the tree", async ({ page }) => {
  await connect(page);
  await page.getByTestId("new-button").click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByTestId("dialog-input").fill("Keep");
  await page.getByTestId("dialog-submit").click();
  await expect(page.getByTestId("entry").filter({ hasText: "Keep" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("entry").filter({ hasText: "Keep" })).toBeVisible({ timeout: 20_000 });
});

test("S11 old /felarumi/ and /felanumio/ links land in FiPen/FiGrid with query and hash", async ({ page }) => {
  await page.goto("/felarumi/?spa=%2Fd%2Fabc#secret");
  await expect(page).toHaveURL(/\/fipen\/\?spa=%2Fd%2Fabc#secret$/);
  await page.goto("/felanumio/?spa=%2Fs%2Fabc#k");
  await expect(page).toHaveURL(/\/figrid\/\?spa=%2Fs%2Fabc#k$/);
});

test("S19 a stale editor chunk after a deploy asks to reload", async ({ page }) => {
  // The tab predates a deploy: its lazy peer-transport chunk is gone from the server.
  await page.route(/\/fipen\/trystero-wire-[A-Z0-9]{8}\.js$/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/fipen/");
  await page.locator("#blank").click();
  await expect(page.locator("#p2p-wait")).toContainText("FiPen was updated. Reload the page to continue.", { timeout: 20_000 });
  await page.unrouteAll();
  await page.locator("#p2p-reload").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
});

test("S49 mobile: nav is a chip row, no horizontal overflow; Transaction log fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 391 && !e.closest(".places")).map((e) => `${e.tagName}.${e.className}<${e.parentElement?.className}|${e.textContent} ${Math.round(e.getBoundingClientRect().right)}`).slice(0, 6));
  expect(wide, wide.join(", ")).toEqual([]);
  await page.getByTestId("txlog-toggle").click();
  const box = (await page.getByTestId("txlog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("nav-fideploy")).toBeVisible();
  await expect(page.getByTestId("nav-ficlub")).toBeVisible();
});

test("S55 wallet & setup menu is filled while the session key is still being authorized after Connect", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1&authdelay=8000");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("account").click();
  const menu = page.getByTestId("account-menu");
  await expect(menu.getByTestId("payment-status")).toBeVisible({ timeout: 4_000 });
  await expect(menu.getByTestId("session-status")).toBeVisible();
});
