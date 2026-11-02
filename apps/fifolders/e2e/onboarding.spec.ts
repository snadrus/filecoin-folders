import { expect, test } from "@playwright/test";

test("first visit signs in once when payment and a dataset already exist", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");

  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("0");
});

test("missing payment and dataset take one fix and no extra signature to create", async ({ page }) => {
  await page.goto("/?onboard=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("setup")).toBeVisible();
  await expect(page.getByTestId("session-status")).toContainText("Session key ready");
  await expect(page.getByTestId("balances")).toContainText("FIL");
  await expect(page.getByTestId("balances")).toContainText("USDFC");
  await expect(page.getByTestId("wallet-signatures")).toContainText("Wallet signatures 1");

  await page.getByTestId("fix-payments").click();
  await expect(page.getByTestId("wallet-signatures")).toContainText("Wallet signatures 3");
  await page.getByTestId("create-dataset").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("3");

  await page.getByTestId("account").click();
  await expect(page.getByTestId("dataset-select")).toBeVisible();
  await expect(page.getByTestId("session-refresh")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("0");
});

test("an expired session key stays on the connect screen", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.evaluate(() => {
    const raw = localStorage.getItem("fifolders:session:314159:0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    if (!raw) throw new Error("missing session");
    const session = JSON.parse(raw) as { expiry: string; sessionAddress: string };
    session.expiry = "1";
    localStorage.setItem("fifolders:session:314159:0x70997970c51812dc3a010c7d01b50e0d17dc79c8", JSON.stringify(session));
    localStorage.setItem("fifolders:mock-registry", JSON.stringify({}));
  });
  await page.reload();
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
});
