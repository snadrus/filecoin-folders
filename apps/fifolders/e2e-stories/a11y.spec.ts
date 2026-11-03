import { expect, test } from "@playwright/test";
import { LIVE } from "./helpers";

// S61 screen readers: every visible or focusable control on each app has an accessible name.
test.skip(LIVE, "mock build");
const audit = () => {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll("button,a[href],input,select,textarea,[role=button]")) as HTMLElement[]) {
    const r = el.getBoundingClientRect(); if ((!r.width || !r.height) && el.tabIndex < 0) continue;
    const id = el.id && document.querySelector(`label[for="${el.id}"]`);
    const name = (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || (id && id.textContent) || el.closest("label")?.textContent || (el as HTMLInputElement).placeholder || el.innerText || "").trim().replace(/\s+/g," ");
    const iconOnly = /^[a-z_]+$/.test(name) && el.querySelector(".material-symbols-outlined") && !el.getAttribute("aria-label");
    if (!name || iconOnly) out.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className} [${el.getAttribute("data-testid")}] name="${name}"`);
  }
  return out;
};
for (const url of ["/?onboard=1&pay=ready&datasets=1", "/identity/", "/ficlub/", "/fideploy/"]) {
  test("S61 every control has an accessible name: " + url, async ({ page }) => {
    await page.goto(url);
    if (url.startsWith("/?")) { await page.getByTestId("connect-wallet").click(); await page.getByTestId("nav-drive").waitFor(); await page.waitForTimeout(800); }
    else await page.waitForTimeout(800);
    expect(await page.evaluate(audit)).toEqual([]);
  });
}

test("S61 icon buttons announce their purpose, not the icon ligature", async ({ page }) => {
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("nav-drive").waitFor();
  await expect(page.getByRole("button", { name: "List view" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Grid view" })).toBeVisible();
  await expect(page.getByRole("button", { name: /view_list|grid_view/ })).toHaveCount(0);
});
