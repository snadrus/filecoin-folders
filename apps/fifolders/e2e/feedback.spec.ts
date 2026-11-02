import { expect, test } from "@playwright/test";

test("costs come first, the new button is prominent, and a document opens beside the drive", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await expect(page.getByTestId("costs")).toBeVisible();
  await expect(page.getByText("Felarumi documents and Felanumio spreadsheets are included")).toBeVisible();
  await page.getByTestId("cost-gb").fill("4");
  await expect(page.getByTestId("cost-estimate")).toContainText("per month");
  await expect(page.getByTestId("cost-deposit")).toContainText("Connect a wallet");
  await page.getByTestId("costs-continue").click();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("chain-steps")).toContainText("Authorized");
  await expect(page.getByTestId("account-identicon")).toBeVisible();

  const box = await page.getByTestId("new-button").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);

  await page.getByTestId("account").click();
  await expect(page.getByTestId("chain-mainnet")).toBeVisible();
  await expect(page.getByTestId("advanced-editors")).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("account-menu")).toHaveCount(0);

  await page.getByTestId("new-button").click();
  const popupPromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "Felarumi document" }).click();
  await page.getByTestId("dialog-input").fill("Letter");
  await page.getByTestId("dialog-submit").click();
  const popup = await popupPromise;
  expect(popup.url()).toContain("felarumi");
  expect(popup.url()).toContain("fifolders=1");
  expect(decodeURIComponent(popup.url())).toContain("/Felarumi/Letter.felarumi");
  await expect(page.getByTestId("entry").filter({ hasText: "Letter.felarumi" })).toContainText("Save pending");
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
