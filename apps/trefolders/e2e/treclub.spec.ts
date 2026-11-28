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

test("S52 not-deployed banner, create club, members/admins, direct remove, 2-sig removal via blob", async ({ page }) => {
  await page.goto("/treclub/");
  await expect(page.getByTestId("treclub-not-deployed")).toContainText("TreClub contract not deployed yet");
  await page.getByTestId("treclub-connect").click();
  await expect(page.getByTestId("treclub-empty")).toBeVisible();

  // Create: labeled wallet toast.
  await page.getByTestId("treclub-name").fill("Builders");
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__hold = "eth_sendTransaction"));
  await page.getByTestId("treclub-create").click();
  const toast = page.getByTestId("wallet-prompt");
  await expect(toast).toContainText("Check your wallet");
  await expect(toast).toContainText("Create club");
  await expect(toast).toContainText("gas ~0.02 FIL");
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__hold = null;
    (w.__release as () => void)();
  });
  await expect(page.getByTestId("treclub-detail")).toContainText("Builders");
  await expect(page.getByTestId("treclub-admins").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("treclub-remove-admin")).toHaveCount(0); // last admin protected

  // Members.
  await page.getByTestId("treclub-member-input").fill(B);
  await page.getByTestId("treclub-add-member").click();
  await expect(page.getByTestId("treclub-members").locator("li")).toHaveCount(2);
  await page.getByTestId("treclub-members").locator("li").nth(1).getByTestId("treclub-remove-member").click();
  await expect(page.getByTestId("treclub-members").locator("li")).toHaveCount(1);
  await page.getByTestId("treclub-member-input").fill("nope");
  await page.getByTestId("treclub-add-member").click();
  await expect(page.getByTestId("treclub-error")).toContainText("valid 0x");

  // Two admins: direct removal available (incl. step down), then re-add.
  await page.getByTestId("treclub-admin-input").fill(B);
  await page.getByTestId("treclub-add-admin").click();
  await expect(page.getByTestId("treclub-remove-admin")).toHaveCount(2);
  await page.getByTestId("treclub-admins").locator("li").nth(1).getByTestId("treclub-remove-admin").click();
  await expect(page.getByTestId("treclub-admins").locator("li")).toHaveCount(1);
  await page.getByTestId("treclub-admin-input").fill(B);
  await page.getByTestId("treclub-add-admin").click();
  await page.getByTestId("treclub-admin-input").fill(C);
  await page.getByTestId("treclub-add-admin").click();
  await expect(page.getByTestId("treclub-admins").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("treclub-remove-admin")).toHaveCount(0);

  // Step 1: A signs removal of C.
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__hold = "eth_signTypedData_v4"));
  await page.getByTestId("treclub-admins").locator("li").nth(2).getByTestId("treclub-sign-removal").click();
  await expect(toast).toContainText("Sign admin removal (step 1 of 2)");
  await expect(toast).toContainText("free signature");
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__hold = null;
    (w.__release as () => void)();
  });
  const blobText = await page.getByTestId("treclub-blob-text").inputValue();
  const blob = JSON.parse(blobText);
  expect(blob).toMatchObject({ kind: "ficlub/remove-admin", target: C, signer1: A, nonce: "0" });
  const download = page.waitForEvent("download");
  await page.getByTestId("treclub-download").click();
  expect((await download).suggestedFilename()).toMatch(/^treclub-1-remove-.*\.json$/);

  // Same admin importing it is rejected.
  await page.getByTestId("treclub-import-text").fill(blobText);
  await page.getByTestId("treclub-import").click();
  await expect(page.getByTestId("treclub-import-problems")).toContainText("different admin");
  await page.getByTestId("treclub-import-text").fill("garbage");
  await page.getByTestId("treclub-import").click();
  await expect(page.getByTestId("treclub-error")).toContainText("not a TreClub removal signature");

  // Step 2: C (the target) co-signs its own removal and submits — allowed.
  await as(page, C);
  await page.getByTestId("treclub-club").click();
  await page.getByTestId("treclub-import-text").fill(blobText);
  await page.getByTestId("treclub-import").click();
  await expect(page.getByTestId("treclub-import-review")).toContainText("Remove admin");
  await page.getByTestId("treclub-cosign").click();
  await expect(page.getByTestId("treclub-notice")).toContainText("two signatures");
  await expect(page.getByTestId("treclub-back")).toHaveCount(0); // C left the club entirely → list view
  await as(page, A);
  await page.getByTestId("treclub-club").click();
  await expect(page.getByTestId("treclub-admins").locator("li")).toHaveCount(2);

  // Replay: the old blob is now stale.
  await page.getByTestId("treclub-admin-input").fill(C);
  await page.getByTestId("treclub-add-admin").click();
  await as(page, B);
  await page.getByTestId("treclub-club").click();
  await page.getByTestId("treclub-import-text").fill(blobText);
  await page.getByTestId("treclub-import").click();
  await expect(page.getByTestId("treclub-import-problems")).toContainText("nonce moved");
  await page.screenshot({ path: "screenshots/treclub.png", fullPage: true });
});

test("TreClub background fills the whole viewport (no grey band under the card)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/treclub/");
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe("rgb(241, 244, 249)");
});
