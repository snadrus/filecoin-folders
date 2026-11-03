import { defineConfig } from "@playwright/test";

/** Real-contract FiClub E2E: anvil local chain + FiClub deployed by e2e-anvil/setup.mjs. Run: pnpm e2e:ficlub-anvil */
export default defineConfig({
  testDir: "e2e-anvil",
  timeout: 90_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4175", viewport: { width: 1280, height: 900 } },
  webServer: {
    command: "node e2e-anvil/serve.mjs",
    url: "http://127.0.0.1:4175/ficlub/",
    reuseExistingServer: false,
  },
});
