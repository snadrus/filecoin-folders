import { expect, test } from "@playwright/test";

test("auto-picks the latest dataset, toasts, and switches from the sidebar menu", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=3&drives=2");
  await page.getByTestId("connect-wallet").click();
  const toast = page.getByTestId("toast").filter({ hasText: "Using your latest dataset (#2)" });
  await expect(toast).toBeVisible();
  await toast.getByTestId("toast-action").click();
  const menu = page.getByTestId("dataset-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("dataset-item")).toHaveCount(3);
  await expect(menu.locator("[aria-checked=true]")).toContainText("#2");
  await expect(menu.getByTestId("dataset-latest")).toHaveCount(1);
  await expect(menu.getByTestId("dataset-item").first()).toHaveAttribute("data-drive", "1");
  await expect(menu.getByTestId("dataset-drive")).toHaveCount(1);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await menu.getByTestId("dataset-item").filter({ hasText: "#1" }).click();
  await expect(page.getByTestId("dataset-switcher")).toContainText("#1");
  expect(await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith("fifolders:dataset:"))?.[1])).toBe("1");
  await expect(page.getByTestId("browser")).toBeVisible();
});
