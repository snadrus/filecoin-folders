import { expect, test } from "@playwright/test";
import { LIVE, url } from "./helpers";

// Phone layouts for the editors (mobile pass round 2). Mock build only: no wallet, no spend.
test.skip(LIVE, "mock build only");
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("M01 FiPen phone: one toolbar row, menus open as bottom sheets, toolbar sits above the keyboard while typing", async ({ page }) => {
  await page.goto(url("fipen/"));
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
  const bar = (await page.locator("#toolbar").boundingBox())!;
  expect(bar.height).toBeLessThan(60); // was 4 wrapped rows
  await page.locator('.menu-btn[data-menu="file"]').tap();
  const pop = page.locator('[data-pop="file"]');
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  await page.locator(".menu-scrim").tap({ position: { x: 20, y: 120 } });
  await expect(pop).toBeHidden();
  const c = (await page.locator("#pages canvas").first().boundingBox())!;
  await page.touchscreen.tap(c.x + 60, c.y + 60);
  await page.keyboard.type("hi");
  // Android-style keyboard: the layout viewport shrinks at the same width.
  await page.setViewportSize({ width: 390, height: 524 });
  await expect(page.locator("body")).toHaveClass(/phone-editing/);
  const low = (await page.locator("#toolbar").boundingBox())!;
  expect(Math.round(low.y + low.height)).toBeGreaterThan(510);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).not.toHaveClass(/phone-editing/);
});

test("M02 FiGrid phone: tap selects without the keyboard, tap again edits, comments open from the toolbar", async ({ page }) => {
  await page.goto(url("figrid/"));
  await page.locator("#blank").click();
  const grid = page.locator("#grid");
  await expect(grid).toBeVisible();
  const g = (await grid.boundingBox())!;
  await page.touchscreen.tap(g.x + 150, g.y + 60);
  await expect(page.locator("#namebox")).not.toHaveText("A1");
  await expect(page.locator("#formula")).not.toBeFocused();
  await page.touchscreen.tap(g.x + 150, g.y + 60);
  await expect(page.locator("#formula")).toBeFocused();
  await page.keyboard.type("42");
  await page.keyboard.press("Enter");
  await expect(page.locator("#side")).toBeHidden();
  await page.locator("#side-toggle").tap();
  await expect(page.locator("#side")).toBeVisible();
  await page.locator("#side-close").tap();
  await expect(page.locator("#side")).toBeHidden();
});

test("M03 drive phone: Details is a full-screen sheet, Rename sits above the keyboard, the wallet menu is a bottom sheet", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeAttached();
  await page.getByTestId("file-input").setInputFiles({ name: "m3.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  const more = page.getByTestId("entry").filter({ hasText: "m3.txt" }).getByTestId("row-more");
  await more.tap();
  await page.getByTestId("context-menu").getByRole("button", { name: "Details", exact: true }).tap();
  const details = page.getByTestId("details");
  await expect(details).toBeVisible();
  await page.evaluate(() => Promise.all((document.querySelector("[data-testid=details]")?.getAnimations() ?? []).map((a) => a.finished.catch(() => undefined))));
  expect(await details.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await details.getByRole("button", { name: "Close details" }).tap();
  await more.tap();
  await page.getByTestId("context-menu").getByRole("button", { name: "Rename", exact: true }).tap();
  const form = (await page.getByTestId("dialog").locator("form").boundingBox())!;
  expect(form.y + form.height).toBeLessThan(844 / 2); // the keyboard takes the lower half
  await page.keyboard.press("Escape");
  await page.getByTestId("account").tap();
  const menu = page.getByTestId("account-menu");
  await page.evaluate(() => Promise.all((document.querySelector("[data-testid=account-menu]")?.getAnimations() ?? []).map((a) => a.finished.catch(() => undefined))));
  const m = (await menu.boundingBox())!;
  expect(m.x).toBe(0);
  expect(Math.round(m.y + m.height)).toBe(844);
  await page.getByTestId("sheet-scrim").tap({ position: { x: 20, y: 20 } });
  await expect(menu).toHaveCount(0);
});

// Round 3 (real Android x86 emulator, Chrome + Gboard) found these; the stories replay the same event shapes.
test("M04 drive phone: a long-press that Chrome Android turns into a drag opens the actions sheet", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeAttached();
  await page.getByTestId("file-input").setInputFiles({ name: "m4.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  const row = page.getByTestId("entry").filter({ hasText: "m4.txt" });
  await expect(row).toBeVisible();
  // Chrome Android: pointerdown(touch) -> dragstart -> pointercancel; no contextmenu event ever fires.
  await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: r.x + 40, clientY: r.y + 10 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "touch", isPrimary: true }));
    el.dispatchEvent(new DragEvent("dragstart", { ...at, cancelable: true, dataTransfer: new DataTransfer() }));
    el.dispatchEvent(new PointerEvent("pointercancel", { ...at, pointerType: "touch" }));
  });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
});

test("M05 FiPen phone: Gboard-style composition reaches the doc live, with sentence-only capitals and a caret on the text line", async ({ page }) => {
  await page.goto(url("fipen/"));
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
  const c = (await page.locator("#pages canvas").first().boundingBox())!;
  await page.touchscreen.tap(c.x + 60, c.y + 60);
  const cdp = await page.context().newCDPSession(page);
  const text = () => page.evaluate(() => (window as any).__editor.getText() as string);
  // Gboard composes every word: each key replaces the whole composing word.
  for (const w of ["h", "he", "hel", "hello "]) await cdp.send("Input.imeSetComposition", { text: w, selectionStart: w.length, selectionEnd: w.length });
  await expect.poll(text).toBe("hello ");
  await cdp.send("Input.insertText", { text: "hello " }); // commit (compositionend)
  for (const w of ["w", "wo", "world"]) await cdp.send("Input.imeSetComposition", { text: w, selectionStart: w.length, selectionEnd: w.length });
  await expect.poll(text).toBe("hello world"); // live while composing
  await cdp.send("Input.insertText", { text: "world" });
  await expect.poll(text).toBe("hello world");
  // Mid-sentence the hidden field keeps a context character so the keyboard does not capitalize every word.
  await expect.poll(() => page.locator("#input").textContent()).toBe(",");
  await page.keyboard.type(". ");
  await expect.poll(() => page.locator("#input").textContent()).toBe("");
  // The caret sits on the text line (phone reflow hides the ruler; overlays used to sit 28px low).
  const gap = await page.evaluate(() => {
    const caret = document.querySelector(".local-caret")!.getBoundingClientRect();
    const canvas = document.querySelector("#pages canvas") as HTMLCanvasElement;
    const k = canvas.width / canvas.getBoundingClientRect().width;
    const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let first = -1;
    for (let y = 0; y < canvas.height && first < 0; y++) for (let x = 0; x < canvas.width; x++) { const i = (y * canvas.width + x) * 4; if (d[i] < 120 && d[i + 3] > 0) { first = y; break; } }
    return caret.top - canvas.getBoundingClientRect().top - first / k;
  });
  expect(Math.abs(gap)).toBeLessThan(10);
});
