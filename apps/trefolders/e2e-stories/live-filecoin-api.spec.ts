import { expect, test, type Page } from "@playwright/test";
import { LIVE } from "./helpers";
import { hasWallet, installWallet } from "./wallet";

// Chain reads prefer api.filecoin.io (key-free, CORS *) and fall back to public RPC. No spend: every tx is refused.
test.skip(!LIVE || !hasWallet(), "live + test wallet");
test.describe.configure({ timeout: 300_000, retries: 0 });

function track(page: Page) {
  const api: string[] = [];
  page.on("response", (r) => {
    if (r.url().startsWith("https://api.filecoin.io/")) api.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return api;
}

async function openLoose(page: Page) {
  await installWallet(page, { allowTx: () => false });
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("nav-loose").click();
  await expect(page.getByTestId("loose-summary").or(page.getByTestId("loose-row").first())).toBeVisible({ timeout: 120_000 });
}

test("S60 live: piece list for the open folder set comes from api.filecoin.io, from the browser", async ({ page }) => {
  const api = track(page);
  await openLoose(page);
  console.log("api.filecoin.io:", [...new Set(api)].join(", "));
  expect(api.some((line) => /^200 \/calibration\/data-sets\/\d+\/pieces$/.test(line))).toBe(true);
});

test("S61 live: api.filecoin.io down → folders and pieces still load over public RPC", async ({ page }) => {
  await page.route("https://api.filecoin.io/**", (route) => route.fulfill({ status: 503, body: "down", headers: { "access-control-allow-origin": "*" } }));
  await openLoose(page);
  await expect(page.getByTestId("nav-drive")).toBeVisible();
});
