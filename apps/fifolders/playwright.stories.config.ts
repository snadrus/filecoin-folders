import { defineConfig } from "@playwright/test";
// User-story suite. Local: mock chain build + staged editors (scripts/stories-serve.sh). Live: STORIES_URL=https://fifolders.scionbase.ai
const port = Number(process.env.STORIES_PORT || 4183);
const live = process.env.STORIES_URL;
export default defineConfig({
  testDir: "e2e-stories",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: Number(process.env.STORIES_WORKERS || 3),
  reporter: [["list"], ["json", { outputFile: "e2e-stories/results.json" }]],
  use: { viewport: { width: 1280, height: 800 }, baseURL: live || `http://127.0.0.1:${port}`, trace: "retain-on-failure", permissions: ["clipboard-read", "clipboard-write"] },
  webServer: live
    ? undefined
    : { command: "../../scripts/stories-serve.sh", url: `http://127.0.0.1:${port}/fipen/`, reuseExistingServer: true, timeout: 300_000 },
});
