import { expect, test } from "@playwright/test";
import { LIVE, editorReady, focusDoc, newFromDrive, text, url } from "./helpers";

// Old Fi* links and files from before the rename must keep working.

test.describe("pre-rename links", () => {
  for (const [old, now] of [
    ["fipen/", "trepen/"],
    ["figrid/", "tregrid/"],
    ["ficlub/", "treclub/"],
    ["fideploy/", "tredeploy/"],
    ["felarumi/", "trepen/"],
    ["felanumio/", "tregrid/"],
  ]) {
    test(`/${old} still opens: lands on /${now} and keeps the query and hash`, async ({ page }) => {
      await page.goto(url(`${old}?room=abc123#key=xyz`));
      await page.waitForURL(new RegExp(`/${now}\\?room=abc123#key=xyz$`));
      await expect(page.locator("body")).not.toContainText("404");
    });
  }

  test("an old /fipen/ share link opens the editor", async ({ page }) => {
    await page.goto(url("fipen/"));
    await page.waitForURL(/\/trepen\/$/);
    await expect(page.locator("#blank")).toBeVisible();
  });
});

test.describe("pre-rename files", () => {
  test.skip(LIVE, "needs the mock-chain build");

  test("a document saved as .fipen (the extension kept for existing files) still reopens from TreFolders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("nav-drive")).toBeVisible();
    const doc = await newFromDrive(page, "TrePen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("written under the old name");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.close();
    await page.bringToFront();
    const row = page.getByTestId("entry").filter({ hasText: ".fipen" }).first();
    await expect(row).toBeVisible();
    const popup = page.context().waitForEvent("page");
    await row.dblclick();
    const again = await popup;
    await again.bringToFront();
    expect(new URL(again.url()).searchParams.get("path") ?? "").toMatch(/\.fipen$/);
    await editorReady(again);
    await expect.poll(() => text(again), { timeout: 20_000 }).toBe("written under the old name");
  });
});
