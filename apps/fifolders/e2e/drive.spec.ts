import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const shots = path.join(import.meta.dirname, "..", "screenshots");

test("upload, folder, move, rename, trash, restore, download, and views", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("nav-drive")).toBeVisible();

  await page.getByTestId("new-button").click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByTestId("dialog-input").fill("Docs");
  await page.getByTestId("dialog-submit").click();
  await expect(page.getByTestId("entry").filter({ hasText: "Docs" })).toBeVisible();

  await page.getByTestId("file-input").setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello fifolders"),
  });
  const file = page.getByTestId("entry").filter({ hasText: "hello.txt" });
  await expect(file).toBeVisible();
  await expect(page.getByTestId("upload-panel")).toBeVisible();

  await file.click({ button: "right" });
  await page.getByRole("button", { name: "Move to", exact: true }).click();
  await page.getByTestId("move-dest").selectOption({ label: "/Docs" });
  await page.getByTestId("move-confirm").click();
  await expect(file).toHaveCount(0);

  await page.getByTestId("entry").filter({ hasText: "Docs" }).dblclick();
  await expect(page.getByTestId("breadcrumb").filter({ hasText: "Docs" })).toBeVisible();
  const moved = page.getByTestId("entry").filter({ hasText: "hello.txt" });
  await expect(moved).toBeVisible();

  await moved.click({ button: "right" });
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByTestId("dialog-input").fill("note.txt");
  await page.getByTestId("dialog-submit").click();
  const note = page.getByTestId("entry").filter({ hasText: "note.txt" });
  await expect(note).toBeVisible();

  await page.screenshot({ path: path.join(shots, "list.png") });

  await note.click({ button: "right" });
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByTestId("details")).toBeVisible();
  await expect(page.getByTestId("piece-cid")).not.toHaveText("—");
  await expect(page.getByTestId("volume-version")).not.toHaveText("0");
  await page.screenshot({ path: path.join(shots, "details.png") });
  await page.getByRole("button", { name: "Close details" }).click();

  await page.getByTestId("view-grid").click();
  await expect(page.getByTestId("browser")).toHaveAttribute("data-view", "grid");
  await page.screenshot({ path: path.join(shots, "grid.png") });
  await page.getByTestId("view-list").click();
  await expect(page.getByTestId("browser")).toHaveAttribute("data-view", "list");

  await note.click({ button: "right" });
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(note).toHaveCount(0);
  await page.getByTestId("nav-trash").click();
  await expect(page.getByTestId("entry").filter({ hasText: "note.txt" })).toBeVisible();
  await page.getByTestId("entry").filter({ hasText: "note.txt" }).click({ button: "right" });
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByTestId("nav-drive").click();
  await page.getByTestId("entry").filter({ hasText: "Docs" }).dblclick();
  await expect(page.getByTestId("entry").filter({ hasText: "note.txt" })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.getByTestId("entry").filter({ hasText: "note.txt" }).click({ button: "right" });
      await page.getByRole("button", { name: "Download" }).click();
    })(),
  ]);
  const saved = await download.path();
  expect(saved).toBeTruthy();
  expect(await readFile(saved!)).toEqual(Buffer.from("hello fifolders"));
});
