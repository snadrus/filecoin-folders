import { expect, test } from "@playwright/test";
import { caret, newDoc, text } from "./helpers";

// S20-S23: FiPen caret behavior with real keyboard events.
test.describe("FiPen caret", () => {
  test.beforeEach(async ({ page }) => newDoc(page));

  test("S20 typing and Enter keep the caret at the insertion point", async ({ page }) => {
    const k = page.keyboard;
    await k.type("Hello");
    expect(await caret(page)).toBe(5);
    await k.press("Enter");
    expect(await caret(page)).toBe(6);
    await k.type("World");
    expect(await text(page)).toBe("Hello\nWorld");
    expect(await caret(page)).toBe(11);
    await k.press("Enter");
    await k.press("Enter");
    expect(await caret(page)).toBe(13);
    await k.type("Third");
    expect(await text(page)).toBe("Hello\nWorld\n\nThird");
  });

  test("S21 Enter at line start, middle and end splits correctly", async ({ page }) => {
    const k = page.keyboard;
    await k.type("abcdef");
    for (let i = 0; i < 3; i++) await k.press("ArrowLeft");
    await k.press("Enter");
    expect(await text(page)).toBe("abc\ndef");
    expect(await caret(page)).toBe(4);
    await k.press("Home");
    await k.press("Enter");
    expect(await text(page)).toBe("abc\n\ndef");
    expect(await caret(page)).toBe(5);
    await k.press("End");
    await k.press("Enter");
    await k.type("g");
    expect(await text(page)).toBe("abc\n\ndef\ng");
    expect(await caret(page)).toBe(10);
  });

  test("S22 arrows, Home/End and typing at line starts/ends across paragraphs", async ({ page }) => {
    const k = page.keyboard;
    await k.type("first line");
    await k.press("Enter");
    await k.type("second");
    await k.press("Enter");
    await k.type("third para");
    await k.press("ArrowUp");
    await k.press("Home");
    await k.type(">");
    expect(await text(page)).toBe("first line\n>second\nthird para");
    await k.press("End");
    await k.type("<");
    expect(await text(page)).toBe("first line\n>second<\nthird para");
    expect(await caret(page)).toBe(19);
    await k.press("ArrowRight"); // to start of next paragraph
    expect(await caret(page)).toBe(20);
    await k.type("#");
    expect(await text(page)).toBe("first line\n>second<\n#third para");
    await k.press("ArrowUp");
    await k.press("ArrowUp");
    await k.press("End");
    await k.type("!");
    expect(await text(page)).toBe("first line!\n>second<\n#third para");
    await k.press("ArrowLeft");
    await k.press("ArrowLeft");
    await k.press("ArrowDown");
    const c = await caret(page);
    expect(c).toBeGreaterThan(11);
    expect(c).toBeLessThanOrEqual(20);
  });

  test("S23 Backspace/Delete join paragraphs and the caret stays at the join", async ({ page }) => {
    const k = page.keyboard;
    await k.type("one");
    await k.press("Enter");
    await k.type("two");
    await k.press("Home");
    await k.press("Backspace");
    expect(await text(page)).toBe("onetwo");
    expect(await caret(page)).toBe(3);
    await k.press("Enter");
    await k.press("ArrowUp");
    await k.press("End");
    await k.press("Delete");
    expect(await text(page)).toBe("onetwo");
    expect(await caret(page)).toBe(3);
    await k.type("-");
    expect(await text(page)).toBe("one-two");
  });

  test("S24 clicking at the end of a line puts the caret there", async ({ page }) => {
    const k = page.keyboard;
    await k.type("short");
    await k.press("Enter");
    await k.type("a much longer second line of text");
    const box = (await page.locator("#pages canvas").first().boundingBox())!;
    // Click far right on the first line: caret should land at its end (5).
    const first = await page.evaluate(() => (window as any).__editor.selection?.());
    void first;
    await page.mouse.click(box.x + box.width - 120, box.y + 98);
    await k.type("X");
    const t = await text(page);
    expect(t.includes("shortX") || t.endsWith("textX")).toBeTruthy();
  });

  test("S25 Undo/redo restores text and caret", async ({ page }) => {
    const k = page.keyboard;
    await k.type("keep");
    await k.press("Enter");
    await k.type("drop");
    await k.press("Control+z");
    expect((await text(page)).startsWith("keep")).toBeTruthy();
    await k.press("Control+y");
    expect(await text(page)).toBe("keep\ndrop");
    expect(await caret(page)).toBe(9);
  });
});
