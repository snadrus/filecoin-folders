import { expect, test } from "@playwright/test";
import { formatEther } from "viem";
import { filBalance, hasWallet, installWallet } from "./wallet";

// S59: deploy a private TreClub instance on Calibration from the test wallet through /tredeploy/ (one tx, minimal spend).
test.skip(!hasWallet() || !process.env.STORIES_SPEND, "needs the Calibration test wallet and STORIES_SPEND=1");
test.describe.configure({ timeout: 600_000 });

test("S59 TreDeploy live: private TreClub on Calibration, bytecode verified, JSON ready", async ({ page }) => {
  const before = await filBalance();
  const w = await installWallet(page, { allowTx: (tx) => !tx.to && !!tx.data }); // contract creation only
  await page.goto("/tredeploy/");
  await page.getByTestId("tredeploy-connect").click();
  await expect(page.getByTestId("tredeploy-account")).toContainText("Filecoin Calibration");
  await expect(page.getByTestId("tredeploy-row-TreClub")).toContainText("bytecode match", { timeout: 60_000 });
  await expect(page.getByTestId("tredeploy-row-TreClub")).toContainText("est. ~", { timeout: 60_000 });
  await page.screenshot({ path: "/workspace/overnight-tredeploy-live-before.png", fullPage: true });
  await page.getByTestId("tredeploy-deploy-TreClub").click();
  await expect(page.getByTestId("wallet-prompt")).toContainText("Deploy TreClub");
  await expect(page.getByTestId("tredeploy-records")).toContainText("✓ bytecode verified", { timeout: 540_000 });
  const json = JSON.parse(await page.getByTestId("tredeploy-json").innerText());
  console.log("S59 deployed", json.deployments.at(-1).address, json.deployments.at(-1).txHash);
  await page.screenshot({ path: "/workspace/overnight-tredeploy-live-after.png", fullPage: true });
  expect(w.calls.filter((c) => c.method === "eth_sendTransaction").length).toBe(1);
  console.log("S59 spent FIL", formatEther(before - (await filBalance())));
});
