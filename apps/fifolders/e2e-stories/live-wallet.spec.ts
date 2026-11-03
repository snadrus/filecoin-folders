import { expect, test } from "@playwright/test";
import { LIVE } from "./helpers";
import { CHAIN_ID, filBalance, hasWallet, installWallet } from "./wallet";
import { formatEther } from "viem";

// Real Calibration reads + an injected EIP-1193 wallet that signs in Node (key never reaches the page or logs).
// eth_sendTransaction is refused by default: payment approval, deposits, datasets and uploads need Andy's approval.
test.skip(!LIVE || !hasWallet(), "set STORIES_URL to the live site; needs the Calibration test wallet");
test.describe.configure({ timeout: 150_000 });

test("S03 connect: one labeled request, account shown, drive visible", async ({ page }) => {
  const w = await installWallet(page);
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("account")).toContainText(w.address.slice(0, 6));
  expect(w.calls.filter((c) => c.method === "eth_requestAccounts").length).toBe(1);
});

test("S04 live: browse while setup is unfinished", async ({ page }) => {
  await installWallet(page);
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  const note = page.getByTestId("setup-note");
  if (await note.count()) {
    await expect(note).toContainText("you can browse meanwhile");
    const open = page.getByTestId("setup-open-wallet");
    if (await open.count()) {
      await open.click();
      await expect(page.getByTestId("account-menu")).toContainText(/ — .+\(.+\)/);
      await page.keyboard.press("Escape");
    }
  }
  await page.getByTestId("nav-recent").click();
  await page.getByTestId("nav-trash").click();
  await page.getByTestId("nav-drive").click();
  await expect(page.getByTestId("breadcrumb").first()).toBeVisible();
});

test("S40 slow signature: 'Check your wallet' toast names the request while waiting, UI stays browsable, toast clears", async ({ page }) => {
  const w = await installWallet(page);
  w.modes.eth_requestAccounts = { kind: "delay", ms: 6000 };
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  const prompt = page.getByTestId("wallet-prompt");
  await expect(prompt).toBeVisible({ timeout: 5000 });
  await expect(prompt).toContainText("Check your wallet");
  await expect(page.getByTestId("wallet-prompt-title")).toContainText(/Connect wallet/);
  await expect(prompt).toContainText(/\(free\)/);
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await expect(prompt).toHaveCount(0, { timeout: 20_000 });
});

test("S41 rejected signature: plain error, Retry works, no stuck state", async ({ page }) => {
  const w = await installWallet(page);
  w.modes.eth_requestAccounts = { kind: "reject" };
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  const retry = page.getByTestId("wallet-retry");
  const err = page.getByTestId("connect-error");
  await expect(retry.or(err).first()).toBeVisible({ timeout: 15_000 });
  w.modes.eth_requestAccounts = { kind: "approve" };
  if (await retry.count()) await retry.click();
  else await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("wallet-prompt")).toHaveCount(0, { timeout: 20_000 });
});

test("S42 locked wallet: clear message, connect works after unlock", async ({ page }) => {
  const w = await installWallet(page);
  w.locked = true;
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("connect-error").or(page.getByTestId("wallet-retry")).first()).toBeVisible({ timeout: 15_000 });
  w.locked = false;
  const retry = page.getByTestId("wallet-retry");
  if (await retry.count()) await retry.click();
  else await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
});

test("S43 repeated clicks do not stack duplicate wallet prompts", async ({ page }) => {
  const w = await installWallet(page);
  w.modes.eth_requestAccounts = { kind: "delay", ms: 4000 };
  await page.goto("/");
  const btn = page.getByTestId("connect-wallet");
  await btn.click();
  await btn.click({ timeout: 2000 }).catch(() => undefined);
  await btn.click({ timeout: 2000 }).catch(() => undefined);
  await expect(page.getByTestId("wallet-prompt")).toHaveCount(1);
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  expect(w.calls.filter((c) => c.method === "eth_requestAccounts").length).toBe(1);
});

test("S44 wallet switches account or chain mid-session: session restarts in place, no reload, no prompt", async ({ page }) => {
  const w = await installWallet(page);
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("nav-trash").click();
  await page.evaluate(() => ((window as any).__noReload = true));
  const signing = () => w.calls.filter((c) => ["eth_requestAccounts", "personal_sign", "eth_signTypedData_v4", "eth_sendTransaction", "wallet_switchEthereumChain"].includes(c.method.split(":")[0])).length;
  const before = signing();
  // Account switch: the wallet now exposes another account to this site.
  const other = "0x1111111111111111111111111111111111111111";
  w.accountOverride = other;
  await w.emit("accountsChanged", [other]);
  await expect(page.getByTestId("account")).toContainText("0x1111", { timeout: 30_000 });
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  // Chain switch: a notice, no prompt.
  await w.emit("chainChanged", "0x13a");
  await expect(page.getByTestId("toast").filter({ hasText: "switched network" })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  expect(signing()).toBe(before);
});

// Spends on Calibration only (Andy approved, test FIL/USDFC). Opt-in: STORIES_SPEND=1.
test("S45 payment approval, session key, upload on live (Calibration spend)", async ({ page }) => {
  test.skip(!process.env.STORIES_SPEND, "spends test FIL on Calibration; set STORIES_SPEND=1");
  test.setTimeout(600_000);
  const fil0 = await filBalance();
  const w = await installWallet(page, { allowTx: () => w.chainId === CHAIN_ID });
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("account").click();
  const menu = page.getByTestId("account-menu");
  const fix = menu.getByTestId("fix-payments");
  await expect(fix.or(menu.getByTestId("payment-status")).first()).toBeVisible({ timeout: 60_000 });
  await expect(menu.getByTestId("session-status")).toBeVisible({ timeout: 60_000 });
  console.log("S45 menu before:", (await menu.innerText()).split("\n").filter((l) => /USDFC|payment|Session|Approve|Enable/i.test(l)).join(" | "));
  if (await fix.count()) {
    await expect(fix).toHaveText(/—.+\(.+\)/);
    await fix.click();
    await expect(page.getByTestId("wallet-prompt").or(page.getByTestId("activity")).first()).toBeVisible({ timeout: 20_000 });
    await expect(menu.getByTestId("payment-status").or(page.getByTestId("payment-status")).first()).toBeVisible({ timeout: 300_000 });
  }
  if (!(await page.getByTestId("account-menu").isVisible())) await page.getByTestId("account").click();
  const auth = page.getByTestId("account-menu").getByTestId("authorize-session");
  if (await auth.count()) {
    await auth.click();
    await expect(page.getByTestId("account-menu").getByTestId("session-status").or(page.getByTestId("session-status")).first()).toContainText("until", { timeout: 300_000 });
  }
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-drive").click();
  const name = `s45-${Date.now()}.txt`;
  await page.getByTestId("file-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("S45 Calibration upload test\n") });
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("upload-panel").locator(".upload-row").filter({ hasText: name })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("upload-panel").locator(".upload-row").filter({ hasText: name })).not.toHaveAttribute("data-status", "uploading", { timeout: 420_000 });
  console.log("S45 upload row:", await page.getByTestId("upload-panel").locator(".upload-row").filter({ hasText: name }).getAttribute("data-status"));
  await expect(page.getByTestId("activity-indicator")).toHaveCount(0, { timeout: 420_000 });
  const txs = w.calls.filter((c) => c.outcome.startsWith("tx ")).map((c) => c.outcome.slice(3));
  const fil1 = await filBalance();
  console.log(`S45 spend: ${formatEther(fil0 - fil1)} tFIL gas; txs: ${txs.join(", ") || "none"}; signatures: ${w.calls.filter((c) => c.method.startsWith("eth_signTypedData_v4") || c.method === "personal_sign").length}`);
  await expect(page.getByTestId("setup-error")).toHaveCount(0);
});


test("S10b fresh browser, same wallet: the drive tree is recovered from chain", async ({ page }) => {
  test.skip(!process.env.STORIES_SPEND, "needs a committed volume (S45 makes one); set STORIES_SPEND=1");
  test.setTimeout(300_000);
  const w = await installWallet(page);
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^s45-\d+\.txt$/).first()).toBeVisible({ timeout: 240_000 });
  expect(w.calls.filter((c) => c.outcome.startsWith("tx ")).length).toBe(0);
});

test("S48 identity save with a picture on live /identity/ (Calibration spend)", async ({ page }) => {
  test.skip(!process.env.STORIES_SPEND, "spends test FIL on Calibration; set STORIES_SPEND=1");
  test.setTimeout(600_000);
  const w = await installWallet(page, { allowTx: () => w.chainId === CHAIN_ID });
  await page.goto("/identity/");
  const connect = page.getByTestId("identity-connect");
  await expect(connect.or(page.getByTestId("identity-name")).first()).toBeVisible({ timeout: 90_000 });
  if (await connect.isVisible()) await connect.click({ timeout: 5_000 }).catch(() => {});
  await expect(page.getByTestId("identity-name")).toBeVisible({ timeout: 90_000 });
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 180;
    const g = c.getContext("2d")!;
    g.fillStyle = "#188038";
    g.fillRect(0, 0, 240, 180);
    g.fillStyle = "#fff";
    g.fillRect(90, 60, 60, 60);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByTestId("identity-image-file").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator("[data-testid=identity-preview] [data-kind=image] img")).toBeVisible();
  await page.getByTestId("identity-save").click();
  await expect(page.getByTestId("identity-saved").or(page.getByTestId("identity-error")).or(page.getByTestId("identity-blocked")).first()).toBeVisible({ timeout: 480_000 });
  await expect(page.getByTestId("identity-saved")).toBeVisible();
  // Fresh read from chain + piece.
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fil-identity:")).forEach((k) => localStorage.removeItem(k)));
  await page.reload();
  await expect(page.getByTestId("identity-status")).toContainText("Saved on chain", { timeout: 120_000 });
  await expect(page.locator("[data-testid=identity-preview] [data-kind=image] img")).toBeVisible();
});
