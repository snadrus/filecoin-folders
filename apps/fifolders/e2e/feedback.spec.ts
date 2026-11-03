import { expect, test } from "@playwright/test";

test("costs open from the storage view, the new button is prominent, and a document opens beside the drive", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("chain-steps")).toHaveCount(0);
  await page.getByTestId("txlog-toggle").click();
  await expect(page.getByTestId("txlog").getByTestId("chain-steps")).toContainText("Authorized");
  await page.getByTestId("txlog-toggle").click();
  await expect(page.locator("[data-testid=account] .fiperson-avatar")).toBeVisible();
  await expect(page.getByTestId("costs")).toHaveCount(0);
  await page.getByTestId("storage-runway").click();
  await expect(page.getByTestId("costs")).toContainText("$2.50/TiB = a penny for 4 GB");
  await expect(page.getByText("FiPen documents and FiGrid spreadsheets are included")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("costs")).toHaveCount(0);
  await page.getByTestId("storage-runway").click();
  await page.getByTestId("costs-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("costs")).toHaveCount(0);
  await page.getByTestId("storage-runway").click();
  await page.getByTestId("costs-close").click();
  await expect(page.getByTestId("costs")).toHaveCount(0);

  const box = await page.getByTestId("new-button").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);

  await page.getByTestId("account").click();
  await expect(page.getByTestId("chain-mainnet")).toBeVisible();
  await expect(page.getByTestId("advanced-editors")).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("account-menu")).toHaveCount(0);

  await page.getByTestId("new-button").click();
  const popupPromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "FiPen document" }).click();
  await expect(page.getByTestId("dialog-input")).toHaveCount(0);
  const popup = await popupPromise;
  expect(popup.url()).toContain("fipen");
  expect(popup.url()).toContain("fifolders=1");
  expect(new URL(popup.url()).searchParams.get("path")).toBe("/FiPen/Untitled document.fipen");
  await expect(page.getByTestId("entry").filter({ hasText: "Untitled document.fipen" })).toContainText("Save pending");
  await expect(page.getByTestId("nav-drive")).toBeVisible();
});

test("a folder is still open after refresh", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-button").click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByTestId("dialog-input").fill("Docs");
  await page.getByTestId("dialog-submit").click();
  await page.getByTestId("entry").filter({ hasText: "Docs" }).dblclick();
  await expect(page.getByTestId("breadcrumb").filter({ hasText: "Docs" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("breadcrumb").filter({ hasText: "Docs" })).toBeVisible();
});
