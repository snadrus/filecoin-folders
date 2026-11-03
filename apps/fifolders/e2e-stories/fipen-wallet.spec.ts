import { expect, test } from "@playwright/test";
import { formatEther } from "viem";
import { LIVE, newDoc, focusDoc, text } from "./helpers";
import { CHAIN_ID, filBalance, hasWallet, installWallet } from "./wallet";

// Standalone FiPen with a wallet on Calibration. Spends test FIL/USDFC (Andy approved); opt-in with STORIES_SPEND=1.
test.skip(!LIVE || !hasWallet() || !process.env.STORIES_SPEND, "live + Calibration wallet + STORIES_SPEND=1");
test.describe.configure({ timeout: 600_000 });

const txs = (w: { calls: { outcome: string }[] }) => w.calls.filter((c) => c.outcome.startsWith("tx ")).map((c) => c.outcome.slice(3));

test("S47 standalone FiPen: Save to Filecoin with a wallet (Calibration)", async ({ page }) => {
  const fil0 = await filBalance();
  const w = await installWallet(page, { allowTx: () => w.chainId === CHAIN_ID });
  await newDoc(page);
  await expect(page.locator("#status")).toHaveText("New, unsaved");
  await page.keyboard.type("S47 standalone save");
  await expect(page.locator("#status")).toHaveText("Unsaved changes");
  await page.keyboard.press("Control+s");
  const dialog = page.locator("#p2p-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="p2p-net"][value="calibration"]').check();
  await dialog.locator("#p2p-wallet").click();
  await expect(dialog.locator("#p2p-status")).toContainText(/baga|bafk/, { timeout: 480_000 });
  console.log("S47 status:", await dialog.locator("#p2p-status").innerText());
  await expect(page.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 30_000 });
  console.log(`S47 spend: ${formatEther(fil0 - (await filBalance()))} tFIL gas; txs: ${txs(w).join(", ") || "none"}; typed-data sigs: ${w.calls.filter((c) => c.method === "eth_signTypedData_v4").length}`);
});

test("S46 FiPen Insert → Signature: reject keeps editing, approve inserts a signature and locks", async ({ page }) => {
  const fil0 = await filBalance();
  const w = await installWallet(page, { allowTx: () => w.chainId === CHAIN_ID });
  await page.addInitScript(() => sessionStorage.setItem("felarumi-filecoin-net", "calibration"));
  await newDoc(page);
  await page.keyboard.type("Agreement S46.");
  w.modes.eth_signTypedData_v4 = { kind: "reject" };
  await page.locator("#signature").click();
  await page.locator("#sig-name").fill("Test Signer");
  await page.locator("#sig-sign").click();
  await expect(page.locator("#sig-sign")).toBeEnabled({ timeout: 480_000 });
  await expect.poll(() => w.calls.filter((c) => c.method === "eth_signTypedData_v4").length, { timeout: 10_000 }).toBe(1);
  await page.keyboard.press("Escape");
  await focusDoc(page);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" More.");
  await expect.poll(() => text(page)).toContain("More.");
  w.modes.eth_signTypedData_v4 = { kind: "approve" };
  await page.locator("#signature").click();
  await page.locator("#sig-name").fill("Test Signer");
  await page.locator("#sig-sign").click();
  await expect(page.locator("#sig-form")).toHaveCount(0, { timeout: 480_000 });
  const sigs = await page.evaluate(() => (window as any).__editor?.signatures?.() ?? null);
  console.log("S46 signatures:", JSON.stringify(sigs)?.slice(0, 300));
  const before = await text(page);
  await focusDoc(page);
  await page.keyboard.type("tamper");
  await expect.poll(() => text(page)).not.toContain("tamper");
  expect((await text(page)).length).toBeGreaterThanOrEqual(before.length);
  console.log(`S46 spend: ${formatEther(fil0 - (await filBalance()))} tFIL gas; txs: ${txs(w).join(", ") || "none"}`);
});
