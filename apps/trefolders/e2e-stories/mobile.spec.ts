import { expect, test } from "@playwright/test";
import { LIVE, url } from "./helpers";

// Phone layouts for the editors (mobile pass round 2). Mock build only: no wallet, no spend.
test.skip(LIVE, "mock build only");
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("M01 TrePen phone: one toolbar row, menus open as bottom sheets, toolbar sits above the keyboard while typing", async ({ page }) => {
  await page.goto(url("trepen/"));
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

test("M02 TreGrid phone: tap selects without the keyboard, tap again edits, comments open from the toolbar", async ({ page }) => {
  await page.goto(url("tregrid/"));
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

test("M05 TrePen phone: Gboard-style composition reaches the doc live, with sentence-only capitals and a caret on the text line", async ({ page }) => {
  await page.goto(url("trepen/"));
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

async function touchAt(page: import("@playwright/test").Page, x: number, y: number, times = 1): Promise<void> {
  // Dispatch on #pages so a handle or the action bar sitting over the point cannot swallow the event.
  await page.evaluate(({ x, y, times }) => {
    const target = document.querySelector("#pages")!;
    const fire = () => {
      for (const type of ["pointerdown", "pointerup"] as const) {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: "touch", pointerId: 1, isPrimary: true, clientX: x, clientY: y, view: window }));
      }
    };
    for (let i = 0; i < times; i++) fire();
  }, { x, y, times });
}

async function openDrawer(page: import("@playwright/test").Page): Promise<void> {
  const btn = page.getByTestId("menu-button");
  await expect(async () => {
    if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.tap();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
  }).toPass();
}

test("M06 TrePen phone: double-tap selects a word, handles appear, the action bar can copy, and toolbar bold applies to the selection", async ({ page }) => {
  await page.goto(url("trepen/"));
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
  await page.evaluate(() => {
    const ed = (window as any).__editor;
    ed.insertText("hello world");
    ed.setSelection(1, 1);
  });
  const pos = await page.evaluate(() => {
    const r = (document.querySelector(".local-caret") as HTMLElement).getBoundingClientRect();
    return { x: r.x + 10, y: r.y + r.height / 2 };
  });
  await touchAt(page, pos.x, pos.y, 2);
  await expect.poll(async () => page.evaluate(() => {
    const s = (window as any).__editor.selection();
    return s.head - s.anchor;
  })).toBeGreaterThan(0);
  await expect(page.getByTestId("sel-handle-start")).toBeVisible();
  await expect(page.getByTestId("sel-handle-end")).toBeVisible();
  await expect(page.getByTestId("sel-bar")).toBeVisible();
  await expect(page.getByTestId("sel-bar").getByRole("button", { name: "Copy" })).toBeVisible();
  await page.locator("#bold").tap();
  await expect.poll(() => page.evaluate(() => (window as any).__editor.styleAt(1).b === true)).toBe(true);
  // Tap in the middle of the selected word (not on a handle at either end) to collapse it.
  const mid = await page.evaluate(() => {
    const a = document.querySelector("[data-testid=sel-handle-start]")!.getBoundingClientRect();
    const b = document.querySelector("[data-testid=sel-handle-end]")!.getBoundingClientRect();
    return { x: (a.left + b.left) / 2, y: Math.min(a.top, b.top) - 8 };
  });
  await touchAt(page, mid.x, mid.y, 1);
  await expect.poll(async () => {
    const s = await page.evaluate(() => (window as any).__editor.selection());
    return s.anchor === s.head;
  }).toBe(true);
});

test("M07 drive phone: every row type shows a 44px ⋮ that opens the actions sheet", async ({ page }) => {
  const sizeOf = async (el: import("@playwright/test").Locator) => {
    const b = (await el.boundingBox())!;
    return { w: b.width, h: b.height };
  };
  await page.goto("/?onboard=1&pay=ready&datasets=1&fcdrive=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeAttached();
  await page.getByTestId("file-input").setInputFiles([
    { name: "doc.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
  ]);
  await expect(page.getByTestId("entry").filter({ hasText: "doc.txt" })).toBeVisible();
  const closeUploads = page.getByRole("button", { name: "Close uploads" });
  if (await closeUploads.isVisible().catch(() => false)) await closeUploads.click();
  const fileMore = page.getByTestId("entry").filter({ hasText: "doc.txt" }).getByTestId("row-more");
  await expect(fileMore).toBeVisible();
  expect(await sizeOf(fileMore)).toEqual({ w: 44, h: 44 });
  await fileMore.tap();
  await expect(page.getByTestId("context-menu").getByRole("button", { name: "Rename", exact: true })).toBeVisible();
  await page.getByTestId("sheet-scrim").tap({ position: { x: 20, y: 20 } });
  await page.getByTestId("view-grid").tap();
  const gridMore = page.getByTestId("entry").filter({ hasText: "doc.txt" }).getByTestId("row-more");
  await expect(gridMore).toBeVisible();
  expect(await sizeOf(gridMore)).toEqual({ w: 44, h: 44 });
  await page.getByTestId("view-list").tap();
  await page.getByTestId("search").fill("doc");
  const searchMore = page.getByTestId("entry").filter({ hasText: "doc.txt" }).getByTestId("row-more");
  await expect(searchMore).toBeVisible();
  expect(await sizeOf(searchMore)).toEqual({ w: 44, h: 44 });
  await page.getByTestId("search").fill("");
  await expect(page.getByTestId("search")).toHaveValue("");
  await page.getByTestId("search").blur();
  await expect(fileMore).toBeVisible();
  // Clearing search enqueues a refresh that can replace the row mid-tap; retry until the sheet stays open.
  await expect(async () => {
    if (!(await page.getByTestId("context-menu").isVisible())) await fileMore.tap();
    await expect(page.getByTestId("context-menu").getByRole("button", { name: "Move to trash", exact: true })).toBeVisible();
  }).toPass();
  await page.getByTestId("context-menu").getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "moved to trash" })).toBeVisible();
  await expect(page.getByTestId("entry").filter({ hasText: "doc.txt" })).toHaveCount(0);
  await openDrawer(page);
  await page.getByTestId("nav-trash").click();
  await expect(page.getByTestId("nav-trash")).toHaveClass(/on/);
  const trashMore = page.getByTestId("entry").filter({ hasText: "doc.txt" }).getByTestId("row-more");
  await expect(trashMore).toBeVisible();
  expect(await sizeOf(trashMore)).toEqual({ w: 44, h: 44 });
  await trashMore.tap();
  await expect(page.getByTestId("context-menu").getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await page.getByTestId("sheet-scrim").tap({ position: { x: 20, y: 20 } });
  await openDrawer(page);
  await page.getByTestId("nav-loose").click();
  await expect(page.getByTestId("nav-loose")).toHaveClass(/on/);
  const loose = page.locator("[data-testid=loose-row]").filter({ hasText: "hello.txt" });
  await expect(loose).toBeVisible();
  await expect(loose.getByTestId("loose-adopt")).toBeHidden();
  const looseMore = loose.getByTestId("row-more");
  await expect(looseMore).toBeVisible();
  expect(await sizeOf(looseMore)).toEqual({ w: 44, h: 44 });
  await looseMore.tap();
  await expect(page.getByTestId("context-menu").getByRole("button", { name: "Add to folders", exact: true })).toBeVisible();
});

test("M08 identity, person, share and TreClub are usable on a phone", async ({ page }) => {
  const noHScroll = async () => page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth + 1);
  await page.goto("/identity/");
  await expect(page.locator("h1")).toBeVisible();
  expect(await noHScroll()).toBe(true);
  const field = page.locator("input, textarea, select").first();
  if (await field.count()) {
    const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  }
  await page.goto("/person/");
  await expect(page.getByRole("heading", { name: "Person" })).toBeVisible();
  expect(await noHScroll()).toBe(true);
  await page.goto("/share/");
  await expect(page.locator("h1")).toBeVisible();
  expect(await noHScroll()).toBe(true);
  await page.goto("/treclub/");
  await expect(page.locator("h1")).toBeVisible();
  expect(await noHScroll()).toBe(true);
  const btn = page.locator("button, a.primary, .primary").first();
  if (await btn.count()) {
    const box = await btn.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(40);
  }
});

test("M09 TrePen phone: tapping the first line places the caret instead of opening the Header dialog", async ({ page }) => {
  await page.goto(url("trepen/"));
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
  await page.evaluate(() => (window as any).__editor.insertText("first line"));
  const c = (await page.locator("#pages canvas").first().boundingBox())!;
  await page.touchscreen.tap(c.x + 60, c.y + 26); // phone reflow: text starts 16px from the top, inside the old 52px header band
  await expect.poll(() => page.evaluate(() => (window as any).__editor.selection().head)).toBeLessThan(11);
  await expect(page.locator("#dialog")).toBeHidden();
});

test("M10 TreGrid phone: the cell shows what you type in the formula bar, which does not autocapitalize", async ({ page }) => {
  await page.goto(url("tregrid/"));
  await page.locator("#blank").click();
  const g = (await page.locator("#grid").boundingBox())!;
  await page.touchscreen.tap(g.x + 150, g.y + 60);
  await page.touchscreen.tap(g.x + 150, g.y + 60);
  await expect(page.locator("#formula")).toBeFocused();
  expect(await page.locator("#formula").getAttribute("autocapitalize")).toBe("off");
  await page.keyboard.type("typed live");
  await expect.poll(() => page.evaluate(() => (window as any).__sheet.painted() as string[])).toContain("typed live");
});
