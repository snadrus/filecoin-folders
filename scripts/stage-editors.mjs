import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const editorDist = path.resolve(process.argv[2] || path.join(root, "collab-edit/p2p/dist"));
const site = path.join(root, "apps/fifolders/dist");

if (!fs.existsSync(path.join(editorDist, "index.html"))) {
  console.error(`missing editor build at ${editorDist}`);
  process.exit(1);
}

const felarumi = path.join(site, "felarumi");
const felanumio = path.join(site, "felanumio");
fs.rmSync(felarumi, { recursive: true, force: true });
fs.rmSync(felanumio, { recursive: true, force: true });
copyTree(editorDist, felarumi, (name) => name === "sheets");
copyTree(path.join(editorDist, "fonts"), path.join(felanumio, "fonts"));
copyTree(path.join(editorDist, "ui"), path.join(felanumio, "ui"));
for (const name of fs.readdirSync(editorDist)) {
  const from = path.join(editorDist, name);
  if (name === "sheets" || name === "index.html" || fs.statSync(from).isDirectory()) continue;
  fs.copyFileSync(from, path.join(felanumio, name));
}
fs.copyFileSync(path.join(editorDist, "sheets/app.css"), path.join(felanumio, "app.css"));
const sheetJs = fs.readFileSync(path.join(editorDist, "sheets/app.js"), "utf8").replaceAll('from "../', 'from "./').replaceAll("from '../", "from './");
fs.writeFileSync(path.join(felanumio, "app.js"), sheetJs);

fs.writeFileSync(path.join(felarumi, "index.html"), relativize(fs.readFileSync(path.join(felarumi, "index.html"), "utf8"), "./", "../felanumio/"));
fs.writeFileSync(
  path.join(felanumio, "index.html"),
  relativize(fs.readFileSync(path.join(editorDist, "sheets/index.html"), "utf8"), "../felarumi/", "./"),
);
for (const dir of [felarumi, felanumio]) {
  const css = path.join(dir, "fonts/fonts.css");
  if (fs.existsSync(css)) {
    fs.writeFileSync(css, fs.readFileSync(css, "utf8").replaceAll("url(/fonts/", "url(").replaceAll('url("/fonts/', 'url("'));
  }
}

fs.writeFileSync(
  path.join(site, "404.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>FiFolders</title>
<script>
(function () {
  var path = location.pathname;
  var base = path.indexOf("/felanumio") === 0 ? "/felanumio" : path.indexOf("/felarumi") === 0 ? "/felarumi" : "";
  if (!base) { location.replace("/"); return; }
  var rest = path.slice(base.length) || "/";
  var params = new URLSearchParams(location.search);
  if (rest !== "/") params.set("spa", rest);
  var query = params.toString();
  location.replace(base + "/" + (query ? "?" + query : "") + location.hash);
})();
</script>
`,
);

console.log(`staged editors into ${site}`);

function relativize(html, home, sheets) {
  return html
    .replaceAll('href="/sheets"', `href="${sheets}"`)
    .replaceAll("href='/sheets'", `href='${sheets}'`)
    .replaceAll('href="/"', `href="${home}"`)
    .replaceAll("href='/'", `href='${home}'`)
    .replaceAll('src="/sheets/app.js"', 'src="app.js"')
    .replaceAll('href="/sheets/app.css"', 'href="app.css"')
    .replaceAll('="/', '="')
    .replaceAll("='/", "='");
}

function copyTree(from, to, skip) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (skip?.(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.statSync(src).isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
}
