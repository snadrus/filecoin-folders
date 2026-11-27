import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const dir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(dir, "dist");
const walletPort = Number(process.env.WALLET_PORT || 4177);
const dappPort = Number(process.env.DAPP_PORT || 4178);

if (!process.env.WALLET_E2E_REUSE) {
  await build({ configFile: resolve(dir, "vite.config.ts"), logLevel: "warn" });
  for (const file of ["empirical-inner.html", "empirical-parent.html"]) {
    mkdirSync(join(dist, "e2e-wallet"), { recursive: true });
    cpSync(resolve(dir, file), join(dist, "e2e-wallet", file));
  }
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function serve(root) {
  return (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const full = resolve(root, "." + rel);
    if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404).end("missing");
      return;
    }
    res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
    res.end(readFileSync(full));
  };
}

await new Promise((resolveOk) => {
  const a = createServer(serve(dist)).listen(walletPort, "::", () => {
    createServer(serve(dist)).listen(dappPort, "::", () => resolveOk());
  });
  a.unref?.();
});
console.log(`wallet http://localhost:${walletPort}/wallet/`);
console.log(`dapp   http://localhost:${dappPort}/e2e-wallet/dapp.html`);

if (process.argv.includes("--wait")) {
  await new Promise(() => {});
}
