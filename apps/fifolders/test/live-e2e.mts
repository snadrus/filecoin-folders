// Live e2e: Pages + Calibration Worker, virtual passkey, Stripe 4242, v2 handover, drive/identity/fipen/person.
import { chmodSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { payOnPage } from "./support/stripe-pay.js";

const OUT = "/workspace/fil-gasless/live";
const SITE = "https://fifolders.scionbase.ai";
const PURCHASE_USD = 3.91;
const CRED_FILE = `${OUT}/webauthn.credential.json`;
const WORKER = "https://fast.scionbase.ai";
const RPC = "https://api.calibration.node.glif.io/rpc/v1";
const FACTORY = "0x228867301f1f0EaF75b5d7af62F3c44e1796A56D";
const LEGACY = "0xCBb99E41C173B06D15212A135ba9F46AAB19DEE5";
const log: Record<string, unknown> = { started: new Date().toISOString(), steps: {} as Record<string, unknown> };
const steps = log.steps as Record<string, unknown>;

const flush = () => writeFileSync(`${OUT}/result.json`, JSON.stringify(log, null, 2));
const say = (msg: string) => {
  console.log(`[e2e ${new Date().toISOString()}] ${msg}`);
  log.last = msg;
  flush();
};

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

const executeBodies: unknown[] = [];
const sponsorPaths: string[] = [];
page.on("request", (r) => {
  if (r.url().startsWith(WORKER)) sponsorPaths.push(`${r.method()} ${new URL(r.url()).pathname}`);
});
page.on("response", async (r) => {
  if (!r.url().startsWith(WORKER)) return;
  if (r.url().includes("/execute")) {
    const body = await r.json().catch(() => null);
    if (body) executeBodies.push(body);
  }
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("console:", m.text().slice(0, 240));
});

let shot = 0;
const snap = async (p: Page, name: string) => {
  const file = `${OUT}/${String(++shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: file, fullPage: true });
  say(`screenshot ${file}`);
  return file;
};
const textOf = async (p: Page) => (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 800);
const visible = async (p: Page, testId: string) => p.getByTestId(testId).first().isVisible().catch(() => false);

async function clickIf(p: Page, testId: string) {
  if (await visible(p, testId)) {
    await p.getByTestId(testId).first().click();
    return true;
  }
  return false;
}

let lastPasskeyClick = 0;
async function continuePasskey(p: Page) {
  if (Date.now() - lastPasskeyClick < 8_000) return null;
  const kind = (await clickIf(p, "passkey-continue")) ? "continue" : (await clickIf(p, "passkey-existing")) ? "existing" : null;
  if (kind) lastPasskeyClick = Date.now();
  return kind;
}

async function ethCall(to: string, data: string) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!json.result) throw new Error(json.error?.message || "eth_call failed");
  return json.result;
}

async function isAccount(factory: string, account: string) {
  const data = "0x25ca4c9c" + account.slice(2).toLowerCase().padStart(64, "0");
  const result = await ethCall(factory, data);
  return BigInt(result) === 1n;
}

async function waitUntil(ms: number, label: string, fn: () => Promise<boolean>) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(2000);
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  // --- 1 already confirmed at start; record status ---
  const status0 = await (await fetch(WORKER + "/status", { headers: { "user-agent": "Mozilla/5.0" } })).json();
  steps.poolBefore = {
    funds: status0.funds,
    pool: status0.pool,
    checkoutOpen: status0.checkoutOpen,
    gasKilled: status0.gas?.killed,
  };
  say(`status funds=${status0.funds?.level} ready=${status0.pool?.ready} fil=${status0.funds?.fil} usdfc=${status0.funds?.usdfc}`);

  const volumeName = `live-e2e-${Date.now().toString(36)}`;
  log.volumeName = volumeName;

  await page.goto(`${SITE}/?usd=${PURCHASE_USD}`, { waitUntil: "networkidle" });
  await page.getByTestId("chain-calibration").click().catch(() => undefined);
  await page.getByTestId("volume-name").fill(volumeName).catch(() => undefined);
  await snap(page, "start");
  await page.getByTestId("passkey-new").click();
  await page.getByTestId("fix-payments").first().waitFor({ timeout: 90_000 });
  await snap(page, "signed-in");
  steps.signIn = { ok: true, text: await textOf(page) };
  const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  writeFileSync(CRED_FILE, JSON.stringify({ authenticatorId, rpId: "fifolders.scionbase.ai", credentials: creds.credentials }));
  chmodSync(CRED_FILE, 0o600);
  const passkeyMeta = { count: creds.credentials.length, discoverable: creds.credentials.every((c) => c.isResidentCredential) };
  log.passkey = passkeyMeta;
  say(`signed in, ${passkeyMeta.count} passkey(s); credential saved`);

  await Promise.all([
    page.waitForURL(/checkout\.stripe\.com/, { timeout: 90_000 }),
    page.getByTestId("fix-payments").first().click(),
  ]);
  const checkoutTest = /cs_test_/.test(page.url());
  const session = /cs_test_[A-Za-z0-9]+/.exec(page.url())?.[0] ?? "";
  steps.checkout = { testMode: checkoutTest, session: session ? "cs_test_…" : "" };
  if (!checkoutTest) throw new Error("checkout was not Stripe test mode");
  say("on Stripe test checkout");
  await payOnPage(page, { email: "fifolders-live-e2e@example.com", screenshot: `${OUT}/stripe-fail.png` });
  await page.waitForURL(/fifolders\.scionbase\.ai/, { timeout: 150_000 });
  log.returnedTo = page.url().replace(/session_id=[^&]+/, "session_id=…");
  await snap(page, "after-stripe");
  say(`returned from Stripe: ${log.returnedTo}`);

  const tHandover = Date.now();
  let lastMark = 0;
  let reloaded = false;
  const paymentsReady = async () =>
    (await visible(page, "payment-status")) || (await visible(page, "credit-balance")) || (await visible(page, "add-credits"));
  await waitUntil(12 * 60_000, "payments ready after passkey resume", async () => {
    if (await paymentsReady()) return true;
    const clicked = await continuePasskey(page);
    if (clicked) say(`clicked passkey ${clicked} after redirect`);
    // Gasless setup uses credit-balance/add-credits; open the account menu if we are signed in but the setup card is hidden.
    if ((await visible(page, "account")) && !(await visible(page, "setup-address")) && !(await paymentsReady())) {
      await page.getByTestId("account").click().catch(() => undefined);
    }
    const elapsed = Date.now() - tHandover;
    // After the sponsor has applied the payment, a stale "Buy storage credits" panel is usually the
    // checkout-settle race; reload and continue with the saved passkey.
    if (!reloaded && elapsed > 90_000 && (await visible(page, "fix-payments")) && (await visible(page, "setup-address"))) {
      reloaded = true;
      say("payments still pending in UI; reloading to pick up the assigned account");
      await page.reload({ waitUntil: "networkidle" });
      await continuePasskey(page);
    }
    if (elapsed - lastMark > 20_000) {
      lastMark = elapsed;
      const ids = ["passkey-continue", "passkey-unavailable", "passkey-existing", "fix-payments", "add-credits", "credit-balance", "payment-status", "setup-address", "authorize-session", "create-dataset", "file-input", "drive-pending", "setup"];
      const seen: string[] = [];
      for (const id of ids) if (await visible(page, id)) seen.push(id);
      say(`handover wait ${Math.round(elapsed / 1000)}s visible=${seen.join(",") || "none"} text=${(await textOf(page)).slice(0, 180)}`);
      await snap(page, `handover-${Math.round(elapsed / 1000)}s`);
    }
    return false;
  });
  const handover = { ok: true, seconds: Math.round((Date.now() - tHandover) / 1000), text: "" };
  await snap(page, "paid-ready");
  handover.text = await textOf(page);
  steps.handover = handover;
  say(`payments ready after ${handover.seconds}s`);

  // Finish setup: authorize / open drive. file-input is sr-only and present during setup, so it is not a ready signal.
  let clickedCreate = false;
  let clickedAuth = false;
  let lastSetupMark = 0;
  const sessionReady = async () => {
    const t = await textOf(page);
    return /Session key until/i.test(t) && !(await visible(page, "authorize-session"));
  };
  await waitUntil(20 * 60_000, "drive ready for upload", async () => {
    if (await sessionReady()) return true;
    if (await visible(page, "create-dataset") && !clickedCreate) {
      clickedCreate = true;
      say("clicking create-dataset");
      await page.getByTestId("create-dataset").first().click();
      return false;
    }
    if (await visible(page, "authorize-session") && !clickedAuth) {
      clickedAuth = true;
      say("clicking authorize-session during setup");
      await page.getByTestId("authorize-session").first().click().catch(() => undefined);
      return false;
    }
    if (await visible(page, "open-drive")) {
      say("clicking open-drive");
      await page.getByTestId("open-drive").click().catch(() => undefined);
      await page.waitForTimeout(2000);
      return false;
    }
    await continuePasskey(page);
    const elapsed = Date.now() - tHandover;
    if (elapsed - lastSetupMark > 20_000) {
      lastSetupMark = elapsed;
      say(`setup wait ${Math.round(elapsed / 1000)}s text=${(await textOf(page)).slice(0, 180)}`);
      await snap(page, `setup-${Math.round(elapsed / 1000)}s`);
    }
    return false;
  });

  let credit: Record<string, unknown> = {};
  if (session) {
    credit = (await (await fetch(`${WORKER}/credits?session=${session}`, { headers: { "user-agent": "Mozilla/5.0" } })).json()) as Record<string, unknown>;
  }
  // also try to discover payer from the account menu / setup address
  if (await visible(page, "account")) await page.getByTestId("account").click().catch(() => undefined);
  const setupAddress = (await page.getByTestId("setup-address").textContent().catch(() => ""))?.trim() || "";
  const payer = String(credit.account || credit.payer || setupAddress || "");
  log.credit = {
    path: credit.path,
    status: credit.status,
    account: payer,
    datasetId: credit.datasetId ?? credit.dataset,
  };
  if (!payer) throw new Error("no payer/account after handover");
  const v2 = await isAccount(FACTORY, payer);
  const v1 = await isAccount(LEGACY, payer);
  steps.v2Account = { ok: v2 && !v1, account: payer, v2, v1, path: credit.path };
  if (!v2 || v1) throw new Error(`assigned account is not v2-only: v2=${v2} v1=${v1} ${payer}`);
  say(`v2 account ${payer} path=${credit.path}`);

  // Authorize session if the button is shown
  if (await visible(page, "account") && !(await visible(page, "authorize-session")) && !(await visible(page, "session-status"))) {
    await page.getByTestId("account").click().catch(() => undefined);
  }
  if (await visible(page, "authorize-session")) {
    say("clicking authorize-session");
    await page.getByTestId("authorize-session").first().click();
    await waitUntil(4 * 60_000, "session ready", async () => {
      const t = await textOf(page);
      return /Session key until/i.test(t) && !(await visible(page, "authorize-session"));
    });
  }
  steps.session = { ok: true, text: (await textOf(page)).slice(0, 300) };
  await snap(page, "session-ready");

  // --- Drive file save ---
  const fileName = "live-e2e.txt";
  await page.getByTestId("file-input").setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(`hello from live e2e ${new Date().toISOString()}\n`),
  });
  say("uploaded live-e2e.txt; waiting for entry / save");
  await waitUntil(20 * 60_000, "drive file saved", async () => {
    const entry = page.getByTestId("entry").filter({ hasText: fileName });
    if (!(await entry.count().catch(() => 0))) {
      // maybe still authorizing
      if (await visible(page, "authorize-session")) {
        await page.getByTestId("authorize-session").first().click().catch(() => undefined);
      }
      await continuePasskey(page);
      return false;
    }
    const activity = await page.getByTestId("activity").innerText().catch(() => "");
    const pending = await visible(page, "activity-indicator");
    if (/Saved|committed|done|Uploaded/i.test(activity) && !pending) return true;
    // entry visible and no error is enough once activity quiets, but wait for a done item if present
    const done = await page.locator('[data-testid=activity-item][data-status=done]').count().catch(() => 0);
    const err = await page.locator('[data-testid=activity-item][data-status=error]').count().catch(() => 0);
    if (err > 0 && done === 0) {
      const errText = await page.getByTestId("activity").innerText().catch(() => "");
      // keep waiting unless it looks fatal and stalled > nothing; don't throw yet
      log.driveActivity = errText.slice(0, 400);
    }
    return done > 0 && !pending;
  });
  await snap(page, "drive-saved");
  steps.driveSave = { ok: true, file: fileName, activity: (await page.getByTestId("activity").innerText().catch(() => "")).slice(0, 400) };
  say("drive file saved");

  // --- Identity profile ---
  await page.goto(`${SITE}/identity/`, { waitUntil: "networkidle" });
  await waitUntil(30_000, "identity connect or form", async () => {
    return (await visible(page, "identity-connect")) || (await visible(page, "identity-form"));
  });
  if (await visible(page, "identity-connect")) {
    await page.getByTestId("identity-connect").click();
  }
  await page.getByTestId("identity-form").waitFor({ timeout: 90_000 });
  await page.getByTestId("identity-name").fill("Live E2E");
  await page.getByTestId("identity-bio").fill("Calibration live e2e profile");
  await snap(page, "identity-form");
  await page.getByTestId("identity-save").click();
  say("saving identity");
  await page.getByTestId("identity-saved").waitFor({ timeout: 15 * 60_000 });
  await snap(page, "identity-saved");
  const identityStatus = await page.getByTestId("identity-status").innerText().catch(() => "");
  steps.identity = { ok: true, status: identityStatus, name: "Live E2E" };
  say(`identity saved: ${identityStatus}`);

  // --- Back to drive so it can process a FiPen save ---
  await page.goto(`${SITE}/`, { waitUntil: "networkidle" });
  await waitUntil(3 * 60_000, "drive session after identity", async () => {
    if (await visible(page, "payment-status") || await visible(page, "file-input")) {
      if (await visible(page, "authorize-session")) {
        await page.getByTestId("authorize-session").first().click().catch(() => undefined);
        return false;
      }
      return await visible(page, "file-input");
    }
    await continuePasskey(page);
    return false;
  });
  await snap(page, "drive-resumed");

  // --- Standalone FiPen ---
  const fipenName = "live-e2e.fipen";
  const fipenUrl =
    `${SITE}/fipen/?fifolders=1` +
    `&name=${encodeURIComponent(fipenName)}` +
    `&path=${encodeURIComponent("/" + fipenName)}` +
    `&volume=${encodeURIComponent(volumeName)}` +
    `&owner=${payer}`;
  const fipen = await ctx.newPage();
  fipen.on("console", (m) => {
    if (m.type() === "error") console.log("fipen console:", m.text().slice(0, 240));
  });
  await fipen.goto(fipenUrl, { waitUntil: "domcontentloaded" });
  // embedded mode auto-clicks Blank document
  await fipen.locator("#input").waitFor({ timeout: 60_000, state: "visible" });
  await fipen.locator("#title").fill("Live E2E Note");
  await fipen.locator("#input").click();
  await fipen.keyboard.type("Hello from standalone FiPen live e2e.");
  await fipen.locator("#p2p-save").waitFor({ timeout: 30_000 });
  await fipen.locator("#p2p-save").click();
  await snap(fipen, "fipen-typed");
  say("fipen save clicked; waiting for queued/saved");
  await waitUntil(20 * 60_000, "fipen saved to volume", async () => {
    const state = await fipen.locator("#status").getAttribute("data-save").catch(() => "");
    log.fipenState = state;
    if (state === "failed") {
      const t = await textOf(fipen);
      throw new Error(`fipen save failed: ${t.slice(0, 200)}`);
    }
    if (state === "saved") return true;
    // drive tab may show the entry / activity
    const entry = await page.getByTestId("entry").filter({ hasText: "live-e2e" }).count().catch(() => 0);
    const activity = await page.getByTestId("activity").innerText().catch(() => "");
    if (entry > 0 && /Saved “?Live E2E|Saved “?live-e2e/i.test(activity)) return true;
    return false;
  });
  await snap(fipen, "fipen-saved");
  await snap(page, "drive-after-fipen");
  steps.fipen = { ok: true, state: log.fipenState, url: fipenUrl.replace(payer, "<payer>") };
  say("fipen doc saved");
  await fipen.close();

  // --- Person page ---
  await page.goto(`${SITE}/person/?id=${payer}`, { waitUntil: "networkidle" });
  await waitUntil(8 * 60_000, "person profile visible", async () => {
    if (await visible(page, "person-page") && await visible(page, "person-name")) {
      const name = (await page.getByTestId("person-name").innerText().catch(() => "")).trim();
      if (/Live E2E/i.test(name)) return true;
    }
    if (await visible(page, "person-missing")) {
      await page.waitForTimeout(8000);
      await page.reload({ waitUntil: "networkidle" }).catch(() => undefined);
    }
    return false;
  });
  const personName = (await page.getByTestId("person-name").innerText().catch(() => "")).trim();
  const personBio = (await page.getByTestId("person-bio").innerText().catch(() => "")).trim();
  await snap(page, "person-page");
  const person = { ok: /Live E2E/i.test(personName), name: personName, bio: personBio, id: payer };
  steps.person = person;
  if (!person.ok) throw new Error(`person page name mismatch: ${personName}`);
  say(`person page shows ${personName}`);

  log.ok = true;
} catch (error) {
  log.ok = false;
  log.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  log.at = page.url().replace(/session_id=[^&]+/, "session_id=…");
  log.text = await textOf(page).catch(() => "");
  await snap(page, "error").catch(() => undefined);
  say(`FAIL: ${log.error}`);
} finally {
  const txs = executeBodies
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      const rec = b as Record<string, unknown>;
      return rec.hash || rec.tx || rec.transactionHash || rec.id || null;
    })
    .filter(Boolean);
  log.executeTxs = txs;
  log.sponsorCalls = [...new Set(sponsorPaths)];
  try {
    const status1 = await (await fetch(WORKER + "/status", { headers: { "user-agent": "Mozilla/5.0" } })).json();
    log.statusAfter = { funds: status1.funds, pool: status1.pool, gasKilled: status1.gas?.killed };
  } catch (e) {
    log.statusAfterError = e instanceof Error ? e.message : String(e);
  }
  log.finished = new Date().toISOString();
  flush();
  console.log(JSON.stringify({ ok: log.ok, error: log.error, steps: log.steps, executeTxs: log.executeTxs, statusAfter: log.statusAfter }, null, 2));
  await browser.close();
}
