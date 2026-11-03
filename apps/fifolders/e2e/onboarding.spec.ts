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
  await expect(page.getByTestId("fix-payments")).toBeVisible();
  await expect(page.getByTestId("balances")).toContainText("FIL");
  await expect(page.getByTestId("balances")).toContainText("USDFC");
  await expect(page.getByTestId("wallet-signatures")).toContainText("Wallet signatures 0");

  await page.getByTestId("fix-payments").click();
  await expect(page.getByTestId("wallet-signatures")).toContainText("Wallet signatures 3");
  await expect(page.getByTestId("session-status")).toContainText("Session key ready");
  await page.getByTestId("create-dataset").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("3");

  await page.getByTestId("account").click();
  await expect(page.getByTestId("account-menu").getByTestId("dataset-menu")).toBeVisible();
  await expect(page.getByTestId("account-menu").getByTestId("wallet-setup")).toBeVisible();
  await expect(page.getByTestId("session-refresh")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("wallet-signatures")).toHaveText("0");
});

test("an expired session key renews with one signature and retries the upload", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
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
  await expect(banner).toContainText("Reconnect wallet session");
  await expect(page.getByTestId("txlog-spinner")).toBeVisible();
  await expect(page.locator(".setup-backdrop")).toHaveCount(0);
  if (process.env.SHOT_TXLOG) await page.screenshot({ path: process.env.SHOT_TXLOG });
  await expect(page.getByText("does not have the required permissions")).toHaveCount(0);
  await page.getByTestId("session-renew-button").click();
  await expect(page.getByTestId("entry").filter({ hasText: "renew.txt" })).toBeVisible();
  await expect(page.getByTestId("session-renew")).toHaveCount(0);
  await expect(page.getByTestId("wallet-signatures")).toHaveText("2");
});

test("an expired session key stays on the connect screen when no public read is available", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1&peek=0");
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

test("refresh with corrupt cached state still renders the app (bug 5)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?onboard=1");
  await page.evaluate(() => {
    localStorage.setItem("fifolders:ops", "{not json");
    localStorage.setItem("fifolders:mock-datasets", "{bad");
    localStorage.setItem("fifolders:fel-alias", "[1,2");
    localStorage.setItem("fifolders:piece-catalog", "nope");
  });
  await page.reload();
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(background).toBe("rgb(255, 255, 255)");
  expect(errors).toEqual([]);
});

test("the public drive renders read-only before the session key is authorized", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1&authdelay=1500");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("setup-note")).toHaveCount(0, { timeout: 10_000 });
  // Expire the session key, then reload: the drive must show before any signature.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:session:")) localStorage.removeItem(key);
  });
  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("setup-note")).toContainText("Finishing wallet setup… you can browse meanwhile");
  await expect(page.getByTestId("wallet-signatures")).toHaveText("0");
  await expect(page.getByTestId("setup-step")).toHaveCount(0);
  await page.getByTestId("setup-open-wallet").click();
  const step = page.getByTestId("account-menu").getByTestId("authorize-session");
  await expect(step).toHaveText("Authorize session key — lets FiFolders save for 7 days without asking each time (~0.05 FIL)");

  // An edit while read-only is staged, not lost.
  await page.getByTestId("file-input").setInputFiles({ name: "early.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(page.getByText("early.txt").first()).toBeVisible();

  await step.click();
  if (!(await page.getByTestId("txlog").isVisible())) await page.getByTestId("txlog-toggle").click();
  await expect(page.getByTestId("activity")).toContainText("Authorize this browser to save");
  await expect(page.getByTestId("activity")).not.toContainText("Send transaction");
  await expect(page.getByTestId("setup-note")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
  await expect(page.getByText("early.txt").first()).toBeVisible();
});
