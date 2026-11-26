// Pay a Stripe Checkout page in test mode with the 4242 test card (headless Chromium). Test mode only.
import { chromium } from "@playwright/test";

export async function payTestCheckout(url: string, opts: { email?: string; screenshot?: string } = {}): Promise<void> {
  if (!/^https:\/\/checkout\.stripe\.com\/.*cs_test_/.test(url)) throw new Error(`not a test-mode Stripe Checkout URL: ${url}`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await payOnPage(page, opts);
  } finally {
    await browser.close();
  }
}

/** Pay the test-mode Checkout already open in `page` and wait for Stripe's redirect to the success URL. */
export async function payOnPage(page: import("@playwright/test").Page, opts: { email?: string; screenshot?: string } = {}): Promise<void> {
  if (!/^https:\/\/checkout\.stripe\.com\/.*cs_test_/.test(page.url())) throw new Error(`not a test-mode Stripe Checkout page: ${page.url()}`);
  try {
    // Checkout renders its form inside the Payment Element iframe.
    let frame: import("@playwright/test").Frame | undefined;
    for (let i = 0; !frame && i < 90; i += 1) {
      for (const candidate of page.frames()) if ((await candidate.locator("#linkAuthentication-emailInput").count().catch(() => 0)) > 0) frame = candidate;
      if (!frame) await page.waitForTimeout(500);
    }
    if (!frame) throw new Error("Stripe Payment Element did not load");
    await frame.locator("#linkAuthentication-emailInput").fill(opts.email ?? "fifolders-e2e@example.com");
    if (!(await frame.locator("#payment-numberInput").isVisible().catch(() => false))) await frame.getByText("Card", { exact: true }).first().click();
    await frame.locator("#payment-numberInput").fill("4242424242424242");
    await frame.locator("#payment-expiryInput").fill("12 / 34");
    await frame.locator("#payment-cvcInput").fill("123");
    if (await frame.locator("#payment-nameInput").isVisible().catch(() => false)) await frame.locator("#payment-nameInput").fill("FiFolders E2E");
    if (await frame.locator("#payment-countryInput").isVisible().catch(() => false)) await frame.locator("#payment-countryInput").selectOption("US");
    if (await frame.locator("#payment-postalCodeInput").isVisible().catch(() => false)) await frame.locator("#payment-postalCodeInput").fill("60601");
    const optIn = frame.locator("#payment-linkOptInInput");
    if ((await optIn.count()) && (await optIn.isChecked().catch(() => false))) await optIn.uncheck({ force: true }).catch(() => undefined);
    // Paid once Stripe navigates to the success URL; the target need not be reachable (e.g. localhost).
    const left = () => !page.url().startsWith("https://checkout.stripe.com/");
    const redirected = page
      .waitForURL((next) => !next.href.startsWith("https://checkout.stripe.com/"), { timeout: 150_000, waitUntil: "commit" })
      .then(() => true, () => left());
    await page.waitForTimeout(1_500); // let Elements finish validating the filled fields
    await frame.getByTestId("payment-form-submit-button").click();
    for (let i = 0; i < 3 && !left(); i += 1) {
      const done = await Promise.race([redirected, page.waitForTimeout(25_000).then(() => false)]);
      if (done || left()) break;
      await frame.getByTestId("payment-form-submit-button").click({ timeout: 5_000 }).catch(() => undefined); // retry a stalled submit
    }
    if (!(await redirected) && !left()) throw new Error("Stripe Checkout did not redirect after submit");
  } catch (error) {
    if (opts.screenshot) await page.screenshot({ path: opts.screenshot, fullPage: true }).catch(() => undefined);
    throw error;
  }
}
