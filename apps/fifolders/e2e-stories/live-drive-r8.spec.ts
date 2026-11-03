import { expect, test, type Page } from "@playwright/test";
import { LIVE } from "./helpers";
import { CHAIN_ID, filBalance, hasWallet, installWallet } from "./wallet";
import { formatEther } from "viem";

// Live click-through of S65/S66/S68/S69 with the Calibration test wallet.
// COST: each fresh browser profile funds a new session key with 0.05 tFIL, plus gas. Run rarely.
test.skip(!LIVE || !hasWallet() || !process.env.STORIES_SPEND, "live + test wallet + STORIES_SPEND=1");
test.describe.configure({ timeout: 900_000 });

const settle = async (page: Page) => {
  await expect(page.getByTestId("activity-indicator")).toHaveCount(0, { timeout: 420_000 });
};

test("R8 live: same-name upload, Manage versions, trash Undo, Uploads collapse", async ({ page }) => {
  const fil0 = await filBalance();
  const w = await installWallet(page, { allowTx: () => w.chainId === CHAIN_ID });
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("nav-drive").click();
  const t0 = Date.now();
  await expect(page.getByText("Finishing wallet setup")).toHaveCount(0, { timeout: 420_000 });
  console.log(`setup finished after ${Math.round((Date.now() - t0) / 1000)}s`);
  const t = Date.now();
  const name = `r8-${t}.txt`;
  const row = () => page.getByTestId("entry").filter({ hasText: name });
  const input = page.getByTestId("file-input");
  const log = (s: string) => console.log(new Date().toTimeString().slice(0, 8), s);

  // S66: two files → collapses to "2 uploads complete"
  await input.setInputFiles([
    { name, mimeType: "text/plain", buffer: Buffer.from("first draft") },
    { name: `r8-${t}-b.txt`, mimeType: "text/plain", buffer: Buffer.from("b") },
  ]);

  for (let i = 0; i < 24 && !(await row().count()); i++) {
    await page.waitForTimeout(10_000);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    console.log(`${i * 10}s`, w.calls.map((c) => `${c.method}:${c.outcome.slice(0, 20)}`).slice(-4).join(","), "|", body.match(/(Finishing[^.]*|Saving|Check your wallet[^.]*|toast[^.]*|Waiting[^.]*)/g)?.slice(0, 4).join(" / "));
    if (i === 3) await page.screenshot({ path: "/workspace/overnight-r8-waiting.png" });
  }
  await expect(row()).toHaveCount(1, { timeout: 1_000 });
  await expect(page.getByTestId("upload-title")).toContainText("uploads complete", { timeout: 420_000 });
  await expect(page.getByTestId("upload-panel")).toHaveAttribute("data-collapsed", "true");
  await page.screenshot({ path: "/workspace/overnight-r8-uploads-collapsed.png" });
  await page.getByTestId("toggle-uploads").click();
  await expect(page.getByTestId("upload-panel").locator(".upload-row").filter({ hasText: name })).toHaveCount(1);
  await page.screenshot({ path: "/workspace/overnight-r8-uploads-expanded.png" });
  log("S66 ok: " + (await page.getByTestId("upload-title").innerText()));
  await settle(page);

  // S68: same name → dialog → Replace
  await input.setInputFiles([{ name, mimeType: "text/plain", buffer: Buffer.from("second draft!") }]);
  const dialog = page.getByTestId("upload-conflict");
  await expect(dialog).toContainText(`“${name}” already exists`);
  await page.screenshot({ path: "/workspace/overnight-r8-conflict.png" });
  await page.getByTestId("upload-conflict-ok").click();
  await expect(row()).toHaveCount(1);
  await expect(row().first()).toContainText("13 B", { timeout: 420_000 });
  log("S68 replace ok");
  await settle(page);
  // Keep both → "(1)"
  await input.setInputFiles([{ name, mimeType: "text/plain", buffer: Buffer.from("v3") }]);
  await dialog.getByLabel("Keep all items").check();
  await page.getByTestId("upload-conflict-ok").click();
  await expect(page.getByTestId("entry").filter({ hasText: `r8-${t} (1).txt` })).toHaveCount(1, { timeout: 420_000 });
  log("S68 keep-both ok");
  await settle(page);

  // S69: Manage versions → 2+ rows, Restore older
  await row().first().click({ button: "right" });
  await page.getByRole("button", { name: "Manage versions" }).click();
  const vd = page.getByTestId("versions-dialog");
  await expect(vd.getByTestId("version-row").nth(1)).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: "/workspace/overnight-r8-versions.png" });
  log("S69 rows: " + (await vd.getByTestId("version-row").count()));
  await vd.getByTestId("version-row").nth(1).getByRole("button", { name: "Restore" }).click();
  await expect(vd).toHaveCount(0);
  await expect(row().first()).toContainText("11 B", { timeout: 420_000 });
  log("S69 restore ok");
  await settle(page);

  // S65: Delete → toast Undo
  await page.getByTestId("entry").filter({ hasText: `r8-${t}-b.txt` }).first().click();
  await page.keyboard.press("Delete");
  const toast = page.getByTestId("toast").filter({ hasText: "moved to trash" });
  await expect(toast).toContainText(`“r8-${t}-b.txt” moved to trash`);
  await page.screenshot({ path: "/workspace/overnight-r8-trash-undo.png" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("entry").filter({ hasText: `r8-${t}-b.txt` })).toHaveCount(1);
  log("S65 ok");
  await settle(page);
  await expect(page.getByTestId("setup-error")).toHaveCount(0);
  const fil1 = await filBalance();
  console.log(`R8 spend: ${formatEther(fil0 - fil1)} tFIL; txs ${w.calls.filter((c) => c.outcome.startsWith("tx ")).length}; sigs ${w.calls.filter((c) => /signTypedData|personal_sign/.test(c.method)).length}`);
});
