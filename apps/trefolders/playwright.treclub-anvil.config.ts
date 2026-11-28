import { defineConfig } from "@playwright/test";

/** Real-contract TreClub E2E: anvil local chain + TreClub deployed by e2e-anvil/setup.mjs. Run: pnpm e2e:treclub-anvil */
export default defineConfig({
  testDir: "e2e-anvil",
  timeout: 90_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4175", viewport: { width: 1280, height: 900 } },
  webServer: {
    command: "node e2e-anvil/serve.mjs",
    url: "http://127.0.0.1:4175/treclub/",
    reuseExistingServer: false,
  },
});
