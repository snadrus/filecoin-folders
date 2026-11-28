import { expect, test } from "@playwright/test";
import { formatEther } from "viem";
import { LIVE } from "./helpers";
import { CHAIN_ID, filBalance, hasWallet, installWallet } from "./wallet";

// Private (read=restricted) dataset on Calibration: open, upload, share by fragment link, open the link as a guest.
// Uses an existing private dataset of the test wallet (PRIVATE_DATASET), so no dataset is created here.
const DATASET = process.env.PRIVATE_DATASET || "";
test.skip(!LIVE || !hasWallet() || !DATASET || !process.env.STORIES_SPEND, "live + test wallet + PRIVATE_DATASET + STORIES_SPEND=1");
test.describe.configure({ timeout: 900_000, retries: 0 });

test("P1 private dataset: badge, upload, fragment share link opens for a guest", async ({ page, browser }) => {
  const fil0 = await filBalance();
  const w = await installWallet(page, { allowTx: () => w.chainId === CHAIN_ID });
  await page.addInitScript(([id, addr]) => localStorage.setItem(`fifolders:dataset:314159:${addr.toLowerCase()}`, id), [DATASET, w.address] as const);
  page.on("console", (m) => {
    if (/Failed to load resource/.test(m.text())) return;
    if (m.type() === "error" || m.type() === "warning" || /private|TreFolders|TreFolders/i.test(m.text())) console.log(`[page ${m.type()}]`, m.text().slice(0, 400));
  });
  page.on("response", (r) => {
    if (r.status() >= 400) console.log("[http]", r.status(), r.request().method(), r.url().slice(0, 160));
  });
  page.on("requestfailed", (r) => console.log("[failed]", r.failure()?.errorText, r.method(), r.url().slice(0, 160)));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 400)));
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("account").click({ timeout: 90_000 });
  const menu = page.getByTestId("account-menu");
  await expect(menu.getByTestId("session-status")).toBeVisible({ timeout: 90_000 });
  const auth = menu.getByTestId("authorize-session");
  if (await auth.count()) {
    await auth.click();
    await expect(page.getByTestId("account-menu").getByTestId("session-status").or(page.getByTestId("session-status")).first()).toContainText("until", { timeout: 300_000 });
  }
  if (!(await page.getByTestId("account-menu").isVisible())) await page.getByTestId("account").click();
  const item = page.getByTestId("dataset-item").filter({ hasText: `#${DATASET}` });
  await expect(item.getByTestId("dataset-visibility")).toHaveAttribute("data-visibility", "private", { timeout: 60_000 });
  await expect(page.getByTestId("current-visibility")).toContainText("Private");
  await page.screenshot({ path: "/workspace/private-p1-account-badge.png" });
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-drive").click();
  const name = `private-${Date.now()}.txt`;
  const body = `only people with the link can read this ${name}\n`;
  await page.getByTestId("file-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
  const row = page.getByTestId("upload-panel").locator(".upload-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 60_000 });
  const status = async () => ((await row.count()) ? await row.getAttribute("data-status", { timeout: 5_000 }).catch(() => "gone") : "gone");
  for (let i = 0; i < 40 && (await status()) === "uploading"; i++) {
    await page.waitForTimeout(15_000);
    if (i === 2) await page.screenshot({ path: "/workspace/private-p1-uploading.png" });
  }
  console.log("upload row:", await status());
  expect(await status()).not.toBe("uploading");
  await expect(page.getByTestId("activity-indicator")).toHaveCount(0, { timeout: 600_000 });
  await page.screenshot({ path: "/workspace/private-p1-uploaded.png" });
  const entry = page.getByTestId("entry").filter({ hasText: name }).first();
  await entry.click({ button: "right" });
  await page.getByRole("button", { name: /Details/ }).first().click();
  const link = page.getByTestId("share-link");
  await expect(link).toBeVisible({ timeout: 120_000 });
  const href = (await link.getAttribute("href"))!;
  console.log("share link:", href.replace(/(k|d|fk)=[^&]+/g, "$1=…"));
  expect(href).toContain("/share/#");
  expect(new URL(href).search).toBe("");
  expect(href).toContain("v=pf1");
  await page.screenshot({ path: "/workspace/private-p1-details.png" });

  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(href);
  await expect(g.getByTestId("share-preview")).toHaveText(body.trim(), { timeout: 120_000 });
  await expect(g.getByTestId("share-download")).toBeVisible();
  await g.screenshot({ path: "/workspace/private-p1-guest.png" });
  // The piece itself is not public.
  const piece = new URLSearchParams(new URL(href).hash.slice(1)).get("piece")!;
  const s = new URLSearchParams(new URL(href).hash.slice(1)).get("s")!.split(",")[0];
  const anon = await g.request.get(`${s}/piece/${piece}`);
  console.log("anonymous /piece/:", anon.status());
  expect(anon.status()).not.toBe(200);
  await guest.close();
  const fil1 = await filBalance();
  console.log(`P1 spend: ${formatEther(fil0 - fil1)} tFIL; txs: ${w.calls.filter((c) => c.outcome.startsWith("tx ")).length}; signatures: ${w.calls.filter((c) => c.method.startsWith("eth_signTypedData_v4")).map((c) => c.method.split(":")[1]).join(",")}`);
});
