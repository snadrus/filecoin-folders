import { expect, type BrowserContext, type Page } from "@playwright/test";

/** STORIES_URL=https://fifolders.scionbase.ai runs against live; unset uses the local mock build. */
export const LIVE = Boolean(process.env.STORIES_URL);
export const BASE = process.env.STORIES_URL || `http://127.0.0.1:${process.env.STORIES_PORT || 4183}`;
export const url = (path: string) => new URL(path, BASE.endsWith("/") ? BASE : BASE + "/").toString();

type Ed = { ready: boolean; getText(): string; selection?(): { anchor: number; head: number } };
const ed = () => (window as unknown as { __editor: Ed }).__editor;

export async function editorReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
}

export const text = (page: Page) => page.evaluate(() => (window as any).__editor.getText() as string);

/** Caret index: the editor API when present, else type a marker, read where it landed, and remove it. */
export async function caret(page: Page): Promise<number> {
  const sel = await page.evaluate(() => (window as any).__editor.selection?.() ?? null);
  if (sel) return sel.head;
  const before = await text(page);
  await page.keyboard.type("¤");
  const after = await text(page);
  await page.keyboard.press("Backspace");
  expect(await text(page)).toBe(before);
  return after.indexOf("¤");
}

/** Standalone FiPen: new blank document, focused at the start. */
export async function newDoc(page: Page): Promise<void> {
  await page.goto(url("fipen/"));
  await page.locator("#blank").click();
  await editorReady(page);
  await focusDoc(page);
}

export async function focusDoc(page: Page): Promise<void> {
  await page.bringToFront();
  const box = await page.locator("#pages canvas").first().boundingBox();
  if (!box) throw new Error("no page canvas");
  await page.mouse.click(box.x + 120, box.y + 120);
}

/** Opens a new FiPen/FiGrid from the drive's New menu; returns the editor tab. */
export async function newFromDrive(drive: Page, kind: "FiPen document" | "FiGrid spreadsheet"): Promise<Page> {
  await drive.getByTestId("new-button").click();
  const popup = drive.context().waitForEvent("page");
  await drive.getByRole("button", { name: kind }).click();
  const tab = await popup;
  await tab.bringToFront();
  return tab;
}

export async function saveState(page: Page): Promise<string> {
  return (await page.locator("#status").getAttribute("data-save")) ?? "";
}

export async function guest(ctx: BrowserContext, link: string): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(link);
  await editorReady(p);
  return p;
}
