import { expect, test, type Page } from "@playwright/test";
import { LIVE, editorReady, focusDoc, newFromDrive } from "./helpers";

// Local mock-chain build only: FiFolders' drive processes the editor's save rows.
test.skip(LIVE, "needs the mock-chain FiFolders build");

async function drive(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("nav-drive")).toBeVisible();
}

async function rename(doc: Page, name: string) {
  const title = doc.locator("#title");
  await title.click();
  await doc.keyboard.press("Control+a");
  await doc.keyboard.type(name);
  await doc.keyboard.press("Enter");
}

test.describe("FiPen title survives saving", () => {
  test("S90 rename, save, reload the editor and reopen from folders: title and item name agree", async ({ page }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("Plan body");
    await rename(doc, "Quarterly plan");
    await doc.locator("#p2p-save").click();
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await page.bringToFront();
    await expect(page.getByTestId("entry").filter({ hasText: "Quarterly plan.fipen" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("entry").filter({ hasText: "Untitled document" })).toHaveCount(0);

    await doc.reload();
    await editorReady(doc);
    await doc.waitForTimeout(2500);
    await expect(doc.locator("#title")).toHaveValue("Quarterly plan");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin");

    // Rename again and save from the reloaded tab: the item follows, nothing reverts.
    await rename(doc, "Quarterly plan v2");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.reload();
    await editorReady(doc);
    await doc.waitForTimeout(1500);
    await expect(doc.locator("#title")).toHaveValue("Quarterly plan v2");
    await page.bringToFront();
    await expect(page.getByTestId("entry").filter({ hasText: "Quarterly plan v2.fipen" })).toBeVisible({ timeout: 20_000 });
    await doc.close();

    const popup = page.context().waitForEvent("page");
    await page.getByTestId("entry").filter({ hasText: "Quarterly plan v2.fipen" }).first().dblclick();
    const again = await popup;
    await editorReady(again);
    await again.waitForTimeout(1500);
    await expect(again.locator("#title")).toHaveValue("Quarterly plan v2");
    await expect.poll(async () => (await page.getByTestId("entry").allInnerTexts()).join(" / ")).not.toMatch(/Quarterly plan\.fipen|Untitled document/);
  });

  test("S91 a guest's presence does not clobber the owner's renamed title on save", async ({ page, browser }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("Shared body");
    await rename(doc, "Team notes");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.locator("#share").click();
    await doc.locator("#copy-link").click();
    const link = await doc.evaluate(() => navigator.clipboard.readText());
    await doc.locator("#dialog-close").click();
    const gctx = await browser.newContext();
    const guest = await gctx.newPage();
    await guest.goto(link);
    await editorReady(guest);
    await expect(guest.locator("#title")).toHaveValue("Team notes");
    await rename(guest, "Team notes (edited by guest)");
    await expect(doc.locator("#title")).toHaveValue("Team notes (edited by guest)");
    await doc.bringToFront();
    await focusDoc(doc);
    await doc.keyboard.type(" more");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await page.bringToFront();
    await expect(page.getByTestId("entry").filter({ hasText: "Team notes (edited by guest).fipen" })).toBeVisible({ timeout: 20_000 });
    await doc.reload();
    await editorReady(doc);
    await doc.waitForTimeout(1500);
    await expect(doc.locator("#title")).toHaveValue("Team notes (edited by guest)");
    await expect(guest.locator("#title")).toHaveValue("Team notes (edited by guest)");
    await gctx.close();
  });
});

test.describe("FiPen title follows a folders rename", () => {
  test("S93 rename the item in folders, reopen: the doc title follows (like renaming in Drive)", async ({ page }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("Draft");
    await rename(doc, "Spec");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.close();
    await page.bringToFront();
    const row = page.getByTestId("entry").filter({ hasText: "Spec.fipen" }).first();
    await row.click();
    await page.keyboard.press("F2");
    await expect(page.getByTestId("dialog-input")).toHaveValue("Spec.fipen");
    await page.getByTestId("dialog-input").fill("Spec final.fipen");
    await page.keyboard.press("Enter");
    const renamed = page.getByTestId("entry").filter({ hasText: "Spec final.fipen" }).first();
    await expect(renamed).toBeVisible({ timeout: 20_000 });
    const popup = page.context().waitForEvent("page");
    await renamed.dblclick();
    const again = await popup;
    await editorReady(again);
    await again.waitForTimeout(2500);
    expect(new URL(again.url()).searchParams.get("name")).toBe("Spec final.fipen");
    await expect(again.locator("#title")).toHaveValue("Spec final");
    await expect.poll(() => again.evaluate(() => (window as any).__editor.getText())).toContain("Draft");
  });
});

test.describe("FiPen guest wallet", () => {
  test("S92 a guest's Save keeps a copy in the guest's own folders (their wallet), owner's file untouched", async ({ page, browser }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("Owner text");
    await rename(doc, "Roadmap");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.locator("#share").click();
    await doc.locator("#copy-link").click();
    const link = await doc.evaluate(() => navigator.clipboard.readText());
    await doc.locator("#dialog-close").click();
    expect(link).not.toMatch(/[?&](fifolders|path|name|volume|owner)=/);

    const gctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const guestFolders = await gctx.newPage();
    await drive(guestFolders);
    const guest = await gctx.newPage();
    await guest.goto(link);
    await editorReady(guest);
    await expect(guest.locator("#title")).toHaveValue("Roadmap");
    await focusDoc(guest);
    await guest.keyboard.press("Control+End");
    await guest.keyboard.type(" plus guest ideas");
    await expect(guest.locator("#p2p-save")).toHaveText("Save a copy");
    await guest.locator("#p2p-save").click();
    await expect(guest.locator("#p2p-copy-text")).toContainText("Copy queued for your folders");
    await expect(guest.locator("#p2p-guest-status")).toHaveText(/Copy saved to your folders/, { timeout: 30_000 });
    await guest.screenshot({ path: "/workspace/fipen-guest-copy.png" });
    await guestFolders.bringToFront();
    await guestFolders.getByTestId("entry").filter({ hasText: "Copies" }).first().dblclick();
    await expect(guestFolders.getByTestId("entry").filter({ hasText: "Roadmap (my copy).fipen" })).toBeVisible({ timeout: 20_000 });
    await guestFolders.screenshot({ path: "/workspace/fipen-guest-copy-folders.png" });
    // The owner's title and item did not change.
    await expect(doc.locator("#title")).toHaveValue("Roadmap");
    await page.bringToFront();
    await expect(page.getByTestId("entry").filter({ hasText: "Roadmap.fipen" })).toBeVisible();
    await gctx.close();
  });
});
