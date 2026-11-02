import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const dist = path.resolve(process.argv[2] || "apps/fifolders/dist");
const routes = ["/", "/felarumi/", "/felanumio/"];

function localFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const full = path.resolve(dist, rel);
  if (full !== dist && !full.startsWith(dist + path.sep)) return null;
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return path.join(full, "index.html");
  return full;
}

function assets(html, pageUrl) {
  const found = new Set();
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const value = match[1];
    if (!value || value.startsWith("data:") || value.startsWith("#") || value.startsWith("mailto:")) continue;
    const url = new URL(value, pageUrl);
    if (url.origin !== pageUrl.origin) continue;
    found.add(url.pathname);
  }
  return [...found];
}

const server = http.createServer((req, res) => {
  const file = localFile(req.url || "/");
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("missing");
    return;
  }
  res.writeHead(200, { "content-type": typeOf(file) });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
const missing = [];

for (const route of routes) {
  const page = await fetch(origin + route);
  if (page.status !== 200) missing.push(`${route} -> ${page.status}`);
  const html = await page.text();
  const pageUrl = new URL(route, origin);
  for (const asset of assets(html, pageUrl)) {
    const response = await fetch(origin + asset);
    if (response.status !== 200) missing.push(`${route} asset ${asset} -> ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (asset.endsWith(".css")) {
      const css = body.toString("utf8");
      for (const match of css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
        const value = match[2];
        if (!value || value.startsWith("data:")) continue;
        const url = new URL(value, new URL(asset, origin));
        if (url.origin !== origin) continue;
        const font = await fetch(url);
        if (font.status !== 200) missing.push(`${asset} url ${url.pathname} -> ${font.status}`);
        await font.arrayBuffer();
      }
    }
  }
}

server.close();
if (missing.length) {
  console.error(missing.join("\n"));
  process.exit(1);
}
console.log(`verified ${routes.join(", ")} with no missing assets`);

function typeOf(file) {
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}
