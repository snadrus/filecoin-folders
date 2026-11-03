import { expect, test, type Page } from "@playwright/test";
import { LIVE, editorReady, focusDoc, newFromDrive, saveState, text } from "./helpers";

// Local mock-chain build only: FiFolders' drive processes the editor's save rows.
test.skip(LIVE, "needs the mock-chain FiFolders build (spend on live)");

async function drive(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("nav-drive")).toBeVisible();
}

async function entries(page: Page) {
  return (await page.getByTestId("entry").allInnerTexts()).join(" / ");
}

async function openFolder(page: Page, name: string) {
  await page.bringToFront();
  await page.getByTestId("entry").filter({ hasText: name }).first().dblclick();
  await expect(page.getByTestId("breadcrumb").filter({ hasText: name })).toBeVisible();
}

test.describe("FiPen inside FiFolders", () => {
  test("S12 new FiPen opens with no filename prompt; Save button sits right of the title", async ({ page }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await expect(page.getByTestId("dialog-input")).toHaveCount(0);
    await editorReady(doc);
    await expect(doc.locator("#title")).toHaveValue("Untitled document");
    const t = (await doc.locator("#title").boundingBox())!;
    const b = (await doc.locator("#p2p-save").boundingBox())!;
    expect(b.x).toBeGreaterThan(t.x + t.width - 1);
    expect(Math.abs(b.y + b.height / 2 - (t.y + t.height / 2))).toBeLessThan(20);
    await expect(doc.locator("#status")).toHaveText("All changes saved");
  });

  test("S13 typing marks Unsaved; Save button and Cmd/Ctrl+S save to the drive", async ({ page }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("Saved by button");
    await expect(doc.locator("#status")).toHaveText("Unsaved changes");
    await doc.locator("#p2p-save").click();
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.keyboard.type(" and keys");
    await expect(doc.locator("#status")).toHaveText("Unsaved changes");
    await doc.keyboard.press("Meta+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.keyboard.type("!");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await openFolder(page, "FiPen");
    await expect(page.getByTestId("entry").filter({ hasText: "Untitled document.fipen" })).not.toContainText("Save pending");
    expect(await entries(page)).not.toMatch(/Save pending/);
  });

  test("S14 autosave fires only when dirty", async ({ page }) => {
    await page.context().addInitScript(() => ((window as any).__p2pAutosaveMs = 2000));
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    let writes = 0;
    await doc.exposeFunction("__countWrite", () => writes++);
    await doc.evaluate(() => {
      const set = localStorage.setItem.bind(localStorage);
      localStorage.setItem = (k: string, v: string) => {
        if (k === "fifolders:ops" && v.includes('"fel:')) (window as any).__countWrite();
        set(k, v);
      };
    });
    await doc.waitForTimeout(5000);
    expect(writes).toBe(0); // clean: no autosave
    await focusDoc(doc);
    await doc.keyboard.type("auto");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 15_000 });
    const after = writes;
    expect(after).toBeGreaterThanOrEqual(1);
    await doc.waitForTimeout(5000);
    expect(writes).toBe(after); // saved: no repeat
  });

  test("S15 reopening a saved doc from the drive shows its content", async ({ page }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("reopen me");
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.close();
    await openFolder(page, "FiPen");
    const popup = page.context().waitForEvent("page");
    await page.getByTestId("entry").filter({ hasText: "Untitled document.fipen" }).dblclick();
    const again = await popup;
    await again.bringToFront();
    await editorReady(again);
    await expect.poll(() => text(again), { timeout: 20_000 }).toBe("reopen me");
    await expect(again.locator("#status")).toHaveText(/Saved to Filecoin|All changes saved/);
  });

  test("S16 reload matrix: dirty stays Unsaved, queued stays Queued, saved stays Saved", async ({ page, context }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    await doc.keyboard.type("draft");
    await expect(doc.locator("#status")).toHaveText("Unsaved changes");
    // Dirty → reload: text kept locally, still Unsaved (never confirmed by FiFolders).
    await doc.reload();
    await editorReady(doc);
    expect(await text(doc)).toBe("draft");
    await expect(doc.locator("#status")).toHaveText("Unsaved changes");
    // Queued (FiFolders tab closed) → reload: still Queued, not "saved".
    await page.close();
    await focusDoc(doc);
    await doc.keyboard.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Queued for FiFolders");
    await doc.reload();
    await editorReady(doc);
    await expect(doc.locator("#status")).toHaveText("Queued for FiFolders");
    // FiFolders comes back, commits; editor shows Saved, and keeps it after reload.
    const back = await context.newPage();
    await drive(back);
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await doc.reload();
    await editorReady(doc);
    expect(await text(doc)).toBe("draft");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin");
    expect(await saveState(doc)).toBe("saved");
  });

  test("S17 caret inside the embedded editor (Enter/arrows/typing)", async ({ page }) => {
    await drive(page);
    const doc = await newFromDrive(page, "FiPen document");
    await editorReady(doc);
    await focusDoc(doc);
    const k = doc.keyboard;
    await k.type("line one");
    await k.press("Enter");
    await k.type("line two");
    await k.press("ArrowUp");
    await k.press("Home");
    await k.type("*");
    await k.press("ArrowDown");
    await k.press("End");
    await k.type("*");
    expect(await text(doc)).toBe("*line one\nline two*");
    await k.press("Control+s");
    await expect(doc.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await k.type("+");
    expect(await text(doc)).toBe("*line one\nline two*+");
  });
});

test.describe("FiGrid inside FiFolders", () => {
  test("S18 FiGrid cell edit, save, reload", async ({ page }) => {
    await drive(page);
    const grid = await newFromDrive(page, "FiGrid spreadsheet");
    await grid.waitForFunction(() => (window as any).__sheet?.ready === true, null, { timeout: 45_000 });
    await expect(page.getByTestId("dialog-input")).toHaveCount(0);
    const box = (await grid.locator("#grid").boundingBox())!;
    await grid.mouse.click(box.x + 80, box.y + 32);
    await expect(grid.locator("#namebox")).toHaveText("A1");
    await grid.keyboard.type("42");
    await grid.keyboard.press("Enter");
    await grid.keyboard.type("=A1*2");
    await grid.keyboard.press("Enter");
    const sheet = () => grid.evaluate(() => [(window as any).__sheet.raw(0, 0), (window as any).__sheet.display(1, 0)]);
    await expect.poll(sheet).toEqual(["42", "84"]);
    await expect(grid.locator("#status")).toHaveText("Unsaved changes");
    await grid.keyboard.press("Control+s");
    await expect(grid.locator("#status")).toHaveText("Saved to Filecoin", { timeout: 20_000 });
    await grid.reload();
    await grid.waitForFunction(() => (window as any).__sheet?.ready === true, null, { timeout: 45_000 });
    await expect.poll(sheet).toEqual(["42", "84"]);
    await expect(grid.locator("#status")).toHaveText("Saved to Filecoin");
    await openFolder(page, "FiGrid");
    await expect(page.getByTestId("entry").filter({ hasText: ".figrid" })).not.toContainText("Save pending");
  });
});
