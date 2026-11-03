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

test("Add to drive references Filecoin Drive pieces in the manifest and reads them back", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1&fcdrive=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("nav-loose").click();
  await expect(page.locator("[data-testid=loose-row][data-origin=drive]")).toHaveCount(3);
  await page.getByTestId("loose-adopt-all").click();
  await expect(page.getByTestId("dialog")).toContainText("Add 4 files to drive");
  await expect(page.getByTestId("dialog-note")).toContainText("gas ~0.01 FIL");
  await page.getByTestId("dialog-input").fill("/Filecoin Drive");
  if (process.env.SHOT_ADOPT) await page.screenshot({ path: process.env.SHOT_ADOPT });
  await page.getByTestId("adopt-confirm").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Added 4 files" })).toBeVisible();
  await expect(page.getByTestId("loose-summary").or(page.getByTestId("empty"))).toContainText("0 loose");
  await page.getByTestId("nav-drive").click();
  await page.getByTestId("entry").filter({ hasText: "Filecoin Drive" }).dblclick();
  await page.getByTestId("entry").filter({ hasText: "docs" }).dblclick();
  await page.getByTestId("entry").filter({ hasText: "reports" }).dblclick();
  const report = page.getByTestId("entry").filter({ hasText: "report.txt" });
  await expect(report.getByTestId("adopted-badge")).toContainText("plaintext");
  await report.dblclick();
  await expect(page.getByTestId("preview-text")).toContainText("Q3 numbers: 42");
});
