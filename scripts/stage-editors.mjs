import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const editorDist = path.resolve(process.argv[2] || path.join(root, "collab-edit/p2p/dist"));
const site = path.join(root, "apps/trefolders/dist");

if (!fs.existsSync(path.join(editorDist, "index.html"))) {
  console.error(`missing editor build at ${editorDist}`);
  process.exit(1);
}

const trepen = path.join(site, "trepen");
const tregrid = path.join(site, "tregrid");
const legacyDoc = path.join(site, "felarumi");
const legacySheet = path.join(site, "felanumio");
// Pre-rename live paths. They keep working as redirects that carry the query string and hash.
const oldPen = path.join(site, "fipen");
const oldGrid = path.join(site, "figrid");
for (const dir of [trepen, tregrid, legacyDoc, legacySheet, oldPen, oldGrid]) fs.rmSync(dir, { recursive: true, force: true });
copyTree(editorDist, trepen, (name) => name === "sheets");
copyTree(path.join(editorDist, "fonts"), path.join(tregrid, "fonts"));
copyTree(path.join(editorDist, "ui"), path.join(tregrid, "ui"));
for (const name of fs.readdirSync(editorDist)) {
  const from = path.join(editorDist, name);
  if (name === "sheets" || name === "index.html" || fs.statSync(from).isDirectory()) continue;
  fs.copyFileSync(from, path.join(tregrid, name));
}
fs.copyFileSync(path.join(editorDist, "sheets/app.css"), path.join(tregrid, "app.css"));
// TreGrid's bundle lives one level up from its build folder: rewrite every chunk reference (from, side-effect, dynamic).
const sheetJs = fs
  .readFileSync(path.join(editorDist, "sheets/app.js"), "utf8")
  .replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])\.\.\//g, "$1$2./");
fs.writeFileSync(path.join(tregrid, "app.js"), sheetJs);

const trepenSvg = fs.readFileSync(path.join(root, "apps/trefolders/public/trepen.svg"));
const tregridSvg = fs.readFileSync(path.join(root, "apps/trefolders/public/tregrid.svg"));
fs.writeFileSync(path.join(trepen, "trepen.svg"), trepenSvg);
fs.writeFileSync(path.join(trepen, "favicon.svg"), trepenSvg);
fs.writeFileSync(path.join(tregrid, "tregrid.svg"), tregridSvg);
fs.writeFileSync(path.join(tregrid, "favicon.svg"), tregridSvg);

fs.writeFileSync(path.join(trepen, "index.html"), brandDoc(relativize(fs.readFileSync(path.join(trepen, "index.html"), "utf8"), "./", "../tregrid/")));
fs.writeFileSync(
  path.join(tregrid, "index.html"),
  brandSheet(relativize(fs.readFileSync(path.join(editorDist, "sheets/index.html"), "utf8"), "../trepen/", "./")),
);
for (const dir of [trepen, tregrid]) {
  const css = path.join(dir, "fonts/fonts.css");
  if (fs.existsSync(css)) {
    fs.writeFileSync(css, fs.readFileSync(css, "utf8").replaceAll("url(/fonts/", "url(").replaceAll('url("/fonts/', 'url("'));
  }
}

fs.mkdirSync(legacyDoc, { recursive: true });
fs.mkdirSync(legacySheet, { recursive: true });
fs.writeFileSync(path.join(legacyDoc, "index.html"), redirectPage("TrePen", "/trepen/"));
fs.writeFileSync(path.join(legacySheet, "index.html"), redirectPage("TreGrid", "/tregrid/"));
fs.mkdirSync(oldPen, { recursive: true });
fs.mkdirSync(oldGrid, { recursive: true });
fs.writeFileSync(path.join(oldPen, "index.html"), redirectPage("TrePen", "/trepen/"));
fs.writeFileSync(path.join(oldGrid, "index.html"), redirectPage("TreGrid", "/tregrid/"));

fs.writeFileSync(
  path.join(site, "404.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>TreFolders</title>
<script>
(function () {
  var path = location.pathname;
  var rules = [["/felanumio", "/tregrid"], ["/felarumi", "/trepen"], ["/figrid", "/tregrid"], ["/fipen", "/trepen"], ["/tregrid", "/tregrid"], ["/trepen", "/trepen"]];
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
    .replaceAll("<title>Felarumi</title>", "<title>TrePen</title>")
    .replaceAll('alt="Felarumi"', 'alt="TrePen"')
    .replaceAll("Felarumi home", "TrePen home")
    .replaceAll(">Felanumio<", ">TreGrid<")
    .replaceAll("Felarumi (.felarumi)", "TrePen (.trepen)")
    .replaceAll('accept=".felarumi,', 'accept=".fipen,.trepen,.felarumi,')
    .replaceAll('href="favicon.png" type="image/png"', 'href="favicon.svg" type="image/svg+xml"')
    .replaceAll('href="favicon.png"', 'href="favicon.svg"')
    .replaceAll('href="icon.png"', 'href="favicon.svg"')
    .replaceAll('src="logo.png"', 'src="trepen.svg"');
}

function brandSheet(html) {
  let next = html
    .replaceAll("<title>Felanumio</title>", "<title>TreGrid</title>")
    .replaceAll("<strong>Felanumio</strong>", "<strong>TreGrid</strong>")
    .replaceAll(">Felarumi<", ">TrePen<")
    .replaceAll('<a class="mark" href="./">F</a>', '<a class="mark" href="./" aria-label="TreGrid home"><img src="tregrid.svg" alt=""></a>');
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
