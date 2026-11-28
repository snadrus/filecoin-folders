import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dir = dirname(fileURLToPath(import.meta.url));
const app = resolve(dir, "..");

export default defineConfig({
  root: app,
  base: "./",
  build: {
    outDir: resolve(dir, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        wallet: resolve(app, "wallet/index.html"),
        dapp: resolve(dir, "dapp.html"),
      },
    },
  },
});
