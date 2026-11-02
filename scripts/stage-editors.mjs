import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const editorDist = path.resolve(process.argv[2] || path.join(root, "collab-edit/p2p/dist"));
const site = path.join(root, "apps/fifolders/dist");

if (!fs.existsSync(path.join(editorDist, "index.html"))) {
  console.error(`missing editor build at ${editorDist}`);
  process.exit(1);
}

const fipen = path.join(site, "fipen");
const figrid = path.join(site, "figrid");
const legacyDoc = path.join(site, "felarumi");
const legacySheet = path.join(site, "felanumio");
for (const dir of [fipen, figrid, legacyDoc, legacySheet]) fs.rmSync(dir, { recursive: true, force: true });
copyTree(editorDist, fipen, (name) => name === "sheets");
copyTree(path.join(editorDist, "fonts"), path.join(figrid, "fonts"));
copyTree(path.join(editorDist, "ui"), path.join(figrid, "ui"));
for (const name of fs.readdirSync(editorDist)) {
  const from = path.join(editorDist, name);
  if (name === "sheets" || name === "index.html" || fs.statSync(from).isDirectory()) continue;
  fs.copyFileSync(from, path.join(figrid, name));
}
fs.copyFileSync(path.join(editorDist, "sheets/app.css"), path.join(figrid, "app.css"));
const sheetJs = fs.readFileSync(path.join(editorDist, "sheets/app.js"), "utf8").replaceAll('from "../', 'from "./').replaceAll("from '../", "from './");
fs.writeFileSync(path.join(figrid, "app.js"), sheetJs);

const fipenSvg = fs.readFileSync(path.join(root, "apps/fifolders/public/fipen.svg"));
const figridSvg = fs.readFileSync(path.join(root, "apps/fifolders/public/figrid.svg"));
fs.writeFileSync(path.join(fipen, "fipen.svg"), fipenSvg);
fs.writeFileSync(path.join(fipen, "favicon.svg"), fipenSvg);
fs.writeFileSync(path.join(figrid, "figrid.svg"), figridSvg);
fs.writeFileSync(path.join(figrid, "favicon.svg"), figridSvg);

fs.writeFileSync(path.join(fipen, "index.html"), brandDoc(relativize(fs.readFileSync(path.join(fipen, "index.html"), "utf8"), "./", "../figrid/")));
fs.writeFileSync(
  path.join(figrid, "index.html"),
  brandSheet(relativize(fs.readFileSync(path.join(editorDist, "sheets/index.html"), "utf8"), "../fipen/", "./")),
);
for (const dir of [fipen, figrid]) {
  const css = path.join(dir, "fonts/fonts.css");
  if (fs.existsSync(css)) {
    fs.writeFileSync(css, fs.readFileSync(css, "utf8").replaceAll("url(/fonts/", "url(").replaceAll('url("/fonts/', 'url("'));
  }
}

fs.mkdirSync(legacyDoc, { recursive: true });
fs.mkdirSync(legacySheet, { recursive: true });
fs.writeFileSync(path.join(legacyDoc, "index.html"), redirectPage("FiPen", "/fipen/"));
fs.writeFileSync(path.join(legacySheet, "index.html"), redirectPage("FiGrid", "/figrid/"));

fs.writeFileSync(
  path.join(site, "404.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>FiFolders</title>
<script>
(function () {
  var path = location.pathname;
  var rules = [["/felanumio", "/figrid"], ["/felarumi", "/fipen"], ["/figrid", "/figrid"], ["/fipen", "/fipen"]];
  var from = "";
  var to = "";
  for (var i = 0; i < rules.length; i++) {
    var prefix = rules[i][0];
    if (path === prefix || path.indexOf(prefix + "/") === 0) {
      from = prefix;
      to = rules[i][1];
      break;
    }
  }
  if (!from) { location.replace("/"); return; }
  var rest = path.slice(from.length) || "/";
  var params = new URLSearchParams(location.search);
  if (rest !== "/") params.set("spa", rest);
  var query = params.toString();
  location.replace(to + "/" + (query ? "?" + query : "") + location.hash);
})();
</script>
`,
);

console.log(`staged editors into ${site}`);

function redirectPage(title, target) {
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<link rel="canonical" href="${target}">
<script>location.replace(${JSON.stringify(target)} + location.search + location.hash);</script>
`;
}

function brandDoc(html) {
  return html
    .replaceAll("<title>Felarumi</title>", "<title>FiPen</title>")
    .replaceAll('alt="Felarumi"', 'alt="FiPen"')
    .replaceAll("Felarumi home", "FiPen home")
    .replaceAll(">Felanumio<", ">FiGrid<")
    .replaceAll("Felarumi (.felarumi)", "FiPen (.fipen)")
    .replaceAll('accept=".felarumi,', 'accept=".fipen,.felarumi,')
    .replaceAll('href="favicon.png" type="image/png"', 'href="favicon.svg" type="image/svg+xml"')
    .replaceAll('href="favicon.png"', 'href="favicon.svg"')
    .replaceAll('href="icon.png"', 'href="favicon.svg"')
    .replaceAll('src="logo.png"', 'src="fipen.svg"');
}

function brandSheet(html) {
  let next = html
    .replaceAll("<title>Felanumio</title>", "<title>FiGrid</title>")
    .replaceAll("<strong>Felanumio</strong>", "<strong>FiGrid</strong>")
    .replaceAll(">Felarumi<", ">FiPen<")
    .replaceAll('<a class="mark" href="./">F</a>', '<a class="mark" href="./" aria-label="FiGrid home"><img src="figrid.svg" alt=""></a>');
  if (!next.includes('rel="icon"')) {
    next = next.replace("<head>", '<head>\n  <link rel="icon" href="favicon.svg" type="image/svg+xml">');
  }
  return next;
}

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
