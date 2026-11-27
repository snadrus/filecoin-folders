import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e-wallet",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 800 },
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e-wallet/serve.mjs --wait",
    url: "http://localhost:4177/wallet/",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
