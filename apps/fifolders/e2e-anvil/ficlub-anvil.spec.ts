import { expect, test, type Page } from "@playwright/test";

// anvil's unlocked default accounts #0..#2 sign/send through the node itself.
const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const C = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const rpc = (method: string, params: unknown) =>
      fetch("http://127.0.0.1:8546", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) })
        .then((r) => r.json())
        .then((j) => {
          if (j.error) throw Object.assign(new Error(j.error.message), j.error);
          return j.result;
        });
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const acct = localStorage.getItem("__acct")!;
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [acct];
        return rpc(method, params);
      },
    };
  });
});

async function as(page: Page, addr: string) {
  await page.evaluate((x) => localStorage.setItem("__acct", x), addr);
  await page.reload();
}

test("real contract on anvil: create, add/remove, 2-sig admin removal with target co-signing", async ({ page }) => {
  await page.goto("/ficlub/");
  await as(page, A);
  await expect(page.getByTestId("ficlub-not-deployed")).toHaveCount(0);
  await page.getByTestId("ficlub-name").fill("Anvil Club");
  await page.getByTestId("ficlub-create").click();
  await expect(page.getByTestId("ficlub-detail")).toContainText("Anvil Club");
  await page.getByTestId("ficlub-member-input").fill(B);
  await page.getByTestId("ficlub-add-member").click();
  await expect(page.getByTestId("ficlub-members").locator("li")).toHaveCount(2);
  await page.getByTestId("ficlub-members").locator("li", { hasText: "0x7099" }).getByTestId("ficlub-remove-member").click();
  await expect(page.getByTestId("ficlub-members").locator("li")).toHaveCount(1);
  for (const x of [B, C]) {
    await page.getByTestId("ficlub-admin-input").fill(x);
    await page.getByTestId("ficlub-add-admin").click();
    await expect(page.getByTestId("ficlub-busy")).toHaveCount(0);
  }
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(3);
  await page.getByTestId("ficlub-admins").locator("li", { hasText: "0x3C44" }).getByTestId("ficlub-sign-removal").click();
  const blobText = await page.getByTestId("ficlub-blob-text").inputValue();
  expect(JSON.parse(blobText)).toMatchObject({ chainId: 31337, target: C, signer1: A });

  await as(page, C); // target co-signs its own removal
  await page.getByTestId("ficlub-club").click();
  await page.getByTestId("ficlub-import-text").fill(blobText);
  await page.getByTestId("ficlub-import").click();
  await page.getByTestId("ficlub-cosign").click();
  await expect(page.getByTestId("ficlub-notice")).toContainText("two signatures");

  await as(page, A);
  await page.getByTestId("ficlub-club").click();
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(2);
  // 2 admins → direct removal (step down) works on chain
  await page.getByTestId("ficlub-admins").locator("li", { hasText: "0x7099" }).getByTestId("ficlub-remove-admin").click();
  await expect(page.getByTestId("ficlub-admins").locator("li")).toHaveCount(1);
});
