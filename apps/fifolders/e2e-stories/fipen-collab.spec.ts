import { expect, test, type Page } from "@playwright/test";
import { caret, editorReady, focusDoc, newDoc, text } from "./helpers";

async function selectLine(page: Page) {
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
}

async function rightClickDoc(page: Page) {
  const box = (await page.locator("#pages canvas").first().boundingBox())!;
  await page.mouse.click(box.x + 140, box.y + 100, { button: "right" });
}

async function addComment(page: Page, body: string) {
  await rightClickDoc(page);
  await page.locator("#context").getByText("Comment", { exact: true }).click();
  const input = page.locator("#notes textarea").last();
  await input.fill(body);
  await page.locator("#notes").getByRole("button", { name: "Comment", exact: true }).click();
}

test.describe("FiPen sharing, comments, names", () => {
  test("S26 Share shows only '🔗 Copy Link' and copies the doc URL", async ({ page }) => {
    await newDoc(page);
    await page.locator("#share").click();
    const dlg = page.locator("#dialog");
    await expect(dlg).toBeVisible();
    await expect(page.locator("#dialog-title")).toHaveText("Share");
    const buttons = dlg.locator("#dialog-body button");
    await expect(buttons).toHaveCount(1);
    await expect(buttons).toHaveText("🔗 Copy Link");
    await expect(dlg.locator("#dialog-body select, #dialog-body input[type=radio]")).toHaveCount(0);
    await buttons.click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(decodeURIComponent(clip)).toContain("/d/");
    expect(clip).toContain("#");
  });

  test("S27 right-click → Comment; card shows no quoted text", async ({ page }) => {
    await newDoc(page);
    await page.keyboard.type("quoted words here");
    await selectLine(page);
    await addComment(page, "a note");
    const card = page.locator("#notes article.note").first();
    await expect(card).toContainText("a note");
    await expect(card).not.toContainText("quoted words here");
    const threads = await page.evaluate(() => (window as any).__editor.threads());
    expect(threads.length).toBe(1);
  });

  test("S28 mobile: selection shows the 💬 Comment bubble", async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await newDoc(page);
    await page.keyboard.type("touch me");
    await selectLine(page);
    await page.dispatchEvent("body", "pointerup");
    await expect(page.locator("#comment-bubble")).toBeVisible();
    await ctx.close();
  });

  test("S29 guest names are Adjective Animal, deterministic per wallet", async ({ browser }) => {
    const wallet = "0x2d63000000000000000000000000000000f401aa";
    const names: string[] = [];
    for (const w of [wallet, wallet, "0x1111111111111111111111111111111111111111"]) {
      const ctx = await browser.newContext();
      await ctx.addInitScript((addr) => localStorage.setItem("fipen:wallet", addr), w);
      const page = await ctx.newPage();
      await newDoc(page);
      names.push((await page.locator("#name-btn").innerText()).trim());
      await ctx.close();
    }
    for (const n of names) expect(n).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(names[0]).toBe(names[1]);
    expect(names[2]).not.toBe(names[0]);
  });

  test("S30 FiFolders display name overrides the guest name; typed name wins", async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem("fifolders:display-name", "Andy J"));
    const page = await ctx.newPage();
    await newDoc(page);
    await expect(page.locator("#name-btn")).toHaveText("Andy J");
    // Clicking your name opens the identity pop-up; "Just use a different name here" is the per-session override.
    await page.locator("#name-btn").click();
    await expect(page.getByTestId("identity-pop-configure").or(page.getByTestId("identity-pop-edit")).first()).toBeVisible();
    page.once("dialog", (d) => d.accept("Zed"));
    await page.getByTestId("identity-pop-local").click();
    await expect(page.locator("#name-btn")).toHaveText("Zed");
    await ctx.close();
  });
});

test.describe("FiPen two-user collaboration (trystero/nostr)", () => {
  test.describe.configure({ timeout: 180_000 });

  async function pair(browser: import("@playwright/test").Browser) {
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await newDoc(owner);
    await owner.keyboard.type("Owner line");
    const link = owner.url();
    const guestCtx = await browser.newContext();
    const guest = await guestCtx.newPage();
    await guest.goto(link);
    await editorReady(guest);
    await expect.poll(() => text(guest), { timeout: 60_000 }).toBe("Owner line");
    return { owner, guest, link, close: async () => (await ownerCtx.close(), await guestCtx.close()) };
  }

  test("S31 edits flow both ways and the caret stays put under remote inserts", async ({ browser }) => {
    const { owner, guest, close } = await pair(browser);
    // Owner caret at end (10). Guest inserts at start; owner's caret must shift right by the insert.
    await focusDoc(guest);
    await guest.keyboard.press("Control+Home");
    await guest.keyboard.type("G: ");
    await expect.poll(() => text(owner), { timeout: 30_000 }).toBe("G: Owner line");
    await owner.bringToFront();
    await owner.keyboard.type("!");
    await expect.poll(() => text(guest), { timeout: 30_000 }).toBe("G: Owner line!");
    expect(await text(owner)).toBe("G: Owner line!");
    await expect(owner.locator("#avatars > *")).toHaveCount(2);
    await close();
  });

  test("S32 guest sees owner comments, cannot resolve; owner can", async ({ browser }) => {
    const { owner, guest, close } = await pair(browser);
    await owner.bringToFront();
    await selectLine(owner);
    await addComment(owner, "owner says");
    await expect(guest.locator("#notes article.note")).toContainText("owner says", { timeout: 30_000 });
    await expect(guest.locator("#notes .resolve-btn")).toHaveCount(0);
    await expect(owner.locator("#notes .resolve-btn")).toHaveCount(1);
    await owner.locator("#notes .resolve-btn").click();
    await expect(guest.locator("#notes article.note")).toHaveCount(0, { timeout: 30_000 });
    await close();
  });

  for (const who of ["owner", "guest", "both"] as const) {
    test(`S33 reload ${who}: peers reconnect, text intact, no duplicates, comments kept`, async ({ browser }) => {
      const { owner, guest, close } = await pair(browser);
      await owner.bringToFront();
      await selectLine(owner);
      await addComment(owner, "keep me");
      await expect(guest.locator("#notes article.note")).toContainText("keep me", { timeout: 30_000 });
      const reload = async (p: Page) => {
        await p.reload();
        await editorReady(p);
      };
      if (who !== "guest") await reload(owner);
      if (who !== "owner") await reload(guest);
      for (const p of [owner, guest]) {
        await expect.poll(() => text(p), { timeout: 60_000 }).toBe("Owner line");
        await expect(p.locator("#notes article.note")).toContainText("keep me", { timeout: 60_000 });
      }
      // The owner's hub sees the guest again (presence), then edits flow.
      await expect.poll(() => owner.evaluate(() => (window as any).__editor.remoteCount()), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      // Sane caret after reload: typing lands where the user clicks/moves, once.
      await focusDoc(guest);
      await guest.keyboard.press("Control+End");
      await guest.keyboard.type(" +g");
      await expect.poll(() => text(owner), { timeout: 30_000 }).toBe("Owner line +g");
      expect(await caret(guest)).toBe("Owner line +g".length);
      await close();
    });
  }
});

test.describe("FiPen guest edits during an owner reload", () => {
  test.describe.configure({ timeout: 180_000 });
  test("S36 guest edits typed while the owner reloads are replayed once", async ({ browser }) => {
    const oc = await browser.newContext();
    const owner = await oc.newPage();
    await newDoc(owner);
    await owner.keyboard.type("Owner line");
    const gc = await browser.newContext();
    const guest = await gc.newPage();
    await guest.goto(owner.url());
    await editorReady(guest);
    await expect.poll(() => text(guest), { timeout: 60_000 }).toBe("Owner line");
    await focusDoc(guest);
    await guest.keyboard.press("Control+End");
    // Typed right before the owner goes away: these ops are unacked by the old hub.
    await guest.keyboard.type(" +g1");
    await owner.reload();
    await editorReady(owner);
    await expect(guest.locator("#p2p-wait")).toBeHidden({ timeout: 60_000 });
    await focusDoc(guest);
    await guest.keyboard.press("Control+End");
    await guest.keyboard.type(" +g2");
    for (const p of [owner, guest]) await expect.poll(() => text(p), { timeout: 60_000 }).toBe("Owner line +g1 +g2");
    await oc.close();
    await gc.close();
  });
});

test.describe("FiPen single-user reload matrix (standalone)", () => {
  test("S34 reload clean doc keeps content and status", async ({ page }) => {
    await newDoc(page);
    await expect(page.locator("#status")).toHaveText("New, unsaved");
    await page.keyboard.type("persist me");
    await page.waitForTimeout(1500);
    await page.reload();
    await editorReady(page);
    expect(await text(page)).toBe("persist me");
    await expect(page.locator("#status")).not.toHaveText(/failed/i);
  });

  test("S35 leaving with unsaved changes warns (beforeunload)", async ({ page }) => {
    await newDoc(page);
    await page.keyboard.type("unsaved");
    await expect(page.locator("#status")).toHaveText("Unsaved changes", { timeout: 5000 });
    let warned = false;
    page.on("dialog", async (d) => {
      warned = d.type() === "beforeunload";
      await d.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => warned).toBe(true);
  });
});
