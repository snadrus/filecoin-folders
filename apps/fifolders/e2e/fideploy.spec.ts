import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const art = JSON.parse(readFileSync(new URL("../src/fideploy/artifacts.json", import.meta.url), "utf8"));
const ME = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const NEW = "0x00000000000000000000000000000000000c1ab0";

/** Fake Calibration wallet: v2 already deployed (bytecode match), FiClub absent; a deploy mints NEW with FiClub's runtime code. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ me, v2code, clubCode, fresh }) => {
      const w = window as unknown as Record<string, unknown>;
      const code: Record<string, string> = { "0x9c06335d7de588caa104ee4fc3bb7cd8aba62443": v2code, "0x518411c2062e119aaf7a8b12a2edf9a939347655": "0x6001" };
      w.__sent = [] as unknown[];
      w.ethereum = {
        on() {},
        request: async ({ method, params }: { method: string; params?: any[] }) => {
          if (method === "eth_chainId") return "0x4cb2f";
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
          if (method === "eth_getCode") return code[String(params![0]).toLowerCase()] ?? "0x";
          if (method === "eth_gasPrice") return "0x5f5e100";
          if (method === "eth_estimateGas") return "0x3b9aca0";
          if (method === "eth_blockNumber") return "0x10";
          if (method === "eth_sendTransaction") {
            (w.__sent as unknown[]).push(params![0]);
            await new Promise((r) => setTimeout(r, 400));
            code[fresh] = clubCode;
            return "0x" + "ab".repeat(32);
          }
          if (method === "eth_getTransactionReceipt")
            return { transactionHash: "0x" + "ab".repeat(32), blockHash: "0x" + "cd".repeat(32), blockNumber: "0x10", contractAddress: fresh, status: "0x1", logs: [], gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", from: me, to: null, transactionIndex: "0x0", type: "0x2", logsBloom: "0x" + "00".repeat(256) };
          if (method === "eth_getTransactionByHash") return null;
          return null;
        },
      };
    },
    { me: ME, v2code: art.FolderRegistryV2.deployedBytecode, clubCode: art.FiClub.deployedBytecode, fresh: NEW },
  );
});

test("S57 FiDeploy: status by bytecode, labeled deploy prompt, verify, deployments JSON", async ({ page }) => {
  await page.goto("/fideploy/");
  await expect(page.getByTestId("fideploy-faucet")).toBeVisible();
  await page.getByTestId("fideploy-connect").click();
  await expect(page.getByTestId("fideploy-account")).toContainText("Filecoin Calibration");
  await expect(page.getByTestId("fideploy-row-FolderRegistryV2")).toContainText("bytecode match");
  await expect(page.getByTestId("fideploy-row-FiClub")).toContainText("not deployed");
  await expect(page.getByTestId("fideploy-row-FiClub")).toContainText("est. ~0.0063 FIL");
  await page.getByTestId("fideploy-deploy-FiClub").click();
  await expect(page.getByTestId("wallet-prompt")).toContainText("Deploy FiClub");
  await expect(page.getByTestId("fideploy-records")).toContainText("✓ bytecode verified");
  const json = JSON.parse(await page.getByTestId("fideploy-json").innerText());
  expect(json.chainId).toBe(314159);
  expect(json.deployments[0]).toMatchObject({ contract: "FiClub", verified: "match" });
  const sent = await page.evaluate(() => (window as any).__sent);
  expect(sent).toHaveLength(1);
  expect(sent[0].data).toBe(art.FiClub.bytecode);
  // Regression: the slower pre-connect public read must not overwrite the wallet's view afterwards.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("fideploy-row-FiClub")).toContainText("est. ~0.0063 FIL");
  await expect(page.getByTestId("fideploy-row-SessionKeyRegistry")).toContainText("present (canonical)");
  await page.screenshot({ path: "screenshots/fideploy.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/fideploy-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("S58 FiDeploy on mainnet needs an explicit acknowledgement", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const orig = w.ethereum.request;
    w.ethereum.request = (a: any) => (a.method === "eth_chainId" ? Promise.resolve("0x13a") : orig(a));
  });
  await page.goto("/fideploy/");
  await page.getByTestId("fideploy-connect").click();
  await expect(page.getByTestId("fideploy-account")).toContainText("Filecoin Mainnet");
  await expect(page.getByTestId("fideploy-deploy-FiClub")).toBeDisabled();
  await page.getByTestId("fideploy-mainnet-ack").check();
  await expect(page.getByTestId("fideploy-deploy-FiClub")).toBeEnabled();
});

test("FiFolders sidebar links to FiClub and FiDeploy", async ({ page }) => {
  await page.goto("/");
  // The links live in the drive sidebar; the stories suite covers the logged-in view. Here: the pages load.
  for (const path of ["/ficlub/", "/fideploy/"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
  }
});
