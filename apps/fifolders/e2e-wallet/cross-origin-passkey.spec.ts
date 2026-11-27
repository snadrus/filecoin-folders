import { test, expect, type CDPSession, type Page, type Frame } from "@playwright/test";

const WALLET = "http://localhost:4177";
const DAPP = "http://localhost:4178";

async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

test.describe("empirical WebAuthn in a cross-origin iframe (Chromium)", () => {
  test("create and get succeed with the allow attribute, and fail without it", async ({ page }) => {
    await addVirtualAuthenticator(page);
    await page.goto(`${DAPP}/e2e-wallet/empirical-parent.html?inner=${encodeURIComponent(`${WALLET}/e2e-wallet/empirical-inner.html`)}`);

    const allowed = page.frameLocator("[data-testid=iframe-allow]");
    const blocked = page.frameLocator("[data-testid=iframe-no-allow]");
    await expect(allowed.getByTestId("inner-create")).toBeVisible();
    await expect(blocked.getByTestId("inner-create")).toBeVisible();

    await allowed.getByTestId("inner-create").click();
    await expect(allowed.getByTestId("inner-out")).toContainText(/"op":\s*"create"/);
    await allowed.getByTestId("inner-get").click();
    await expect(allowed.getByTestId("inner-out")).toContainText(/"op":\s*"get"/);

    await blocked.getByTestId("inner-create").click();
    await expect(blocked.getByTestId("inner-out")).toContainText(/ERROR/);
    const blockedCreate = await blocked.getByTestId("inner-out").innerText();
    expect(blockedCreate).toMatch(/NotAllowedError|not allowed|publickey-credentials-create|Permissions Policy|feature is not enabled/i);

    await blocked.getByTestId("inner-get").click();
    await expect(blocked.getByTestId("inner-out")).toContainText(/ERROR/);
    const blockedGet = await blocked.getByTestId("inner-out").innerText();
    expect(blockedGet).toMatch(/NotAllowedError|not allowed|publickey-credentials-get|Permissions Policy|feature is not enabled/i);
  });
});

test.describe("limited-wallet connector", () => {
  test("iframe create and discover, with confirmation of the dApp origin", async ({ page }) => {
    await addVirtualAuthenticator(page);
    const walletUrl = `${WALLET}/wallet/`;
    await page.goto(`${DAPP}/e2e-wallet/dapp.html?wallet=${encodeURIComponent(walletUrl)}`);

    await page.getByTestId("dapp-create").click();
    const wallet = page.frameLocator("[data-testid=limited-wallet-iframe]");
    await expect(wallet.getByTestId("wallet-confirm")).toBeVisible();
    await expect(wallet.getByTestId("wallet-origin")).toHaveText(DAPP);
    await wallet.getByTestId("wallet-continue").click();
    await expect(page.getByTestId("dapp-out")).toContainText(/"credentialId"/);

    await page.getByTestId("dapp-discover").click();
    await expect(wallet.getByTestId("wallet-confirm")).toBeVisible();
    await expect(wallet.getByTestId("wallet-origin")).toHaveText(DAPP);
    await wallet.getByTestId("wallet-continue").click();
    await expect(page.getByTestId("dapp-out")).toContainText(/"credentialId"/);
  });

  test("popup fallback can create a passkey when preferPopup is set", async ({ page, context }) => {
    await addVirtualAuthenticator(page);
    const walletUrl = `${WALLET}/wallet/`;
    await page.goto(`${DAPP}/e2e-wallet/dapp.html?popup=1&wallet=${encodeURIComponent(walletUrl)}`);

    const popupPromise = context.waitForEvent("page");
    await page.getByTestId("dapp-create").click();
    const popup = await popupPromise;
    await addVirtualAuthenticator(popup);
    await expect(popup.getByTestId("wallet-confirm")).toBeVisible();
    await expect(popup.getByTestId("wallet-origin")).toHaveText(DAPP);
    await popup.getByTestId("wallet-continue").click();
    await expect(page.getByTestId("dapp-out")).toContainText(/"credentialId"/);
  });
});
