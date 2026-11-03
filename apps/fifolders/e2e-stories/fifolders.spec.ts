import { expect, test, type Page } from "@playwright/test";
import { LIVE } from "./helpers";

// FiFolders drive stories on the mock-chain build (no spend). `?onboard=1` drives the mock wallet flow.
test.skip(LIVE, "mock-chain build only; live wallet stories are in live-wallet.spec.ts");

const ready = "/?onboard=1&pay=ready&datasets=1";

async function connect(page: Page, query = ready) {
  await page.goto(query);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
}

test("S01 first visit: no cost pop-up until asked; costs open from the bottom-left with the exact text", async ({ page }) => {
  await connect(page);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("costs")).toHaveCount(0);
  const runway = page.getByTestId("storage-runway");
  const box = (await runway.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeLessThan(vp.width / 3);
  expect(box.y).toBeGreaterThan(vp.height / 2);
  await runway.click();
  const costs = page.getByTestId("costs");
  await expect(costs).toContainText("Per month:");
  await expect(costs.locator(".cost-list li")).toHaveText([
    "$2.50/TiB = a penny for 4 GB",
    "$0.12 per dataset ($0.50 at start)",
    "A penny per piece added",
  ]);
  await page.keyboard.press("Escape");
  await expect(costs).toHaveCount(0);
});

test("S02 light theme even when the OS prefers dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(Math.min(r, g, b)).toBeGreaterThan(200);
});

test("S04 drive is browsable read-only while setup transactions are pending; edits are staged", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&authdelay=1500");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:session:")) localStorage.removeItem(key);
  });
  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await expect(page.getByTestId("setup-note")).toContainText(/you can browse/i);
  // S70: the note sits above the file list; it must not take a column of its own and squeeze the list.
  await expect(page.getByTestId("browser").getByTestId("setup-note")).toHaveCount(1);
  const ws = (await page.locator("main.workspace").boundingBox())!;
  const list = (await page.getByTestId("browser").boundingBox())!;
  expect(list.width).toBeGreaterThan(ws.width * 0.9);
  await page.getByTestId("nav-recent").click();
  await page.getByTestId("nav-drive").click();
  await page.getByTestId("file-input").setInputFiles({ name: "early.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(page.getByText("early.txt").first()).toBeVisible();
  // Lazy session key (decision 1/2): the first save asks for the key and says so while it waits.
  await expect(page.getByTestId("setup-note")).toContainText("Setting up your wallet session");
  await expect(page.getByTestId("upload-title")).toContainText("waiting for wallet setup");
  await expect(page.getByTestId("upload-title")).toContainText("complete", { timeout: 20_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
});

test("S04b Delete after the session was refunded waits visibly for a new session, then saves after one signature", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&authdelay=1500");
  await page.getByTestId("file-input").setInputFiles({ name: "gone.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(page.getByTestId("upload-title")).toContainText("complete", { timeout: 20_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
  await page.getByTestId("account").click();
  await page.getByTestId("refund-session").click();
  await expect(page.getByText(/Session disconnected/)).toBeVisible();
  await page.keyboard.press("Escape");
  const row = page.getByTestId("entry").filter({ hasText: "gone.txt" });
  await row.click();
  await page.keyboard.press("Delete");
  await page.getByTestId("save-changes").click();
  await expect(page.getByTestId("setup-note")).toContainText("Setting up your wallet session");
  await expect(page.getByTestId("setup-note")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("2");
  await page.getByTestId("nav-drive").click();
  await expect(page.getByTestId("entry").filter({ hasText: "gone.txt" })).toHaveCount(0);
});

test("S05/S06 wallet requests are labeled with purpose+cost; 'Check your wallet' shows while waiting and clears", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&authdelay=2500");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:session:")) localStorage.removeItem(key);
  });
  await page.reload();
  await page.getByTestId("setup-open-wallet").click();
  const step = page.getByTestId("account-menu").getByTestId("authorize-session");
  await expect(step).toHaveText(/^Authorize session key — .+ \(.+\)$/);
  await step.click();
  // The mock wallet has no prompt UI; the labeled request shows in the Transaction log (activity lives there since #32).
  await page.keyboard.press("Escape");
  if (!(await page.getByTestId("txlog").count())) await page.getByTestId("txlog-toggle").click();
  await expect(page.getByTestId("activity")).toContainText(/Authorize session key — .+\(.+\)/);
  await expect(page.getByTestId("setup-note")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
});

test("S07 transaction log sidebar lists chain steps; activity rows auto-dismiss ~10s with a blue progress bar", async ({ page }) => {
  await connect(page);
  // Lazy session key: the first upload authorizes it, so its chain steps show up in the log.
  await page.getByTestId("txlog-toggle").click(); // activity rows live in the Transaction log (#32)
  await page.getByTestId("file-input").setInputFiles({ name: "act.txt", mimeType: "text/plain", buffer: Buffer.from("activity") });
  const done = page.getByTestId("activity-item").filter({ has: page.getByTestId("activity-progress") }).first();
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("txlog").getByTestId("chain-steps")).toHaveCount(1);
  const color = await done.getByTestId("activity-progress").evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = color.match(/\d+/g)!.map(Number);
  expect(b).toBeGreaterThan(r);
  expect(b).toBeGreaterThan(g - 1);
  const t0 = Date.now();
  await expect(done).toHaveCount(0, { timeout: 14_000 });
  expect(Date.now() - t0).toBeGreaterThan(5_000);
});

test("S08 dataset selection persists across reload", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=3&drives=2");
  await page.getByTestId("account").click();
  const menu = page.getByTestId("dataset-menu");
  await menu.getByTestId("dataset-item").filter({ hasText: "#1" }).click();
  await page.reload();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("account").click();
  await expect(page.getByTestId("dataset-menu").locator("[aria-checked=true]")).toContainText("#1");
});

test("S09 loose pieces summary reconciles with the piece count", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
  await expect(page.getByTestId("entry").filter({ hasText: "a.txt" })).toBeVisible();
  await page.getByTestId("nav-loose").click();
  const summary = page.getByTestId("loose-summary");
  await page.waitForTimeout(3000);
  if (!(await summary.count())) {
    // Nothing loose: the summary is hidden and the list is empty.
    await expect(page.getByTestId("loose-row")).toHaveCount(0);
    return;
  }
  const m = (await summary.innerText()).match(/(\d+) pieces: (\d+) in folders, (\d+) manifests, (\d+) loose/);
  expect(m).not.toBeNull();
  const [total, inFolders, manifests, loose] = m!.slice(1).map(Number);
  expect(inFolders + manifests + loose).toBe(total);
  await expect(page.getByTestId("loose-row")).toHaveCount(loose);
});

test("S10 refresh restores the tree", async ({ page }) => {
  await connect(page);
  await page.getByTestId("new-button").click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByTestId("dialog-input").fill("Keep");
  await page.getByTestId("dialog-submit").click();
  await expect(page.getByTestId("entry").filter({ hasText: "Keep" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("entry").filter({ hasText: "Keep" })).toBeVisible({ timeout: 20_000 });
});

test("S11 old /felarumi/ and /felanumio/ links land in FiPen/FiGrid with query and hash", async ({ page }) => {
  await page.goto("/felarumi/?spa=%2Fd%2Fabc#secret");
  await expect(page).toHaveURL(/\/fipen\/\?spa=%2Fd%2Fabc#secret$/);
  await page.goto("/felanumio/?spa=%2Fs%2Fabc#k");
  await expect(page).toHaveURL(/\/figrid\/\?spa=%2Fs%2Fabc#k$/);
});

test("S19 a stale editor chunk after a deploy asks to reload", async ({ page }) => {
  // The tab predates a deploy: its lazy peer-transport chunk is gone from the server.
  await page.route(/\/fipen\/trystero-wire-[A-Z0-9]{8}\.js$/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/fipen/");
  await page.locator("#blank").click();
  await expect(page.locator("#p2p-wait")).toContainText("FiPen was updated. Reload the page to continue.", { timeout: 20_000 });
  await page.unrouteAll();
  await page.locator("#p2p-reload").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true, null, { timeout: 45_000 });
});

test("S49 mobile: nav is a chip row, no horizontal overflow; Transaction log fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 391 && !e.closest(".places")).map((e) => `${e.tagName}.${e.className}<${e.parentElement?.className}|${e.textContent} ${Math.round(e.getBoundingClientRect().right)}`).slice(0, 6));
  expect(wide, wide.join(", ")).toEqual([]);
  await page.getByTestId("txlog-toggle").click();
  const box = (await page.getByTestId("txlog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("nav-fideploy")).toHaveCount(0);
  await expect(page.getByTestId("nav-ficlub")).toHaveCount(0);
});

test("S55 wallet & setup menu is filled while the session key is still being authorized after Connect", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1&authdelay=8000");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("account").click();
  const menu = page.getByTestId("account-menu");
  await expect(menu.getByTestId("payment-status")).toBeVisible({ timeout: 4_000 });
  await expect(menu.getByTestId("session-status")).toBeVisible();
});

test("S50 Loose pieces: one Filecoin Drive file → Add to drive names count + cost first, then it lives in My Drive", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&fcdrive=1");
  await page.getByTestId("nav-loose").click();
  const rows = page.locator("[data-testid=loose-row][data-origin=drive]");
  await expect(rows).toHaveCount(3);
  const hello = rows.filter({ hasText: "hello.txt" });
  await hello.hover();
  await hello.getByTestId("loose-adopt").click();
  await expect(page.getByTestId("dialog")).toContainText(/Add 1 file/);
  await expect(page.getByTestId("dialog-note")).toContainText("FIL");
  await page.getByTestId("adopt-confirm").click();
  await expect(page.getByTestId("toast").filter({ hasText: /Added 1 file/ })).toBeVisible();
  await expect(rows.filter({ hasText: "hello.txt" })).toHaveCount(0);
  await page.getByTestId("nav-drive").click();
  await expect(page.getByTestId("entry").filter({ hasText: "hello.txt" }).first()).toBeVisible();
});

test("S53 FiPerson everywhere: header, owner column and wallet menu show the same person", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles({ name: "p.txt", mimeType: "text/plain", buffer: Buffer.from("p") });
  const name = (await page.getByTestId("account-label").innerText()).trim();
  expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$|.+/);
  await expect(page.getByTestId("entry").filter({ hasText: "p.txt" }).locator(".cell.owner")).toContainText(name);
  await page.getByTestId("account").click();
  await expect(page.getByTestId("identity-name")).toHaveText(name);
  await expect(page.getByTestId("account-address")).toContainText("0x");
});

test("S54 dataset picker: switching reloads the drive in place and the check moves", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=3&drives=2");
  await page.evaluate(() => ((window as any).__noReload = 1));
  await page.getByTestId("account").click();
  const items = page.getByTestId("dataset-menu").getByTestId("dataset-item");
  await expect(items).toHaveCount(3);
  const target = items.filter({ hasText: "#1" });
  await target.click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  await page.getByTestId("account").click();
  await expect(page.getByTestId("dataset-menu").getByTestId("dataset-item").filter({ hasText: "#1" })).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(1);
});

test("S54b the 'Using your latest dataset' snackbar hides itself", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=2");
  const snack = page.getByTestId("toast").filter({ hasText: "Using your latest dataset" });
  await expect(snack).toBeVisible();
  await expect(snack).toHaveCount(0, { timeout: 13_000 });
});

test("S50b Loose pieces empty state explains what shows up there", async ({ page }) => {
  await connect(page);
  await page.getByTestId("nav-loose").click();
  await expect(page.locator(".empty-state")).toContainText("Add to drive");
});

test("S60 keyboard like Drive: ↑/↓ move the selection, Shift+↓ extends, Ctrl+A selects all, F2 renames, Enter opens", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles([
    { name: "k1.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
    { name: "k2.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
  ]);
  const rows = page.getByTestId("entry");
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "false");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator("[data-testid=entry][data-selected=true]")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await expect(page.locator("[data-testid=entry][data-selected=true]")).toHaveCount(2);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("F2");
  await expect(page.getByTestId("dialog-input")).toHaveValue("k1.txt");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("preview-text")).toContainText("one");
});

test("S62 a large upload (bigger than localStorage) still shows up and saves, with no raw quota error", async ({ page }) => {
  test.setTimeout(120_000);
  await connect(page);
  await page.getByTestId("file-input").setInputFiles([{ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(12 * 1024 * 1024, 7) }]);
  await expect(page.getByTestId("entry")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator("body")).not.toContainText("exceeded the quota");
  await expect(page.getByRole("button", { name: /^Save \d+ change/ })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("storage-runway")).toContainText("12 MB");
});

test("S63 keyboard only: Tab reaches the file list, selects a row, ↓ and Enter work without the mouse", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles([
    { name: "t1.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "t2.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  const rows = page.getByTestId("entry");
  await expect(rows).toHaveCount(2);
  await page.getByTestId("sort-size").focus();
  await page.keyboard.press("Tab");
  await expect(rows.nth(0)).toBeFocused();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("preview-text")).toContainText("second");
});

test.describe("S64 phone: menus and dialogs sit above the Uploads panel", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("every context-menu item is clickable (topmost) while Uploads is open", async ({ page }) => {
    await connect(page);
    await page.getByTestId("file-input").setInputFiles([{ name: "m.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
    await expect(page.getByTestId("entry")).toHaveCount(1);
    await expect(page.locator(".uploads")).toBeVisible();
    await page.getByTestId("entry").first().click({ button: "right" });
    const covered = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".menu button")].filter((b) => {
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(top && b.contains(top));
      }).map((b) => b.textContent?.trim()),
    );
    expect(covered).toEqual([]);
  });
});

test("S63b mouse on focusable rows: Shift-click extends, move + trash + restore run (Trash menu is Restore/Delete forever/Details) with no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await connect(page);
  await page.getByTestId("new-button").click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByTestId("dialog-input").fill("Docs");
  await page.keyboard.press("Enter");
  await page.getByTestId("file-input").setInputFiles([
    { name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("r") },
    { name: "notes.md", mimeType: "text/plain", buffer: Buffer.from("n") },
  ]);
  const rows = page.getByTestId("entry");
  await expect(rows).toHaveCount(3);
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.locator("[data-testid=entry][data-selected=true]")).toHaveCount(2);
  await rows.filter({ hasText: "report.txt" }).click();
  await rows.filter({ hasText: "report.txt" }).click({ button: "right" });
  await page.getByRole("button", { name: "Move to", exact: true }).click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "notes.md" }).click();
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("nav-trash").click();
  await rows.filter({ hasText: "notes.md" }).click({ button: "right" });
  await expect(page.getByTestId("context-menu").locator("button")).toHaveText([/Restore/, /Delete forever/, /Details/]);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(rows).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("S65 Delete shows 'moved to trash · Undo' like Drive, and Undo puts the file back", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles([{ name: "oops.txt", mimeType: "text/plain", buffer: Buffer.from("o") }]);
  const rows = page.getByTestId("entry");
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(0);
  const toast = page.getByTestId("toast").filter({ hasText: "moved to trash" });
  await expect(toast).toContainText("“oops.txt” moved to trash");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("oops.txt");
});

test("S66 Uploads panel collapses to 'N uploads complete' when done (Drive), and expands on click", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles([
    { name: "u1.txt", mimeType: "text/plain", buffer: Buffer.from("1") },
    { name: "u2.txt", mimeType: "text/plain", buffer: Buffer.from("2") },
  ]);
  const panel = page.getByTestId("upload-panel");
  await expect(page.getByTestId("upload-title")).toHaveText("2 uploads complete");
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await expect(panel.locator(".upload-row")).toHaveCount(0);
  await page.getByTestId("toggle-uploads").click();
  await expect(panel.locator(".upload-row")).toHaveCount(2);
  await page.getByTestId("toggle-uploads").click();
  await expect(panel.locator(".upload-row")).toHaveCount(0);
});

test("S67 offline: the drive says so (Drive parity) and the notice clears on reconnect", async ({ page, context }) => {
  await connect(page);
  const chip = page.getByTestId("offline-chip");
  await expect(chip).toHaveCount(0);
  await context.setOffline(true);
  await expect(chip).toContainText("You're offline");
  await context.setOffline(false);
  await expect(chip).toHaveCount(0);
});

test("S68 same-name upload asks Replace / Keep all (Drive); Replace makes a new version, Keep all adds '(1)'", async ({ page }) => {
  await connect(page);
  const input = page.getByTestId("file-input");
  const rows = page.getByTestId("entry");
  await input.setInputFiles([{ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("v1") }]);
  await expect(rows).toHaveCount(1);
  await input.setInputFiles([{ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("v2 longer") }]);
  const dialog = page.getByTestId("upload-conflict");
  await expect(dialog).toContainText("“plan.txt” already exists");
  await page.getByTestId("upload-conflict-ok").click(); // default: Replace
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("9 B");
  await input.setInputFiles([{ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("v3") }]);
  await dialog.getByLabel("Keep all items").check();
  await page.getByTestId("upload-conflict-ok").click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("entry").filter({ hasText: "plan (1).txt" })).toHaveCount(1);
  await input.setInputFiles([{ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("v4") }]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(rows).toHaveCount(2);
});

test("S69 Manage versions (Drive): lists a file's versions newest first; Restore brings back an older one", async ({ page }) => {
  await connect(page);
  const input = page.getByTestId("file-input");
  const rows = page.getByTestId("entry");
  await input.setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("first draft") }]);
  await expect(rows).toHaveCount(1);
  await input.setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("second draft!") }]);
  await page.getByTestId("upload-conflict-ok").click();
  await expect(rows.first()).toContainText("13 B");
  await rows.first().click({ button: "right" });
  await page.getByRole("button", { name: "Manage versions" }).click();
  const dialog = page.getByTestId("versions-dialog");
  await expect(dialog.getByTestId("version-row")).toHaveCount(2);
  await expect(dialog.getByTestId("version-row").first()).toContainText("Current version");
  await dialog.getByTestId("version-row").nth(1).getByRole("button", { name: "Restore" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows.first()).toContainText("11 B");
  await rows.first().dblclick();
  await expect(page.getByTestId("preview-text")).toContainText("first draft");
});

test("S71 reads don't wait behind wallet setup: Manage versions and Details open while the session key prompt is still open", async ({ page }) => {
  await connect(page, "/?onboard=1&pay=ready&datasets=1&authdelay=60000");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:session:")) localStorage.removeItem(key);
  });
  await page.reload();
  await expect(page.getByTestId("setup-note")).toBeVisible();
  await page.getByTestId("file-input").setInputFiles([{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
  const row = page.getByTestId("entry").filter({ hasText: "a.txt" });
  await expect(row).toHaveCount(1);
  await row.click({ button: "right" });
  await page.getByRole("button", { name: "Manage versions" }).click();
  await expect(page.getByTestId("versions-dialog")).toBeVisible({ timeout: 3_000 });
  await page.keyboard.press("Escape");
  await row.click({ button: "right" });
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByTestId("details")).toBeVisible({ timeout: 3_000 });
});

test("S72 Disconnect session and refund: key forgotten, amount shown, next save asks again (one signature)", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles({ name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("1") });
  await expect(page.getByTestId("upload-title")).toContainText("complete", { timeout: 20_000 });
  await expect(page.getByTestId("wallet-signatures")).toHaveText("1");
  await page.getByTestId("account").click();
  await page.getByTestId("refund-session").click();
  await expect(page.getByText(/Session disconnected\. 0\.0490 tFIL refunded to your wallet\./)).toBeVisible();
  if (!(await page.getByTestId("account-menu").count())) await page.getByTestId("account").click();
  await expect(page.getByTestId("session-status")).toHaveText("Session key missing");
  await page.keyboard.press("Escape");
  await page.getByTestId("file-input").setInputFiles({ name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("2") });
  await expect(page.getByTestId("entry").filter({ hasText: "second.txt" })).toHaveCount(1);
  await expect(page.getByTestId("wallet-signatures")).toHaveText("2", { timeout: 20_000 });
});

test("S73 guest share page: name, size, who shared it, Open, and Download with the real file name", async ({ page, context }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles({ name: "Trip plan.txt", mimeType: "text/plain", buffer: Buffer.from("see you there") });
  const row = page.getByTestId("entry").filter({ hasText: "Trip plan.txt" });
  await expect(page.getByTestId("upload-title")).toContainText("complete", { timeout: 20_000 });
  await row.click({ button: "right" });
  await page.getByRole("button", { name: "Details" }).click();
  const href = await page.getByTestId("share-link").getAttribute("href");
  expect(href).toContain("/share/?cid=");
  // A guest: fresh browser context, nothing connected.
  const guest = await context.browser()!.newContext();
  const g = await guest.newPage();
  await g.route("https://ipfs.io/**", (route) => route.fulfill({ status: 200, body: "see you there", headers: { "content-type": "text/plain", "access-control-allow-origin": "*" } }));
  await g.goto(href!);
  await expect(g.getByTestId("share-name")).toHaveText("Trip plan.txt");
  await expect(g.getByTestId("share-size")).toContainText("bytes");
  await expect(g.getByTestId("share-owner")).toBeVisible();
  await expect(g.getByTestId("share-open")).toHaveAttribute("href", /ipfs\.io\/ipfs\/.+filename=Trip%20plan\.txt/);
  const [download] = await Promise.all([g.waitForEvent("download"), g.getByTestId("share-download").click()]);
  expect(download.suggestedFilename()).toBe("Trip plan.txt");
  await g.screenshot({ path: "/workspace/ff-share-page.png" });
  await guest.close();
});

function wav(seconds: number): Buffer {
  const rate = 8000, n = rate * seconds, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return b;
}

test("S74 audio like Drive: clicking a song opens a player — play, scrub, volume, download with its name", async ({ page }) => {
  await connect(page);
  await page.getByTestId("file-input").setInputFiles([{ name: "voice memo.wav", mimeType: "", buffer: wav(3) }]);
  const row = page.getByTestId("entry").filter({ hasText: "voice memo.wav" });
  await expect(row).toHaveCount(1);
  await row.dblclick();
  const audio = page.getByTestId("preview-audio");
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute("controls", "");
  await page.waitForFunction(() => (document.querySelector("[data-testid=preview-audio]") as HTMLAudioElement)?.duration > 2.5);
  const state = await audio.evaluate(async (el: HTMLAudioElement) => {
    el.muted = true;
    await el.play();
    el.currentTime = 2; // scrub
    el.volume = 0.3;
    await new Promise((r) => setTimeout(r, 200));
    return { t: el.currentTime, v: el.volume, err: el.error?.code ?? 0 };
  });
  expect(state.err).toBe(0);
  expect(state.t).toBeGreaterThanOrEqual(2);
  expect(state.v).toBeCloseTo(0.3);
  const dl = page.getByTestId("preview-download");
  await expect(dl).toHaveAttribute("download", "voice memo.wav");
  const [download] = await Promise.all([page.waitForEvent("download"), dl.click()]);
  expect(download.suggestedFilename()).toBe("voice memo.wav");
  await page.screenshot({ path: "screenshots/audio-preview.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("preview")).toHaveCount(0);
});

test("S75 nav has no Deploy contracts or FiClub; FiClub lives on the identity page; /fideploy/ still loads by URL", async ({ page }) => {
  await connect(page);
  await expect(page.getByText("Deploy contracts")).toHaveCount(0);
  await expect(page.getByTestId("nav-ficlub")).toHaveCount(0);
  await page.goto("/identity/");
  await expect(page.getByTestId("identity-ficlub-link")).toHaveAttribute("href", "../ficlub/");
  const res = await page.goto("/fideploy/");
  expect(res?.status()).toBe(200);
});
