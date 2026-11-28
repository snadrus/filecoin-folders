import { expect, test } from "@playwright/test";
import { LIVE } from "./helpers";
import { hasWallet, installWallet } from "./wallet";

// No-spend live checks: every transaction is refused; edits stay staged locally.
test.skip(!LIVE || !hasWallet(), "live + test wallet");
test.describe.configure({ timeout: 300_000, retries: 0 });

test("R8b live, no spend: Manage versions opens with history; Delete → 'moved to trash · Undo'", async ({ page }) => {
  const w = await installWallet(page, { allowTx: () => false });
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  const row = page.getByTestId("entry").filter({ hasText: /^.*r8-\d+\.txt/ }).first();
  await expect(row).toBeVisible({ timeout: 120_000 });
  const name = (await row.getAttribute("aria-label"))!;
  await row.click({ button: "right" });
  await page.screenshot({ path: "/workspace/overnight-r8b-menu.png" });
  await page.getByRole("button", { name: "Manage versions" }).click();
  const vd = page.getByTestId("versions-dialog");
  await expect(vd.getByTestId("version-row").first()).toBeVisible({ timeout: 120_000 });
  console.log("versions:", (await vd.innerText()).replace(/\s+/g, " ").slice(0, 300));
  await page.screenshot({ path: "/workspace/overnight-r8b-versions.png" });
  await page.keyboard.press("Escape");
  await expect(vd).toHaveCount(0);
  await page.getByTestId("entry").filter({ hasText: name }).first().click();
  await page.keyboard.press("Delete");
  const toast = page.getByTestId("toast").filter({ hasText: "moved to trash" });
  await expect(toast).toContainText(`“${name}” moved to trash`);
  await page.screenshot({ path: "/workspace/overnight-r8b-trash-undo.png" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("entry").filter({ hasText: name })).toHaveCount(1);
  console.log("txs attempted:", w.calls.filter((c) => c.method === "eth_sendTransaction").map((c) => c.outcome.slice(0, 30)).join(", "));
});
