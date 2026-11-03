import { expect, test } from "@playwright/test";

/* User story: while I (the owner) was away, a participant saved a copy of my doc with their edits. Back in FiFolders
   I see it under "Participant copies" and bring it into my own drive: as the next version of the original when nothing
   changed on my side since their base, or side by side when it diverged. I keep owning the document. */

const doc = (text: string) =>
  JSON.stringify({ kind: "felarumi-p2p", title: "Plan", snapshot: { text: text + "\n", styles: [] }, copyOf: { doc: "doc:abc", owner: "", baseRev: 3, by: "Ada", at: 1 } });

test("owner takes participant copies into their drive: new version or side by side", async ({ page }) => {
  await page.addInitScript(
    ({ a, b }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        "fifolders:copies",
        JSON.stringify([
          { id: "v1", kind: "doc", title: "Plan", from: "Ada", content: a, origin: { doc: "doc:abc", owner: "", baseRev: 3, by: "Ada", at: 1 }, fit: "version", path: "/FiPen/Plan.fipen", received: 1 },
          { id: "d1", kind: "doc", title: "Plan", from: "Grace", content: b, origin: { doc: "doc:abc", owner: "", baseRev: 1, by: "Grace", at: 2 }, fit: "diverged", path: "/FiPen/Plan.fipen", received: 2 },
        ]),
      );
    },
    { a: doc("Ada's edits"), b: doc("Grace's edits") },
  );
  await page.goto("/?onboard=1&pay=ready&datasets=1");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("nav-drive")).toBeVisible();
  const section = page.getByTestId("participant-copies");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("participant-copy")).toHaveCount(2);
  await page.screenshot({ path: "/workspace/fipen-after-participant-copies.png" });
  await section.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByTestId("participant-copy")).toHaveCount(1);
  await section.getByRole("button", { name: "Copy to my drive" }).click();
  await expect(page.getByTestId("participant-copies")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("fifolders:copies"))).toBe("[]");
  await expect(page.getByTestId("entry").filter({ hasText: "FiPen" })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("entry").filter({ hasText: "FiPen" }).dblclick();
  await expect.poll(async () => (await page.getByTestId("entry").allInnerTexts()).join(" | "), { timeout: 20_000 }).toContain("Plan (copy from Grace)");
  await expect.poll(async () => (await page.getByTestId("entry").allInnerTexts()).join(" | ")).toMatch(/(^|\| )Plan(\.fipen)?\n/);
});
