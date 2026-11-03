import { expect, test } from "@playwright/test";
import { LIVE } from "./helpers";
import { hasWallet, installWallet } from "./wallet";

// Real Calibration reads + an injected EIP-1193 wallet that signs in Node (key never reaches the page or logs).
// eth_sendTransaction is refused by default: payment approval, deposits, datasets and uploads need Andy's approval.
test.skip(!LIVE || !hasWallet(), "set STORIES_URL to the live site; needs the Calibration test wallet");
test.describe.configure({ timeout: 150_000 });

test("S03 connect: one labeled request, account shown, drive visible", async ({ page }) => {
  const w = await installWallet(page);
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("account-label")).toContainText(w.address.slice(0, 6));
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
  const signing = () => w.calls.filter((c) => ["eth_requestAccounts", "personal_sign", "eth_signTypedData_v4", "eth_sendTransaction", "wallet_switchEthereumChain"].includes(c.method)).length;
  const before = signing();
  // Account switch: the wallet now exposes another account to this site.
  const other = "0x1111111111111111111111111111111111111111";
  w.accountOverride = other;
  await w.emit("accountsChanged", [other]);
  await expect(page.getByTestId("account-label")).toContainText("0x1111", { timeout: 30_000 });
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  // Chain switch: a notice, no prompt.
  await w.emit("chainChanged", "0x13a");
  await expect(page.getByTestId("toast").filter({ hasText: "switched network" })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  expect(signing()).toBe(before);
});

test("S45 payment approval / deposit / dataset / upload on live", async () => {
  test.skip(true, "blocked: needs Andy approval for spend");
});
