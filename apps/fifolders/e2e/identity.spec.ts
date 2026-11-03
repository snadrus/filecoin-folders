import { expect, test } from "@playwright/test";

const ADDRESS = "0x2222222222222222222222222222222222222222";

/** A fake EIP-1193 wallet: answers instantly except where a test holds a request open. No real chain, no spend. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript((address) => {
    const w = window as unknown as Record<string, unknown>;
    w.__calls = [] as string[];
    w.__hold = null;
    w.ethereum = {
      request: async ({ method }: { method: string }) => {
        (w.__calls as string[]).push(method);
        if (w.__hold === method) await new Promise((r) => (w.__release = r));
        if (method === "eth_accounts") return w.__connected ? [address] : [];
        if (method === "eth_requestAccounts") return ((w.__connected = true), [address]);
        if (method === "eth_signTypedData_v4") return "0x" + "11".repeat(65);
        if (method === "eth_sendTransaction") return "0x" + "22".repeat(32);
        return null;
      },
    };
  }, ADDRESS);
});

test("connect, edit, save identity with labeled wallet prompts, then return to the doc", async ({ page }) => {
  await page.goto("/identity/?return=" + encodeURIComponent("/?from=fipen"));
  await page.getByTestId("identity-connect").click();
  const name = page.getByTestId("identity-name");
  await expect(name).toBeVisible();
  await expect(page.getByTestId("identity-status")).toContainText("Not set up yet");
  await name.fill("Andy Jackson");
  await page.getByTestId("identity-emoji").fill("🦊");
  await page.locator('[data-action="color"]').first().click();
  await page.getByTestId("identity-bio").fill("Builds things on Filecoin");

  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__hold = "eth_signTypedData_v4"));
  await page.getByTestId("identity-save").click();
  const toast = page.getByTestId("wallet-prompt");
  await expect(toast).toContainText("Check your wallet");
  await expect(toast).toContainText("Store identity piece");
  await expect(toast).toContainText("free signature");
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__hold = null;
    (w.__release as () => void)();
  });
  await expect(page.getByTestId("identity-saved")).toBeVisible();
  const cached = await page.evaluate((a) => JSON.parse(localStorage.getItem("fil-identity:v1:" + a) || "null"), ADDRESS);
  expect(cached.identity).toMatchObject({ v: 1, schema: "fil-identity/profile", displayName: "Andy Jackson", avatar: { emoji: "🦊" }, bio: "Builds things on Filecoin" });
  const calls = await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
  expect(calls).toContain("eth_sendTransaction");
  await page.waitForURL(/\/\?from=fipen/);

  // Fresh cache: identity is read back from the (mock) chain pointer + piece.
  await page.evaluate((a) => localStorage.removeItem("fil-identity:v1:" + a), ADDRESS);
  await page.goto("/identity/");
  await page.getByTestId("identity-connect").click();
  await expect(page.getByTestId("identity-status")).toContainText("Saved on chain");
  await expect(page.getByTestId("identity-name")).toHaveValue("Andy Jackson");
});

test("saving without storage payments is blocked and asks for nothing", async ({ page }) => {
  await page.goto("/identity/?blocked=payments");
  await page.getByTestId("identity-connect").click();
  await page.getByTestId("identity-save").click();
  await expect(page.getByTestId("identity-blocked")).toContainText("Storage payments are not set up");
  const calls = await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
  expect(calls).not.toContain("eth_sendTransaction");
  expect(calls).not.toContain("eth_signTypedData_v4");
});

test("story: upload a picture, it is cropped to a small square, saved in the identity, and shown instead of the emoji", async ({ page }) => {
  await page.goto("/identity/");
  await page.getByTestId("identity-connect").click();
  await page.getByTestId("identity-name").fill("Andy Jackson");
  await page.getByTestId("identity-emoji").fill("🦊");
  await expect(page.getByTestId("identity-image-pick")).toHaveText("Upload picture");
  // A 300x200 photo-like PNG (non-square, so the crop matters).
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 200;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 300, 200);
    grad.addColorStop(0, "#1a73e8");
    grad.addColorStop(1, "#e37400");
    g.fillStyle = grad;
    g.fillRect(0, 0, 300, 200);
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(150, 100, 60, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByTestId("identity-image-file").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const img = page.locator("[data-testid=identity-preview] .fiperson-avatar[data-kind=image] img");
  await expect(img).toBeVisible();
  const dims = await img.evaluate((el: HTMLImageElement) => new Promise<[number, number, number]>((r) => {
    const probe = new Image();
    probe.onload = () => r([probe.naturalWidth, probe.naturalHeight, el.src.length]);
    probe.src = el.src;
  }));
  expect(dims[0]).toBe(128);
  expect(dims[1]).toBe(128);
  expect(dims[2]).toBeLessThanOrEqual(24_000);
  await expect(page.getByTestId("identity-image-pick")).toHaveText("Change picture");
  await expect(page.getByTestId("identity-image-remove")).toBeVisible();
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  await page.getByTestId("identity-save").click();
  await expect(page.getByTestId("identity-saved")).toBeVisible();
  const cached = await page.evaluate((a) => JSON.parse(localStorage.getItem("fil-identity:v1:" + a) || "null"), ADDRESS);
  expect(cached.identity.avatar.image).toMatch(/^data:image\/(webp|png|jpeg);base64,/);

  // Read back from the (mock) chain: picture survives, and the drive's identity line shows it.
  await page.evaluate((a) => localStorage.removeItem("fil-identity:v1:" + a), ADDRESS);
  await page.goto("/identity/");
  await page.getByTestId("identity-connect").click();
  await expect(page.getByTestId("identity-status")).toContainText("Saved on chain");
  await expect(page.locator("[data-testid=identity-preview] .fiperson-avatar[data-kind=image] img")).toBeVisible();

  await page.getByTestId("identity-image-remove").click();
  await expect(page.locator("[data-testid=identity-preview] .fiperson-avatar")).toHaveAttribute("data-kind", "emoji");
});
