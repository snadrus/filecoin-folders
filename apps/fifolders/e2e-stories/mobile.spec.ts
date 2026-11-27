import { expect, test } from "@playwright/test";
import { LIVE, url } from "./helpers";

// Phone layouts for the editors (mobile pass round 2). Mock build only: no wallet, no spend.
test.skip(LIVE, "mock build only");
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("M01 FiPen phone: one toolbar row, menus open as bottom sheets, toolbar sits above the keyboard while typing", async ({ page }) => {
  await page.goto(url("fipen/"));
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
  const bar = (await page.locator("#toolbar").boundingBox())!;
  expect(bar.height).toBeLessThan(60); // was 4 wrapped rows
  await page.locator('.menu-btn[data-menu="file"]').tap();
  const pop = page.locator('[data-pop="file"]');
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  await page.locator(".menu-scrim").tap({ position: { x: 20, y: 120 } });
  await expect(pop).toBeHidden();
  const c = (await page.locator("#pages canvas").first().boundingBox())!;
  await page.touchscreen.tap(c.x + 60, c.y + 60);
  await page.keyboard.type("hi");
  // Android-style keyboard: the layout viewport shrinks at the same width.
  await page.setViewportSize({ width: 390, height: 524 });
  await expect(page.locator("body")).toHaveClass(/phone-editing/);
  const low = (await page.locator("#toolbar").boundingBox())!;
  expect(Math.round(low.y + low.height)).toBeGreaterThan(510);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).not.toHaveClass(/phone-editing/);
});

test("M02 FiGrid phone: tap selects without the keyboard, tap again edits, comments open from the toolbar", async ({ page }) => {
  await page.goto(url("figrid/"));
  await page.locator("#blank").click();
  const grid = page.locator("#grid");
  await expect(grid).toBeVisible();
  const g = (await grid.boundingBox())!;
  await page.touchscreen.tap(g.x + 150, g.y + 60);
  await expect(page.locator("#namebox")).not.toHaveText("A1");
  await expect(page.locator("#formula")).not.toBeFocused();
  await page.touchscreen.tap(g.x + 150, g.y + 60);
  await expect(page.locator("#formula")).toBeFocused();
  await page.keyboard.type("42");
  await page.keyboard.press("Enter");
  await expect(page.locator("#side")).toBeHidden();
  await page.locator("#side-toggle").tap();
  await expect(page.locator("#side")).toBeVisible();
  await page.locator("#side-close").tap();
  await expect(page.locator("#side")).toBeHidden();
});

test("M03 drive phone: Details is a full-screen sheet, Rename sits above the keyboard, the wallet menu is a bottom sheet", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeAttached();
  await page.getByTestId("file-input").setInputFiles({ name: "m3.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  const more = page.getByTestId("entry").filter({ hasText: "m3.txt" }).getByTestId("row-more");
  await more.tap();
  await page.getByTestId("context-menu").getByRole("button", { name: "Details", exact: true }).tap();
  const details = page.getByTestId("details");
  await expect(details).toBeVisible();
  await page.evaluate(() => Promise.all((document.querySelector("[data-testid=details]")?.getAnimations() ?? []).map((a) => a.finished.catch(() => undefined))));
  expect(await details.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await details.getByRole("button", { name: "Close details" }).tap();
  await more.tap();
  await page.getByTestId("context-menu").getByRole("button", { name: "Rename", exact: true }).tap();
  const form = (await page.getByTestId("dialog").locator("form").boundingBox())!;
  expect(form.y + form.height).toBeLessThan(844 / 2); // the keyboard takes the lower half
  await page.keyboard.press("Escape");
  await page.getByTestId("account").tap();
  const menu = page.getByTestId("account-menu");
  await page.evaluate(() => Promise.all((document.querySelector("[data-testid=account-menu]")?.getAnimations() ?? []).map((a) => a.finished.catch(() => undefined))));
  const m = (await menu.boundingBox())!;
  expect(m.x).toBe(0);
  expect(Math.round(m.y + m.height)).toBe(844);
  await page.getByTestId("sheet-scrim").tap({ position: { x: 20, y: 20 } });
  await expect(menu).toHaveCount(0);
});
