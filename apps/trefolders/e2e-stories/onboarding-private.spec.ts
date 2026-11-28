import { expect, test } from "@playwright/test";
import { LIVE } from "./helpers";

// First-run onboarding on the mock-chain build: the default dataset is private; a no-PRF passkey falls back to public.
test.skip(LIVE, "mock build only");

async function connectFresh(page: import("@playwright/test").Page, query: string) {
  await page.goto(`/?onboard=1&${query}`);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("setup").or(page.getByTestId("nav-drive"))).toBeVisible({ timeout: 20_000 });
}

test("S80 first-run onboarding creates a private dataset by default; Public is still choosable", async ({ page }) => {
  await connectFresh(page, "pay=ready");
  await expect(page.getByTestId("visibility-private")).toBeChecked();
  await expect(page.getByTestId("visibility-public")).not.toBeChecked();
  await page.getByTestId("create-dataset").click();
  await expect(page.getByTestId("nav-drive")).toBeAttached({ timeout: 20_000 });
  await page.getByTestId("account").click();
  await expect(page.getByTestId("current-visibility")).toContainText("Private");
  // Public is still offered for a later dataset.
  await expect(page.getByTestId("visibility-public")).toBeVisible();
  await expect(page.getByTestId("visibility-private")).toBeChecked();
});

test("S81 a passkey without PRF falls back to a public dataset with a notice and Connect full wallet", async ({ page }) => {
  await connectFresh(page, "pay=ready&noprf=1");
  await page.getByTestId("create-dataset").click();
  await expect(page.getByTestId("private-fallback-notice")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("private-fallback-notice")).toContainText(/public/i);
  await expect(page.getByTestId("connect-full-wallet")).toBeVisible();
  await page.getByTestId("account").click();
  await expect(page.getByTestId("current-visibility")).toContainText(/Public/i);
  await page.getByTestId("connect-full-wallet").click();
  await expect(page.getByTestId("connect")).toBeVisible();
  await expect(page.getByTestId("advanced")).toHaveAttribute("open", "");
  await expect(page.getByTestId("connect-wallet")).toHaveText("Connect full wallet");
});
