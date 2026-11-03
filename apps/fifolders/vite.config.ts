import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 4173 },
  build: {
    target: "es2022",
    rollupOptions: {
      // /identity/ is its own page and bundle; shared helpers split into common chunks.
      input: { main: resolve(__dirname, "index.html"), identity: resolve(__dirname, "identity/index.html"), ficlub: resolve(__dirname, "ficlub/index.html"), fideploy: resolve(__dirname, "fideploy/index.html"), person: resolve(__dirname, "person/index.html"), slack: resolve(__dirname, "slack/callback/index.html") },
    },
  },
});
