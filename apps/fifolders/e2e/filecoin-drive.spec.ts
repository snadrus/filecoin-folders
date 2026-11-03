import { expect, test } from "@playwright/test";

test("Filecoin Drive pieces show in Loose pieces with folders, IPFS roots, and directory contents", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1&fcdrive=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("account").click();
  await expect(page.getByTestId("dataset-filecoin-drive")).toContainText("Filecoin Drive");
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-loose").click();
  const rows = page.locator("[data-testid=loose-row][data-origin=drive]");
  await expect(rows).toHaveCount(3);
  await expect(page.locator("[data-testid=loose-folder][data-folder='docs/reports']")).toContainText("report.txt");
  await expect(page.getByTestId("loose-summary")).toContainText("3 from Filecoin Drive");
  const site = rows.filter({ hasText: "site" });
  await site.getByTestId("loose-expand").click();
  await expect(page.getByTestId("unixfs-entry")).toHaveCount(3);
  await expect(page.getByTestId("unixfs-entry").filter({ hasText: "main.css" })).toBeVisible();
  const download = page.waitForEvent("download");
  await rows.filter({ hasText: "hello.txt" }).getByTestId("loose-download").click();
  expect((await download).suggestedFilename()).toBe("hello.txt");
  await expect(rows.first().getByTestId("loose-gateway")).toHaveAttribute("href", /dweb\.link\/ipfs\//);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
});
