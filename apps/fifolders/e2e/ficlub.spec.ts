import { expect, test, type Page } from "@playwright/test";

const A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const C = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";

/** Fake EIP-1193 wallet with a switchable account (window.__account). No chain, no spend. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript((a) => {
    const w = window as unknown as Record<string, unknown>;
    w.__calls = [] as string[];
    w.__account ??= a;
    w.ethereum = {
      request: async ({ method }: { method: string }) => {
        (w.__calls as string[]).push(method);
        if (w.__hold === method) await new Promise((r) => (w.__release = r));
        if (method === "eth_accounts") return localStorage.getItem("__connected") ? [localStorage.getItem("__acct") || w.__account] : [];
        if (method === "eth_requestAccounts") return localStorage.setItem("__connected", "1"), [localStorage.getItem("__acct") || w.__account];
        if (method === "eth_signTypedData_v4") return "0x" + "11".repeat(65);
        if (method === "eth_sendTransaction") return "0x" + "22".repeat(32);
        return null;
      },
    };
  }, A);
});

async function as(page: Page, addr: string) {
  await page.evaluate((x) => localStorage.setItem("__acct", x), addr);
  await page.reload();
}

test("not-deployed banner, create club, members/admins, direct remove, 2-sig removal via blob", async ({ page }) => {
  await page.goto("/ficlub/");
  await expect(page.getByTestId("ficlub-not-deployed")).toContainText("FiClub contract not deployed yet");
  await page.getByTestId("ficlub-connect").click();
  await expect(page.getByTestId("ficlub-empty")).toBeVisible();

  // Create: labeled wallet toast.
  await page.getByTestId("ficlub-name").fill("Builders");
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__hold = "eth_sendTransaction"));
  await page.getByTestId("ficlub-create").click();
  const toast = page.getByTestId("wallet-prompt");
  await expect(toast).toContainText("Check your wallet");
  await expect(toast).toContainText("Create club");
  await expect(toast).toContainText("gas ~0.02 FIL");
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__hold = null;
    (w.__release as () => void)();
  });
  await expect(page.getByTestId("ficlub-detail")).toContainText("Builders");
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("ficlub-remove-admin")).toHaveCount(0); // last admin protected

  // Members.
  await page.getByTestId("ficlub-member-input").fill(B);
  await page.getByTestId("ficlub-add-member").click();
  await expect(page.getByTestId("ficlub-members").locator("li")).toHaveCount(2);
  await page.getByTestId("ficlub-members").locator("li").nth(1).getByTestId("ficlub-remove-member").click();
  await expect(page.getByTestId("ficlub-members").locator("li")).toHaveCount(1);
  await page.getByTestId("ficlub-member-input").fill("nope");
  await page.getByTestId("ficlub-add-member").click();
  await expect(page.getByTestId("ficlub-error")).toContainText("valid 0x");

  // Two admins: direct removal available (incl. step down), then re-add.
  await page.getByTestId("ficlub-admin-input").fill(B);
  await page.getByTestId("ficlub-add-admin").click();
  await expect(page.getByTestId("ficlub-remove-admin")).toHaveCount(2);
  await page.getByTestId("ficlub-admins").locator("li").nth(1).getByTestId("ficlub-remove-admin").click();
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(1);
  await page.getByTestId("ficlub-admin-input").fill(B);
  await page.getByTestId("ficlub-add-admin").click();
  await page.getByTestId("ficlub-admin-input").fill(C);
  await page.getByTestId("ficlub-add-admin").click();
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("ficlub-remove-admin")).toHaveCount(0);

  // Step 1: A signs removal of C.
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__hold = "eth_signTypedData_v4"));
  await page.getByTestId("ficlub-admins").locator("li").nth(2).getByTestId("ficlub-sign-removal").click();
  await expect(toast).toContainText("Sign admin removal (step 1 of 2)");
  await expect(toast).toContainText("free signature");
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__hold = null;
    (w.__release as () => void)();
  });
  const blobText = await page.getByTestId("ficlub-blob-text").inputValue();
  const blob = JSON.parse(blobText);
  expect(blob).toMatchObject({ kind: "ficlub/remove-admin", target: C, signer1: A, nonce: "0" });
  const download = page.waitForEvent("download");
  await page.getByTestId("ficlub-download").click();
  expect((await download).suggestedFilename()).toMatch(/^ficlub-1-remove-.*\.json$/);

  // Same admin importing it is rejected.
  await page.getByTestId("ficlub-import-text").fill(blobText);
  await page.getByTestId("ficlub-import").click();
  await expect(page.getByTestId("ficlub-import-problems")).toContainText("different admin");
  await page.getByTestId("ficlub-import-text").fill("garbage");
  await page.getByTestId("ficlub-import").click();
  await expect(page.getByTestId("ficlub-error")).toContainText("not a FiClub removal signature");

  // Step 2: C (the target) co-signs its own removal and submits — allowed.
  await as(page, C);
  await page.getByTestId("ficlub-club").click();
  await page.getByTestId("ficlub-import-text").fill(blobText);
  await page.getByTestId("ficlub-import").click();
  await expect(page.getByTestId("ficlub-import-review")).toContainText("Remove admin");
  await page.getByTestId("ficlub-cosign").click();
  await expect(page.getByTestId("ficlub-notice")).toContainText("two signatures");
  await expect(page.getByTestId("ficlub-back")).toHaveCount(0); // C left the club entirely → list view
  await as(page, A);
  await page.getByTestId("ficlub-club").click();
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(2);

  // Replay: the old blob is now stale.
  await page.getByTestId("ficlub-admin-input").fill(C);
  await page.getByTestId("ficlub-add-admin").click();
  await as(page, B);
  await page.getByTestId("ficlub-club").click();
  await page.getByTestId("ficlub-import-text").fill(blobText);
  await page.getByTestId("ficlub-import").click();
  await expect(page.getByTestId("ficlub-import-problems")).toContainText("nonce moved");
  await page.screenshot({ path: "screenshots/ficlub.png", fullPage: true });
});

test("FiClub background fills the whole viewport (no grey band under the card)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ficlub/");
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe("rgb(241, 244, 249)");
});
