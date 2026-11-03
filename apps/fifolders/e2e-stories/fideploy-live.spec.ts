import { expect, test } from "@playwright/test";
import { formatEther } from "viem";
import { filBalance, hasWallet, installWallet } from "./wallet";

// S59: deploy a private FiClub instance on Calibration from the test wallet through /fideploy/ (one tx, minimal spend).
test.skip(!hasWallet() || !process.env.STORIES_SPEND, "needs the Calibration test wallet and STORIES_SPEND=1");
test.describe.configure({ timeout: 600_000 });

test("S59 FiDeploy live: private FiClub on Calibration, bytecode verified, JSON ready", async ({ page }) => {
  const before = await filBalance();
  const w = await installWallet(page, { allowTx: (tx) => !tx.to && !!tx.data }); // contract creation only
  await page.goto("/fideploy/");
  await page.getByTestId("fideploy-connect").click();
  await expect(page.getByTestId("fideploy-account")).toContainText("Filecoin Calibration");
  await expect(page.getByTestId("fideploy-row-FiClub")).toContainText("bytecode match", { timeout: 60_000 });
  await expect(page.getByTestId("fideploy-row-FiClub")).toContainText("est. ~", { timeout: 60_000 });
  await page.screenshot({ path: "/workspace/overnight-fideploy-live-before.png", fullPage: true });
  await page.getByTestId("fideploy-deploy-FiClub").click();
  await expect(page.getByTestId("wallet-prompt")).toContainText("Deploy FiClub");
  await expect(page.getByTestId("fideploy-records")).toContainText("✓ bytecode verified", { timeout: 540_000 });
  const json = JSON.parse(await page.getByTestId("fideploy-json").innerText());
  console.log("S59 deployed", json.deployments.at(-1).address, json.deployments.at(-1).txHash);
  await page.screenshot({ path: "/workspace/overnight-fideploy-live-after.png", fullPage: true });
  expect(w.calls.filter((c) => c.method === "eth_sendTransaction").length).toBe(1);
  console.log("S59 spent FIL", formatEther(before - (await filBalance())));
});
