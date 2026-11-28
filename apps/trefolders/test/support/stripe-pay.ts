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
export async function payOnPage(page: import("@playwright/test").Page, opts: { email?: string; screenshot?: string; onSubmit?: () => void } = {}): Promise<void> {
  if (!/^https:\/\/checkout\.stripe\.com\/.*cs_test_/.test(page.url())) throw new Error(`not a test-mode Stripe Checkout page: ${page.url()}`);
  try {
    // Checkout renders its form inside the Payment Element iframe.
    // 429 / "Something went wrong" on first load is common; reload a few times.
    let frame: import("@playwright/test").Frame | undefined;
    const broken = async () => /something went wrong/i.test(await page.locator("body").innerText().catch(() => ""));
    for (let attempt = 0; !frame && attempt < 4; attempt += 1) {
      for (let i = 0; !frame && i < 40; i += 1) {
        if (await broken()) break;
        for (const candidate of page.frames()) if ((await candidate.locator("#linkAuthentication-emailInput").count().catch(() => 0)) > 0) frame = candidate;
        if (!frame) await page.waitForTimeout(500);
      }
      if (frame) break;
      if (attempt < 3) {
        await page.waitForTimeout(8_000 + attempt * 8_000);
        await page.reload({ waitUntil: "domcontentloaded" });
      }
    }
    if (!frame) throw new Error("Stripe Payment Element did not load");
    await frame.locator("#linkAuthentication-emailInput").fill(opts.email ?? "trefolders-e2e@example.com");
    if (!(await frame.locator("#payment-numberInput").isVisible().catch(() => false))) await frame.getByText("Card", { exact: true }).first().click();
    await frame.locator("#payment-numberInput").fill("4242424242424242");
    await frame.locator("#payment-expiryInput").fill("12 / 34");
    await frame.locator("#payment-cvcInput").fill("123");
    if (await frame.locator("#payment-nameInput").isVisible().catch(() => false)) await frame.locator("#payment-nameInput").fill("TreFolders E2E");
    if (await frame.locator("#payment-countryInput").isVisible().catch(() => false)) await frame.locator("#payment-countryInput").selectOption("US");
    if (await frame.locator("#payment-postalCodeInput").isVisible().catch(() => false)) await frame.locator("#payment-postalCodeInput").fill("60601");
    // Link opt-in ("Save my information") surfaces a phone field that blocks Pay
    // when the number is empty/incomplete. Uncheck it on the payment frame and
    // the page, immediately before submit — Stripe can re-check after field fill.
    const uncheckLinkOptIn = async () => {
      const roots = [frame, page] as const;
      for (const root of roots) {
        const box = root.locator("#payment-linkOptInInput, input[name=\"enableStripePass\"], input[name=\"linkOptIn\"]").first();
        if (await box.count().catch(() => 0)) {
          if (await box.isChecked().catch(() => false)) await box.setChecked(false, { force: true }).catch(() => undefined);
        }
        const label = root.getByText("Save my information for faster checkout");
        if ((await label.count().catch(() => 0)) && (await box.isChecked().catch(() => false))) {
          await label.first().click({ force: true }).catch(() => undefined);
        }
      }
    };
    await uncheckLinkOptIn();
    // Paid once Stripe navigates to the success URL; the target need not be reachable (e.g. localhost).
    const left = () => !page.url().startsWith("https://checkout.stripe.com/");
    const phoneError = async () => {
      const t = (await frame.locator("body").innerText().catch(() => "")) + (await page.locator("body").innerText().catch(() => ""));
      return /phone number is incomplete/i.test(t);
    };
    const redirected = page
      .waitForURL((next) => !next.href.startsWith("https://checkout.stripe.com/"), { timeout: 150_000, waitUntil: "commit" })
      .then(() => true, () => left());
    await page.waitForTimeout(1_500); // let Elements finish validating the filled fields
    await uncheckLinkOptIn();
    if (await phoneError()) await uncheckLinkOptIn();
    opts.onSubmit?.();
    await frame.getByTestId("payment-form-submit-button").click();
    for (let i = 0; i < 3 && !left(); i += 1) {
      const done = await Promise.race([redirected, page.waitForTimeout(8_000).then(() => false)]);
      if (done || left()) break;
      await uncheckLinkOptIn();
      await frame.getByTestId("payment-form-submit-button").click({ timeout: 5_000 }).catch(() => undefined); // retry a stalled submit
    }
    if (!(await redirected) && !left()) throw new Error("Stripe Checkout did not redirect after submit");
  } catch (error) {
    if (opts.screenshot) await page.screenshot({ path: opts.screenshot, fullPage: true }).catch(() => undefined);
    throw error;
  }
}
