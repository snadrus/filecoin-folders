import { expect, test } from "@playwright/test";

test("first visit signs in once when payment and a dataset already exist", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await expect(page.getByTestId("costs")).toBeVisible();
  await page.getByTestId("costs-continue").click();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");

  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("0");
});

test("missing payment and dataset take one fix and no extra signature to create", async ({ page }) => {
  await page.goto("/?onboard=1");
  await page.getByTestId("costs-continue").click();
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

test("an expired session key renews with one signature and retries the upload", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("costs-continue").click();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith("fifolders:session:"));
    if (!key) throw new Error("missing session");
    const session = JSON.parse(localStorage.getItem(key) ?? "{}") as { sessionAddress: string; expiry: string };
    session.expiry = "1";
    localStorage.setItem(key, JSON.stringify(session));
    const book = JSON.parse(localStorage.getItem("fifolders:mock-registry") || "{}") as Record<string, string>;
    book[`0x70997970c51812dc3a010c7d01b50e0d17dc79c8:${session.sessionAddress.toLowerCase()}`] = "1";
    localStorage.setItem("fifolders:mock-registry", JSON.stringify(book));
  });
  await page.getByTestId("file-input").setInputFiles({
    name: "renew.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("renew me"),
  });
  const banner = page.getByTestId("session-renew");
  await expect(banner).toContainText("Session expired — Renew (1 signature)");
  await expect(page.getByText("does not have the required permissions")).toHaveCount(0);
  await page.getByTestId("session-renew-button").click();
  await expect(page.getByTestId("entry").filter({ hasText: "renew.txt" })).toBeVisible();
  await expect(page.getByTestId("session-renew")).toHaveCount(0);
  await expect(page.getByTestId("wallet-signatures")).toHaveText("2");
});

test("an expired session key stays on the connect screen", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("costs-continue").click();
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
  await page.getByTestId("costs-continue").click();
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
});
