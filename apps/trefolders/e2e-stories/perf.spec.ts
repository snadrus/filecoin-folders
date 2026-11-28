import { expect, test, type Page } from "@playwright/test";

async function connect(page: Page) {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
}

test("P1 250 files: upload, list renders, select-all, sort, search, scroll stay responsive", async ({ page }) => {
  test.setTimeout(240_000);
  await connect(page);
  const files = Array.from({ length: Number(process.env.N || 250) }, (_, i) => ({ name: `f${String(i).padStart(3, "0")}.txt`, mimeType: "text/plain", buffer: Buffer.from(`file ${i}`) }));
  let t = Date.now();
  await page.getByTestId("file-input").setInputFiles(files);
  await expect(page.getByTestId("entry")).toHaveCount(Number(process.env.N || 250), { timeout: 120_000 });
  console.log("P1 upload+list ms", Date.now() - t);
  await expect(page.getByTestId("activity-indicator")).toHaveCount(0, { timeout: 120_000 });
  console.log("P1 settled ms", Date.now() - t);
  const time = async (label: string, fn: () => Promise<void>) => { const s = Date.now(); await fn(); const ms = Date.now() - s; console.log("P1", label, "ms", ms); return ms; };
  await time("click", async () => { await page.getByTestId("entry").first().click(); await expect(page.getByTestId("entry").first()).toHaveAttribute("data-selected", "true"); });
  await time("click 2", async () => { await page.getByTestId("entry").nth(5).click(); await expect(page.getByTestId("entry").nth(5)).toHaveAttribute("data-selected", "true"); });
  await time("ctrl+a", async () => { await page.keyboard.press("Control+a"); await expect(page.locator("[data-testid=entry][data-selected=true]")).toHaveCount(250); });
  await time("sort size", async () => { await page.getByTestId("sort-select").selectOption("size"); await page.waitForTimeout(50); });
  await time("search", async () => { await page.getByRole("searchbox").fill("f12"); await expect(page.getByTestId("entry")).toHaveCount(10, { timeout: 10_000 }); });
  await page.getByRole("searchbox").fill("");
  await time("scroll end", async () => { await page.getByTestId("entry").last().scrollIntoViewIfNeeded(); });
  const arrows = await time("arrow x20", async () => { await page.getByTestId("entry").first().click(); for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown"); });
  expect(arrows).toBeLessThan(2_500);
  const per = await page.evaluate(() => { const el = document.activeElement as HTMLElement; const t = performance.now(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); return performance.now() - t; });
  console.log("P1 one ArrowDown in-page ms", Math.round(per));
  // Regression: ↑/↓ used to re-render all rows (~130ms of script per key at 250 files).
  expect(per).toBeLessThan(30);
  const renders = await page.evaluate(() => { let n = 0; const o = new MutationObserver((m) => { n += m.length; }); o.observe(document.body, { childList: true, subtree: true }); (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); return new Promise((r) => setTimeout(() => { o.disconnect(); r(n); }, 500)); });
  console.log("P1 mutations per ArrowDown", renders);
  const longTask = await page.evaluate(async () => { const s = performance.now(); await new Promise((r) => requestAnimationFrame(() => r(null))); return performance.now() - s; });
  console.log("P1 frame ms", Math.round(longTask), "DOM nodes", await page.evaluate(() => document.getElementsByTagName("*").length));
  await page.screenshot({ path: "/workspace/overnight-perf-250.png" });
});
