// Debug: sponsored passkey session (saved credential, no checkout), public dataset: upload → trash → delete forever → save.
import { readFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
const OUT = "/workspace/delete-debug";
const SITE = process.env.SITE || "https://fifolders.scionbase.ai";
const saved = JSON.parse(readFileSync("/workspace/live-private-sponsored/webauthn.credential.json", "utf8"));
const b = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } } as never)) as { authenticatorId: string };
for (const c of saved.credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { ...c, rpId: c.rpId || "scionbase.ai" } } as never);
page.on("console", (m) => { const t = m.text(); if (!/Failed to load|CORS/.test(t)) console.log(`[${m.type()}]`, t.slice(0, 300)); });
page.on("dialog", (d) => void d.accept());
const say = (s: string) => console.log(`[dbg ${new Date().toISOString()}] ${s}`);
const vis = (id: string) => page.getByTestId(id).first().isVisible().catch(() => false);
let n = 0;
const snap = (name: string) => page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png` });
const ops = () => page.evaluate(() => localStorage.getItem("fifolders:ops") || "[]");
async function until(ms: number, label: string, fn: () => Promise<boolean>) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await page.waitForTimeout(2000); }
  throw new Error(`timeout ${label}`);
}
try {
  await page.goto(SITE, { waitUntil: "networkidle" });
  await until(120_000, "signed in", async () => {
    for (const t of ["passkey-continue", "passkey-existing"]) if (await vis(t)) await page.getByTestId(t).click().catch(() => undefined);
    return vis("account");
  });
  say("signed in; ops at load: " + (await ops()).slice(0, 600));
  await until(600_000, "drive ready", async () => {
    if (await vis("authorize-session")) await page.getByTestId("authorize-session").first().click().catch(() => undefined);
    if (await vis("open-drive")) await page.getByTestId("open-drive").click().catch(() => undefined);
    return (await vis("file-input")) && !(await vis("drive-loading"));
  });
  await snap("ready");
  say("drive ready; ops: " + (await ops()).slice(0, 800));
  const name = `del-${Date.now()}.txt`;
  await page.getByTestId("file-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("delete me\n") });
  await until(600_000, "uploaded", async () => (await page.getByTestId("entry").filter({ hasText: name }).count()) > 0 && !(await vis("save-changes")) && /complete/i.test(await page.getByTestId("upload-panel").innerText().catch(() => "")));
  say("uploaded; ops: " + (await ops()).slice(0, 800));
  await page.getByTestId("entry").filter({ hasText: name }).first().click({ button: "right" });
  await page.getByRole("button", { name: /Move to trash/ }).first().click();
  await page.getByTestId("nav-trash").click();
  await page.getByTestId("entry").filter({ hasText: name }).first().click({ button: "right" });
  await page.getByRole("button", { name: /Delete forever/ }).first().click();
  await page.waitForTimeout(1500);
  await snap("staged");
  say("staged; save visible=" + (await vis("save-changes")) + " ops: " + (await ops()).slice(0, 800));
  await page.getByTestId("save-changes").click();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(15_000);
    const removals = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("fifolders:removals")).map(([k, v]) => `${k}=${v.slice(0, 300)}`));
    say(`t+${(i + 1) * 15}s save visible=${await vis("save-changes")} removals=${JSON.stringify(removals)} ops=${(await ops()).slice(0, 700)}`);
    if (i === 1 || i === 8) await snap(`after-save-${i}`);
    if (!(await vis("save-changes")) && removals.length) break;
  }
  await snap("end");
} catch (e) {
  say("ERR " + (e as Error).message);
  await snap("err");
} finally {
  await b.close();
}
