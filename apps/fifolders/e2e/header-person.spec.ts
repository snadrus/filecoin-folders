import { expect, test, type Locator } from "@playwright/test";

/** Pixel art must sit centered in its round frame: compare the SVG box with the frame box. */
async function expectCentered(frame: Locator): Promise<void> {
  const outer = (await frame.boundingBox())!;
  const inner = (await frame.locator("svg").boundingBox())!;
  expect(Math.abs(inner.x + inner.width / 2 - (outer.x + outer.width / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(inner.y + inner.height / 2 - (outer.y + outer.height / 2))).toBeLessThanOrEqual(0.5);
  expect(inner.width).toBeGreaterThanOrEqual(outer.width - 1);
}

test("header shows the FiPerson name + pixel avatar, wallet address as secondary text", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  const label = page.getByTestId("account-label");
  await expect(label).toHaveText(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  await expect(page.getByTestId("account-address")).toHaveText(/^0x[0-9a-fA-F]{4}…/);
  const frame = page.locator("[data-testid=account] .fiperson-avatar[data-kind=pixel]");
  await expect(frame).toBeVisible();
  await expectCentered(frame);
  // Same person as the account menu.
  const name = await label.textContent();
  await page.getByTestId("account").click();
  await expect(page.getByTestId("identity-summary").getByTestId("identity-name")).toHaveText(name!);
  await page.getByTestId("account").click();
  await page.locator("header.topbar").screenshot({ path: test.info().outputPath("header.png") });
});
